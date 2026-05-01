'use strict';

/**
 * SynthModem — main entry point
 *
 * Starts the SIP server and wires up call session management.
 *
 * CLI flags:
 *   --force-proto PROTO   Force a specific modem protocol (bypasses V.8 negotiation)
 *                         Valid values: V21 V22 V22bis V23 V32bis V34
 *   --verbose             Set log level to trace
 */

const config           = require('../config');

// ─── CLI flag handling ─────────────────────────────────────────────────────────
(function applyCLI() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : null; };
  const has = (flag) => args.includes(flag);
  const proto = get('--force-proto');
  if (proto) {
    const valid = ['V21','Bell103','V22','V22bis','V23','V32bis','V34'];
    if (!valid.includes(proto)) {
      console.error(`Unknown protocol "${proto}". Valid: ${valid.join(' ')}`);
      process.exit(1);
    }
    config.modem.native.forceProtocol = proto;
    console.log(`[CLI] Forcing protocol: ${proto}`);
  }
  if (has('--verbose')) config.logging.level = 'trace';
})();
const { makeLogger }   = require('./logger');
const { SipServer }    = require('./sip/SipServer');
const { CallSession }  = require('./session/CallSession');

const log = makeLogger('SynthModem');

// ─── Global state ─────────────────────────────────────────────────────────────

const sipServer   = new SipServer();
let activeSession = null;   // single active session (architecture allows expansion)
let modemPool     = null;   // ModemBackendPool for VM-backed backends
                            // (slmodemd or slmodemd-pjsip). Null in native.

// ─── SIP event handlers ────────────────────────────────────────────────────────

sipServer.on('invite', async (dialog, msg) => {
  if (activeSession && activeSession.active) {
    log.warn(`Rejecting INVITE — session already active (${activeSession.id})`);
    return; // SipServer already sends 486 in this case
  }

  log.info(`Incoming call: ${dialog.remoteUri} → ${dialog.localUri}`);

  const session = new CallSession(sipServer, dialog, { modemPool });
  activeSession = session;

  session.on('ended', ({ callId, reason }) => {
    log.info(`Session ended: ${callId} (${reason})`);
    if (activeSession && activeSession.id === callId) {
      activeSession = null;
    }
  });

  try {
    await session.setup();
  } catch (err) {
    log.error(`Failed to setup session: ${err.message}`);
    activeSession = null;
  }
});

sipServer.on('ack', (dialog) => {
  if (activeSession && activeSession.id === dialog.callId) {
    // activate() is async; its own internal error handling hangs up
    // on failure. We catch here only to avoid unhandled promise
    // rejection warnings — nothing to do beyond that.
    Promise.resolve(activeSession.activate()).catch(err => {
      log.error(`activate failed: ${err && err.message}`);
    });
  }
});

sipServer.on('bye', (dialog) => {
  if (activeSession && activeSession.id === dialog.callId) {
    activeSession.onBye();
  }
});

sipServer.on('cancel', (dialog) => {
  if (activeSession && activeSession.id === dialog.callId) {
    activeSession.onBye();
  }
});

