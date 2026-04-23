'use strict';

/*
 * SlmodemVM.js — host-side process + socket lifecycle for the
 *                slmodemd backend.
 *
 * ────────────────────────────────────────────────────────────────────
 *
 * ROLE
 *
 *   Owns the spawned slmodemd process (real, or mock-slmodemd for
 *   testing), creates the two Unix-domain sockets the modemd-shim
 *   connects back into, and exposes a framed, event-based interface
 *   to callers (SlmodemBackend.js being the main one).
 *
 *   In M1 this talks to the mock or to a native slmodemd on the same
 *   host. In M2 the same class will talk to the shim inside a QEMU
 *   guest through QEMU's chardev-socket feature, which exposes a
 *   virtio-serial port to the guest as a Unix socket on the host.
 *   The Node API is identical either way; only the invoker's choice
 *   of executable and args differs.
 *
 * LIFECYCLE
 *
 *   new SlmodemVM(opts)   — nothing happens yet
 *   vm.start()            — opens listeners, spawns child, resolves
 *                           when HELLO is received. Rejects on
 *                           failure (listener error, child exit
 *                           before HELLO, timeout).
 *   vm.on('status', ...)  — structured MODEM_STATUS events
 *   vm.on('at-response', ...) — raw PTY AT-mode bytes from shim
 *   vm.on('data-rx', buf) — raw PTY data-mode bytes from shim
 *   vm.on('audio', buf)   — 320-byte PCM frames from shim
 *   vm.on('exit', info)   — child exited (or the whole session ended)
 *   vm.sendAT(cmd)        — queue an AT command
 *   vm.sendData(buf)      — send bytes in data mode
 *   vm.sendAudio(buf)     — send one audio frame (160 samples, int16 LE)
 *   vm.sendSilence()      — send the WIRE_TYPE_SILENCE optimization
 *   vm.hangup()           — request HANGUP
 *   vm.stop()             — clean shutdown, returns Promise
 *
 * FAULT MODEL
 *
 *   - Any I/O error on a socket after start() is considered fatal to
 *     the session; the class emits 'error' and transitions to a dead
 *     state, after which sendX() methods are no-ops. Callers should
 *     recreate the instance (typical pattern: one SlmodemVM per call).
 *   - Child exiting is also fatal; same emits.
 *   - stop() is idempotent and safe in any state.
 *
 * FRAMING
 *
 *   Uses ../shim/wire.h via vm/qemu-runner/wire.js. Audio and control
 *   are two separate wire-framed streams. See wire.h for the protocol.
 */

const { EventEmitter } = require('events');
const { spawn }        = require('child_process');
const net              = require('net');
const fs               = require('fs');
const os               = require('os');
const path             = require('path');
const wire             = require('./wire');

/* ──────────────────────────────────────────────────────────────────
 * Default timeouts. Tune via constructor opts if needed.
 * ────────────────────────────────────────────────────────────────── */

const DEFAULTS = Object.freeze({
  // How long we wait for the shim to connect to BOTH our sockets
  // after spawning the child. 5 seconds is generous; in practice
  // the shim connects within a few ms on a single host.
  connectTimeoutMs: 5000,

  // How long we wait for HELLO after both sockets are connected.
  // The shim sends HELLO immediately, so this should be very short;
  // set to 2000 for slow VMs / cold JIT.
  helloTimeoutMs: 2000,

  // How long stop() waits for the child to exit gracefully before
  // escalating to SIGKILL.
  stopGraceMs: 2000,
});

