'use strict';

/**
 * CallSession
 *
 * The single owner of one active call.
 * Wires together:
 *   SipDialog  → knows who called and the SIP state
 *   RtpSession → bidirectional audio over UDP
 *   ModemDSP   → modem handshake and data codec
 *   TelnetProxy → terminal UI and TCP proxy
 *
 * Lifecycle:
 *   1. Created by SipServer when INVITE arrives
 *   2. Allocates RTP port, calls sipServer.answerCall()
 *   3. On ACK: starts DSP
 *   4. On ModemDSP 'connected': attaches TelnetProxy
 *   5. On BYE / silence hangup: tears everything down
 *
 * Optional: per-call audio capture (WAV files) when config.modem.captureAudio
 * is true. Writes one _rx.wav and one _tx.wav per call to
 * config.modem.captureDir, useful for debugging modem handshakes against
 * real hardware.
 */

const { EventEmitter }          = require('events');
const dgram                     = require('dgram');
const config                    = require('../../config');
const { makeLogger }            = require('../logger');
const { RtpSession, allocateRtpPort, releaseRtpPort } = require('../rtp/RtpSession');
const { TelnetProxy }           = require('../telnet/TelnetProxy');
const { AudioCapture }          = require('../dsp/AudioCapture');

const log = makeLogger('CallSession');

/**
 * Build a DSP backend per config.modem.backend.
 *
 *   'native'         → ModemDSP (in-process, pure-JS modem protocols)
 *   'slmodemd-pjsip' → PjsipBackend (slmodemd + d-modem + PJSIP in VM,
 *                                    external→internal SIP B2BUA).
 *                     Must come from a pool; no inline fallback.
 *
 * Both classes expose the same runtime interface:
 *   .start() / .stop()
 *   .write(Buffer)     (data-mode bytes — no-op before 'connected')
 *   emits: 'connected', 'data', 'silenceHangup', 'error'
 *
 * Native additionally exposes:
 *   .receiveAudio(Float32Array), emits 'audioOut'
 * B2BUA backends additionally expose:
 *   .activate({extRtpSocket, extPeer}), .mode === 'b2bua'
 *
 * For native, if no pool was provided we fall back to constructing a
 * fresh backend inline — still functional, just slower to answer. For
 * slmodemd-pjsip no such fallback exists because PjsipBackend's
 * startup cost is too high to incur per-call (PJSIP init + REGISTER
 * round-trip ~9s). Throws if the pool is misconfigured.
 */
function _buildModemBackendSync() {
  const backend = (config.modem && config.modem.backend) || 'native';
  if (backend === 'slmodemd-pjsip' || backend === 'auto') {
    throw new Error(
      `${backend} backend requires a ModemBackendPool ` +
      '(pass opts.modemPool to CallSession). Cold-booting PjsipBackend ' +
      'per call is not supported. (auto mode also relies on the pool ' +
      'because it starts every call in slmodemd-pjsip b2bua mode.)');
  }
  if (backend === 'native') {
    const { ModemDSP } = require('../dsp/ModemDSP');
    log.info('Modem backend: native (in-process DSP)');
    return new ModemDSP(config.modem.role);
  }
  throw new Error(
    `config.modem.backend must be 'native', 'slmodemd-pjsip', or 'auto'; got: ${backend}`);
}

class CallSession extends EventEmitter {

