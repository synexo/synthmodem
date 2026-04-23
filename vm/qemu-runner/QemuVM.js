'use strict';

/*
 * QemuVM.js — host-side driver for the synthmodem runtime VM.
 *
 * Extends SlmodemVM by replacing the "spawn slmodemd directly" child
 * with "spawn qemu-system-i386 and let slmodemd run inside the guest."
 *
 * ────────────────────────────────────────────────────────────────────
 *
 * Everything the caller sees is identical to SlmodemVM:
 *   vm.start()       — resolve when HELLO arrives from the shim
 *   vm.sendAT(cmd)   — same
 *   vm.on('audio')   — same
 *   vm.stop()        — same
 *
 * The only differences are under the hood:
 *   - the child is qemu-system-i386, not slmodemd
 *   - the child connects to our audio/control TCP loopback listeners
 *     through virtio-serial chardev=socket, not directly as sibling
 *     processes
 *
 * Because M1 SlmodemVM already treats those sockets as the transport
 * boundary, the parent layer (SlmodemBackend, CallSession) doesn't
 * care which backend is active. Selection is a config toggle.
 *
 * WHY SUBCLASSING
 *
 * The bulk of SlmodemVM is generic infrastructure: socket listeners,
 * wire frame parsing, event plumbing, state machine, cleanup. Only
 * the "what do we spawn and with what args" step is backend-specific.
 * A one-method override keeps the two backends from diverging on the
 * shared bits.
 *
 * SOCKET ROLES
 *
 * SlmodemVM creates TCP listeners on the host (via transport.js).
 * In M1 the shim connects to them directly. In M2, QEMU's
 * chardev=socket,server=off connects — from inside QEMU's point of
 * view it's connecting to a server the host already stood up. QEMU
 * then exposes that socket to the guest kernel via virtio-serial as
 * a character device, and the shim inside the VM opens that
 * character device. Data flows end-to-end transparently.
 */

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const { SlmodemVM } = require('./SlmodemVM');
const { buildQemuArgs, detectAccelerator } = require('./qemu-args');
const { createTransport } = require('./transport');

