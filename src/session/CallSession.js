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
const config                    = require('../../config');
const { makeLogger }            = require('../logger');
const { RtpSession, allocateRtpPort, releaseRtpPort } = require('../rtp/RtpSession');
const { TelnetProxy }           = require('../telnet/TelnetProxy');
const { AudioCapture }          = require('../dsp/AudioCapture');

const log = makeLogger('CallSession');

/**
 * Build a DSP backend per config.modem.backend.
 *
 *   'native'   → ModemDSP (in-process, pure-JS + spandsp)
 *   'slmodemd' → SlmodemBackend (offload to slmodemd running in VM)
 *
 * Both classes expose the same interface:
 *   .start() / .stop()
 *   .receiveAudio(Float32Array)
 *   .write(Buffer)
 *   emits: 'audioOut', 'connected', 'data', 'silenceHangup', 'error'
 *
 * Used only for the 'native' path today. The slmodemd path goes
 * through ModemBackendPool so the VM is pre-warmed at synthmodem
 * startup rather than cold-booted at call time.
 *
 * For slmodemd backend, if no pool was provided (e.g. test harness),
 * we fall back to constructing a fresh SlmodemBackend inline — still
 * functional, just slower to answer.
 */
function _buildModemBackendSync() {
  const backend = (config.modem && config.modem.backend) || 'native';
  if (backend === 'slmodemd') {
    const { SlmodemBackend } = require('../backends/SlmodemBackend');
    log.info('Modem backend: slmodemd (no-pool fallback — cold boot per call)');
    return new SlmodemBackend({ role: config.modem.role });
  }
  if (backend === 'native') {
    const { ModemDSP } = require('../dsp/ModemDSP');
    log.info('Modem backend: native (in-process DSP)');
    return new ModemDSP(config.modem.role);
  }
  throw new Error(
    `config.modem.backend must be 'native' or 'slmodemd', got: ${backend}`);
}

class CallSession extends EventEmitter {

