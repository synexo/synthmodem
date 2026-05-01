'use strict';

/**
 * PjsipBackend — backend B orchestrator.
 *
 * Runs one VM with modemd-tunnel + (eventually) slmodemd + d-modem +
 * PJSIP. On activate() places an internal SIP INVITE against in-VM
 * PJSIP and bridges RTP between an externally-owned caller socket
 * and the internal RTP leg through the tunnel.
 *
 * ─── Why d-modem is essential (do not route around it) ───────────
 *
 * Backend B's entire reason to exist is to inherit D-Modem's proven
 * audio path into slmodemd:
 *
 *   - PJSIP's software clock (`snd_use_sw_clock`) drives the 20 ms
 *     put_frame/get_frame cadence.
 *   - Fixed 40-frame jitter buffer (jb_min_pre = jb_max_pre = jb_init).
 *   - PLC disabled on PCMU/PCMA (fake audio would corrupt modem tones).
 *   - VAD disabled, echo canceller off, null sound device.
 *   - PCMU/PCMA exclusive codec priority.
 *   - `dmodem_put_frame` writes 320-byte PCM frames directly to
 *     slmodemd's audio socketpair, with silence-on-underrun to keep
 *     slmodemd's DSP clock fed.
 *
 * These together are what makes backend B worth the effort — we
 * tried reimplementing equivalent pacing in Node (Clock Pump v2)
 * and it works at V.32bis but is fragile at higher speeds. Any
 * future change that bypasses d-modem, replaces PJSIP with a
 * Node-side RTP shim, or otherwise takes over the path from RTP to
 * slmodemd's audio socketpair gives up these optimizations. The
 * whole point of this backend is to keep that path intact.
 *
 * ─── Status ──────────────────────────────────────────────────────
 *
 * This is step-4b scope: SIP + RTP glue. Step-5 adds the control
 * channel (AT commands, data bytes) so the modem can actually run a
 * handshake. Until step 5, this backend will establish a call and
 * bridge RTP but will NOT emit a 'connected' event tied to a real
 * modem handshake — instead 'connected' fires as soon as INVITE
 * returns 200 OK, purely as a placeholder for the interface shape.
 *
 * ─── Interface vs. native ModemDSP ───────────────────────────────
 *
 * PjsipBackend and the native ModemDSP share the general shape
 * CallSession expects:
 *   start() / stop()
 *   activate() — one-shot entry to "begin the call" (INVITE for
 *     pjsip; answer-tone start for native)
 *   write(Buffer) — send data-mode bytes
 *   events: 'connected', 'silenceHangup', 'error', 'data'
 *
 * They differ in media plane:
 *
 *   Native ModemDSP exposes `receiveAudio(Float32Array)` and emits
 *     'audioOut' events. CallSession wires these to an RtpSession
 *     for the external leg, which decodes/encodes PCMU.
 *
 *   PjsipBackend owns the whole media plane internally. It takes an
 *     `extRtpSocket` + `extPeer` from the caller and bridges RTP
 *     packets directly (no decode/re-encode). CallSession should NOT
 *     wire receiveAudio/audioOut for this backend.
 *
 * This is exposed via the `mode` property: 'pcm' (native) or
 * 'b2bua' (PjsipBackend). CallSession uses this to pick the right
 * wiring.
 *
 * ─── Lifecycle ───────────────────────────────────────────────────
 *
 *   new PjsipBackend(opts)
 *     └─► validates inputs, creates state
 *
 *   start() / await startAsync()
 *     └─► spawns QEMU
 *     └─► awaits TCP-chardev accept (tunnel connection from guest)
 *     └─► creates UdpTcpTunnel, binds SIP/RTP/RTCP UDP sockets on host
 *     └─► probes PJSIP with OPTIONS until it responds (readiness)
 *         READY
 *
 *   activate({ extRtpSocket, extPeer })
 *     └─► creates SipUacInternal, invites in-VM PJSIP
 *     └─► on 200 OK: creates RtpBridge and starts forwarding
 *     └─► emits 'connected' with negotiated media info
 *         CONFIRMED
 *
 *   hangup() / stop()
 *     └─► if CONFIRMED: SipUacInternal.hangup() (BYE → 200)
 *     └─► stops RtpBridge
 *     └─► tears down tunnel, UAC, VM
 */

const { EventEmitter } = require('events');
const { spawn }        = require('child_process');
const dgram            = require('dgram');
const net              = require('net');
const fs               = require('fs');
const path             = require('path');

const { UdpTcpTunnel }   = require('../tunnel/UdpTcpTunnel');
const { SipUacInternal } = require('../sip/SipUacInternal');
const { VmRegistrar }    = require('../sip/VmRegistrar');
const { RtpBridge }      = require('../rtp/RtpBridge');
const { makeLogger, isLevelEnabled } = require('../logger');
const wire               = require('../../vm/qemu-runner/wire');
const { parseResultLine, RATE_TO_PROTOCOL } =
                           require('./at-result-line');

const log = makeLogger('PjsipBackend');

const DEFAULT_READINESS_TIMEOUT_MS = 25000;   /* pjsua warm-up cap */
const DEFAULT_PROBE_INTERVAL_MS    = 1500;

/* Small async delay used between sequential AT commands in
 * activate(). slmodemd processes the PTY serially and benefits
 * from a short gap between commands to finalize each one before
 * the next arrives. Single in-flight buffer; arrivals after this one wait. */
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* Map wire protocol type byte → human name for instrumentation
 * summaries. Uses the wire module's own TYPE table as source of
 * truth. Unknown types get rendered as hex so new/unrecognized
 * types still show up in logs rather than silently disappearing. */
function _wireTypeName(t) {
  for (const [name, val] of Object.entries(wire.TYPE)) {
    if (val === t) return name;
  }
  return `type0x${t.toString(16).padStart(2, '0')}`;
}

class PjsipBackend extends EventEmitter {

