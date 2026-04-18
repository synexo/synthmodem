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
    const valid = ['V21','V22','V22bis','V23','V32bis','V34'];
    if (!valid.includes(proto)) {
      console.error(`Unknown protocol "${proto}". Valid: ${valid.join(' ')}`);
      process.exit(1);
    }
    config.modem.forceProtocol = proto;
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

// ─── SIP event handlers ────────────────────────────────────────────────────────

sipServer.on('invite', async (dialog, msg) => {
  if (activeSession && activeSession.active) {
    log.warn(`Rejecting INVITE — session already active (${activeSession.id})`);
    return; // SipServer already sends 486 in this case
  }

  log.info(`Incoming call: ${dialog.remoteUri} → ${dialog.localUri}`);

  const session = new CallSession(sipServer, dialog);
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
    activeSession.activate();
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
  log.info('  SynthModem v1.0 — Modem/Telnet Gateway');
  log.info('═══════════════════════════════════════');
  log.info(`Config: SIP ${config.sip.host}:${config.sip.port}, RTP ${config.rtp.portMin}-${config.rtp.portMax}`);
  log.info(`Modem role: ${config.modem.role}, protocols: ${config.modem.protocolPreference.join(', ')}${config.modem.forceProtocol ? ' [FORCED: '+config.modem.forceProtocol+']' : ''}`);

  try {
    await sipServer.start();
    log.info('SynthModem ready — waiting for calls');
  } catch (err) {
    log.error(`Failed to start: ${err.message}`);
    process.exit(1);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function shutdown(signal) {
  log.info(`Received ${signal} — shutting down`);
  if (activeSession) activeSession.hangup('shutdown');
  await sipServer.stop();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