  /**
   * @param {SipServer} sipServer
   * @param {SipDialog} dialog
   * @param {object} [opts]
   * @param {ModemBackendPool} [opts.modemPool] — if provided AND
   *     config.modem.backend is a pooled VM-backed backend
   *     (slmodemd-pjsip), the backend is checked out from the pool
   *     instead of being constructed inline. On hangup/bye, the
   *     backend is returned to the pool for recycling (fresh VM boot).
   */
  constructor(sipServer, dialog, opts = {}) {
    super();
    this._sip      = sipServer;
    this._dialog   = dialog;

    // Decide RTP playout mode. Modem audio cannot tolerate silence
    // concealment (injected zero samples break DSP PLL lock). There
    // are two modem-safe options:
    //
    //   'immediate'       — no buffer; every packet is emitted as it
    //                       arrives. Minimal latency. No jitter or
    //                       reorder tolerance.
    //
    //   'fixed-buffered'  — D-Modem-style deep queue (default 800ms).
    //                       Absorbs jitter and reorder without ever
    //                       emitting fake samples. High but fixed
    //                       latency; modems don't care.
    //
    // For slmodemd-pjsip we run in 'b2bua' mode and Node is out of
    // the audio path entirely (PJSIP/d-modem owns the RTP session
    // inside the VM), so playoutMode is moot for that backend. For
    // native we honor whatever the config says, including 'immediate'
    // for low-latency local testing.
    const backend = (config.modem && config.modem.backend) || 'native';
    const rtpConfigured = (config.rtp && config.rtp.playoutMode) || 'buffered';
    const playoutMode = rtpConfigured;

    /* Call-session mode. Two distinct operating models:
     *
     *   'pcm'    — RTP → ModemDSP (native backend).
     *              CallSession owns RtpSession, decodes/encodes audio
     *              in-process, wires rtp.audio→dsp.receiveAudio and
     *              dsp.audioOut→rtp.send.
     *
     *   'b2bua'  — RTP flows directly between the external caller and
     *              the in-VM PJSIP (d-modem) via PjsipBackend's
     *              RtpBridge. CallSession owns a raw dgram socket on
     *              the local RTP port (to claim the port for the SDP
     *              answer) and hands it to the backend, which reads
     *              and writes it as-is. No codec work in Node — PJSIP
     *              and d-modem handle media end-to-end.
     *
     *   'auto'   — starts in 'b2bua' (slmodemd-pjsip handles V.8 and
     *              high-rate training). If slmodemd's V.8 negotiation
     *              times out without a CONNECT — the deterministic
     *              pattern produced by vintage non-V.8 callers per
     *              boot logs from 2026-04-30 19:44 — CallSession
     *              SWAPS the backend at runtime: the VM is recycled,
     *              the local RTP socket is adopted by an in-process
     *              RtpSession, and ModemDSP takes over with V.8/ANSam
     *              skipped. Native's legacy automode probe chain
     *              (V.22bis → V.21 → Bell103) handles the rest.
     *              Capture in this mode runs only after the swap.
     *
     * The selection is driven by config.modem.backend. The b2bua-vs-pcm
     * decision is fixed for non-auto backends. For 'auto' it starts as
     * b2bua and may transition to pcm during _swapToNative().
     */
    this._mode = (backend === 'slmodemd-pjsip' || backend === 'auto') ? 'b2bua' : 'pcm';

    /* `auto` mode: track whether we're still in the slmodemd-pjsip
     * phase (eligible to swap on V.8 timeout) or have already
     * succeeded / swapped. Set true on backend 'connected'; if a
     * 'silenceHangup' arrives while still false, we swap. */
    this._everConnected = false;

    /* `auto` mode: while a swap to native is in progress, we don't
     * want a stray 'silenceHangup' or 'error' from the dying PJSIP
     * backend to trigger another teardown. Set during _swapToNative
     * and cleared only by hangup/onBye. */
    this._swapping = false;

    /* Captured at the backend's 'connected' event; passed to
     * TelnetProxy.attach() for banner-placeholder substitution. */
    this._connectInfo = null;

    /* Tracks whether the current `this._dsp` came from the modem pool
     * (PjsipBackend) or was constructed inline (ModemDSP). Required by
     * `auto` mode where a single CallSession may own a pooled backend
     * first and then a native one after the swap. Without this flag
     * _teardownDsp can't tell which path to take.
     *
     * Set true when checked out from the pool; reset false in
     * _swapToNative when a native ModemDSP replaces the pooled backend.
     */
    this._dspIsPooled = false;

    /* Remembered for _swapToNative — RtpSession constructor needs the
     * same playoutMode and traceTxTiming the pcm path would have used. */
    this._playoutMode = playoutMode;

    /* RtpSession is only used in pcm mode. For b2bua, a raw dgram
     * socket is allocated in setup() instead. */
    this._rtp      = (this._mode === 'pcm')
                       ? new RtpSession({
                           playoutMode,
                           traceTxTiming: !!config.modem.traceTxTiming,
                         })
                       : null;
    this._rtpSock  = null;   /* b2bua only: raw dgram socket handed to backend */
    this._pool     = opts.modemPool || null;
    this._dsp      = null;   // set by activate() — may need async checkout
    this._telnet   = new TelnetProxy();
    this._rtpPort  = null;
    this._active   = false;
    this._id       = dialog.callId;
    this._capture  = null;

    /* Per-call audio capture (optional, for debugging). Today only
     * functional for backend === 'native' where Node owns the decoded
     * PCM stream end-to-end. The 'slmodemd-pjsip' branch logs once
     * per call and skips: in B2BUA mode Node only sees raw PCMU bytes
     * passing through RtpBridge, never decoded audio.
     *
     * Future work (Phase 4-5): hook RtpBridge._forward — the single
     * chokepoint where every RTP packet (both directions) passes
     * through Node — and emit per-direction WAVs (PCMU, RFC 7656
     * format code 7) and/or .pcap of RTP datagrams. The hook is
     * small but format/layout choices are deferred until then. */
    if (config.modem.captureAudio && this._mode === 'pcm') {
      try {
        this._capture = new AudioCapture({
          dir: config.modem.captureDir || './captures',
          tag: String(this._id).replace(/[^a-z0-9]/gi, '-'),
        });
        log.info(`[${this._id}] Audio capture enabled`);
        log.debug(`[${this._id}]   RX → ${this._capture.rxPath}`);
        log.debug(`[${this._id}]   TX → ${this._capture.txPath}`);
      } catch (e) {
        log.warn(`[${this._id}] Audio capture setup failed: ${e.message}`);
        this._capture = null;
      }
    } else if (config.modem.captureAudio && this._mode === 'b2bua') {
      log.debug(`[${this._id}] captureAudio requested but ignored in b2bua mode`);
    }
  }