  /**
   * @param {SipServer} sipServer
   * @param {SipDialog} dialog
   * @param {object} [opts]
   * @param {ModemBackendPool} [opts.modemPool] — if provided AND
   *     config.modem.backend === 'slmodemd', the backend is checked
   *     out from the pool instead of being constructed inline. On
   *     hangup/bye, the backend is returned to the pool for recycling
   *     (fresh VM boot).
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
    // The 'fixed-buffered' approach is what the D-Modem project uses
    // with PJSIP and is credited with multi-day call stability, so
    // that's our default for slmodemd. If a user has explicitly
    // configured 'immediate' in config, we honor it (useful for
    // low-latency local testing). Native DSP respects the config as-is
    // because ModemDSP runs its own RX timing.
    const backend      = (config.modem && config.modem.backend) || 'native';
    const rtpConfigured = (config.rtp && config.rtp.playoutMode) || 'buffered';
    let playoutMode;
    if (backend === 'slmodemd') {
      playoutMode = (rtpConfigured === 'immediate') ? 'immediate' : 'fixed-buffered';
    } else {
      playoutMode = rtpConfigured;
    }

    this._rtp      = new RtpSession({ playoutMode });
    this._pool     = opts.modemPool || null;
    this._dsp      = null;   // set by setup() — may need async checkout
    this._telnet   = new TelnetProxy();
    this._rtpPort  = null;
    this._active   = false;
    this._id       = dialog.callId;
    this._capture  = null;

    // Per-call audio capture (optional, for debugging).
    if (config.modem.captureAudio) {
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
    }
  }

  // ─── Setup ───────────────────────────────────────────────────────────────────

  async setup() {
    log.info(`Setting up call session ${this._id}`);

    // Allocate RTP port
    this._rtpPort = await allocateRtpPort();
    await this._rtp.open(this._rtpPort);
    log.debug(`[${this._id}] RTP port ${this._rtpPort} open`);

    // Configure RTP codec from negotiated dialog
    const codecInfo = this._dialog.negotiatedCodec || config.rtp.preferredCodecs[0];
    this._rtp.setCodec(codecInfo.name, codecInfo.payloadType);

    // Tell the SIP server to answer with our RTP port
    this._dialog.localRtpPort = this._rtpPort;
    this._sip.answerCall(this._dialog, this._rtpPort);

    // Store session on dialog for reference
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

    // Acquire the DSP backend. Two paths:
    //   - slmodemd with a pool → checkout() for a pre-warmed backend
    //   - native (or slmodemd without a pool) → construct inline
    try {
      if (this._pool && (config.modem && config.modem.backend) === 'slmodemd') {
        this._dsp = await this._pool.checkout();
        log.info(`[${this._id}] Modem backend: slmodemd (pool checkout)`);
      } else {
        this._dsp = _buildModemBackendSync();
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

    // Point RTP at remote
    this._rtp.setRemote(this._dialog.remoteRtpAddr, this._dialog.remoteRtpPort);

    // Wire RTP → DSP (inbound audio). Capture RX audio alongside if enabled.
    // Guard: with the fixed-buffered jitter mode, the RTP session may
    // still have queued packets that drain after teardown (this._dsp
    // set to null in hangup). Silently ignore those late emissions —
    // they're ~800ms of stale audio nobody wants.
    this._rtp.on('audio', samples => {
      if (this._capture) {
        try { this._capture.writeRx(samples); } catch (e) { /* ignore */ }
      }
      if (!this._dsp) return;
      try { this._dsp.receiveAudio(samples); } catch (_) { /* racing teardown */ }
    });

    // Wire DSP → RTP (outbound audio). Capture TX audio alongside if enabled.
    this._dsp.on('audioOut', samples => {
      if (this._capture) {
        try { this._capture.writeTx(samples); } catch (e) { /* ignore */ }
      }
      this._rtp.send(samples);
    });

    // When modem connects, attach telnet proxy
    this._dsp.on('connected', () => this._onModemConnected());

    // Silence hangup
    this._dsp.on('silenceHangup', () => {
      log.info(`[${this._id}] Silence hangup`);
      this.hangup('silence');
    });

    // Backend errors (VM boot failure, QEMU crash, native DSP assert, etc.)
    // must not crash the process. Log and hang up the call.
    this._dsp.on('error', err => {
      log.error(`[${this._id}] Modem backend error: ${err.message}`);
      this.hangup('backend-error');
    });

    // Start modem DSP. For native backend, this boots spandsp and
    // begins generating answer tone in one shot. For SlmodemBackend
    // coming from the pool, the VM is already warm — start() is
    // idempotent there (marks _started but does nothing because the
    // VM is up) and activate() sends atInit+ATA to begin the answer.
    // For SlmodemBackend constructed inline (no-pool fallback),
    // start() boots the VM and we then need to activate() it.
    this._dsp.start();

    if (typeof this._dsp.activate === 'function') {
      // Split-lifecycle backend (SlmodemBackend). Activate is async;
      // run it but don't block RTP wiring on its completion.
      Promise.resolve(this._dsp.activate()).catch(err => {
        log.error(`[${this._id}] DSP activate failed: ${err.message}`);
        this.hangup('activate-error');
      });
    }
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
    //   Phase 1 — MINIMUM HOLD: wait config.modem.postTrainIdleMs
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
    const holdMs        = (config.modem.postTrainIdleMs    ?? 3000);
    const quiescenceMs  = (config.modem.postTrainQuiescenceMs ?? 500);
    const attachMaxMs   = (config.modem.postTrainAttachMaxMs  ?? 10000);

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
      });

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

  hangup(reason = 'normal') {
    if (!this._active) return;
    this._active = false;
    log.info(`[${this._id}] Hanging up (reason: ${reason})`);

    this._telnet.disconnect();

    // Send BYE now (doesn't depend on DSP/VM state), then run the
    // async teardown path which captures dumps before tearing down.
    if (this._dialog.canBye()) {
      this._sip.sendBye(this._dialog);
    }

    // Fire-and-forget — all callers treat hangup() as synchronous
    // void. Errors inside are logged, not propagated.
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
   *   1. If config.modem.dumpModemPipeline is on AND the backend
   *      supports captureAudioDumps, pull the /tmp/modem_*.raw files
   *      out of the VM (short timeout; best-effort).
   *   2. Write those dumps to the capture directory via
   *      AudioCapture.writeDump (filename siblings of the WAVs).
   *   3. Tear down the DSP (backend.stop or pool.recycle).
   *   4. Close the RTP port.
   *   5. Close the WAV capture.
   *   6. Emit 'ended'.
   *
   * Step ordering matters: dumps MUST be captured BEFORE the VM is
   * stopped because the VM's /tmp is destroyed with it. Everything
   * else follows normal cleanup ordering.
   *
   * Any failure in any step is logged but doesn't stop the rest of
   * cleanup from happening — a broken VM shouldn't prevent releasing
   * the RTP port or emitting 'ended'.
   *
   * @param {string} reason
   * @private
   */
  async _finalizeTeardown(reason) {
    // Step 1-2: capture and write dumps. Gate on config + backend
    // capability; silently skip if either is missing.
    const wantDumps = config.modem && config.modem.dumpModemPipeline;
    if (wantDumps && this._dsp && typeof this._dsp.captureAudioDumps === 'function'
        && this._capture && typeof this._capture.writeDump === 'function') {
      try {
        const dumps = await this._dsp.captureAudioDumps(5000);
        for (const [name, buf] of Object.entries(dumps)) {
          try {
            const outPath = this._capture.writeDump(name, buf);
            log.info(`[${this._id}] Dump saved: ${outPath} (${buf.length} bytes)`);
          } catch (e) {
            log.warn(`[${this._id}] writeDump(${name}) failed: ${e.message}`);
          }
        }
      } catch (e) {
        log.warn(`[${this._id}] captureAudioDumps failed: ${e.message}`);
      }
    }

    // Step 3: DSP teardown. This is where pool.recycle() / dsp.stop()
    // runs, which kills the VM. Must happen AFTER dump capture.
    this._teardownDsp();

    // Step 4: RTP.
    try {
      this._rtp.close();
    } catch (e) { /* ignore */ }
    if (this._rtpPort) {
      releaseRtpPort(this._rtpPort);
      this._rtpPort = null;
    }

    // Step 5: close WAV capture.
    this._closeCapture();

    // Step 6: ended.
    this.emit('ended', { callId: this._id, reason });
  }

  /**
   * Tear down the DSP backend. Two paths:
   *
   *   1. Backend came from ModemBackendPool (slmodemd + pool): call
   *      pool.recycle(). The pool is responsible for stopping the
   *      backend and starting a fresh replacement VM in the
   *      background. This overlaps boot cost with call cleanup.
   *
   *   2. Backend was constructed inline (native, or slmodemd w/o
   *      pool): just call stop().
   *
   * Also guards against _dsp being null (hangup called before
   * activate() or after a failed checkout).
   * @private
   */
  _teardownDsp() {
    if (!this._dsp) return;
    const dsp = this._dsp;
    this._dsp = null;

    const backend = (config.modem && config.modem.backend) || 'native';
    if (this._pool && backend === 'slmodemd') {
      // Pool handles stop() internally and kicks off the replacement
      // warmup. Fire-and-forget; errors surface via pool 'error' event.
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
  }

  _closeCapture() {
    if (!this._capture) return;
    try {
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
