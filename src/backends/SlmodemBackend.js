'use strict';

/*
 * SlmodemBackend.js — a drop-in replacement for ModemDSP that routes
 *                     audio and data through an slmodemd instance
 *                     owned by a SlmodemVM.
 *
 * ────────────────────────────────────────────────────────────────────
 *
 * ROLE
 *
 *   CallSession holds a single object it calls "the DSP" and expects
 *   this surface from it:
 *
 *     methods: start(), stop(), receiveAudio(Float32Array), write(Buffer)
 *     events:  'connected' {protocol, bps, instance}
 *              'audioOut'  Float32Array (samples to send via RTP)
 *              'data'      Buffer       (bytes decoded by the modem)
 *              'silenceHangup'           (no audio for a long time)
 *
 *   SlmodemBackend implements exactly that surface by adapting to
 *   SlmodemVM, which speaks wire-framed int16 PCM and AT/DATA bytes.
 *   CallSession should not need to know which backend is in play;
 *   selecting it is a config.modem.backend toggle.
 *
 * AUDIO CONVERSION
 *
 *   RTP side: Float32Array samples in [-1.0, +1.0] at 8 kHz.
 *   Wire side: int16 little-endian at 8 kHz, 320 bytes per 20 ms frame.
 *
 *   Conversion is straightforward: multiply by 32767 and clamp.
 *   int16 → float: divide by 32768.
 *
 *   RTP packetization is 20 ms (160 samples) by default — see
 *   config.rtp.packetIntervalMs. The shim expects exactly one
 *   audio frame per wire message, 160 samples. If RTP's packet
 *   size ever changes, we'd need to repacketize here.
 *
 * HANDSHAKE STATE MACHINE
 *
 *   slmodemd owns the handshake. It emits result codes on the PTY
 *   that the shim parses and forwards as WIRE_TYPE_MODEM_STATUS
 *   events. We listen for:
 *
 *     CONNECT <rate>  → emit 'connected' with protocol derived from
 *                       the rate (best-effort; slmodemd can also
 *                       emit an explicit protocol name via AT+MS
 *                       or equivalent — future work).
 *     NO CARRIER      → hang up, emit end-of-call behaviour
 *     ERROR           → treat like NO CARRIER
 *
 *   Before 'connected', bytes from slmodemd go nowhere (there's no
 *   data stream yet). After 'connected', shim data-mode bytes arrive
 *   as 'data-rx' events and we forward them as the 'data' event.
 *
 *   write() is a no-op before 'connected' (matches the old ModemDSP
 *   behaviour — see ModemDSP.js line ~128).
 *
 * SILENCE HANGUP
 *
 *   Same threshold as the native backend: if no non-silent RTP audio
 *   arrives for silenceHangupPackets packets (default 150 = 3s),
 *   emit 'silenceHangup'. This is purely an RX-side notion; we
 *   compute it from the RTP input before sending to slmodemd.
 *
 * LIFECYCLE
 *
 *   new SlmodemBackend({ vmOpts, role, ... })
 *   backend.start()          — await VM ready, hooks up events
 *   backend.stop()           — tear down VM
 *
 *   start() is NOT async-throw-on-failure in the same way SlmodemVM
 *   is. Like ModemDSP.start() it returns void; failures are emitted
 *   as 'error' (or 'silenceHangup' for the timeout case). That
 *   matches CallSession's expectations. If a caller wants the ready
 *   promise, use backend.startAsync() instead.
 */

const { EventEmitter } = require('events');
const path             = require('path');
const config           = require('../../config');
const { makeLogger }   = require('../logger');
const { SlmodemVM }    = require('../../vm/qemu-runner/SlmodemVM');
const { QemuVM    }    = require('../../vm/qemu-runner/QemuVM');
const wire             = require('../../vm/qemu-runner/wire');

const log = makeLogger('SlmodemBackend');

// Map slmodemd CONNECT rates to protocol names, best-effort.
/**
 * Promise-based sleep helper. Used to space out sequential writes on
 * the control channel when back-to-back small writes are unsafe on
 * certain transports (notably Windows named pipes).
 */
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// slmodemd doesn't always tell us the protocol explicitly, but the
// rate is a good proxy for logging and for CallSession's 'connected'
// event payload. If the rate doesn't match any mapping, we emit
// "unknown" and let the rate speak for itself.
//
// Source: ITU-T modem spec common rates. Rates above 14400 imply
// V.32bis or newer; rates at/below 2400 imply V.22bis or older.
const RATE_TO_PROTOCOL = Object.freeze({
  300:   'V21',
  1200:  'V22',       // or V23 — same rate, different modulation
  2400:  'V22bis',
  4800:  'V32bis',
  7200:  'V32bis',
  9600:  'V32bis',
  12000: 'V32bis',
  14400: 'V32bis',
  16800: 'V34',
  19200: 'V34',
  21600: 'V34',
  24000: 'V34',
  26400: 'V34',
  28800: 'V34',
  31200: 'V34',
  33600: 'V34',
  // V.90 downstream
  38400: 'V90',
  42000: 'V90',
  44000: 'V90',
  46666: 'V90',
  50000: 'V90',
  52000: 'V90',
  53333: 'V90',
  56000: 'V90',
});