  // ─── Setup ───────────────────────────────────────────────────────────────────

  async setup() {
    log.info(`Setting up call session ${this._id} (mode=${this._mode})`);

    /* Allocate the external RTP port. Both modes need one so we
     * can put it in the SDP answer. In pcm mode we then bind an
     * RtpSession on it; in b2bua mode we bind a raw dgram socket
     * that the backend will consume. */
    this._rtpPort = await allocateRtpPort();

    if (this._mode === 'b2bua') {
      /* Raw socket — no decode, no encode, no jitter buffer.
       * PjsipBackend.activate() attaches a 'message' listener and
       * the RtpBridge shuttles bytes between this socket and the
       * in-VM PJSIP. We deliberately do NOT attach any listener
       * ourselves between now and activate(); any packet arriving
       * in that window is dropped by the kernel (until a listener
       * is added) or simply sits in the socket buffer. That's fine
       * — an external caller sending RTP before we've answered is
       * out-of-spec and we'd discard it anyway.
       *
       * Bind to 0.0.0.0 (i.e. all interfaces), NOT 127.0.0.1 — the
       * external caller is on the LAN and sends RTP to whichever
       * IP we advertised in the SDP answer (typically our LAN
       * address). A loopback-only bind silently drops all those
       * packets at the kernel level. Matches RtpSession (used by
       * the native backend), which also binds 0.0.0.0. */
      this._rtpSock = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => {
        this._rtpSock.once('error', reject);
        this._rtpSock.bind(this._rtpPort, '0.0.0.0', () => {
          this._rtpSock.removeListener('error', reject);
          resolve();
        });
      });
      log.debug(`[${this._id}] raw RTP socket bound 0.0.0.0:${this._rtpPort} (b2bua)`);
    } else {
      await this._rtp.open(this._rtpPort);
      log.debug(`[${this._id}] RTP port ${this._rtpPort} open (pcm)`);

      /* Configure RTP codec from negotiated dialog. B2BUA mode
       * skips this because no codec work happens in Node — PJSIP
       * in the VM handles PCMU/PCMA end-to-end. */
      const codecInfo = this._dialog.negotiatedCodec || config.rtp.preferredCodecs[0];
      this._rtp.setCodec(codecInfo.name, codecInfo.payloadType);
    }

    /* Tell the SIP server to answer with our RTP port. Same call
     * in both modes — answer SDP is decided by SIP-level codec
     * negotiation, not by how we process the audio downstream. */
    this._dialog.localRtpPort = this._rtpPort;
    this._sip.answerCall(this._dialog, this._rtpPort);