class SlmodemVM extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.slmodemdPath   - Path to slmodemd (or mock-slmodemd).
   * @param {string} opts.shimPath       - Path to modemd-shim (absolute).
   * @param {string[]} [opts.slmodemdArgs] - Extra args to pass to slmodemd.
   *                                        The final "-e <shimPath>" is
   *                                        always appended.
   * @param {string}   [opts.socketDir]  - Where to put the Unix sockets.
   *                                       Defaults to os.tmpdir(). Useful
   *                                       to override for sandboxed runs.
   * @param {string}   [opts.ptyPath]    - PTY path to pass to the shim
   *                                       via SYNTHMODEM_PTY_PATH. Must
   *                                       match the PTY the slmodemd
   *                                       process creates (from the
   *                                       mock, read from its stdout;
   *                                       for real slmodemd, the
   *                                       symlink `/dev/ttySLn`).
   * @param {string}   [opts.logLevel]   - "error" | "info" | "debug".
   *                                       Passed to the shim via env.
   * @param {boolean}  [opts.traceWireFrames] - When true, emit a
   *                                       'frame-trace' event for every
   *                                       wire frame in either direction.
   *                                       Event payload:
   *                                         { dir: 'rx'|'tx',
   *                                           channel: 'audio'|'control',
   *                                           type: <number>,
   *                                           typeName: <string>,
   *                                           size: <number>,
   *                                           preview: <hex-string> }
   *                                       Very noisy — audio streams at
   *                                       50 fps per direction. Intended
   *                                       for protocol debugging only.
   * @param {object}   [opts.timeouts]   - Override DEFAULTS.
   * @param {function} [opts.onChildStdout] - Callback for mock's stdout
   *                                          line (used to extract PTS=).
   */
  constructor(opts) {
    super();
    if (!opts || !opts.slmodemdPath || !opts.shimPath) {
      throw new TypeError('SlmodemVM: slmodemdPath and shimPath are required');
    }
    this._opts = {
      slmodemdPath:     opts.slmodemdPath,
      shimPath:         opts.shimPath,
      slmodemdArgs:     opts.slmodemdArgs || [],
      socketDir:        opts.socketDir    || os.tmpdir(),
      ptyPath:          opts.ptyPath      || '/dev/ttySL0',
      logLevel:         opts.logLevel     || 'error',
      traceWireFrames:  opts.traceWireFrames ?? false,
      onChildStdout:    opts.onChildStdout,
      timeouts:         { ...DEFAULTS, ...(opts.timeouts || {}) },
    };

    // State machine: 'idle' | 'starting' | 'ready' | 'stopping' | 'dead'
    // Transitions are one-way forward; any error jumps to 'dead'.
    this._state = 'idle';

    // Populated during start().
    this._audioPath     = null;
    this._controlPath   = null;
    this._audioServer   = null;
    this._controlServer = null;
    this._audioSocket   = null;   // accepted socket from shim
    this._controlSocket = null;   // accepted socket from shim
    this._audioParser   = new wire.Parser();
    this._controlParser = new wire.Parser();
    this._child         = null;
    this._helloInfo     = null;   // set to the HELLO payload text

    // Promise helpers for start().
    this._startResolve = null;
    this._startReject  = null;
    this._startTimer   = null;

    // For cleanup tracking.
    this._stopPromise  = null;
    this._childStdoutBuf = '';
    this._childStderrBuf = '';

    // For captureAudioDumps(). When a dump request is in flight,
    // _dumpInProgress is the { resolve, reject, timer, files } tuple
    // that collects incoming DUMP_DATA frames into a map keyed by
    // filename (Buffer concatenated per name in arrival order).
    // Resolved on DUMP_DONE, rejected on timeout/error.
    this._dumpInProgress = null;
  }

  get state() { return this._state; }
  get helloInfo() { return this._helloInfo; }

  /**
   * Start the backend. Resolves once HELLO is received (and therefore
   * the whole process+socket chain is live). Rejects on any failure
   * before that point.
   */
  start() {
    if (this._state !== 'idle') {
      return Promise.reject(new Error(
        `SlmodemVM.start() in state '${this._state}'; construct a new instance`));
    }
    this._state = 'starting';

    return new Promise((resolve, reject) => {
      this._startResolve = resolve;
      this._startReject  = reject;

      // Deadline for the entire start sequence (spawn + connect + HELLO).
      // Individual steps (connectTimeoutMs, helloTimeoutMs) are applied
      // below; this is a belt-and-braces overall cap.
      const { connectTimeoutMs, helloTimeoutMs } = this._opts.timeouts;
      this._startTimer = setTimeout(() => {
        this._failStart(new Error(
          `SlmodemVM.start: timed out after ${connectTimeoutMs + helloTimeoutMs}ms`));
      }, connectTimeoutMs + helloTimeoutMs);

      // The default POSIX order is: servers up first, then spawn the
      // child. The shim connects immediately on exec, so the servers
      // must already be listening. Subclasses can override this
      // sequence entirely — see QemuVM on Windows, which must spawn
      // QEMU first because QEMU creates the named pipes lazily.
      this._performStartSequence()
        .catch(err => this._failStart(err));
    });
  }

  /**
   * The ordered steps of start(). POSIX default: sockets, then spawn.
   * Override in subclasses if the transport requires a different
   * order (e.g. Windows named pipes: spawn first, then connect).
   *
   * @returns {Promise<void>}
   * @protected
   */
  async _performStartSequence() {
    await this._createSockets();
    this._spawnChild();
  }

  /* ──────────────────────────────────────────────────────────────
   * Socket setup
   *
   * Creates the two listener sockets. Uses a PID-suffixed path in
   * socketDir so multiple instances on the same host don't collide.
   * ────────────────────────────────────────────────────────────── */

  async _createSockets() {
    const pid = process.pid;
    const ts  = Date.now();
    // Short collision-resistant suffix; the sockets live for one call.
    const suffix = `${pid}-${ts}`;
    this._audioPath   = path.join(this._opts.socketDir, `synthmodem-audio-${suffix}.sock`);
    this._controlPath = path.join(this._opts.socketDir, `synthmodem-control-${suffix}.sock`);

    // Clean any stale files at those paths. Normally won't exist.
    for (const p of [this._audioPath, this._controlPath]) {
      try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }

    // Create both servers in parallel.
    this._audioServer   = await this._listen(this._audioPath,   'audio');
    this._controlServer = await this._listen(this._controlPath, 'control');
  }

  _listen(sockPath, label) {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', err => {
        // Errors on the listening socket after listen() succeeds are
        // fatal session errors.
        this._handleFatal(new Error(`${label} server error: ${err.message}`));
      });
      server.on('connection', socket => {
        // Accept exactly one connection per listener (from the shim).
        // Subsequent connections would be a bug (another shim? test
        // harness misuse?) — close them immediately.
        if (label === 'audio' && this._audioSocket) {
          socket.destroy(); return;
        }
        if (label === 'control' && this._controlSocket) {
          socket.destroy(); return;
        }
        if (label === 'audio')   this._onAudioAccepted(socket);
        else                     this._onControlAccepted(socket);

        // Stop listening — one connection is all we want.
        try { server.close(); } catch (_) { /* ignore */ }
      });
      server.listen(sockPath, err => {
        if (err) return reject(new Error(`${label} listen(${sockPath}): ${err.message}`));
        resolve(server);
      });
    });
  }

  _onAudioAccepted(socket) {
    this._audioSocket = socket;
    socket.on('data', chunk => {
      try { this._audioParser.feed(chunk); }
      catch (e) { this._handleFatal(e); }
    });
    socket.on('error', err => this._handleExpectedClose('audio', err));
    socket.on('close', () => {
      if (this._state !== 'dead' && this._state !== 'stopping') {
        this._handleFatal(new Error('audio socket closed unexpectedly'));
      }
    });
    this._audioParser.on('frame', f => this._onAudioFrame(f));
    this._audioParser.on('error', e => this._handleFatal(e));
  }

  _onControlAccepted(socket) {
    this._controlSocket = socket;
    socket.on('data', chunk => {
      try { this._controlParser.feed(chunk); }
      catch (e) { this._handleFatal(e); }
    });
    socket.on('error', err => this._handleExpectedClose('control', err));
    socket.on('close', () => {
      if (this._state !== 'dead' && this._state !== 'stopping') {
        this._handleFatal(new Error('control socket closed unexpectedly'));
      }
    });
    this._controlParser.on('frame', f => this._onControlFrame(f));
    this._controlParser.on('error', e => this._handleFatal(e));
  }

  /**
   * Shared error-path filter for the audio/control TCP sockets.
   * When QEMU exits (clean stop, crash, or external kill), the other
   * end of both sockets closes. The close manifests differently per
   * platform:
   *
   *   POSIX: usually 'close' event with no preceding 'error'
   *   Windows: 'error' with code ECONNRESET, then 'close'
   *
   * During a clean stop (state is 'stopping' or 'dead' already),
   * this is the expected, normal consequence of killing QEMU — NOT
   * a fatal condition. Swallow the error; the 'close' handler above
   * also guards, so nothing else propagates.
   *
   * During an active session, these errors ARE fatal (the VM has
   * crashed or the host connection collapsed), and we route to
   * _handleFatal as before.
   *
   * @private
   */
  _handleExpectedClose(label, err) {
    const benignOnShutdown = (
      err && (err.code === 'ECONNRESET' ||
              err.code === 'EPIPE'      ||
              err.code === 'ECONNABORTED')
    );
    if ((this._state === 'stopping' || this._state === 'dead') && benignOnShutdown) {
      // Silently absorbed — the 'close' handler's state guard is
      // the authoritative "did this happen during shutdown" check.
      return;
    }
    this._handleFatal(new Error(`${label} socket: ${err.message}`));
  }

  /* ──────────────────────────────────────────────────────────────
   * Child process lifecycle
   * ────────────────────────────────────────────────────────────── */

  _spawnChild() {
    // Subclass hook. Default implementation spawns slmodemd directly,
    // which is M1 behavior and keeps the mock testing path working.
    // QemuVM overrides this to spawn qemu-system-i386 instead.
    //
    // The subclass is responsible for:
    //   - setting this._child to a ChildProcess (or ChildProcess-like)
    //   - wiring stderr → 'stderr' event (optional, best effort)
    //   - hooking 'error' → _handleFatal
    //   - hooking 'exit' to the logic below (fatal-if-starting,
    //     expected-if-stopping, unexpected otherwise)
    return this._spawnSlmodemd();
  }

  _spawnSlmodemd() {
    const env = {
      ...process.env,
      SYNTHMODEM_AUDIO_PATH:   this._audioPath,
      SYNTHMODEM_CONTROL_PATH: this._controlPath,
      SYNTHMODEM_PTY_PATH:     this._opts.ptyPath,
      SYNTHMODEM_LOG_LEVEL:    this._opts.logLevel,
    };

    // Final argv: user's slmodemdArgs, then "-e <shimPath>".
    const args = [...this._opts.slmodemdArgs, '-e', this._opts.shimPath];

    this._child = spawn(this._opts.slmodemdPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Stream-decode stdout/stderr line-by-line for logging and for
    // the PTS= scraper (if opts.onChildStdout is set, we invoke it
    // per-line).
    this._child.stdout.on('data', chunk => {
      this._childStdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = this._childStdoutBuf.indexOf('\n')) >= 0) {
        const line = this._childStdoutBuf.slice(0, idx);
        this._childStdoutBuf = this._childStdoutBuf.slice(idx + 1);
        if (this._opts.onChildStdout) {
          try { this._opts.onChildStdout(line); } catch (_) { /* user cb errors ignored */ }
        }
      }
    });
    this._child.stderr.on('data', chunk => {
      // Stderr is typically logging from slmodemd/mock/shim. We emit
      // it as a 'stderr' event for the caller to capture / log.
      const text = chunk.toString('utf8');
      this._childStderrBuf += text;
      this.emit('stderr', text);
    });

    this._hookChildLifecycle();
  }

  /**
   * Shared child lifecycle handlers — 'error' is always fatal,
   * 'exit' is fatal if we hadn't finished starting yet. Used by
   * both the M1 slmodemd spawn and the M2 QEMU spawn.
   * Subclasses that override _spawnChild() should call this
   * after creating this._child.
   */
  _hookChildLifecycle() {
    this._child.on('error', err => {
      this._handleFatal(new Error(`spawn error: ${err.message}`));
    });
    this._child.on('exit', (code, signal) => {
      const info = { code, signal, stderr: this._childStderrBuf };
      if (this._state === 'stopping' || this._state === 'dead') {
        this.emit('exit', info);
      } else if (this._state === 'starting') {
        this._failStart(new Error(
          `child exited during start (code=${code}, signal=${signal})`));
      } else {
        this._handleFatal(new Error(
          `child exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────
   * Frame handling
   * ────────────────────────────────────────────────────────────── */

  _onControlFrame({ type, payload }) {
    this._trace('rx', 'control', type, payload);
    switch (type) {
      case wire.TYPE.HELLO:
        this._helloInfo = payload.toString('utf8');
        // If this is the first HELLO and we're starting, complete the start promise.
        if (this._state === 'starting') {
          this._completeStart();
        } else {
          // Late or duplicate HELLO — log and ignore.
          this.emit('stderr', `[SlmodemVM] unexpected HELLO in state ${this._state}\n`);
        }
        break;
      case wire.TYPE.AT_RESPONSE:
        this.emit('at-response', payload);
        break;
      case wire.TYPE.DATA_RX:
        this.emit('data-rx', payload);
        break;
      case wire.TYPE.MODEM_STATUS:
        {
          // Payload is JSON per wire.h. Parse defensively.
          let ev = null;
          try { ev = JSON.parse(payload.toString('utf8')); }
          catch (_) { /* malformed — log and drop */ }
          if (ev) this.emit('status', ev);
        }
        break;
      case wire.TYPE.DUMP_DATA:
        this._onDumpData(payload);
        break;
      case wire.TYPE.DUMP_DONE:
        this._onDumpDone();
        break;
      default:
        // Unknown types are silently ignored (forward-compat policy).
        break;
    }
  }

  _onAudioFrame({ type, payload }) {
    this._trace('rx', 'audio', type, payload);
    switch (type) {
      case wire.TYPE.AUDIO:
        this.emit('audio', payload);
        break;
      case wire.TYPE.SILENCE:
        // Emit a zero-filled buffer so consumers don't need to
        // special-case silence. Allocating is cheap (320 bytes);
        // reusing a shared buffer would risk aliasing bugs for
        // async consumers.
        this.emit('audio', Buffer.alloc(wire.WIRE_AUDIO_BYTES));
        break;
      default:
        break;
    }
  }

  _completeStart() {
    if (this._state !== 'starting') return;
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    this._state = 'ready';
    const resolve = this._startResolve;
    this._startResolve = null; this._startReject = null;
    if (resolve) resolve();
  }

  _failStart(err) {
    if (this._state !== 'starting') return;
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    const reject = this._startReject;
    this._startResolve = null; this._startReject = null;
    this._handleFatal(err);
    if (reject) reject(err);
  }

  _handleFatal(err) {
    if (this._state === 'dead') return;
    const wasStarting = (this._state === 'starting');
    this._state = 'dead';

    if (wasStarting) {
      // Error contract during startup is the start() Promise rejecting,
      // NOT an 'error' event. If we emit here too, callers who are only
      // awaiting start() (and haven't yet attached an 'error' listener)
      // will crash Node with an unhandled 'error' event before they
      // even get a chance to see the rejection. The Promise rejection
      // below is what surfaces the error to the caller.
      if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
      const reject = this._startReject;
      this._startResolve = null; this._startReject = null;
      if (reject) reject(err);
    } else {
      // After startup, event emission is the error contract. Callers
      // who care will have attached an 'error' listener. If no listener
      // exists, Node's default behavior of turning an unhandled 'error'
      // into a process crash is the right behavior — it means a bug in
      // the caller's error handling that needs attention.
      this.emit('error', err);
    }

    // Clean up synchronously. stop()'s cleanup is idempotent.
    this._teardown();
  }

  /* ──────────────────────────────────────────────────────────────
   * Wire-frame tracing (opt-in)
   * ────────────────────────────────────────────────────────────── */

  /**
   * Emit a 'frame-trace' event describing one wire frame. Zero cost
   * when traceWireFrames is false: we early-return before touching
   * Buffer/hex methods so high-throughput audio doesn't pay.
   * @private
   */
  _trace(dir, channel, type, payloadOrFrame) {
    if (!this._opts.traceWireFrames) return;
    // For TX calls we pass just the payload (already encoded); the
    // frame header adds 3 bytes and we know the type separately.
    // For RX calls we pass the parsed payload; same shape. Size we
    // report is the payload size, which is usually what the reader
    // actually cares about.
    const buf = Buffer.isBuffer(payloadOrFrame)
      ? payloadOrFrame
      : Buffer.from(payloadOrFrame || '');
    const previewBytes = buf.slice(0, 32);
    this.emit('frame-trace', {
      dir,
      channel,
      type,
      typeName: wire.typeName(type),
      size:     buf.length,
      preview:  previewBytes.toString('hex'),
    });
  }

  /* ──────────────────────────────────────────────────────────────
   * Send paths
   * ────────────────────────────────────────────────────────────── */

  sendAT(cmd) {
    if (this._state !== 'ready') return false;
    if (typeof cmd !== 'string') throw new TypeError('sendAT: cmd must be a string');
    this._trace('tx', 'control', wire.TYPE.AT, cmd);
    const frame = wire.encode(wire.TYPE.AT, cmd);
    return this._controlSocket.write(frame);
  }

  sendData(buf) {
    if (this._state !== 'ready') return false;
    this._trace('tx', 'control', wire.TYPE.DATA_TX, buf);
    const frame = wire.encode(wire.TYPE.DATA_TX, buf);
    return this._controlSocket.write(frame);
  }

  sendAudio(pcm) {
    if (this._state !== 'ready') return false;
    if (pcm.length !== wire.WIRE_AUDIO_BYTES) {
      throw new RangeError(`sendAudio: expected ${wire.WIRE_AUDIO_BYTES} bytes, got ${pcm.length}`);
    }
    this._trace('tx', 'audio', wire.TYPE.AUDIO, pcm);
    return this._audioSocket.write(wire.encode(wire.TYPE.AUDIO, pcm));
  }

  sendSilence() {
    if (this._state !== 'ready') return false;
    this._trace('tx', 'audio', wire.TYPE.SILENCE, Buffer.alloc(0));
    return this._audioSocket.write(wire.encode(wire.TYPE.SILENCE));
  }

  hangup() {
    if (this._state !== 'ready') return false;
    this._trace('tx', 'control', wire.TYPE.HANGUP, Buffer.alloc(0));
    return this._controlSocket.write(wire.encode(wire.TYPE.HANGUP));
  }

  /* ──────────────────────────────────────────────────────────────
   * Diagnostic: capture slmodemd's internal audio dump files
   *
   * slmodemd writes three diagnostic files inside the guest VM
   * (modem_main.c rx_dump/tx_dump hooks):
   *
   *   /tmp/modem_rx_8k.raw  — 16-bit signed 8000 Hz mono, pre-resample.
   *                           Exactly the bytes the shim wrote to
   *                           slmodemd from the wire — compare to the
   *                           Node RX capture WAV to measure pipeline
   *                           integrity Node → TCP → QEMU → virtio →
   *                           shim → slmodemd.
   *
   *   /tmp/modem_rx.raw     — 16-bit signed 9600 Hz mono, post-resample.
   *                           What the DSP blob actually sees. Compare
   *                           to modem_rx_8k.raw to measure the 8 → 9.6
   *                           resampler's fidelity.
   *
   *   /tmp/modem_tx.raw     — 16-bit signed 9600 Hz mono, pre-resample.
   *                           What the DSP blob emits. Compare to the
   *                           Node TX capture WAV (after host-side
   *                           9.6→8 resample) to measure the reverse
   *                           pipeline.
   *
   * The VM's /tmp is a tmpfs that dies with the VM. This method asks
   * the shim to stream the file contents back over the control channel
   * as a series of DUMP_DATA frames, terminated by DUMP_DONE. Call it
   * BEFORE stop(): once QEMU is killed the dumps are gone.
   *
   * On timeout or DUMP_DONE, resolves with { filename: Buffer }.
   * Files that the shim couldn't open are simply absent from the map
   * (not an error).
   *
   * Only one dump capture may be in flight at a time.
   *
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<Object<string, Buffer>>}
   * ────────────────────────────────────────────────────────────── */
  captureAudioDumps(timeoutMs = 5000) {
    if (this._state !== 'ready') {
      return Promise.reject(new Error(
        `captureAudioDumps in state '${this._state}' — must be 'ready'`));
    }
    if (this._dumpInProgress) {
      return Promise.reject(new Error(
        'captureAudioDumps: another dump is already in progress'));
    }

    return new Promise((resolve, reject) => {
      const ctx = {
        resolve,
        reject,
        timer: null,
        // Per-filename chunk lists. Concatenated once at DUMP_DONE.
        chunks: new Map(),
      };
      ctx.timer = setTimeout(() => {
        if (this._dumpInProgress !== ctx) return;
        this._dumpInProgress = null;
        reject(new Error(`captureAudioDumps: timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this._dumpInProgress = ctx;

      // Fire the request. From here, _onDumpData/_onDumpDone drive
      // the state machine.
      this._trace('tx', 'control', wire.TYPE.DUMP_REQUEST, Buffer.alloc(0));
      try {
        this._controlSocket.write(wire.encode(wire.TYPE.DUMP_REQUEST));
      } catch (e) {
        clearTimeout(ctx.timer);
        this._dumpInProgress = null;
        reject(new Error(`captureAudioDumps: write failed: ${e.message}`));
      }
    });
  }

  /*
   * Handle an inbound DUMP_DATA frame from the shim.
   *
   * Payload:
   *    u8  name_len
   *    u8  name[name_len]
   *    u8  data[...]
   *
   * A single file may span many frames — we accumulate per-name chunks
   * and concatenate at DUMP_DONE.
   *
   * If no dump is in progress, the frame is silently dropped (stale
   * frame from a previous request that completed during a race).
   *
   * @private
   */
  _onDumpData(payload) {
    if (!this._dumpInProgress) return;  // stale
    if (!payload || payload.length < 1) return;
    const nameLen = payload[0];
    if (nameLen === 0 || payload.length < 1 + nameLen) {
      // Malformed; log and drop but don't fail the whole dump.
      this.emit('stderr', `[SlmodemVM] DUMP_DATA: malformed name_len=${nameLen} plen=${payload.length}\n`);
      return;
    }
    const name = payload.slice(1, 1 + nameLen).toString('utf8');
    const data = payload.slice(1 + nameLen);

    const ctx = this._dumpInProgress;
    const list = ctx.chunks.get(name);
    if (list) list.push(data);
    else      ctx.chunks.set(name, [data]);
  }

  /*
   * Handle DUMP_DONE — finalize the in-progress capture.
   * @private
   */
  _onDumpDone() {
    const ctx = this._dumpInProgress;
    if (!ctx) return;  // stale
    clearTimeout(ctx.timer);
    this._dumpInProgress = null;

    // Concatenate per-name chunk lists into one Buffer each.
    const out = {};
    for (const [name, list] of ctx.chunks) {
      out[name] = list.length === 1 ? list[0] : Buffer.concat(list);
    }
    ctx.resolve(out);
  }

  /* ──────────────────────────────────────────────────────────────
   * Shutdown
   *
   * Idempotent. Safe to call in any state. Always resolves.
   * ────────────────────────────────────────────────────────────── */

  stop() {
    if (this._stopPromise) return this._stopPromise;
    const prevState = this._state;
    this._state = 'stopping';

    // If a dump is still in flight when stop is called, cancel it so
    // the promise rejects rather than being left dangling forever.
    // In normal flow CallSession awaits captureAudioDumps() before
    // calling stop; this only fires on abort paths.
    if (this._dumpInProgress) {
      const ctx = this._dumpInProgress;
      this._dumpInProgress = null;
      clearTimeout(ctx.timer);
      ctx.reject(new Error('captureAudioDumps: VM stopping'));
    }

    this._stopPromise = new Promise(resolve => {
      // Send SIGTERM; child propagates to shim. Wait up to grace ms
      // then SIGKILL. Then cleanup sockets/listeners/files.
      const cleanup = () => {
        this._teardown();
        this._state = 'dead';
        resolve();
      };

      // If _handleFatal already ran, teardown is done and _child may
      // be a never-successfully-started ChildProcess that will never
      // fire 'exit'. Skip straight to cleanup.
      if (prevState === 'dead') {
        cleanup();
        return;
      }

      if (!this._child || this._child.exitCode !== null ||
          this._child.signalCode !== null) {
        // No child or already exited.
        cleanup();
        return;
      }

      let done = false;
      const onExit = () => { if (done) return; done = true; cleanup(); };
      this._child.once('exit', onExit);
      // Also listen for 'error' in case the child never reached exec
      // (e.g. spawn ENOENT) — that fires 'error' then 'exit' will
      // follow with exitCode=null. Defensive belt-and-braces.
      this._child.once('error', () => { if (done) return; done = true; cleanup(); });

      try { this._child.kill('SIGTERM'); } catch (_) { /* ignore */ }

      setTimeout(() => {
        if (done) return;
        try { this._child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        // Even SIGKILL can fail on a process that never ran. Force
        // cleanup after another grace period.
        setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
        }, this._opts.timeouts.stopGraceMs);
      }, this._opts.timeouts.stopGraceMs);
    });

    // If we were still starting, reject the start promise too.
    if (prevState === 'starting' && this._startReject) {
      const reject = this._startReject;
      this._startResolve = null; this._startReject = null;
      if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
      reject(new Error('stopped before ready'));
    }

    return this._stopPromise;
  }

  _teardown() {
    // Close sockets (best effort).
    for (const s of [this._audioSocket, this._controlSocket]) {
      if (s) try { s.destroy(); } catch (_) {}
    }
    for (const srv of [this._audioServer, this._controlServer]) {
      if (srv) try { srv.close(); } catch (_) {}
    }
    // Remove socket files.
    for (const p of [this._audioPath, this._controlPath]) {
      if (p) try { fs.unlinkSync(p); } catch (_) {}
    }
    this._audioSocket = null;
    this._controlSocket = null;
    this._audioServer = null;
    this._controlServer = null;
  }
}

module.exports = { SlmodemVM, DEFAULTS };