/**
 * Convert a 320-byte int16 LE PCM buffer to a Float32Array in [-1, 1].
 * Input buffer length must equal wire.WIRE_AUDIO_BYTES.
 */
function pcmToFloat(buf) {
  const samples = wire.WIRE_AUDIO_BYTES / 2;   // 160
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    out[i] = s / 32768;
  }
  return out;
}

/**
 * Convert a Float32Array (any length, expected 160 samples) to a
 * 320-byte int16 LE Buffer. Values outside [-1, 1] are clipped;
 * NaN becomes 0.
 */
function floatToPcm(samples) {
  const n = samples.length;
  const out = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    let v = samples[i];
    if (Number.isNaN(v)) v = 0;
    if (v >  1) v =  1;
    if (v < -1) v = -1;
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

/**
 * Parse a line of AT output from slmodemd for known result codes.
 * Returns {event, rate?} or null for nothing interesting.
 */
function parseResultLine(line) {
  const t = line.trim();
  if (/^CONNECT(\s+(\d+))?$/.test(t)) {
    const m = /^CONNECT(?:\s+(\d+))?/.exec(t);
    const rate = m[1] ? parseInt(m[1], 10) : 0;
    return { event: 'connect', rate };
  }
  if (/^NO\s*CARRIER$/i.test(t)) return { event: 'nocarrier' };
  if (/^BUSY$/i.test(t))         return { event: 'busy' };
  if (/^NO\s*DIALTONE$/i.test(t))return { event: 'nodialtone' };
  if (/^RING$/i.test(t))         return { event: 'ring' };
  if (/^ERROR$/i.test(t))        return { event: 'error' };
  return null;
}


class SlmodemBackend extends EventEmitter {

  /**
   * @param {object} opts
   * @param {object} opts.vmOpts         - passed through to SlmodemVM
   * @param {string} [opts.role]         - 'answer' (default) or 'originate'.
   *                                       Not yet used — slmodemd's role
   *                                       is driven by whether we send
   *                                       ATA or ATD.
   * @param {object} [opts.modemCfg]     - override config.modem; defaults
   *                                       to the live project config.
   */
  constructor(opts = {}) {
    super();
    this._vmOpts  = opts.vmOpts  || {};
    this._role    = opts.role    || config.modem.role || 'answer';
    this._cfg     = opts.modemCfg || config.modem;

    this._vm          = null;
    this._connected   = false;
    this._silentPkts  = 0;
    this._ptyLineBuf  = '';   // accumulates AT_RESPONSE bytes to parse result codes
    this._started     = false;
    this._activated   = false;
    this._startPromise = null;

    // RX audio repacketization buffer. SIP peers can send 80/160/240
    // samples per RTP packet depending on their ptime; slmodemd needs
    // exactly 160-sample frames. We accumulate into this buffer and
    // drain in 160-sample windows; the 160-sample chunks then feed
    // the Clock Pump v2 ring (below). Allocated lazily on first use.
    this._rxBuf    = null;
    this._rxBufLen = 0;

    // ─── Clock Pump v2 ─────────────────────────────────────────────
    //
    // Paces writes to slmodemd at exactly 20 ms cadence, independent
    // of upstream RTP arrival timing. Node is the clock master.
    //
    // State machine:
    //   IDLE          — before activate(); nothing to pump. Incoming
    //                   audio is dropped (there's no DSP downstream).
    //   PREBUFFERING  — activate() has been called; ATA is in flight.
    //                   Accumulate arriving audio into the ring. When
    //                   depth >= PREBUFFER_FRAMES, start the clock.
    //   PUMPING       — setInterval fires every 20 ms. Each tick pops
    //                   one 160-sample frame from the ring and writes
    //                   to the VM. Empty ring → write explicit silence
    //                   (160 zeros). Overflow past MAX_DEPTH → drop
    //                   oldest DROP_BATCH frames. Resets to IDLE on
    //                   stop() or hangup.
    //
    // Sized for realistic network coalescing:
    //   PREBUFFER_FRAMES = 40  (800 ms) — shock absorber for 60-200ms
    //                                     cellular/Wi-Fi bursts.
    //   MAX_DEPTH        = 100 (2000 ms) — only hit if sender clock is
    //                                      faster than ours long-term.
    //   DROP_BATCH       = 20 (400 ms)  — how many to drop when forced.
    //
    // Each ring slot stores one 320-byte int16 Buffer, or null (meaning
    // empty). The ring is a pre-allocated circular Array with head/tail
    // indices and size counter for O(1) push/pop.
    this._pump = {
      state: 'IDLE',
      ring:  new Array(100).fill(null),
      head:  0,
      tail:  0,
      size:  0,
      capacity: 100,
      prebufferFrames: 40,
      dropBatch: 20,
      tickTimer: null,
      // 5s rolling stats
      stats: {
        lastSec: 0,
        ticks:   0,
        writes:  0,
        silences: 0,
        drops:    0,
        overflows: 0,
        maxDepth:  0,
        slmTxFrames: 0,
      },
    };

    // Rate/protocol of current connection, set by 'connected' event.
    // Both are best-effort and may be 0/'unknown' when slmodemd emits
    // a rateless CONNECT (which is normal on the V.32/V.32bis answer
    // side). Nothing downstream blocks on exact values — they're used
    // for log lines only.
    this._currentProtocol = null;
    this._currentBps      = 0;
  }

  get connected()    { return this._connected; }
  get protocol()     { return this._currentProtocol; }
  get state()        { return this._vm ? this._vm.state : 'idle'; }

  /**
   * Build the VM instance based on config.modem.slmodemd.mode.
   *
   *   'qemu' (default): QemuVM — spawns qemu-system-i386 with the
   *                     bundled VM image, slmodemd + shim run inside
   *                     the guest. This is the shipping configuration.
   *
   *   'host':           SlmodemVM — spawns slmodemd directly on the
   *                     host. Linux-only, requires Debian bookworm–
   *                     compatible glibc. Mainly for M1 testing and
   *                     the mock-slmodemd smoke tests.
   *
   * Constructor-supplied vmOpts take precedence over config — useful
   * for tests that override just the paths. If a test passes vmOpts
   * with qemuPath/kernelPath, we assume qemu mode regardless of config.
   *
   * @returns {SlmodemVM|QemuVM}
   * @private
   */
  _buildVm() {
    const sl = (this._cfg && this._cfg.slmodemd) || {};
    // Determine mode. Explicit vmOpts override anything; else config;
    // else qemu (the shipping default).
    let mode = sl.mode || 'qemu';
    // Allow tests to force mode implicitly by passing shape-specific opts.
    if (this._vmOpts.qemuPath || this._vmOpts.kernelPath) mode = 'qemu';
    else if (this._vmOpts.slmodemdPath)                   mode = 'host';

    const repoRoot = path.resolve(__dirname, '../..');
    const resolve = p => {
      if (!p) return p;
      return path.isAbsolute(p) ? p : path.join(repoRoot, p);
    };

    if (mode === 'qemu') {
      // Merge config into explicit vmOpts (vmOpts wins).
      const transport = (sl.transport) || {};
      const merged = {
        qemuPath:        QemuVM.resolveQemuPath(this._vmOpts.qemuPath || sl.qemuPath),
        kernelPath:      resolve(this._vmOpts.kernelPath  || sl.kernelPath),
        initrdPath:      resolve(this._vmOpts.initrdPath  || sl.initrdPath),
        memoryMb:        this._vmOpts.memoryMb    ?? sl.vmMemoryMb    ?? 256,
        accel:           this._vmOpts.accel       ?? sl.vmAccel       ?? null,
        appendExtra:     this._vmOpts.appendExtra ?? sl.vmAppendExtra ?? null,
        socketDir:       this._vmOpts.socketDir   ?? sl.socketDir     ?? null,
        logLevel:        this._vmOpts.logLevel    ?? sl.logLevel      ?? 'error',
        // TCP transport for VM chardev: Node listens, QEMU connects.
        // All three fall through to transport.js defaults if unset.
        audioPort:       this._vmOpts.audioPort   ?? transport.audioPort,
        controlPort:     this._vmOpts.controlPort ?? transport.controlPort,
        bindHost:        this._vmOpts.bindHost    ?? transport.bindHost,
        // Diagnostic options.
        bootLogPath:     this._vmOpts.bootLogPath     ?? sl.bootLogPath     ?? null,
        crashDumpDir:    this._vmOpts.crashDumpDir    ?? sl.crashDumpDir    ?? null,
        traceWireFrames: this._vmOpts.traceWireFrames ?? sl.traceWireFrames ?? false,
      };
      log.info(`VM mode: qemu  kernel=${merged.kernelPath}`);
      return new QemuVM(merged);
    }

    // Host mode — direct slmodemd spawn.
    const merged = {
      slmodemdPath:    resolve(this._vmOpts.slmodemdPath || sl.slmodemdPath),
      shimPath:        resolve(this._vmOpts.shimPath     || sl.shimPath),
      slmodemdArgs:    this._vmOpts.slmodemdArgs || sl.slmodemdArgs || [],
      ptyPath:         this._vmOpts.ptyPath      || sl.ptyPath      || '/tmp/synthmodem-ttySL0',
      logLevel:        this._vmOpts.logLevel     || sl.logLevel     || 'error',
      socketDir:       this._vmOpts.socketDir    || sl.socketDir    || null,
      traceWireFrames: this._vmOpts.traceWireFrames ?? sl.traceWireFrames ?? false,
    };
    log.info(`VM mode: host  slmodemd=${merged.slmodemdPath}`);
    return new SlmodemVM(merged);
  }

  // ─── start / activate / stop ───────────────────────────────────
  //
  // Lifecycle is split into two phases to support pre-warming the
  // VM at synthmodem startup (ModemBackendPool) rather than at
  // per-call time. Call flow:
  //
  //   const backend = new SlmodemBackend({...});
  //   await backend.startAsync();    // phase 1: boot VM, wait for HELLO
  //                                   //          — VM is warm but idle
  //   ... time passes ...
  //   backend.activate();             // phase 2: send atInit + ATA
  //                                   //          — modem begins answering
  //   ... call proceeds ...
  //   await backend.stop();           // tear down
  //
  // The native ModemDSP backend exposes a single .start() that does
  // everything in one call. To preserve API parity, our .start() /
  // .startAsync() only do phase 1, and CallSession is responsible for
  // calling .activate() at the right moment (after SIP ACK).
  //
  // For backwards-compat with test code that expects the old single-
  // phase behavior, .startAsync({activate:true}) will chain activate()
  // after the VM is ready.

  /**
   * Fire-and-forget phase-1 start. Boots the VM and waits for HELLO;
   * slmodemd ends up in idle/command mode. No atInit, no ATA.
   * Emits 'error' on failure instead of throwing.
   */
  start() {
    if (this._started) return;
    this._started = true;
    this._startPromise = this._startInternal().catch(err => {
      log.error(`start failed: ${err.message}`);
      this.emit('error', err);
    });
  }

  /**
   * Async-promise form. Resolves when the VM is ready to take AT
   * commands. Tests and newer callers prefer this over the fire-and-
   * forget start().
   *
   * @param {object} [opts]
   * @param {boolean} [opts.activate=false] — if true, also run activate()
   *     before resolving. Convenience for tests and legacy callers.
   */
  async startAsync(opts = {}) {
    this.start();
    await this._startPromise;
    if (opts && opts.activate) {
      await this.activate();
    }
  }

  /**
   * Phase 2: send atInit commands and ATA. Safe to call only after
   * start()/startAsync() has resolved. Idempotent — a second call is
   * a no-op.
   *
   * In 'originate' role we don't auto-dial; the test harness calls
   * sendAT('ATD...') explicitly. Phase 2 is then a no-op.
   */
  async activate() {
    if (this._activated) return;
    if (!this._vm) {
      throw new Error('activate(): VM not started (call start/startAsync first)');
    }
    this._activated = true;

    if (this._role === 'answer') {
      // Run atInit sequence first, then ATA.
      //
      // Even under TCP transport (no Windows-pipe small-write quirk),
      // we keep a short gap between sequential AT commands because
      // slmodemd processes them serially and benefits from the space
      // to finalize each one (update internal state, emit OK) before
      // the next arrives.
      const atInit = (this._cfg.slmodemd && this._cfg.slmodemd.atInit) || [];
      if (!Array.isArray(atInit)) {
        log.warn(`config.modem.slmodemd.atInit must be an array of strings, got ${typeof atInit} — ignoring`);
      } else {
        for (const cmd of atInit) {
          if (typeof cmd !== 'string' || cmd.length === 0) {
            log.warn(`atInit entry ignored (expected non-empty string): ${JSON.stringify(cmd)}`);
            continue;
          }
          log.info(`atInit → ${cmd}`);
          this._vm.sendAT(cmd);
          await _sleep(50);
        }
      }
      // Clock Pump v2: arm the ring BEFORE ATA so the very first RTP
      // arrivals are captured into the pre-buffer. Ring fills during
      // handshake preamble; clock starts when slmodemd emits its first
      // TX (proof modemap_start completed and m->started=true).
      this._pumpArm();
      log.info('activate → ATA');
      this._vm.sendAT('ATA');
    } else {
      log.debug('activate: role is not answer, skipping ATA');
    }
  }

  /**
   * Phase 1: boot the VM, wire up event handlers, wait for the shim's
   * HELLO frame. Leaves slmodemd in idle/command mode, ready for ATA
   * to be sent later by activate().
   * @private
   */
  async _startInternal() {
    log.info(`Starting slmodemd backend (role=${this._role})`);

    this._vm = this._buildVm();

    // Forward shim stderr to our logger at debug. Useful for diagnosing
    // handshake issues without making the default log level chatty.
    this._vm.on('stderr', text => {
      if (config.logging && config.logging.logDspState) {
        // Strip the newline at end to avoid double-line logs.
        log.trace(text.replace(/\n+$/, ''));
      }
    });

    // Shim status events — structured JSON from the VM's modemd-shim
    // signalling protocol state changes (connect, ring, busy, etc.).
    // The shim emits these in parallel with the PTY text stream, so
    // they're a more reliable connect-detection signal than scraping
    // the PTY. We fire 'connected' from here AS WELL AS from the
    // PTY-text path; whichever arrives first wins, subsequent arrivals
    // are idempotent no-ops.
    this._vm.on('status', ev => {
      log.debug(`shim status: ${JSON.stringify(ev)}`);
      if (!ev || typeof ev !== 'object') return;
      if (ev.event === 'connect' && !this._connected) {
        // Any CONNECT means the modem has carrier. slmodemd's V.32/V.32bis
        // answer path emits "CONNECT\r\n" without a numeric rate, so the
        // shim may report rate=0. We don't gate on rate — it's just for
        // logging. Protocol name likewise; unknown is fine.
        const rate = Number.isInteger(ev.rate) ? ev.rate : 0;
        this._connected = true;
        this._currentBps      = rate;
        this._currentProtocol = RATE_TO_PROTOCOL[rate] || 'unknown';
        log.info(`CONNECT${rate ? ' ' + rate : ''} (via shim status)${this._currentProtocol !== 'unknown' ? ' — ' + this._currentProtocol : ''}`);
        this.emit('connected', {
          protocol: this._currentProtocol,
          bps:      this._currentBps,
          instance: this,
        });
      }
    });

    // AT responses: scan for result codes to drive state machine.
    this._vm.on('at-response', buf => this._onAtResponse(buf));

    // Data-mode bytes: forward to ModemDSP 'data' consumer.
    this._vm.on('data-rx', buf => this.emit('data', buf));

    // Audio from slmodemd: convert int16 PCM → Float32, emit audioOut.
    // ALSO drive the Clock Pump v2 state machine: the first TX audio
    // from slmodemd post-activation proves m->started=true and that
    // slmodemd is actively select()-ing on the audio socketpair. That's
    // our cue to start the paced write clock.
    this._vm.on('audio', pcm16 => {
      this._pumpOnSlmTx();
      this.emit('audioOut', pcmToFloat(pcm16));
    });

    // Fatal VM errors propagate up.
    this._vm.on('error', err => {
      log.error(`vm error: ${err.message}`);
      this.emit('error', err);
    });

    await this._vm.start();

    log.info('slmodemd backend ready (idle — call activate() to answer)');
  }

  stop() {
    if (!this._vm) return Promise.resolve();
    log.info('Stopping slmodemd backend');
    // Tear down the pump first so no more writes to the VM after this.
    this._pumpReset();
    // Best-effort graceful hangup before tearing down.
    try { if (this._connected) this._vm.hangup(); } catch (_) {}
    return this._vm.stop();
  }

  /**
   * Diagnostic: pull slmodemd's /tmp/modem_*.raw files out of the VM
   * before stop(). Returns a Promise that resolves to
   * `{ "modem_rx_8k.raw": Buffer, "modem_rx.raw": Buffer, "modem_tx.raw": Buffer }`
   * on success, or rejects on timeout. See SlmodemVM.captureAudioDumps
   * for the rationale and file-format details.
   *
   * Must be called BEFORE stop() — once the VM is SIGTERMed, its tmpfs
   * is gone. CallSession handles the ordering in its hangup path when
   * the `config.capture.dumpModemPipeline` knob is enabled.
   *
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<Object<string, Buffer>>}
   */
  captureAudioDumps(timeoutMs = 5000) {
    if (!this._vm) {
      return Promise.reject(new Error('captureAudioDumps: no VM'));
    }
    return this._vm.captureAudioDumps(timeoutMs);
  }

  // ─── RX audio: RTP → slmodemd ──────────────────────────────────

  /**
  /**
   * Feed received audio samples. Matches ModemDSP signature.
   *
   * slmodemd expects exactly 160 samples per audio frame (8 kHz × 20 ms).
   * Real SIP peers may send 80, 160, or 240 samples per packet depending
   * on their negotiated ptime. We buffer incoming samples and drain in
   * 160-sample windows; any partial tail carries over to the next call.
   *
   * @param {Float32Array} samples
   */
  receiveAudio(samples) {
    if (!this._vm || this._vm.state !== 'ready') return;

    // Silence-hangup tracking. Only meaningful AFTER the modem has
    // connected — during handshake slmodemd may be transmitting
    // answer tones into a caller that stays quiet for many seconds
    // (especially old/slow modems that need tens of seconds before
    // sending V.8 CM). Triggering silence-hangup during handshake
    // would abort calls that were about to connect.
    //
    // slmodemd itself emits NO CARRIER if the handshake times out
    // or truly fails — that's the authoritative signal for "handshake
    // failed". This check is purely for mid-call dead-link detection.
    if (this._connected) {
      const silenceThreshold = this._cfg.silenceThreshold || 0.001;
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
      const rms = Math.sqrt(sumSq / samples.length);
      if (rms < silenceThreshold) {
        this._silentPkts++;
        if (this._silentPkts >= (this._cfg.silenceHangupPackets || 150)) {
          log.warn(`${this._silentPkts} silent packets — emitting silence-hangup`);
          this.emit('silenceHangup');
          this._silentPkts = 0;
        }
      } else {
        this._silentPkts = 0;
      }
    }

    // Accumulate into _rxBuf and drain in 160-sample chunks into the
    // Clock Pump v2 ring. The tick handler drains the ring at exactly
    // 20 ms cadence; we don't write to the VM from this path anymore.
    this._appendRxBuf(samples);
    while (this._rxBufLen >= wire.WIRE_AUDIO_SAMPLES) {
      const chunk = this._rxBuf.subarray(0, wire.WIRE_AUDIO_SAMPLES);
      try {
        const pcm = floatToPcm(chunk);   // fresh 320-byte Buffer
        this._pumpPush(pcm);
      } catch (e) {
        log.trace(`floatToPcm: ${e.message}`);
      }
      // Shift remaining samples to the front.
      this._rxBuf.copyWithin(0, wire.WIRE_AUDIO_SAMPLES, this._rxBufLen);
      this._rxBufLen -= wire.WIRE_AUDIO_SAMPLES;
    }
  }

  /**
   * Append to the RX buffer, growing if needed. The buffer is
   * allocated lazily and kept at whatever size satisfies the biggest
   * burst we've seen so far — normally ~240 samples once, stable
   * thereafter.
   * @private
   */
  _appendRxBuf(samples) {
    const need = this._rxBufLen + samples.length;
    if (!this._rxBuf || this._rxBuf.length < need) {
      // Round up to next multiple of 160 + slack for typical burst size.
      const newLen = Math.max(need, 640);
      const grown = new Float32Array(newLen);
      if (this._rxBuf) grown.set(this._rxBuf.subarray(0, this._rxBufLen));
      this._rxBuf = grown;
    }
    this._rxBuf.set(samples, this._rxBufLen);
    this._rxBufLen += samples.length;
  }

  // ─── Clock Pump v2 ─────────────────────────────────────────────
  //
  // Ring operations are O(1). All mutation happens on the Node event
  // loop; no locking needed.

  /**
   * Push one 320-byte int16LE PCM frame (160 samples @ 8kHz = 20ms)
   * into the pump ring. Advances the state machine from IDLE →
   * PREBUFFERING → WAITING_FOR_SLM_TX automatically as frames
   * accumulate.
   * @param {Buffer} pcmFrame  exactly wire.WIRE_AUDIO_BYTES long
   * @private
   */
  _pumpPush(pcmFrame) {
    const p = this._pump;

    // IDLE: drop. No call active, so there's nothing downstream to
    // eventually drain what we'd accumulate. Prevents warm-pool
    // ring-fill.
    if (p.state === 'IDLE') return;

    // Overflow check (applies in PUMPING, also caps PREBUFFERING /
    // WAITING so we never hold unbounded audio across a stuck state).
    if (p.size >= p.capacity) {
      // Drop oldest dropBatch frames to make headroom. Also log.
      this._pumpDropOldest(p.dropBatch);
      p.stats.overflows++;
      log.debug(`pump: ring overflow, dropped ${p.dropBatch} oldest frames (state=${p.state})`);
    }

    // Append.
    p.ring[p.tail] = pcmFrame;
    p.tail = (p.tail + 1) % p.capacity;
    p.size++;
    if (p.size > p.stats.maxDepth) p.stats.maxDepth = p.size;

    this._pumpMaybeStartClock();
  }

  /** Pop one frame off the front of the ring. @returns {Buffer|null} */
  _pumpPop() {
    const p = this._pump;
    if (p.size === 0) return null;
    const frame = p.ring[p.head];
    p.ring[p.head] = null;
    p.head = (p.head + 1) % p.capacity;
    p.size--;
    return frame;
  }

  /** Drop oldest N frames (for overflow). */
  _pumpDropOldest(n) {
    const p = this._pump;
    const drop = Math.min(n, p.size);
    for (let i = 0; i < drop; i++) {
      p.ring[p.head] = null;
      p.head = (p.head + 1) % p.capacity;
      p.size--;
    }
    p.stats.drops += drop;
  }

  /**
   * activate() path: move IDLE → PREBUFFERING to start accepting RTP
   * frames into the ring. Called from activate() right before ATA is
   * sent so the first upstream arrivals aren't dropped.
   * @private
   */
  _pumpArm() {
    const p = this._pump;
    if (p.state !== 'IDLE') {
      log.debug(`pump: _pumpArm while in state ${p.state} — ignoring`);
      return;
    }
    p.state = 'PREBUFFERING';
    p.stats.lastSec = Math.floor(Date.now() / 1000);
    log.info(`pump: PREBUFFERING (need ${p.prebufferFrames} frames before clock starts)`);
  }

  /**
   * slmodemd has emitted its first TX audio frame post-activation,
   * which proves m->started=true and slmodemd is actively select()-ing
   * on the audio socketpair. Start the 20 ms clock.
   * @private
   */
  _pumpOnSlmTx() {
    const p = this._pump;
    p.stats.slmTxFrames++;
    // Stat-only. State transitions happen via _pumpMaybeStartClock
    // triggered from _pumpPush when the pre-buffer fills.
  }

  /**
   * Start the clock if the pre-buffer has filled. Called from
   * _pumpPush on every push.
   *
   * We don't wait for slmodemd TX before starting the clock — doing
   * so creates a deadlock: slmodemd doesn't emit TX until it has RX
   * data to process, and we don't send RX data until slmodemd emits
   * TX. So we trust that 800ms of pre-buffer (40 frames) is more
   * than enough for slmodemd's modemap_start to complete (which
   * takes low-single-digit ms) and for m->started=true. Once the
   * clock starts, writes queue into the kernel socketpair; slmodemd
   * drains them as fast as its select loop permits.
   * @private
   */
  _pumpMaybeStartClock() {
    const p = this._pump;
    if (p.state !== 'PREBUFFERING') return;
    if (p.size < p.prebufferFrames) return;

    p.state = 'PUMPING';
    log.info(`pump: PUMPING (ring=${p.size}, pre-buffer filled — clock starts)`);
    // Use a shorter interval (10ms) so the tick fires at least as
    // often as the required 20ms cadence even under Windows's poor
    // setInterval resolution. The tick handler itself is catch-up:
    // it writes however many 20ms frames are due since the last
    // write, based on wall-clock elapsed time. That way a missed
    // wake-up (tick at +36ms instead of +20ms) simply results in
    // writing 2 frames on that tick instead of 1, keeping the
    // long-term rate at exactly 50 fps regardless of timer jitter.
    p.lastWriteMs = Date.now();
    p.tickTimer = setInterval(() => this._pumpTick(), 10);
  }

  /**
   * Catch-up tick: write (elapsed_ms / 20) frames to slmodemd, updating
   * lastWriteMs by exactly that-many * 20ms. Compensates for Windows's
   * setInterval resolution (~15ms minimum, drifts under load) by
   * trusting the wall clock, not the timer.
   * @private
   */
  _pumpTick() {
    const p = this._pump;
    if (p.state !== 'PUMPING') return;
    if (!this._vm || this._vm.state !== 'ready') return;

    p.stats.ticks++;

    const now = Date.now();
    let elapsed = now - p.lastWriteMs;
    // Safety clamp: if something stalled badly, don't try to flood
    // 500 frames at once. Cap to 500 ms of catch-up = 25 frames.
    if (elapsed > 500) elapsed = 500;

    // Number of 20 ms frames due.
    let due = Math.floor(elapsed / 20);
    if (due <= 0) return;

    for (let i = 0; i < due; i++) {
      let frame = this._pumpPop();
      if (frame) {
        p.stats.writes++;
      } else {
        // Underrun: send explicit silence. Critical that we write
        // SOMETHING on every 20ms slot — slmodemd's blocking read
        // keeps its DSP timer phase-aligned only if bytes arrive
        // regularly. Skipping would let the DSP drift, which is
        // exactly the failure mode we're trying to prevent.
        frame = Buffer.alloc(wire.WIRE_AUDIO_BYTES);  // zero-filled
        p.stats.silences++;
      }
      try {
        this._vm.sendAudio(frame);
      } catch (e) {
        log.trace(`pump: sendAudio: ${e.message}`);
      }
    }
    // Advance lastWriteMs by exactly `due * 20` — not to `now` —
    // so fractional-frame remainders don't accumulate. Next tick will
    // pick up the remaining elapsed ms.
    p.lastWriteMs += due * 20;

    // 5-second telemetry.
    const nowSec = Math.floor(now / 1000);
    if (nowSec - p.stats.lastSec >= 5) {
      const s = p.stats;
      log.info(
        `pump stats 5s: ticks=${s.ticks}  writes=${s.writes}  ` +
        `silences=${s.silences}  drops=${s.drops}  overflows=${s.overflows}  ` +
        `maxDepth=${s.maxDepth}  slmTx=${s.slmTxFrames}  ringNow=${p.size}`);
      s.ticks = s.writes = s.silences = s.drops = s.overflows = 0;
      s.maxDepth = 0;
      s.slmTxFrames = 0;
      s.lastSec = nowSec;
    }
  }

  /**
   * Tear down: stop the clock, clear the ring, return to IDLE.
   * Called from stop() and _onNocarrier.
   * @private
   */
  _pumpReset() {
    const p = this._pump;
    if (p.tickTimer) {
      clearInterval(p.tickTimer);
      p.tickTimer = null;
    }
    for (let i = 0; i < p.capacity; i++) p.ring[i] = null;
    p.head = p.tail = p.size = 0;
    p.stats.maxDepth = 0;
    const prev = p.state;
    p.state = 'IDLE';
    if (prev !== 'IDLE') log.info(`pump: IDLE (was ${prev})`);
  }

  // ─── Data mode write ───────────────────────────────────────────

  /**
   * Write data-mode bytes. Matches ModemDSP.write() signature.
   * No-op before 'connected' (mirrors ModemDSP behavior).
   * @param {Buffer} data
   */
  write(data) {
    if (!this._connected) {
      log.trace('write() before connected — dropping');
      return;
    }
    this._vm.sendData(data);
  }

  // ─── AT response parsing ───────────────────────────────────────

  /**
   * Accumulate AT_RESPONSE bytes and scan for complete lines; parse
   * each line for result codes that drive the state machine.
   */
  _onAtResponse(buf) {
    this._ptyLineBuf += buf.toString('utf8');
    // Cap the buffer so a pathological modem can't OOM us.
    if (this._ptyLineBuf.length > 8192) {
      this._ptyLineBuf = this._ptyLineBuf.slice(-4096);
    }
    // Process complete lines (CR-terminated; most modems use \r\n).
    let idx;
    while ((idx = this._ptyLineBuf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this._ptyLineBuf.slice(0, idx);
      // Advance past the terminator (may be 1 or 2 chars).
      const rest = this._ptyLineBuf.slice(idx);
      const termLen = rest.startsWith('\r\n') ? 2 : 1;
      this._ptyLineBuf = rest.slice(termLen);
      if (!line) continue;
      this._handleResultLine(line);
    }
  }

  _handleResultLine(line) {
    log.trace(`AT line: ${JSON.stringify(line)}`);
    const res = parseResultLine(line);
    if (!res) return;
    switch (res.event) {
      case 'connect': {
        // Rate is informational. slmodemd's V.32/V.32bis answer path
        // emits a rateless "CONNECT\r\n"; we don't gate on the number.
        const rate = res.rate;
        this._connected = true;
        this._currentBps      = rate;
        this._currentProtocol = RATE_TO_PROTOCOL[rate] || 'unknown';
        log.info(`CONNECT${rate ? ' ' + rate : ''}${this._currentProtocol !== 'unknown' ? ' — ' + this._currentProtocol : ''}`);
        this.emit('connected', {
          protocol: this._currentProtocol,
          bps:      this._currentBps,
          instance: this,   // parity with ModemDSP's connected payload
        });
        break;
      }
      case 'nocarrier':
      case 'busy':
      case 'nodialtone':
        // Clock pump: modem is hanging up. Stop pacing writes; any
        // further arrivals will be dropped until next activate().
        this._pumpReset();
        if (this._connected) {
          log.info(`Connection ended: ${res.event.toUpperCase()}`);
          this._connected = false;
          this._currentBps = 0;
          this._currentProtocol = null;
          // ModemDSP doesn't have a standard 'disconnected' event;
          // CallSession handles termination via SIP BYE or silence
          // hangup. We emit 'silenceHangup' here as the closest
          // existing signal — the effect is the same (call torn down).
          this.emit('silenceHangup');
        } else {
          // Pre-connect NO CARRIER / BUSY means slmodemd's handshake
          // timed out or failed. Without escalation CallSession would
          // sit waiting for SIP BYE indefinitely (silence-hangup is
          // now gated behind _connected). Tell it to tear down.
          log.info(`Handshake failed: ${res.event.toUpperCase()}`);
          this.emit('silenceHangup');
        }
        break;
      case 'error':
        // AT-command-level errors during handshake setup can be benign
        // (slmodemd rejecting an AT+MS argument form, or echo of a
        // command we just sent). Log but don't tear down — the
        // subsequent CONNECT or NO CARRIER will decide the real
        // outcome.
        if (this._connected) {
          log.info('ERROR while connected — treating as disconnect');
          this._connected = false;
          this._currentBps = 0;
          this._currentProtocol = null;
          this.emit('silenceHangup');
        } else {
          log.debug(`result before connect: ${res.event}`);
        }
        break;
      case 'ring':
        // Informational only — we don't use ATS0 auto-answer anymore.
        log.debug('RING received');
        break;
    }
  }
}

module.exports = {
  SlmodemBackend,
  // Exported for testing.
  pcmToFloat,
  floatToPcm,
  parseResultLine,
  RATE_TO_PROTOCOL,
};