    /* Store session on dialog for reference */
    this._dialog.session = this;
  }

  // ─── Activate (called on ACK received) ───────────────────────────────────────
  //
  // Activation is async because acquiring the DSP backend may involve
  // waiting for the ModemBackendPool to complete a warmup (if a call
  // ended very recently and the replacement VM isn't ready yet).
  //
  // The SIP server only waits for answerCall's synchronous response;
  // ACK handling is fire-and-forget from index.js. So activate()
  // being async is fine — we just kick off the work and let it run.

  async activate() {
    if (this._active) return;
    this._active = true;
    log.info(`[${this._id}] Call active — acquiring DSP`);

    /* Acquire the DSP backend. Three paths:
     *
     *   - slmodemd-pjsip (b2bua) + pool → checkout PjsipBackend
     *   - auto                + pool   → checkout PjsipBackend (same
     *                                    initial path; CallSession may
     *                                    swap to native later via
     *                                    _swapToNative if V.8 fails)
     *   - native / no-pool fallback     → construct inline
     *
     * The inline path is rejected for slmodemd-pjsip (and auto) inside
     * _buildModemBackendSync — cold-booting PjsipBackend per call costs
     * ~9 seconds of PJSIP init + REGISTER, which blows past any
     * reasonable SIP ACK window.
     */
    const backendCfg = (config.modem && config.modem.backend) || 'native';
    const usesPool   = (backendCfg === 'slmodemd-pjsip' || backendCfg === 'auto');
    try {
      if (this._pool && usesPool) {
        this._dsp = await this._pool.checkout();
        this._dspIsPooled = true;
        log.info(`[${this._id}] Modem backend: ${backendCfg} (pool checkout)`);
      } else {
        this._dsp = _buildModemBackendSync();
        this._dspIsPooled = false;
      }
    } catch (err) {
      log.error(`[${this._id}] Failed to acquire DSP: ${err.message}`);
      this.hangup('backend-acquire-error');
      return;
    }

    if (config.logging.logDspState) {
      this._dsp.on('connected', info => {
        log.info(`[${this._id}] Modem connected: ${info.protocol} @ ${info.bps} bps`);
      });
    }

    /* Audio-plane wiring is mode-specific.
     *
     *   pcm:   RtpSession ↔ ModemDSP, Node does the PCM conversion
     *          and packetization.
     *   b2bua: hand the raw external socket + learned peer to
     *          PjsipBackend; it wires its own RtpBridge between our
     *          raw socket and the internal-leg RTP. Node is out of
     *          the audio path entirely.
     *
     * Both modes listen for 'connected' (handshake complete),
     * 'silenceHangup', and 'error' on the backend. b2bua omits the
     * audio event wiring.
     */
    if (this._mode === 'b2bua') {
      /* PjsipBackend expects the external RTP socket to be bound
       * and unencumbered. this._rtpSock was set up in setup(). It
       * must not have any 'message' listener attached — the bridge
       * installs its own. */
      const extPeer = (this._dialog.remoteRtpAddr && this._dialog.remoteRtpPort)
        ? { address: this._dialog.remoteRtpAddr,
            port:    this._dialog.remoteRtpPort }
        : undefined;
      /* activate() is async and awaits INVITE→200 OK→ACK with the
       * in-VM PJSIP, then starts the RTP bridge. Run it but don't
       * block the rest of CallSession setup on its completion —
       * the backend emits 'connected' when the modem handshake
       * completes, which is what CallSession actually cares about. */
      Promise.resolve(
        this._dsp.activate({ extRtpSocket: this._rtpSock, extPeer })
      ).catch(err => {
        log.error(`[${this._id}] b2bua activate failed: ${err.message}`);
        this.hangup('activate-error');
      });
    } else {
      /* PCM mode: point RTP at remote, wire audio events. */
      this._rtp.setRemote(this._dialog.remoteRtpAddr, this._dialog.remoteRtpPort);

      /* Wire RTP → DSP (inbound audio). Capture RX audio if enabled.
       * Guard: with the fixed-buffered jitter mode, the RTP session
       * may still have queued packets that drain after teardown
       * (this._dsp set to null in hangup). Silently ignore those
       * late emissions — they're ~800ms of stale audio nobody wants. */
      this._rtp.on('audio', samples => {
        if (this._capture) {
          try { this._capture.writeRx(samples); } catch (e) { /* ignore */ }
        }
        if (!this._dsp) return;
        try { this._dsp.receiveAudio(samples); } catch (_) { /* racing teardown */ }
      });

      /* Wire DSP → RTP (outbound audio). Capture TX audio if enabled. */
      this._dsp.on('audioOut', samples => {
        if (this._capture) {
          try { this._capture.writeTx(samples); } catch (e) { /* ignore */ }
        }
        this._rtp.send(samples);
      });
    }

    /* Common event wiring (both modes). */

    /* When modem connects, attach telnet proxy. PjsipBackend emits
     * 'connected' when modemd-ctrl forwards CONNECT via the control
     * chardev; native ModemDSP emits it when handshake completes.
     *
     * Also flips `_everConnected` so an `auto`-mode silenceHangup
     * arriving AFTER a successful connection is treated as a real
     * disconnect (not a swap trigger). */
    this._dsp.on('connected', info => {
      this._everConnected = true;
      this._connectInfo   = info || null;
      this._onModemConnected();
    });

    /* Silence hangup.
     *
     * Default behaviour: tear down the call.
     *
     * `auto` mode override: if the backend is the pooled PjsipBackend
     * AND we never reached 'connected', this `silenceHangup` is the
     * deterministic V.8-CM-timeout pattern from a vintage non-V.8
     * caller. Don't tear down — swap to the native backend and let
     * the legacy automode probe chain handle the caller. The boot
     * logs from 2026-04-30 19:44-19:46 confirmed this pattern is
     * 100% reproducible at ~12 s after ATA, regardless of caller
     * protocol (V.22bis, V.22, V.21, Bell103). */
    this._dsp.on('silenceHangup', () => {
      if (this._swapping) {
        /* A late event from the dying PJSIP backend after the swap
         * has already started. Ignore — the swap path owns
         * teardown of the old backend. */
        return;
      }
      if (backendCfg === 'auto' && this._dspIsPooled && !this._everConnected) {
        log.info(`[${this._id}] auto: PJSIP V.8 timed out without CONNECT — swapping to native`);
        this._swapToNative().catch(err => {
          log.error(`[${this._id}] swap to native failed: ${err.message}`);
          this.hangup('swap-failed');
        });
        return;
      }
      log.info(`[${this._id}] Silence hangup`);
      this.hangup('silence');
    });

    /* Backend errors (VM boot failure, QEMU crash, native DSP
     * assert, etc.) must not crash the process. Log and hang up.
     * In `auto` mode during a swap, errors from the dying backend
     * are swallowed — the swap path owns the recycle. */
    this._dsp.on('error', err => {
      if (this._swapping) return;
      log.error(`[${this._id}] Modem backend error: ${err.message}`);
      this.hangup('backend-error');
    });

    /* Start modem DSP.
     *
     *   native:   begins V.8 / answer tone via HandshakeEngine.
     *   b2bua (PjsipBackend): no-op; already started at pool-warm
     *             time. Activate was already kicked off above.
     */
    this._dsp.start();

    /* For split-lifecycle backends, activate() is a separate async
     * step. PjsipBackend is split-lifecycle but we already called
     * activate() above in the b2bua branch (it needs args). Only
     * call it here for non-b2bua split-lifecycle backends. */
    if (this._mode !== 'b2bua' && typeof this._dsp.activate === 'function') {
      Promise.resolve(this._dsp.activate()).catch(err => {
        log.error(`[${this._id}] DSP activate failed: ${err.message}`);
        this.hangup('activate-error');
      });
    }
  }

  /**
   * `auto` backend: swap from the pooled PjsipBackend to a fresh
   * in-process ModemDSP. Triggered when slmodemd-pjsip times out
   * waiting for a V.8 CM (deterministic ~12 s after ATA per the
   * 2026-04-30 boot logs), which means the caller is vintage and
   * doesn't speak V.8.
   *
   * Sequencing notes:
   *   - PjsipBackend's RtpBridge.stop() (via pool.recycle) detaches
   *     its 'message' listener but leaves _rtpSock alive (documented
   *     RtpBridge behaviour). RtpSession then adopts that same socket
   *     without rebinding.
   *   - The new ModemDSP starts with skipV8/skipAnsam — the caller
   *     just heard 12 s of ANSam from PJSIP and is in V.25 "answer-
   *     tone-heard, awaiting training" state. Native's legacy
   *     automode probe chain handles the rest.
   *   - Hangup-during-swap is guarded by `_swapping` (suppresses
   *     stray events from the dying backend) and by re-checking
   *     `_active` between steps (a hangup() during the await would
   *     flip it false; we abort cleanly).
   *   - Audio capture for the b2bua phase isn't supported today, so
   *     `_capture` is null on entry. We lazy-init it here so the
   *     post-swap (pcm) phase IS captured. The resulting WAV starts
   *     at the swap point — the b2bua phase is missing — which is
   *     documented in config.js.
   */
  async _swapToNative() {
    if (this._swapping) return;            // shouldn't happen, but be defensive
    if (!this._active) return;             // hangup beat us to it
    this._swapping = true;

    const oldDsp = this._dsp;
    /* Detach our listeners on the dying backend so any final events
     * during pool.recycle() don't fire user-visible side effects.
     * (Errors during recycle still surface via the pool's 'error'
     * event, which is wired in index.js.) */
    if (oldDsp && typeof oldDsp.removeAllListeners === 'function') {
      oldDsp.removeAllListeners('connected');
      oldDsp.removeAllListeners('silenceHangup');
      oldDsp.removeAllListeners('error');
      oldDsp.removeAllListeners('data');
    }

    /* Hand the dying PJSIP backend back to the pool. The pool calls
     * stop() on it, which stops its RtpBridge (removes the 'message'
     * listener from _rtpSock without closing the socket) and tears
     * down the VM. Replacement warmup runs in the background.
     *
     * After this returns, _rtpSock is alive, listener-free, ready
     * for RtpSession.adoptSocket(). */
    if (this._dspIsPooled && this._pool) {
      try {
        this._pool.recycle(oldDsp);
      } catch (err) {
        log.warn(`[${this._id}] swap: pool.recycle threw: ${err.message}`);
      }
    } else {
      // Defensive: should never happen, but if for some reason the
      // pooled invariant doesn't hold, just stop the backend.
      try { if (oldDsp && oldDsp.stop) oldDsp.stop(); } catch (_) {}
    }
    this._dsp = null;
    this._dspIsPooled = false;

    if (!this._active) {
      // Hangup landed during the (small but non-zero) recycle await.
      // Don't continue building a new backend that nobody will use.
      this._swapping = false;
      return;
    }

    /* Switch the audio plane to pcm mode. */
    this._mode = 'pcm';

    /* Construct a fresh RtpSession and have it adopt the raw socket
     * that PjsipBackend's RtpBridge just released. _rtpSock came
     * from setup() and was never closed; transfer ownership to the
     * RtpSession (which will close it on _rtp.close() during normal
     * teardown). */
    const { RtpSession } = require('../rtp/RtpSession');
    this._rtp = new RtpSession({
      playoutMode:   this._playoutMode,
      traceTxTiming: !!config.modem.traceTxTiming,
    });
    this._rtp.adoptSocket(this._rtpSock);
    this._rtpSock = null;   // RtpSession owns it now

    /* Codec & remote endpoint from the SIP dialog (set during INVITE,
     * stable across the swap). */
    const codecInfo = this._dialog.negotiatedCodec || config.rtp.preferredCodecs[0];
    this._rtp.setCodec(codecInfo.name, codecInfo.payloadType);
    this._rtp.setRemote(this._dialog.remoteRtpAddr, this._dialog.remoteRtpPort);

    /* Lazy-init audio capture for the post-swap (pcm) portion. The
     * b2bua phase before the swap is not captured — documented as a
     * known gap in config.js. */
    if (config.modem.captureAudio && !this._capture) {
      try {
        this._capture = new AudioCapture({
          dir: config.modem.captureDir || './captures',
          tag: String(this._id).replace(/[^a-z0-9]/gi, '-'),
        });
        log.info(`[${this._id}] auto: post-swap audio capture enabled`);
        log.debug(`[${this._id}]   RX → ${this._capture.rxPath}`);
        log.debug(`[${this._id}]   TX → ${this._capture.txPath}`);
      } catch (e) {
        log.warn(`[${this._id}] swap: audio capture setup failed: ${e.message}`);
        this._capture = null;
      }
    }

    /* Construct the native ModemDSP. */
    const { ModemDSP } = require('../dsp/ModemDSP');
    this._dsp = new ModemDSP(config.modem.role);
    this._dspIsPooled = false;

    /* Wire the RTP↔DSP audio plane (mirror of activate()'s pcm branch). */
    this._rtp.on('audio', samples => {
      if (this._capture) {
        try { this._capture.writeRx(samples); } catch (e) { /* ignore */ }
      }
      if (!this._dsp) return;
      try { this._dsp.receiveAudio(samples); } catch (_) { /* racing teardown */ }
    });
    this._dsp.on('audioOut', samples => {
      if (this._capture) {
        try { this._capture.writeTx(samples); } catch (e) { /* ignore */ }
      }
      this._rtp.send(samples);
    });

    /* Wire the post-swap event handlers using the REGULAR (non-auto)
     * semantics: connected → attach telnet, silenceHangup → tear
     * down, error → tear down. There's no second swap available.
     * Note: we also keep _everConnected updates correct, which makes
     * any pathological swap-during-swap impossible. */
    this._dsp.on('connected', info => {
      this._everConnected = true;
      this._connectInfo   = info || null;
      this._onModemConnected();
    });
    this._dsp.on('silenceHangup', () => {
      log.info(`[${this._id}] Silence hangup (post-swap)`);
      this.hangup('silence');
    });
    this._dsp.on('error', err => {
      log.error(`[${this._id}] Modem backend error (post-swap): ${err.message}`);
      this.hangup('backend-error');
    });
    /* Forward modem data — PjsipBackend mirrors this through its
     * control chardev; native ModemDSP emits 'data' from
     * HandshakeEngine. _onModemConnected attaches the TelnetProxy
     * which consumes 'data' there. */

    /* Start the new DSP in fall-through mode: skip V.8 (caller has
     * already failed slmodemd's V.8) and skip ANSam (caller already
     * heard 12 s of it). HandshakeEngine jumps straight to the
     * V.25 legacy automode probe chain. */
    this._dsp.start({ skipV8: true, skipAnsam: true });

    log.info(`[${this._id}] auto: swap complete — native backend running, legacy probe chain active`);
    this._swapping = false;
  }

  // ─── Modem data path ─────────────────────────────────────────────────────────

  _onModemConnected() {
    log.info(`[${this._id}] Modem handshake complete — holding post-train idle`);

    // Post-training "V.42 Penalty Box" — after V.22 training completes,
    // most modern modems spend some seconds transmitting V.42 ODP trying
    // to negotiate LAPM error correction. synthmodem doesn't implement
    // V.42, so we must wait that window out without sending any payload
    // bytes (which would corrupt the caller's descrambler and cause it
    // to refuse DCD) and without routing the descrambled ODP garbage to
    // TelnetProxy (the menu would interpret the bytes as hostnames).
    //
    // Strategy: two-phase wait.
    //
    //   Phase 1 — MINIMUM HOLD: wait config.modem.native.postTrainIdleMs
    //   (default 6000 ms) unconditionally. This covers the V.22
    //   §6.3.1.2.2 tail and the typical V.42 T400 timers observed in
    //   consumer modems (4-6 s). Smaller values (3-4 s) caused some
    //   modems to drop the call when banner bytes arrived mid-V.42.
    //
    //   Phase 2 — QUIESCENCE WAIT: after the minimum hold, keep the
    //   TelnetProxy detached as long as RX bytes keep arriving. When the
    //   byte stream goes quiet for QUIESCENCE_MS (caller has finished
    //   V.42 and dropped into mark idle, which our binding suppresses
    //   as 0xFF), attach the TelnetProxy. Hard cap at ATTACH_MAX_MS from
    //   training-complete to avoid waiting forever on pathological modems.
    //
    // During both phases, RX bytes are counted for quiescence tracking
    // but NOT routed anywhere — they're silently discarded.
    const nativeCfg     = config.modem.native || {};
    const holdMs        = (nativeCfg.postTrainIdleMs        ?? 3000);
    const quiescenceMs  = (nativeCfg.postTrainQuiescenceMs  ?? 500);
    const attachMaxMs   = (nativeCfg.postTrainAttachMaxMs   ?? 10000);

    log.debug(`[${this._id}] Post-train hold: minimum ${holdMs}ms, then wait ${quiescenceMs}ms quiescence (cap ${attachMaxMs}ms)`);

    const startedAt = Date.now();
    let lastByteAt  = startedAt;
    let droppedCount = 0;
    let minHoldElapsed = false;
    let attached = false;

    // Temporary RX sink — counts bytes for quiescence tracking but
    // discards them.
    const rxSink = (buf) => {
      if (attached) return;          // real path is active now
      lastByteAt = Date.now();
      droppedCount += buf.length;
    };
    this._dsp.on('data', rxSink);

    const attach = (reason) => {
      if (attached || !this._active) return;
      attached = true;
      this._dsp.off('data', rxSink);
      const waited = Date.now() - startedAt;
      log.info(`[${this._id}] Post-train hold complete — attaching TelnetProxy (${reason}, waited ${waited}ms, dropped ${droppedCount} bytes)`);

      // DSP data → TelnetProxy — bytes from here onwards are real user input.
      this._dsp.on('data', buf => this._telnet.receive(buf));

      // TelnetProxy output → DSP. Guard against the call having been
      // torn down (this._dsp cleared in hangup) before this callback
      // fires — async flows like DNS lookups and TCP errors can
      // stringify-then-send a response many seconds after the user has
      // hung up. Silently dropping the write is the right thing; the
      // socket is gone and so is the modem DSP channel.
      this._telnet.attach(buf => {
        if (!this._dsp) return;
        try { this._dsp.write(buf); } catch (_) { /* racing teardown */ }
      }, this._connectInfo);

      // TelnetProxy requests disconnect.
      this._telnet.on('disconnect', () => {
        log.info(`[${this._id}] User disconnected via terminal`);
        this.hangup('user');
      });
    };

    // Phase 1: min hold timer.
    setTimeout(() => {
      if (!this._active) return;
      minHoldElapsed = true;
      // If there's been no byte activity during the min hold at all, we
      // can attach right away — nothing in flight.
      if (Date.now() - lastByteAt >= quiescenceMs) {
        attach('quiet from start');
      }
    }, holdMs);

    // Phase 2: periodic quiescence check.
    const tick = setInterval(() => {
      if (!this._active || attached) {
        clearInterval(tick);
        return;
      }
      const now = Date.now();
      if (now - startedAt >= attachMaxMs) {
        clearInterval(tick);
        attach('attach_max reached');
        return;
      }
      if (minHoldElapsed && now - lastByteAt >= quiescenceMs) {
        clearInterval(tick);
        attach('quiescence');
      }
    }, 100);
  }

  // ─── Hangup ───────────────────────────────────────────────────────────────────

  /**
   * Tear down the call. Synchronous returns void; the actual
   * teardown runs asynchronously through `_finalizeTeardown`.
   *
   * Ordering note for callers that want to observe completion: the
   * 'ended' event may fire SYNCHRONOUSLY within this call if the
   * teardown chain has no real awaited I/O (e.g. stub backends in
   * tests, b2bua mode with a pool whose `recycle()` is sync).
   * Attach your listener BEFORE calling hangup() if you intend to
   * await 'ended':
   *
   *     const p = new Promise(r => session.once('ended', r));
   *     session.hangup();
   *     await p;
   *
   * Attaching the listener after hangup() may miss the event.
   */
  hangup(reason = 'normal') {
    if (!this._active) return;
    this._active = false;
    log.info(`[${this._id}] Hanging up (reason: ${reason})`);

    this._telnet.disconnect();

    /* Send BYE now (doesn't depend on DSP/VM state), then run the
     * async teardown path which captures dumps before tearing
     * down. */
    if (this._dialog.canBye()) {
      this._sip.sendBye(this._dialog);
    }

    /* Fire-and-forget — all callers treat hangup() as synchronous
     * void. Errors inside are logged, not propagated. */
    this._finalizeTeardown(reason);
  }

  // ─── BYE received from remote ─────────────────────────────────────────────────

  onBye() {
    log.info(`[${this._id}] BYE received`);
    this._active = false;
    this._telnet.disconnect();
    this._finalizeTeardown('bye');
  }

  /**
   * Common async teardown path for both hangup() and onBye().
   *
   *   1. Tear down the DSP (backend.stop or pool.recycle).
   *   2. Close the RTP port.
   *   3. Close the WAV capture.
   *   4. Emit 'ended'.
   *
   * Any failure in any step is logged but doesn't stop the rest of
   * cleanup from happening — a broken VM shouldn't prevent releasing
   * the RTP port or emitting 'ended'.
   *
   * @param {string} reason
   * @private
   */
  async _finalizeTeardown(reason) {
    /* Step 1: DSP teardown. This is where pool.recycle() / dsp.stop()
     * runs, which kills the VM. For b2bua mode this is where
     * PjsipBackend detaches its 'message' listener from our raw
     * socket, so it's safe to close the socket in step 2. */
    this._teardownDsp();

    /* Step 2: audio-plane cleanup. Mode-specific.
     *
     *   pcm:   close RtpSession (stops its socket, flushes queue).
     *   b2bua: close the raw dgram socket we handed to the backend.
     *          The backend's RtpBridge was stopped in _teardownDsp
     *          above, so detaching the listener has already happened
     *          and close() is safe. */
    if (this._mode === 'b2bua') {
      if (this._rtpSock) {
        try { this._rtpSock.close(); } catch (e) { /* ignore */ }
        this._rtpSock = null;
      }
    } else {
      try {
        this._rtp.close();
      } catch (e) { /* ignore */ }
    }
    if (this._rtpPort) {
      releaseRtpPort(this._rtpPort);
      this._rtpPort = null;
    }

    /* Step 3: close WAV capture if any. Captures the post-swap
     * portion in `auto` mode (b2bua phase isn't captured). pcm
     * always captures from the start. b2bua-only never has one. */
    this._closeCapture();

    /* Step 4: ended. */
    this.emit('ended', { callId: this._id, reason });
  }

  /**
   * Tear down the DSP backend. Two paths:
   *
   *   1. Backend came from ModemBackendPool (slmodemd-pjsip, or
   *      auto in its pre-swap b2bua phase): call pool.recycle().
   *      The pool is responsible for stopping the backend and
   *      starting a fresh replacement VM in the background.
   *
   *   2. Backend was constructed inline (native, or auto post-swap):
   *      just call stop().
   *
   * Decision is made by `_dspIsPooled` rather than re-reading
   * config.modem.backend, because in `auto` mode the same call may
   * own a pooled backend at first and a native one later.
   *
   * Also guards against _dsp being null (hangup called before
   * activate() or after a failed checkout).
   * @private
   */
  _teardownDsp() {
    if (!this._dsp) return;
    const dsp = this._dsp;
    this._dsp = null;

    if (this._pool && this._dspIsPooled) {
      /* Pool handles stop() internally and kicks off the replacement
       * warmup. Fire-and-forget; errors surface via pool 'error'
       * event. */
      try {
        this._pool.recycle(dsp);
      } catch (err) {
        log.warn(`[${this._id}] pool.recycle threw: ${err.message}`);
      }
    } else {
      try {
        const p = dsp.stop();
        if (p && typeof p.catch === 'function') {
          p.catch(err => log.debug(`[${this._id}] dsp.stop() rejected: ${err.message}`));
        }
      } catch (err) {
        log.debug(`[${this._id}] dsp.stop() threw: ${err.message}`);
      }
    }
    this._dspIsPooled = false;
  }

  _closeCapture() {
    if (!this._capture) return;
    try {
      // If TX timing trace was enabled, dump it alongside the wav
      // captures using the same basename. Format is a tab-separated
      // text file readable by tools/analyze-tx-timing.js.
      if (this._rtp && config.modem.traceTxTiming) {
        const tracePath = this._capture.basePath + '_tx_timing.txt';
        try {
          if (this._rtp.dumpTxTimingTrace(tracePath)) {
            log.info(`[${this._id}]   TX timing trace → ${tracePath}`);
          }
        } catch (e) {
          log.warn(`[${this._id}] TX timing dump failed: ${e.message}`);
        }
      }
      this._capture.close();
      log.info(`[${this._id}] Audio capture saved:`);
      log.info(`[${this._id}]   RX → ${this._capture.rxPath}`);
      log.info(`[${this._id}]   TX → ${this._capture.txPath}`);
    } catch (e) {
      log.warn(`[${this._id}] Audio capture close failed: ${e.message}`);
    }
    this._capture = null;
  }

  get id()        { return this._id; }
  get dialog()    { return this._dialog; }
  get active()    { return this._active; }
  get dsp()       { return this._dsp; }
  get rtp()       { return this._rtp; }
}

module.exports = { CallSession };