class QemuVM extends SlmodemVM {
  /**
   * @param {object} opts
   * @param {string} opts.qemuPath      - Path to qemu-system-i386 binary.
   * @param {string} opts.kernelPath    - Absolute path to vm/images/bzImage.
   * @param {string} opts.initrdPath    - Absolute path to vm/images/rootfs.cpio.gz.
   * @param {string} [opts.socketDir]   - Ignored in TCP transport mode;
   *                                      accepted for backwards compat.
   * @param {number} [opts.audioPort]   - TCP port for audio channel.
   *                                      Default 25800 (transport.js).
   * @param {number} [opts.controlPort] - TCP port for control channel.
   *                                      Default 25801 (transport.js).
   * @param {string} [opts.bindHost]    - Host interface to bind; default
   *                                      127.0.0.1 (loopback only).
   * @param {string} [opts.logLevel]    - error|info|debug. Controls both
   *                                      the host-side SlmodemVM logger
   *                                      AND the guest shim (via kernel
   *                                      cmdline synthmodem_log=...).
   * @param {number} [opts.memoryMb=256]
   * @param {string} [opts.accel]       - Force accelerator (see qemu-args.js).
   * @param {string} [opts.appendExtra] - Extra kernel cmdline tokens.
   * @param {object} [opts.timeouts]    - Timeouts override (see SlmodemVM).
   * @param {string} [opts.bootLogPath] - If set, append everything QEMU
   *                                      writes to stdout+stderr here.
   *                                      Created in append mode.
   * @param {string} [opts.crashDumpDir]- If set, on unclean VM exit write
   *                                      the last 256 KB of boot log
   *                                      plus a metadata sidecar to a
   *                                      timestamped file in this dir.
   */
  constructor(opts) {
    if (!opts || !opts.qemuPath || !opts.kernelPath || !opts.initrdPath) {
      throw new TypeError('QemuVM: qemuPath, kernelPath, initrdPath are required');
    }
    // SlmodemVM's constructor requires slmodemdPath and shimPath, neither
    // of which apply to QEMU mode. Pass harmless placeholders — they're
    // stored but never used because we override _spawnChild.
    super({
      slmodemdPath: '(unused: QemuVM)',
      shimPath:     '(unused: QemuVM)',
      socketDir:    opts.socketDir,
      logLevel:     opts.logLevel,
      traceWireFrames: opts.traceWireFrames,
      timeouts:     opts.timeouts,
    });

    this._qemuOpts = {
      qemuPath:      opts.qemuPath,
      kernelPath:    opts.kernelPath,
      initrdPath:    opts.initrdPath,
      memoryMb:      opts.memoryMb    ?? 256,
      accel:         opts.accel       ?? detectAccelerator(),
      appendExtra:   opts.appendExtra,
      // TCP transport configuration. Undefined here falls back to
      // transport.js's defaults (25800/25801/127.0.0.1).
      audioPort:     opts.audioPort,
      controlPort:   opts.controlPort,
      bindHost:      opts.bindHost,
      // Guest log level piggybacks on host logLevel. info/debug in the
      // guest gets us shim connect + AT traces on the serial console;
      // error keeps the guest quiet and only emits real problems.
      guestLogLevel: opts.logLevel && ['info','debug'].includes(opts.logLevel)
                     ? opts.logLevel : null,
    };

    this._bootLogPath  = opts.bootLogPath  || null;
    this._crashDumpDir = opts.crashDumpDir || null;
    this._bootLogStream = null;  // lazy-opened on first write

    for (const p of [opts.kernelPath, opts.initrdPath]) {
      if (!fs.existsSync(p)) {
        throw new Error(`QemuVM: input file missing: ${p}`);
      }
    }

    // Validate qemu binary if it looks like an absolute path. We skip
    // the check for bare names (no slash/backslash and no drive letter)
    // because those are PATH lookups resolved at spawn time.
    //
    // The most common failure here is Windows users writing
    // `qemuPath: 'C:\Program Files\qemu\qemu-system-i386.exe'` in
    // config.js without escaping the backslashes. Node parses that
    // string literal and silently drops the backslashes that don't
    // form valid escape sequences — result: a corrupted path like
    // "C:Program Filesqemuqemu-system-i386.exe" that fails spawn()
    // with a very confusing ENOENT. We try to catch this at
    // construction with a message that explains the fix.
    const q = opts.qemuPath;
    const looksLikePath = q && (
      q.includes('/') || q.includes('\\') || /^[a-zA-Z]:/.test(q)
    );
    if (looksLikePath && !fs.existsSync(q)) {
      const looksMangled = process.platform === 'win32' &&
        /^[a-zA-Z]:[A-Za-z]/.test(q);  // e.g. "C:Program" instead of "C:\\Program"
      let msg = `QemuVM: qemu binary not found at '${q}'.`;
      if (looksMangled) {
        msg += '\n       Path appears to be missing backslashes — on Windows, ' +
               'use forward slashes or double-backslashes in JS string literals:' +
               "\n           qemuPath: 'C:/Program Files/qemu/qemu-system-i386.exe'" +
               "\n       or  qemuPath: 'C:\\\\Program Files\\\\qemu\\\\qemu-system-i386.exe'";
      } else {
        msg += '\n       Set config.modem.slmodemd.qemuPath or the ' +
               'QEMU_SYSTEM_I386 environment variable.';
      }
      throw new Error(msg);
    }

    // Give QEMU more start-time headroom than the mock needs. The
    // kernel alone takes 2–4 seconds to boot under TCG, plus init
    // script, plus module loading. 15 seconds is generous.
    // Callers can override via opts.timeouts.
    if (!opts.timeouts) {
      this._opts.timeouts.connectTimeoutMs = 15000;
      this._opts.timeouts.helloTimeoutMs   = 10000;
    }

    // Most recent boot log captured from QEMU's stdout (kernel console
    // + guest init messages). Exposed via the 'stderr' event (for
    // symmetry with SlmodemVM) and accessible via this.bootLog.
    this._bootLog = '';

    // Transport descriptor (created lazily in _performStartSequence).
    // Owns the platform-specific chardev syntax, pipe/socket paths,
    // and connect ordering. See transport.js.
    this._transport = null;

    // Watch our own 'exit' event to trigger crash dump on unclean exits.
    this.on('exit', info => this._maybeCrashDump(info));
  }