sipServer.on('error', (err) => {
  log.error(`SIP server error: ${err.message}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  log.info('═══════════════════════════════════════');
  log.info('  SynthModem — Modem/Telnet Gateway');
  log.info('═══════════════════════════════════════');
  log.info(`Config: SIP ${config.sip.host}:${config.sip.port}, RTP ${config.rtp.portMin}-${config.rtp.portMax}`);
  log.info(`Modem role: ${config.modem.role}, backend: ${config.modem.backend}`);
  if (config.modem.backend === 'native' || config.modem.backend === 'auto') {
    if (config.modem.backend === 'native') {
      log.info(`  protocols: ${config.modem.native.protocolPreference.join(', ')}` +
               (config.modem.native.forceProtocol
                  ? ` [FORCED: ${config.modem.native.forceProtocol}]`
                  : ''));
    }

    // On Windows the default system timer interrupt fires at ~15.6 ms.
    // setInterval(5)+Date.now() pacing for our RTP TX path is gated on
    // that quantum, producing 16/31/16/31 ms inter-packet stutter (vs
    // ideal 20 ms). Hardware modems on the wire can't track the
    // resulting carrier-phase jitter during long pure-marking idle and
    // produce visible terminal garbage. timeBeginPeriod(1) raises the
    // system timer rate to 1 ms while we hold the claim — same trick
    // browsers and audio software have used for years.
    //
    // The native addon is optional. If it failed to build, the JS
    // wrapper logs a clear warning and we run with default timer
    // resolution (degraded RTP timing on Windows; fine on Linux).
    // The slmodemd-pjsip backend does not need this — its DSP and
    // pacing are in C inside the VM, which runs at PJSIP's own clock.
    //
    // 'auto' mode also needs this: when the swap to native fires,
    // the in-process ModemDSP takes over the TX path on the host's
    // event loop and has the same Windows timer-quantum problem
    // native does. The bug shows up as ongoing visible-but-bogus
    // characters on the caller's terminal after the modem connects.
    // Capture-enabled audio paths happened to mask it (sync disk
    // writes added enough latency to dampen the timer-quantum
    // bursts); capture-disabled paths exposed it. Always claim the
    // 1 ms timer for any backend that may run the native DSP.
    try {
      const tres = require('../native/win-timer-resolution');
      const r = tres.begin(1);
      if (tres.isAvailable() && r === 0) {
        if (tres.platform() === 'win32') {
          log.info('Windows multimedia timer raised to 1 ms (timeBeginPeriod)');
        }
      }
    } catch (e) {
      log.warn(`Timer resolution module load failed: ${e.message}`);
    }
  }

  try {
    /* Pre-warm the modem VM if a VM-backed backend is in use. This
     * gates SIP-server startup on the VM being ready, so our first
     * "ready" log line truly means we can accept calls without any
     * boot delay at call time.
     *
     * Backend slmodemd-pjsip: ~9s boot including PJSIP init +
     * REGISTER roundtrip through VmRegistrar.
     *
     * Backend 'auto': also pre-warms the VM, since every call starts
     * in slmodemd-pjsip b2bua mode. The VM is recycled after a V.8
     * timeout-without-CM falls through to the native backend (per
     * CallSession's auto-mode swap logic). */
    const backend = (config.modem && config.modem.backend) || 'native';
    const needsVm = (backend === 'slmodemd-pjsip' || backend === 'auto');
    if (needsVm) {
      const { ModemBackendPool } = require('./backends/ModemBackendPool');
      const { PjsipBackend }     = require('./backends/PjsipBackend');
      const { QemuVM }           = require('../vm/qemu-runner/QemuVM');
      const path                 = require('path');
      const fs                   = require('fs');
      log.info(`Pre-warming modem VM (${backend} backend)…`);

      /* Resolve qemu + kernel from the slmodemd-pjsip config block. */
      const repoRoot = path.resolve(__dirname, '..');
      const slCfg    = (config.modem && config.modem['slmodemd-pjsip']) || {};
      const qemuCfg  = slCfg.qemu || {};

      const qemuPath = QemuVM.resolveQemuPath(qemuCfg.qemuPath);

      /* kernelPath — prefer config; else fall back to repo-relative.
       * Resolve against repoRoot if given as a relative path so the
       * process's cwd doesn't matter. */
      const kRaw = qemuCfg.kernelPath ||
                   path.join('vm', 'images', 'bzImage');
      const kernelPath = path.isAbsolute(kRaw) ? kRaw
                                               : path.resolve(repoRoot, kRaw);

      /* initrdPath — the slmodemd-pjsip backend uses
       * rootfs-slmodemd-pjsip.cpio.gz, hardcoded here rather than
       * pulled from config (keeps config drift from breaking the
       * launch path). */
      const initrdPath = path.join(repoRoot, 'vm', 'images',
                                   'rootfs-slmodemd-pjsip.cpio.gz');

      /* Fail-fast with an actionable message if any prerequisite is
       * missing — much nicer than an "ENOENT" stack trace from a
       * child_process spawn deep in the pool warmup. */
      for (const [label, p] of [
        ['QEMU',   qemuPath],
        ['kernel', kernelPath],
        ['initrd', initrdPath],
      ]) {
        if (p.includes(path.sep) && !fs.existsSync(p)) {
          log.error(`Cannot start: ${label} not found at ${p}`);
          if (label === 'QEMU') {
            log.error("  Set config.modem['slmodemd-pjsip'].qemu.qemuPath " +
                      'to the absolute path of qemu-system-i386 (or .exe ' +
                      'on Windows), or set the QEMU_SYSTEM_I386 environment ' +
                      'variable.');
          } else if (label === 'initrd') {
            log.error('  Build it with: make -C vm');
          }
          process.exit(1);
        }
      }

      /* If the user set config.modem['slmodemd-pjsip'].bootLogPath,
       * forward it to PjsipBackend — the VM console goes there. Each
       * VM gets its own file so per-call logs don't clobber each
       * other: we append a timestamp per backend instance when the
       * factory is invoked. */
      const bootLogBase = slCfg.bootLogPath || null;
      if (bootLogBase) {
        try {
          const dir = path.dirname(
            path.isAbsolute(bootLogBase) ? bootLogBase
                                         : path.resolve(repoRoot, bootLogBase));
          fs.mkdirSync(dir, { recursive: true });
        } catch (_) { /* ignore; backend will fail loudly if dir is bad */ }
      }
      let _bootLogSeq = 0;

      modemPool = new ModemBackendPool({
        backendOpts: {
          qemuPath, kernelPath, initrdPath,
          role: config.modem.role,
          enableControl: true,   /* step 5a: modemd-ctrl for AT/data */
          useRegistrar:  true,   /* step 5c: d-modem registers here */
          /* atInit runs via PjsipBackend.activate() before ATA. */
          atInit: slCfg.atInit || [],
        },
        backendFactory: (opts) => {
          /* Per-VM bootLogPath. If the configured value ends in '.log',
           * insert a sequence number before the extension; otherwise
           * append '.N'. On Node restart the sequence restarts at 0;
           * that's fine because the previous run's logs are still on
           * disk with different timestamps. */
          let perCallOpts = opts;
          if (bootLogBase) {
            const seq = _bootLogSeq++;
            const resolved = path.isAbsolute(bootLogBase)
              ? bootLogBase
              : path.resolve(repoRoot, bootLogBase);
            const parsed = path.parse(resolved);
            const ts = new Date().toISOString()
              .replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
            const bootLogPath = path.join(
              parsed.dir,
              `${parsed.name}.${ts}-${seq}${parsed.ext || '.log'}`);
            log.info(`[backend slmodemd-pjsip] boot log → ${bootLogPath}`);
            perCallOpts = { ...opts, bootLogPath };
          }
          return new PjsipBackend(perCallOpts);
        },
      });
      modemPool.on('error', err => {
        log.error(`Modem pool error: ${err.message}`);
      });
      await modemPool.start();
      log.info(`Modem VM warm (${backend})`);
    }

    await sipServer.start();
    log.info('SynthModem ready — waiting for calls');
  } catch (err) {
    log.error(`Failed to start: ${err.message}`);
    // Best-effort cleanup of a partially-started pool.
    if (modemPool) {
      try { await modemPool.stop(); } catch (_) {}
    }
    process.exit(1);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal} — shutting down`);
  if (activeSession) {
    try { activeSession.hangup('shutdown'); } catch (_) {}
  }
  try { await sipServer.stop(); } catch (err) {
    log.warn(`SIP stop failed: ${err.message}`);
  }
  if (modemPool) {
    try { await modemPool.stop(); } catch (err) {
      log.warn(`Modem pool stop failed: ${err.message}`);
    }
  }
  // Release the Windows multimedia timer claim, if we raised it. No-op
  // on non-Windows / addon-not-loaded.
  try {
    const tres = require('../native/win-timer-resolution');
    tres.end();
  } catch (_) { /* ignore */ }
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