  /**
   * @param {object} opts
   * @param {string} opts.qemuPath      Path to qemu-system-i386.
   * @param {string} opts.kernelPath    Kernel (bzImage).
   * @param {string} opts.initrdPath    Backend-B rootfs cpio.gz.
   * @param {string} [opts.role='answer']
   * @param {string} [opts.targetUri='sip:modem@127.0.0.1:5090']
   *                                    INVITE target URI. In tests
   *                                    this is pjsip-test-peer's
   *                                    binding (5090). In production
   *                                    with real d-modem, Node's
   *                                    VmRegistrar learns d-modem's
   *                                    ephemeral port from the
   *                                    REGISTER Contact header and
   *                                    PjsipBackend replaces this
   *                                    before activate() fires.
   *                                    SIP URI of the in-VM modem.
   * @param {string} [opts.bootLogPath] Append QEMU stdio here if set.
   * @param {number} [opts.readinessTimeoutMs=25000]
   * @param {number} [opts.memoryMb=256]
   * @param {boolean} [opts.enableControl=false]
   *                                    If true, wire a second virtio-
   *                                    serial chardev ("synthmodem.control")
   *                                    alongside the tunnel. Step 5
   *                                    needs this for modemd-ctrl; the
   *                                    step-4b tests don't. When enabled
   *                                    the accepted TCP socket is exposed
   *                                    as `this.controlSocket` so callers
   *                                    can attach the backend
   *                                    control parser to it.
   * @param {boolean} [opts.skipReadinessProbe=false]
   *                                    If true, startAsync() reaches
   *                                    READY as soon as the chardevs
   *                                    are connected — it doesn't run
   *                                    an OPTIONS probe against PJSIP.
   *                                    Used in step-5b AT tests where
   *                                    d-modem's PJSIP binds an
   *                                    ephemeral port we can't OPTIONS
   *                                    at a fixed URI (step 5c handles
   *                                    port discovery via registrar).
   * @param {boolean} [opts.useRegistrar=false]
   *                                    If true, spin up a VmRegistrar
   *                                    on the tunnel's SIP channel and
   *                                    use the learned Contact binding
   *                                    as the INVITE target URI. This
   *                                    is the production path for
   *                                    real d-modem: Node accepts
   *                                    d-modem's REGISTER, learns its
   *                                    ephemeral PJSIP port, and uses
   *                                    that instead of a fixed URI.
   *                                    Mutually exclusive with an
   *                                    OPTIONS probe — if
   *                                    useRegistrar=true we gate
   *                                    readiness on first REGISTER,
   *                                    not OPTIONS ping.
   */
  constructor(opts = {}) {
    super();
    if (!opts.qemuPath || !opts.kernelPath || !opts.initrdPath) {
      throw new Error('PjsipBackend: qemuPath, kernelPath, initrdPath required');
    }
    for (const p of [opts.qemuPath, opts.kernelPath, opts.initrdPath]) {
      /* Only validate existence for paths that look absolute; qemu
       * may come from PATH as a bare name. */
      if ((p.includes('/') || p.includes('\\')) && !fs.existsSync(p)) {
        throw new Error(`PjsipBackend: missing file ${p}`);
      }
    }

    this.qemuPath     = opts.qemuPath;
    this.kernelPath   = opts.kernelPath;
    this.initrdPath   = opts.initrdPath;
    this.role         = opts.role          || 'answer';
    this.targetUri    = opts.targetUri     || 'sip:modem@127.0.0.1:5090';
    this.bootLogPath  = opts.bootLogPath   || null;
    this.memoryMb     = opts.memoryMb      || 256;
    this.readinessTimeoutMs = opts.readinessTimeoutMs ||
                              DEFAULT_READINESS_TIMEOUT_MS;
    this.enableControl      = opts.enableControl === true;
    this.skipReadinessProbe = opts.skipReadinessProbe === true;
    this.useRegistrar       = opts.useRegistrar === true;

    /* atInit: ordered list of AT commands to send on the modem PTY
     * AFTER RING is observed and BEFORE ATA. Shapes the modem's
     * behavior for the incoming call (modulation selection via
     * AT+MS, error correction AT\Nn, compression AT%Cn, etc).
     * Driven from `config.modem['slmodemd-pjsip'].atInit`. An array
     * of strings; each is sent as its own AT command with a small
     * inter-command gap. Empty array / unset = no init, just ATA. */
    this.atInit = Array.isArray(opts.atInit) ? opts.atInit.slice() : [];

    /* Expose the backend mode marker so CallSession can branch. */
    this.mode = 'b2bua';

    /* Runtime state */
    this.state = 'IDLE';
    /* IDLE → SPAWNING → TCP_WAIT → PROBING → READY → ACTIVATING →
     * CONFIRMED → STOPPED */

    this._vmChild       = null;
    this._vmFailedReject = null;   /* set while startAsync is in-flight;
                                      rejected by child error/exit to
                                      fail startAsync fast */
    this._tunnelServer  = null;   /* TCP listener for tunnel chardev     */
    this._controlServer = null;   /* TCP listener for control chardev    */
    this._tcpSocket     = null;   /* accepted TCP socket (tunnel chardev) */
    this.controlSocket  = null;   /* accepted TCP socket (control chardev);
                                    public so callers (tests) can also
                                    attach their own parsers — our internal
                                    wire.Parser coexists peacefully. */
    this._tunnel        = null;   /* UdpTcpTunnel                         */
    this._uacSock       = null;   /* UDP socket for SipUacInternal        */
    this._uac        = null;
    this._registrar  = null;   /* VmRegistrar (only when useRegistrar) */
    this._extSocket  = null;   /* externally-provided; caller owns lifetime */
    this._extPeer    = null;
    this._intRtpSock = null;   /* our own internal-leg RTP socket */
    this._bridge     = null;

    /* Control-channel state.
     *
     * Populated when enableControl=true and the VM's modemd-ctrl
     * connects. The parser emits wire frames; _onCtrlFrame dispatches
     * HELLO/AT_RESPONSE/DATA_RX to their respective handlers. */
    this._ctrlParser      = null;   /* wire.Parser for controlSocket */
    this._ptyLineBuf      = '';     /* accumulator for AT_RESPONSE text */
    this._ptyUnterminatedTimer = null; /* debounce for bare-word result codes
                                          that arrived without a \r\n
                                          terminator — see _onPtyText */
    this._connected       = false;  /* has CONNECT been seen? */
    this._currentBps      = 0;      /* CONNECT rate, informational */
    this._currentProtocol = null;   /* e.g. 'V32bis' */

    /* ─── Control-chardev instrumentation ──────────────────────────
     * Diagnostic counters for debugging the "CONNECT arrives 128s
     * late" issue. Record every raw byte delivery on controlSocket
     * and every wire frame dispatched, with timestamps. A periodic
     * timer logs deltas every 2s so we can see in the npm-start
     * output whether bytes arrived in real time or burst-late.
     * All of this is inert until _startCtrlInstrumentation() runs
     * (called at the same point as _setupControlParser). */
    this._ctrlRawBytesTotal   = 0;
    this._ctrlRawBytesLastLog = 0;
    this._ctrlLastChunkAt     = 0;   /* ms since epoch of last data event */
    this._ctrlFramesByType    = Object.create(null); /* {type: count}   */
    this._ctrlFramesLastLog   = Object.create(null); /* for deltas       */
    this._ctrlInstrumentTimer = null;

    this._startPromise = null;
  }

  /* ─── Public interface ──────────────────────────────────────── */