  /**
   * Get the captured boot log from the guest VM. Useful for debugging
   * failed boots. Empty until the VM has emitted any output.
   */
  get bootLog() {
    return this._bootLog;
  }

  /**
   * Get the effective QEMU opts (mainly for test/debug introspection).
   */
  get qemuOpts() {
    return { ...this._qemuOpts };
  }

  /**
   * Override the parent's start sequence.
   *
   * Since the transport layer is now unified on TCP loopback (see
   * transport.js), the flow is simple and platform-agnostic:
   *
   *   1. createTransport() builds the port/bindHost descriptor
   *   2. transport.connect() starts the listeners and returns a
   *      promise that resolves with both accepted sockets
   *   3. we spawn QEMU — it connects to our listeners as a client
   *   4. once both connects land, route them through the parent's
   *      _onAudioAccepted / _onControlAccepted hooks, which handle
   *      frame parsing and HELLO detection as normal
   *
   * The listeners are started BEFORE spawn, so QEMU never hits
   * ECONNREFUSED trying to dial in.
   *
   * @protected
   */
  async _performStartSequence() {
    this._transport = createTransport({
      audioPort:   this._qemuOpts.audioPort,
      controlPort: this._qemuOpts.controlPort,
      bindHost:    this._qemuOpts.bindHost,
    });
    // Expose the addresses on the parent's fields too so logs and
    // diagnostics that reference _audioPath / _controlPath still work.
    this._audioPath   = this._transport.audio.nodeAddress;
    this._controlPath = this._transport.control.nodeAddress;

    // Start listeners, then spawn QEMU. connect() returns a promise
    // that resolves once both accepts have landed.
    const acceptsPromise = this._transport.connect();

    this._spawnChild();

    let audio, control, servers;
    try {
      ({ audio, control, servers } = await acceptsPromise);
    } catch (err) {
      // Listener error (EADDRINUSE is the common case) or QEMU failed
      // to connect. Kill the child if it's still around and propagate.
      try { this._child && this._child.kill(); } catch (_) {}
      throw err;
    }

    // Hold on to the servers so stop() can close them cleanly.
    this._audioServer   = servers[0];
    this._controlServer = servers[1];

    this._onAudioAccepted(audio);
    this._onControlAccepted(control);
  }