  /**
   * Boot VM, stand up tunnel, readiness-check PJSIP.
   */
  async startAsync() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._startInternal().catch(err => {
      log.error(`startAsync failed: ${err.message}`);
      this.emit('error', err);
      throw err;
    });
    return this._startPromise;
  }

  /** Fire-and-forget form. */
  start() {
    this.startAsync();
  }

  /**
   * Place the internal SIP INVITE and set up RTP bridging. Call
   * only after startAsync() resolves.
   *
   * @param {object} opts
   * @param {dgram.Socket} opts.extRtpSocket  Caller's external-leg
   *     RTP socket. Bound, unencumbered — we attach a 'message'
   *     listener for bridging; caller should not also consume the
   *     socket themselves while activate is in effect.
   * @param {{address,port}} [opts.extPeer]   Optional initial caller
   *     RTP peer. If omitted, bridge learns it from the first
   *     received packet.
   *
   * Emits 'media-ready' with { remoteRtpAddr, remoteRtpPort, codec }
   * once INVITE succeeds and the RTP bridge is wired. This is
   * distinct from 'connected' (which fires later, when the modem
   * handshake completes and the PTY emits a CONNECT line). Most
   * callers don't need 'media-ready' because the returned promise
   * already resolves with the same info; it's kept for symmetry
   * with existing tests that race a 'once' listener against the
   * promise.
   */
  async activate({ extRtpSocket, extPeer } = {}) {
    if (this.state !== 'READY') {
      throw new Error(`PjsipBackend.activate: bad state ${this.state}`);
    }
    if (!extRtpSocket) {
      throw new Error('PjsipBackend.activate: extRtpSocket required');
    }
    this._extSocket = extRtpSocket;
    this._extPeer   = extPeer || null;
    const extSockAddr = extRtpSocket.address ? extRtpSocket.address() : null;
    log.info(
      `activate: extSocket=${extSockAddr ? extSockAddr.address+':'+extSockAddr.port : '?'}, ` +
      `extPeer=${this._extPeer ? this._extPeer.address+':'+this._extPeer.port : 'learning'}`);
    this._transition('ACTIVATING');

    /* Create the internal-leg RTP socket. Bind ephemeral; the
     * tunnel's UDP peer learning will pick up our source port when
     * we send the first packet. */
    this._intRtpSock = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      this._intRtpSock.once('error', reject);
      this._intRtpSock.bind(0, '127.0.0.1', () => {
        this._intRtpSock.removeListener('error', reject);
        resolve();
      });
    });

    const intLocalPort = this._intRtpSock.address().port;
    log.info(`int RTP socket bound ephemeral: 127.0.0.1:${intLocalPort}`);

    /* The SDP offer advertises our internal-leg port as the one
     * PJSIP should send RTP to. Since PJSIP is inside the VM and
     * talks through the tunnel, what it actually sees as "our"
     * RTP address is 127.0.0.1:10000 (where the VM-side tunnel
     * delivers frames). But that's a PJSIP-side concern — from
     * the SDP's point of view, the port we advertise is what we
     * want PJSIP to send RTP to on its side. And since the tunnel
     * delivers host→VM frames to the dst_port in the frame header,
     * we need PJSIP to end up sending RTP to our host-side
     * `UdpTcpTunnel.hostPorts.rtp` (10002 by default), which means
     * we advertise **10002 in the SDP**, not our internal-leg
     * socket's local port. Our internal-leg socket just needs to
     * start "sending through" port 10002 so the tunnel's learned-
     * peer logic picks us up for the return path.
     *
     * Clearer phrasing: PJSIP's SDP offer-answer thinks the remote
     * RTP endpoint is at 127.0.0.1:10002 (our side of the tunnel).
     * The tunnel relays to/from the Node world. On the Node side,
     * UdpTcpTunnel terminates 10002 and bridges to whichever
     * ephemeral socket has "learned in." */
    const advertisedRtpPort = '10000';

    this._uac = new SipUacInternal({
      udpSocket:    this._uacSock,
      peerAddress:  '127.0.0.1',
      peerPort:     this._tunnel.hostPorts.sip,
      localAddress: '127.0.0.1',
      targetUri:    this.targetUri,
    });
    this._uac.on('ended', info => {
      /* Peer-initiated BYE. Treat as remote hangup. */
      log.info(`peer hangup (${info.initiator})`);
      this.emit('silenceHangup');   /* reuse the existing event */
    });
    this._uac.on('error', err => this.emit('error', err));

    /* Answer flow (role='answer' only):
     *
     *   1. We TX INVITE from Node's UAC to the tunnel.
     *   2. In the VM, PJSIP (d-modem) receives INVITE, sends 100
     *      Trying, fires `on_incoming_call`.
     *   3. d-modem notifies slmodemd; slmodemd prints "RING" to the
     *      PTY. modemd-ctrl forwards that to Node as an AT_RESPONSE
     *      frame.
     *   4. Node sees "RING" and sends ATA.
     *   5. slmodemd tells d-modem to answer; d-modem sends 200 OK.
     *   6. Our UAC's invite() promise resolves.
     *
     * The RING→ATA race (vs. sending ATA blindly after INVITE TX)
     * is critical. If ATA arrives BEFORE d-modem's on_incoming_call
     * fires, slmodemd answers a call that doesn't exist yet; d-modem
     * later receives the INVITE and tries to RING a modem that's
     * already off-hook — deadlock. Waiting for RING guarantees
     * PJSIP has fully ingested the INVITE and d-modem is in the
     * incoming-call state.
     *
     * Timeout safety net: if no RING arrives within 3s, send ATA
     * anyway as a fallback. This covers cases where the modem is
     * configured with auto-answer (S0=1) and the RING was
     * processed before we could see it.
     *
     * atInit handling: before ATA, run each string in `this.atInit`
     * as its own AT command with a 50ms inter-command gap. Matches
     * the same activate() ordering used previously. Shapes the modem for the
     * incoming call (AT+MS for modulation, AT\Nn for EC, etc.).
     * Errors on individual commands are logged but don't abort the
     * sequence — some slmodemd builds emit ERROR on command forms
     * that still had the intended side effect, and we'd rather try
     * ATA than give up.
     */
    const answerSequence = async (triggerReason) => {
      if (this.role !== 'answer') return;
      for (const cmd of this.atInit) {
        if (typeof cmd !== 'string' || cmd.length === 0) {
          log.warn(`atInit entry ignored (expected non-empty string): ${JSON.stringify(cmd)}`);
          continue;
        }
        log.info(`atInit → ${cmd}`);
        try { this.sendAt(cmd); }
        catch (e) { log.warn(`sendAt('${cmd}') failed: ${e.message}`); }
        await _sleep(50);
      }
      log.info(`activate → ATA (${triggerReason})`);
      try { this.sendAt('ATA'); }
      catch (e) { log.warn(`sendAt('ATA') failed: ${e.message}`); }
    };

    let ringSeen = false;
    const onAtForRing = (text) => {
      if (!ringSeen && /\bRING\b/.test(text)) {
        ringSeen = true;
        this.off('at-response', onAtForRing);
        /* Fire and forget — answerSequence runs asynchronously
         * (atInit has inter-command sleeps). The INVITE await
         * below still races against it via the 10s invite
         * timeout, which is plenty of time for a 3-5 cmd atInit
         * at 50ms each. */
        answerSequence('RING observed').catch(err =>
          log.warn(`answerSequence failed: ${err.message}`));
      }
    };
    this.on('at-response', onAtForRing);

    let ringFallback = null;
    if (this.role === 'answer' && this.controlSocket) {
      ringFallback = setTimeout(() => {
        if (ringSeen) return;
        log.warn('RING-fallback timeout (modem may still be coming up)');
        this.off('at-response', onAtForRing);
        answerSequence('RING-fallback timeout').catch(err =>
          log.warn(`answerSequence failed: ${err.message}`));
      }, 3000);
    }

    let negotiated;
    try {
      negotiated = await this._uac.invite({
        localRtpPort: advertisedRtpPort,
        offerCodecs: [
          { payloadType: 0, name: 'PCMU', clockRate: 8000 },
        ],
        timeoutMs: 10000,
      });
    } finally {
      /* Detach listeners/timers regardless of invite outcome. */
      this.off('at-response', onAtForRing);
      if (ringFallback) clearTimeout(ringFallback);
    }
    log.info(`invite OK: remote RTP=${negotiated.remoteRtpAddr}:${negotiated.remoteRtpPort} codec=${JSON.stringify(negotiated.codec)}`);

    /* Start RTP bridge. The internal-leg socket sends to the
     * tunnel's RTP UDP port (10002); the tunnel's learned-peer
     * logic on the host side picks up our ephemeral source port
     * on the first outgoing packet so return traffic lands back
     * at us. */
    this._bridge = new RtpBridge({
      extSocket: this._extSocket,
      intSocket: this._intRtpSock,
      extPeer:   this._extPeer,
      intPeer:   { address: '127.0.0.1', port: this._tunnel.hostPorts.rtp },
    });
    this._bridge.start();

    /* Send a single zero-payload UDP packet so the tunnel's host-
     * side UDP-peer learning records our ephemeral port for the
     * return path. RTP implementations tolerate 0-byte packets
     * (they're treated as nothing) but the tunnel's learn-from-
     * first-packet logic fires regardless of payload.
     *
     * Note: this is a stop-gap. If and when we have real external-
     * leg RTP flowing, the bridge will send it onward naturally
     * and this kickstart becomes redundant — but it's cheap
     * insurance for the no-ext-traffic case (e.g. step-4b test). */
    this._intRtpSock.send(Buffer.alloc(0), this._tunnel.hostPorts.rtp, '127.0.0.1');

    this._transition('CONFIRMED');
    /* Emit 'media-ready' when the INVITE succeeds and RTP bridge
     * is wired. This is NOT the same as the modem-handshake
     * 'connected' event (which fires later on PTY CONNECT). Kept
     * under a distinct name so CallSession can listen on
     * 'connected' for handshake completion without ambiguity. */
    this.emit('media-ready', negotiated);
  }

  /**
   * Shut down the dialog and the VM. Idempotent.
   */
  async stop() {
    if (this.state === 'STOPPED' || this.state === 'IDLE') return;
    this._transition('STOPPED');

    /* Stop the periodic control-chardev instrumentation timer. */
    this._stopCtrlInstrumentation();

    /* Cancel any pending unterminated-line flush. */
    this._cancelUnterminatedFlush();

    /* Stop registrar (if any) early so late REGISTER refreshes don't
     * fire events during teardown. */
    if (this._registrar) {
      try { this._registrar.stop(); } catch (_) {}
      this._registrar = null;
    }

    /* Stop RTP bridge before UAC teardown so we don't try to
     * forward late RTP after the peer hangs up. */
    if (this._bridge) {
      try { this._bridge.stop(); } catch (_) {}
      this._bridge = null;
    }

    if (this._uac) {
      try {
        if (this._uac.state === 'CONFIRMED') {
          await this._uac.hangup({ timeoutMs: 3000 });
        }
      } catch (err) {
        log.debug(`hangup during stop: ${err.message}`);
      }
      try { this._uac.close(); } catch (_) {}
      this._uac = null;
    }

    /* Close our own sockets. Ext socket is caller-owned. */
    if (this._intRtpSock) {
      try { this._intRtpSock.close(); } catch (_) {}
      this._intRtpSock = null;
    }
    if (this._uacSock) {
      try { this._uacSock.close(); } catch (_) {}
      this._uacSock = null;
    }

    if (this._tunnel) {
      try {
        if (this._tunnel.tcpSocket) this._tunnel.tcpSocket.destroy();
        await this._tunnel.stop();
      } catch (_) {}
      this._tunnel = null;
    }

    if (this.controlSocket) {
      try { this.controlSocket.destroy(); } catch (_) {}
      this.controlSocket = null;
    }

    if (this._tunnelServer) {
      try { this._tunnelServer.close(); } catch (_) {}
      this._tunnelServer = null;
    }
    if (this._controlServer) {
      try { this._controlServer.close(); } catch (_) {}
      this._controlServer = null;
    }

    if (this._vmChild) {
      try { this._vmChild.kill('SIGKILL'); } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
      this._vmChild = null;
    }

    /* Drop the startAsync failure-propagation hook (if still set).
     * Late child errors firing after stop() should just no-op
     * rather than trying to reject a promise nobody's awaiting. */
    this._vmFailedReject = null;
  }

  /* ─── Internals ─────────────────────────────────────────────── */

  async _startInternal() {
    this._transition('SPAWNING');

    /* Bring up TCP listener(s) BEFORE spawning QEMU so it can connect
     * as a client. We always listen for the tunnel chardev; if the
     * control chardev is enabled, we listen for that too (on a second
     * port so QEMU can pair them via separate -chardev args). */
    const tunnelListener = await this._startChardevListener('tunnel');
    this._tunnelServer = tunnelListener.tcpServer;

    let controlListener = null;
    if (this.enableControl) {
      controlListener = await this._startChardevListener('control');
      this._controlServer = controlListener.tcpServer;
    }

    /* Spawn QEMU pointed at whatever listener ports we have. */
    this._spawnQemu({
      tunnelPort: tunnelListener.port,
      controlPort: controlListener ? controlListener.port : null,
    });
    this._transition('TCP_WAIT');

    /* Once QEMU is spawned, any failure (spawn ENOENT, immediate
     * exit, etc.) surfaces as a 'vmFailed' rejection. We race every
     * subsequent await against it so a dead VM doesn't just hang
     * us until the pool's warmup timeout fires.
     *
     * Resolves only when the backend reaches STOPPED cleanly; any
     * error emission from _spawnQemu's handlers rejects it. The
     * listener is cleared in stop() so we don't leak it. */
    this._vmFailedPromise = new Promise((_, reject) => {
      this._vmFailedReject = reject;
    });
    /* Silence unhandled-rejection in case we resolve cleanly later
     * without anyone awaiting this. Pair with the final cleanup
     * in stop() that clears _vmFailedReject. */
    this._vmFailedPromise.catch(() => {});

    /* Await the guest's chardev connections in parallel. The ordering
     * in which QEMU dials them is unspecified, so we await both.
     * Also race against _vmFailedPromise so a spawn failure
     * short-circuits instead of hanging on socketPromise. */
    const awaits = [tunnelListener.socketPromise];
    if (controlListener) awaits.push(controlListener.socketPromise);
    const sockets = await Promise.race([
      Promise.all(awaits),
      this._vmFailedPromise,
    ]);
    this._tcpSocket = sockets[0];
    if (controlListener) this.controlSocket = sockets[1];

    /* Stop accepting further connections on both listeners. */
    try { this._tunnelServer.close(); } catch (_) {}
    this._tunnelServer = null;
    if (this._controlServer) {
      try { this._controlServer.close(); } catch (_) {}
      this._controlServer = null;
    }

    /* Bring up the tunnel. Attach the socket directly rather than
     * calling _tunnel.start() (which would open its own TCP).
     * vmSipPort matches the port in targetUri — used as dst_port
     * in frames going VM-ward before peer learning completes.
     * Once d-modem (or pjsip-test-peer) replies, modemd-tunnel
     * learns its source and subsequent sends go there. */
    const targetPort = this._parseTargetPort(this.targetUri);
    this._tunnel = new UdpTcpTunnel({
      tcp: { host: '127.0.0.1', port: 1 },   /* placeholder */
      vmSipPort: targetPort,
    });
    this._tunnel.tcpSocket = this._tcpSocket;
    this._tcpSocket.on('data', chunk => this._tunnel._onTcpData(chunk));
    this._tcpSocket.on('close', () => {
      if (this.state !== 'STOPPED') {
        this.emit('error', new Error('tunnel chardev closed unexpectedly'));
      }
    });

    /* Control socket: set up our internal wire-parser to emit
     * `connected`/`data`/`silenceHangup`. Also attach a close-watch.
     * External callers (tests) can still attach their own parsers
     * to `this.controlSocket` via the public field — EventEmitter
     * dispatches to all listeners so ours and theirs coexist.
     *
     * We parse AT_RESPONSE text for CONNECT / NO CARRIER / BUSY
     * using shared helpers (parseResultLine + RATE_TO_PROTOCOL from
     * src/backends/at-result-line.js) so CallSession sees an event
     * surface CallSession expects from a backend with `mode: 'b2bua'`. */
    if (this.controlSocket) {
      this._setupControlParser();
      this.controlSocket.on('close', () => {
        if (this.state !== 'STOPPED') {
          this.emit('error', new Error('control chardev closed unexpectedly'));
        }
      });
    }

    await this._bindTunnelUdp();

    /* Create the UAC socket now (separate from tunnel-UDP sockets).
     * SipUacInternal sends from this socket to the tunnel's SIP port. */
    this._uacSock = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      this._uacSock.once('error', reject);
      this._uacSock.bind(0, '127.0.0.1', () => {
        this._uacSock.removeListener('error', reject);
        resolve();
      });
    });

    /* Readiness gate. Three paths:
     *
     *   1. useRegistrar=true (production with real d-modem). Spin up
     *      a VmRegistrar on our tunnel; wait for d-modem's REGISTER.
     *      On success, update targetUri to the learned Contact.
     *   2. skipReadinessProbe=true (step-5b AT tests). Go READY as
     *      soon as the tunnel is wired, without any SIP activity.
     *   3. Default (step-3/4 pjsip-test-peer tests). OPTIONS probe
     *      against the fixed targetUri.
     */
    if (this.useRegistrar) {
      this._transition('PROBING');
      this._registrar = new VmRegistrar({ tunnel: this._tunnel });
      this._registrar.start();
      this._registrar.on('error', err =>
        log.error(`registrar error: ${err.message}`));
      log.info('waiting for REGISTER from in-VM PJSIP (d-modem)...');
      const binding = await this._registrar.waitForRegistration(
        this.readinessTimeoutMs);
      /* Update targetUri to point at the learned binding. This is
       * what SipUacInternal will use when activate() fires. */
      const newTarget = binding.contactUri;
      log.info(`REGISTER received; targetUri updated: ${this.targetUri} → ${newTarget}`);
      this.targetUri = newTarget;
    } else if (!this.skipReadinessProbe) {
      this._transition('PROBING');
      await this._probePjsip();
    } else {
      log.info('readiness probe skipped (skipReadinessProbe=true)');
    }

    /* startAsync is complete; clear the fail-fast reject hook so
     * later child errors (which DO happen normally on stop) don't
     * try to reject a startAsync promise nobody awaits anymore. */
    this._vmFailedReject = null;

    this._transition('READY');
  }

  /**
   * Stand up a TCP listener on an ephemeral port. Returns the listen
   * port and a promise that resolves with the first accepted socket
   * (one accept; further connections aren't expected).
   *
   * @param {string} label  Just for error messages.
   */
  _startChardevListener(label) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      let resolved = false;
      let socketResolve, socketReject;
      const socketPromise = new Promise((res, rej) => {
        socketResolve = res; socketReject = rej;
      });
      const timer = setTimeout(() => {
        if (!resolved) socketReject(new Error(
          `VM did not connect to ${label} chardev within 30s`));
      }, 30000);
      srv.once('connection', s => {
        resolved = true;
        clearTimeout(timer);
        /* Disable Nagle on the accepted chardev socket. Modem control-channel
         * (SlmodemVM's transport layer) does the same thing —
         * small writes must flush promptly across virtio-serial
         * so responses like "\r\nCONNECT\r\n" don't sit in a TCP
         * buffer for minutes waiting for more data to coalesce.
         * Pairs with `nodelay=on` on QEMU's -chardev socket spec
         * below so both endpoints are Nagle-free. */
        try { s.setNoDelay(true); } catch (_) {}
        socketResolve(s);
      });
      srv.once('error', err => { if (!resolved) reject(err); });
      srv.listen(0, '127.0.0.1', () => {
        resolve({ port: srv.address().port, tcpServer: srv, socketPromise });
      });
    });
  }

  _spawnQemu({ tunnelPort, controlPort }) {
    const args = [
      '-M', 'pc', '-m', String(this.memoryMb), '-nographic',
      '-kernel', this.kernelPath, '-initrd', this.initrdPath,
      '-append', 'console=ttyS0 panic=-1 loglevel=3',
      '-no-reboot', '-accel', 'tcg',
      '-device', 'virtio-serial-pci,id=virtio-serial0',
      /* nodelay=on disables Nagle on QEMU's side of the chardev
       * TCP socket. Without this, small writes (like a single
       * "\r\nCONNECT\r\n" after ~2 minutes of quiet data-mode
       * traffic on the ctrl chardev) can sit in QEMU's TCP send
       * buffer until some other write forces a flush. Symptom
       * was a ~128s delay between slmodemd emitting CONNECT and
       * Node observing it. Pairs with setNoDelay(true) on the
       * Node-accepted socket in _startChardevListener. */
      '-chardev', `socket,id=tunnel,host=127.0.0.1,port=${tunnelPort},server=off,nodelay=on`,
      '-device', 'virtserialport,chardev=tunnel,name=synthmodem.tunnel',
    ];
    if (controlPort != null) {
      args.push(
        '-chardev', `socket,id=control,host=127.0.0.1,port=${controlPort},server=off,nodelay=on`,
        '-device', 'virtserialport,chardev=control,name=synthmodem.control',
      );
    }
    const child = spawn(this.qemuPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    /* Attach 'error' listener immediately — spawn failures (ENOENT
     * when qemuPath is wrong, EACCES, etc.) emit synchronously on
     * the child before any of our other wiring has a chance to
     * run. Without this listener the default Node behavior is to
     * throw, crashing the whole process. We want to surface it as
     * a backend error so the pool can report it cleanly.
     *
     * Also reject _vmFailedPromise so startAsync's in-flight awaits
     * short-circuit instead of hanging until the warmup timeout. */
    child.on('error', err => {
      log.error(`QEMU spawn failed (qemuPath=${this.qemuPath}): ${err.message}`);
      const wrapped = new Error(
        `Failed to spawn QEMU at '${this.qemuPath}': ${err.message}`);
      if (this._vmFailedReject) this._vmFailedReject(wrapped);
      if (this.state !== 'STOPPED') {
        this.emit('error', wrapped);
      }
    });

    if (this.bootLogPath) {
      const logFile = fs.createWriteStream(this.bootLogPath, { flags: 'a' });
      child.stdout.pipe(logFile);
      child.stderr.pipe(logFile);
    } else {
      /* Drain stdout/stderr to nowhere so we don't fill the pipe
       * buffer and deadlock QEMU. */
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
    }
    child.on('exit', (code, signal) => {
      if (this.state !== 'STOPPED') {
        const err = new Error(`VM exited: ${code}/${signal}`);
        log.warn(`QEMU exited unexpectedly: code=${code} signal=${signal}`);
        /* Reject startAsync's awaits (pre-READY) in addition to
         * emitting — otherwise startAsync hangs on socketPromise. */
        if (this._vmFailedReject) this._vmFailedReject(err);
        this.emit('error', err);
      }
    });
    this._vmChild = child;
  }

  async _bindTunnelUdp() {
    /* UdpTcpTunnel.start() binds its UDP sockets in a single call;
     * we skipped start() to take control of the TCP side, so drive
     * the bindings by hand. Private-method access is a coupling
     * compromise documented in UdpTcpTunnel's source — both modules
     * are in the same module family. */
    await this._tunnel._bindUdp('sip',  this._tunnel.hostPorts.sip);
    await this._tunnel._bindUdp('rtp',  this._tunnel.hostPorts.rtp);
    await this._tunnel._bindUdp('rtcp', this._tunnel.hostPorts.rtcp);
  }

  async _probePjsip() {
    /* Ephemeral UAC just for probing — don't reuse the main UAC
     * because probe() is idempotent but our main UAC will be set up
     * freshly in activate(). */
    const probeUac = new SipUacInternal({
      udpSocket:    this._uacSock,
      peerAddress:  '127.0.0.1',
      peerPort:     this._tunnel.hostPorts.sip,
      localAddress: '127.0.0.1',
      targetUri:    this.targetUri,
    });
    const deadline = Date.now() + this.readinessTimeoutMs;
    try {
      while (Date.now() < deadline) {
        try {
          await probeUac.probe({ timeoutMs: DEFAULT_PROBE_INTERVAL_MS });
          return;
        } catch (_) { /* retry */ }
      }
      throw new Error(
        `PJSIP did not respond to OPTIONS within ${this.readinessTimeoutMs}ms`);
    } finally {
      /* Remove probeUac's socket listener so it doesn't compete
       * with the main UAC's listener. */
      probeUac.close();
    }
  }

  _transition(newState) {
    const prev = this.state;
    this.state = newState;
    log.debug(`${prev} → ${newState}`);
  }

  /**
   * Extract the numeric port from a SIP URI like
   * 'sip:modem@127.0.0.1:5090'. Falls back to 5060 if the URI has no
   * explicit port (standard SIP default, even though it doesn't
   * match our production-VS-test binding; this is a last-resort
   * fallback for partially-formed URIs, not the expected path).
   */
  _parseTargetPort(uri) {
    const m = /^sip:[^@]*@[^:]+:(\d+)/i.exec(uri || '');
    return m ? parseInt(m[1], 10) : 5060;
  }

  /* ─── Control-channel (modemd-ctrl) parsing ─────────────────────── */

  /**
   * Attach a wire.Parser to `this.controlSocket` and route frames
   * through `_onCtrlFrame`. Safe to co-exist with a caller's own
   * parser — EventEmitter delivers 'data' events to every listener.
   */
  _setupControlParser() {
    this._ctrlParser = new wire.Parser();
    this._ctrlParser.on('frame', f => this._onCtrlFrame(f));
    this._ctrlParser.on('error', err => {
      log.warn(`wire.Parser error on control socket: ${err.message}`);
    });
    this.controlSocket.on('data', chunk => {
      /* --- instrumentation: raw byte delivery ---
       * Count bytes as they arrive at the TCP socket, BEFORE wire
       * framing. Gated behind debug log level because the periodic
       * summary is very noisy at steady state (one INFO line every
       * 2s for the entire VM lifetime). The gap-burst hexdump would
       * still be useful at lower levels, but it was primarily added
       * to chase the unterminated-CONNECT bug which is now handled
       * by _maybeScheduleUnterminatedFlush. Keeping the entire
       * instrument as a single debug-gated block keeps the wire
       * path quiet in production and keeps the diagnostic available
       * when needed. */
      if (isLevelEnabled('debug')) {
        const now = Date.now();
        const gapMs = this._ctrlLastChunkAt
          ? (now - this._ctrlLastChunkAt) : 0;
        this._ctrlLastChunkAt  = now;
        this._ctrlRawBytesTotal += chunk.length;
        if (gapMs > 5000) {
          const preview = chunk.slice(0, Math.min(32, chunk.length))
            .toString('hex').match(/../g).join(' ');
          const ascii = chunk.slice(0, Math.min(32, chunk.length))
            .toString('utf8')
            .replace(/[^\x20-\x7e]/g, '.');
          log.debug(
            `[ctrl-instrument] chunk after ${Math.round(gapMs/1000)}s gap: ` +
            `${chunk.length} bytes, first=[${preview}] ascii="${ascii}"`);
        }
      }

      try { this._ctrlParser.feed(chunk); }
      catch (e) {
        log.error(`control wire parse failed: ${e.message}`);
      }
    });

    /* Kick off the periodic summary timer ONLY at debug log level.
     * At info/warn/error levels the timer never starts, so there's
     * no 2s-interval work being done at all. */
    if (isLevelEnabled('debug')) {
      this._startCtrlInstrumentation();
    }
  }

  /**
   * Start the periodic summary logger for control-chardev activity.
   * Idempotent — can be called multiple times without stacking
   * timers. Cancel with _stopCtrlInstrumentation().
   */
  _startCtrlInstrumentation() {
    if (this._ctrlInstrumentTimer) return;
    this._ctrlInstrumentTimer = setInterval(() => {
      const nowTotal = this._ctrlRawBytesTotal;
      const deltaBytes = nowTotal - this._ctrlRawBytesLastLog;
      this._ctrlRawBytesLastLog = nowTotal;

      /* Frame type deltas */
      const typeParts = [];
      for (const [t, count] of Object.entries(this._ctrlFramesByType)) {
        const prev = this._ctrlFramesLastLog[t] || 0;
        const d = count - prev;
        if (d > 0) typeParts.push(`${t}+${d}`);
        this._ctrlFramesLastLog[t] = count;
      }

      const sinceLastChunk = this._ctrlLastChunkAt
        ? Math.round((Date.now() - this._ctrlLastChunkAt) / 1000) + 's'
        : 'never';

      /* Parser accumulator depth — if bytes are arriving but no
       * frames emit, this would grow. Helps distinguish
       * "bytes flowing, parser stuck" from "bytes not arriving". */
      const parserBuf = this._ctrlParser && this._ctrlParser._buf
        ? this._ctrlParser._buf.length : 0;

      /* Only log when something's changed OR when the silence is
       * notable (>5s since last chunk AND we're past initial
       * bring-up). Otherwise too chatty at steady state. Uses
       * debug level — when log level is info/warn/error the timer
       * itself doesn't start, but if something ever reached this
       * code path at lower levels, log.debug would still suppress
       * correctly. */
      if (deltaBytes > 0 || typeParts.length > 0) {
        log.debug(
          `[ctrl-instrument] +${deltaBytes}B, frames=[${typeParts.join(',') || 'none'}], ` +
          `totalBytes=${nowTotal}, parserBuf=${parserBuf}B, sinceLastChunk=${sinceLastChunk}`);
      } else if (this._ctrlLastChunkAt && (Date.now() - this._ctrlLastChunkAt) > 5000) {
        log.debug(
          `[ctrl-instrument] SILENT +0B, sinceLastChunk=${sinceLastChunk}, ` +
          `totalBytes=${nowTotal}, parserBuf=${parserBuf}B`);
      }
    }, 2000);
    this._ctrlInstrumentTimer.unref?.();
  }

  _stopCtrlInstrumentation() {
    if (this._ctrlInstrumentTimer) {
      clearInterval(this._ctrlInstrumentTimer);
      this._ctrlInstrumentTimer = null;
    }
  }

  _onCtrlFrame(frame) {
    /* --- instrumentation: count each frame by wire type so the
     * periodic summary can report (e.g.) "AT_RESPONSE+3 DATA_RX+127".
     * Human-readable name mapping done here (not in summary) so
     * unknown/new types show up as "type0xNN" rather than vanish. */
    const typeName = _wireTypeName(frame.type);
    this._ctrlFramesByType[typeName] =
      (this._ctrlFramesByType[typeName] || 0) + 1;

    switch (frame.type) {
      case wire.TYPE.HELLO: {
        /* Informational; modemd-ctrl announces itself on connect.
         * Emitted as a 'hello' event so callers (tests, callsession)
         * can observe control-channel readiness. */
        const msg = frame.payload.toString('utf8');
        log.info(`control HELLO: ${msg}`);
        this.emit('hello', msg);
        break;
      }

      case wire.TYPE.AT_RESPONSE:
        this._onPtyText(frame.payload.toString('utf8'));
        break;

      case wire.TYPE.DATA_RX:
        /* Data-mode bytes from slmodemd via modemd-ctrl. Pass through
         * to CallSession which routes them to TelnetProxy. */
        this.emit('data', frame.payload);
        break;

      case wire.TYPE.MODEM_STATUS: {
        /* Structured state events from modemd-ctrl. Payload is JSON
         * (same convention as the deprecated modemd-shim once used). Today's
         * production modemd-ctrl does NOT emit MODEM_STATUS frames,
         * but a planned rebuild will add CONNECT-with-rate and
         * NO CARRIER status events so Node gets reliable programmatic
         * state regardless of PTY read-splitting. Handling the frame
         * type now means the next modemd-ctrl.bin can light this up
         * without any further Node changes.
         *
         * First-wins semantics: if the PTY-
         * text path (_handleResultLine) already fired 'connected',
         * we ignore a late status 'connect' — de-dup is the same
         * _connected flag. The reverse is true too. Benefit in
         * the backend-B case: when the PTY read splits CONNECT from
         * its \r\n and the bare "CONNECT" flush fires with rate=0,
         * a subsequent MODEM_STATUS frame can still carry the real
         * rate. We update _currentBps/_currentProtocol and log the
         * rate, but do NOT re-emit 'connected' (that's the de-dup).
         */
        let ev = null;
        try { ev = JSON.parse(frame.payload.toString('utf8')); }
        catch (_) { /* malformed — log and drop */ }
        if (!ev || typeof ev !== 'object') {
          log.debug('control MODEM_STATUS: unparseable payload');
          break;
        }
        log.debug(`control MODEM_STATUS: ${JSON.stringify(ev)}`);

        if (ev.event === 'connect') {
          const rate = Number.isInteger(ev.rate) ? ev.rate : 0;
          if (!this._connected) {
            /* First-wins: status arrived before PTY text (or PTY
             * text never fired). Drive the full connect sequence. */
            this._connected = true;
            this._currentBps      = rate;
            this._currentProtocol = RATE_TO_PROTOCOL[rate] || 'unknown';
            log.info(`CONNECT${rate ? ' ' + rate : ''} (via modem status)${this._currentProtocol !== 'unknown' ? ' — ' + this._currentProtocol : ''}`);
            this.emit('connected', {
              protocol: this._currentProtocol,
              bps:      this._currentBps,
              instance: this,
            });
          } else if (rate && !this._currentBps) {
            /* PTY-text path fired first but couldn't extract rate
             * (classic case: bare "CONNECT" after ptyline
             * defensive flush). Fill in the rate now for log
             * completeness. No re-emit — consumers already got
             * their 'connected' event. */
            this._currentBps      = rate;
            this._currentProtocol = RATE_TO_PROTOCOL[rate] || 'unknown';
            log.info(`CONNECT rate completed from modem status: ${rate}${this._currentProtocol !== 'unknown' ? ' — ' + this._currentProtocol : ''}`);
          }
          /* If already connected WITH a rate, ignore — status
           * arrived late with no new info. */
        }
        /* Other ev.event values (e.g. 'nocarrier') deferred until
         * the VM side actually emits them — historically the synthmodem stack only
         * uses status for 'connect'. Extend here when needed. */
        break;
      }

      case wire.TYPE.HANGUP:
        /* Explicit hangup notification from modemd-ctrl (e.g. if the
         * PTY closes). Treated the same as silence hangup by
         * CallSession. */
        log.info('control HANGUP from modemd-ctrl');
        if (this._connected) {
          this._connected = false;
          this.emit('silenceHangup');
        }
        break;

      default:
        /* Ignore — DUMP_*, AUDIO, SILENCE aren't relevant on the
         * control channel (audio flows through the tunnel's RTP
         * channel, not the control chardev). */
        log.debug(`control frame type ${frame.type} ignored`);
        break;
    }
  }

  /**
   * Accumulate AT_RESPONSE text and scan for complete lines; parse
   * each line for result codes (CONNECT / NO CARRIER / etc.) and
   * drive the backend's connected/silenceHangup state.
   *
   * AT response line parser. Lifted
   * into PjsipBackend rather than shared-class because the two
   * backends have different state surfaces (Clock Pump, etc.) even
   * though the AT-line parsing is identical.
   */
  _onPtyText(text) {
    /* Emit the raw text for observers that want to see unparsed AT
     * output (tests, diagnostic consumers). CallSession doesn't use
     * this — it reacts to 'connected' / 'silenceHangup' / 'data'. */
    this.emit('at-response', text);

    this._ptyLineBuf += text;
    if (this._ptyLineBuf.length > 8192) {
      /* Bound the accumulator; a pathological modem shouldn't OOM us. */
      this._ptyLineBuf = this._ptyLineBuf.slice(-4096);
    }
    let idx;
    while ((idx = this._ptyLineBuf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this._ptyLineBuf.slice(0, idx);
      const rest = this._ptyLineBuf.slice(idx);
      const termLen = rest.startsWith('\r\n') ? 2 : 1;
      this._ptyLineBuf = rest.slice(termLen);
      if (!line) continue;
      this._handleResultLine(line);
    }

    /* Defensive recovery: the normal loop above only fires when the
     * buffer contains an explicit \r or \n. But the VM-side framing
     * splits PTY reads by syscall boundary, not by line boundary, so
     * a result code like "CONNECT" can arrive in one AT_RESPONSE
     * frame and its "\r\n" can arrive in the NEXT frame — and if
     * modemd-ctrl has by then flipped into data_mode (because its
     * pty_scan_for_transitions saw "CONNECT" in pty_tail), the "\r\n"
     * will come through tagged as DATA_RX instead of AT_RESPONSE,
     * and _onPtyText never sees it. Result: the CONNECT event is
     * stuck in the buffer until some UNRELATED later AT_RESPONSE
     * carries a terminator — which might be many minutes later, if
     * ever. Observed in production as a ~140s delay between
     * slmodemd emitting CONNECT and Node firing the 'connected'
     * event, with the entire data-mode session elapsing in between.
     *
     * Workaround: if the residual (unterminated) buffer, trimmed,
     * exactly parses as a known result code, schedule a short
     * debounced flush. If more bytes arrive before the debounce
     * fires (including the "\r\n" via a terminated path), the normal
     * loop will consume it first and clear the buffer, cancelling
     * the debounce. This keeps behavior byte-exact for the common
     * terminated case and only kicks in when we're genuinely stuck.
     *
     * The proper fix is VM-side: modemd-ctrl should
     * hold off flipping data_mode until after the terminator has
     * also been emitted. That's tracked separately. This is a
     * belt-and-suspenders safety net that runs without a VM
     * rebuild. */
    this._maybeScheduleUnterminatedFlush();
  }

  /**
   * If `_ptyLineBuf` is non-empty AND its trimmed content matches a
   * known result code on its own, arm a short debounce timer to
   * flush it as a line. Any subsequent call that successfully
   * consumes the buffer via the terminator path will naturally
   * cancel the timer (buffer is empty → condition fails →
   * _cancelUnterminatedFlush runs).
   */
  _maybeScheduleUnterminatedFlush() {
    /* If we already have a pending timer and the buffer still looks
     * like an unterminated result code, leave it running. If it now
     * looks different (e.g. more bytes arrived that don't parse
     * alone), reset. */
    const trimmed = this._ptyLineBuf.replace(/[\r\n]+$/, '').trim();
    const looksLikeResult = trimmed.length > 0 &&
                            parseResultLine(trimmed) !== null;

    if (!looksLikeResult) {
      /* Buffer doesn't look like a parseable result code. Cancel
       * any pending flush — either buffer was cleared by the line
       * loop or it grew into something we shouldn't speculatively
       * flush. */
      this._cancelUnterminatedFlush();
      return;
    }

    /* Already armed? Reset so the debounce restarts from now. This
     * means repeated arrivals of the same trailing-byte stream will
     * keep pushing the flush out — appropriate, because a real
     * terminator might still be in flight. */
    this._cancelUnterminatedFlush();
    this._ptyUnterminatedTimer = setTimeout(() => {
      this._ptyUnterminatedTimer = null;
      /* Re-check under the timer — buffer might have been consumed
       * between scheduling and firing. */
      const t = this._ptyLineBuf.replace(/[\r\n]+$/, '').trim();
      if (t.length === 0) return;
      const res = parseResultLine(t);
      if (!res) return;
      log.warn(
        `[PjsipBackend] flushing unterminated result code from buffer ` +
        `after 150ms quiescence: ${JSON.stringify(t)} ` +
        `(this indicates the VM shim split CONNECT/NO CARRIER from its ` +
        `\\r\\n terminator across wire frames; VM fix pending)`);
      /* Consume the entire buffer — this matches what the line loop
       * would have done had the terminator arrived. */
      this._ptyLineBuf = '';
      this._handleResultLine(t);
    }, 150);
    /* Allow Node to exit cleanly if this is the only pending work. */
    this._ptyUnterminatedTimer.unref?.();
  }

  _cancelUnterminatedFlush() {
    if (this._ptyUnterminatedTimer) {
      clearTimeout(this._ptyUnterminatedTimer);
      this._ptyUnterminatedTimer = null;
    }
  }

  _handleResultLine(line) {
    const res = parseResultLine(line);
    if (!res) return;
    switch (res.event) {
      case 'connect': {
        if (this._connected) return;  /* de-dup echoed CONNECTs */
        const rate = res.rate;
        this._connected = true;
        this._currentBps      = rate;
        this._currentProtocol = RATE_TO_PROTOCOL[rate] || 'unknown';
        log.info(`CONNECT${rate ? ' ' + rate : ''}${this._currentProtocol !== 'unknown' ? ' — ' + this._currentProtocol : ''}`);
        this.emit('connected', {
          protocol: this._currentProtocol,
          bps:      this._currentBps,
          instance: this,
        });
        break;
      }
      case 'nocarrier':
      case 'busy':
      case 'nodialtone':
        if (this._connected) {
          log.info(`Connection ended: ${res.event.toUpperCase()}`);
          this._connected = false;
          this._currentBps = 0;
          this._currentProtocol = null;
        } else {
          log.info(`Handshake failed: ${res.event.toUpperCase()}`);
        }
        this.emit('silenceHangup');
        break;
      case 'error':
        /* Benign AT-level errors; don't tear down. Later CONNECT/
         * NO CARRIER decides. */
        log.debug(`AT ERROR: ${line}`);
        break;
      /* 'ring' ignored — auto-answer via ATS0 in the VM handles it. */
    }
  }

  /**
   * Send AT command text to the in-VM modem via modemd-ctrl.
   * Used by CallSession during activate() to send e.g. ATE0 or
   * AT&K0 before ATA. The command is framed as a wire AT frame,
   * which modemd-ctrl in the VM unwraps and writes to the PTY
   * (with appropriate CR termination).
   *
   * @param {string} cmd  AT command, without CR
   */
  sendAt(cmd) {
    if (!this.controlSocket) {
      throw new Error('sendAt: control channel not enabled');
    }
    const frame = wire.encode(wire.TYPE.AT, cmd);
    this.controlSocket.write(frame);
  }

  /**
   * Send data-mode bytes to the in-VM modem. No-op before
   * 'connected' (so
   * CallSession's TelnetProxy can write freely without worrying
   * about timing races).
   *
   * @param {Buffer} buf  data-mode bytes
   */
  write(buf) {
    if (!this._connected) {
      log.trace('write() before connected — dropping');
      return;
    }
    if (!this.controlSocket) {
      log.warn('write() but control channel disabled');
      return;
    }
    const frame = wire.encode(wire.TYPE.DATA_TX, buf);
    this.controlSocket.write(frame);
  }
}

module.exports = { PjsipBackend };