  /**
   * Spawn qemu-system-i386.
   *
   * Contract: must not block waiting for audio/control connections —
   * those are awaited asynchronously by the caller on Windows, and
   * arrive via the listener on POSIX.
   */
  _spawnChild() {
    const { args, accel } = buildQemuArgs({
      kernelPath:    this._qemuOpts.kernelPath,
      initrdPath:    this._qemuOpts.initrdPath,
      transport:     this._transport,
      memoryMb:      this._qemuOpts.memoryMb,
      accel:         this._qemuOpts.accel,
      appendExtra:   this._qemuOpts.appendExtra,
      guestLogLevel: this._qemuOpts.guestLogLevel,
    });
    this._qemuOpts.accelResolved = accel;

    this._child = spawn(this._qemuOpts.qemuPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // QEMU's stdout is the guest kernel console (-nographic routes
    // serial to stdio by default) plus QEMU's own startup messages.
    // We don't split them apart — the whole stream is the "boot log"
    // and is useful for diagnosing boot failures.
    //
    // Three things happen with every byte:
    //   1. appended to the capped in-memory buffer (this._bootLog)
    //   2. emitted as 'stderr' for subscribers
    //   3. optionally appended to this._bootLogPath on disk
    const onOut = chunk => {
      const text = chunk.toString('utf8');
      this._bootLog += text;
      // Cap the buffer so a never-ending boot log doesn't OOM us.
      if (this._bootLog.length > 256 * 1024) {
        this._bootLog = this._bootLog.slice(-128 * 1024);
      }
      this.emit('stderr', text);
      if (this._bootLogPath) this._writeBootLog(text);
    };
    this._child.stdout.on('data', onOut);
    this._child.stderr.on('data', onOut);

    this._hookChildLifecycle();
  }

  /**
   * Append a chunk to the persistent boot log file. Lazy-opens the
   * write stream on first call. Errors are swallowed — the boot log
   * is diagnostic, never critical.
   * @private
   */
  _writeBootLog(text) {
    if (!this._bootLogStream) {
      try {
        // Ensure parent dir exists.
        const dir = path.dirname(this._bootLogPath);
        fs.mkdirSync(dir, { recursive: true });
        this._bootLogStream = fs.createWriteStream(this._bootLogPath, { flags: 'a' });
        this._bootLogStream.on('error', () => { this._bootLogStream = null; });
        // Header to separate boot sessions.
        const hdr = `\n\n==== QemuVM boot ${new Date().toISOString()} ====\n`;
        this._bootLogStream.write(hdr);
      } catch (_) {
        this._bootLogStream = null;
        return;
      }
    }
    try { this._bootLogStream.write(text); } catch (_) { /* ignore */ }
  }

  /**
   * Called when the child emits 'exit'. If it was an unclean exit and
   * crashDumpDir is set, write a dump file for post-mortem.
   * @private
   */
  _maybeCrashDump(info) {
    if (!this._crashDumpDir) return;
    // Clean shutdowns are code=0 OR signal=SIGTERM (we killed it on stop).
    const clean = (info.code === 0) ||
                  (info.code === null && info.signal === 'SIGTERM');
    if (clean) return;
    try {
      fs.mkdirSync(this._crashDumpDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(this._crashDumpDir, `qemuvm-crash-${stamp}.log`);
      const metaFile = path.join(this._crashDumpDir, `qemuvm-crash-${stamp}.meta.json`);
      fs.writeFileSync(logFile, this._bootLog);
      fs.writeFileSync(metaFile, JSON.stringify({
        timestamp:     new Date().toISOString(),
        exitCode:      info.code,
        exitSignal:    info.signal,
        state:         this._state,
        accel:         this._qemuOpts.accelResolved,
        kernelPath:    this._qemuOpts.kernelPath,
        initrdPath:    this._qemuOpts.initrdPath,
        bootLogBytes:  this._bootLog.length,
      }, null, 2));
    } catch (_) { /* ignore dump failures */ }
  }

  /**
   * Override stop to also close the boot log stream and release
   * transport resources.
   */
  async stop(...args) {
    const r = await super.stop(...args);
    if (this._bootLogStream) {
      try { this._bootLogStream.end(); } catch (_) {}
      this._bootLogStream = null;
    }
    if (this._transport) {
      try { this._transport.cleanup(); } catch (_) {}
      this._transport = null;
    }
    return r;
  }

  /**
   * Convenience: find qemu-system-i386 on PATH, respecting an override
   * via the QEMU_SYSTEM_I386 environment variable. Doesn't validate
   * that it's actually runnable — caller should check existence.
   */
  static resolveQemuPath(override) {
    if (override) return override;
    if (process.env.QEMU_SYSTEM_I386) return process.env.QEMU_SYSTEM_I386;
    return 'qemu-system-i386';  // rely on PATH lookup at spawn time
  }

  /**
   * Convenience: compute the canonical kernel + initrd paths relative
   * to the repo root. Used by tests and by the default config path.
   */
  static defaultImagePaths(repoRoot) {
    return {
      kernelPath: path.join(repoRoot, 'vm', 'images', 'bzImage'),
      initrdPath: path.join(repoRoot, 'vm', 'images', 'rootfs.cpio.gz'),
    };
  }
}

module.exports = { QemuVM };
