'use strict';

/**
 * SynthModem Test Client
 *
 * A self-contained CLI tool that:
 *  1. Starts a SIP UAC and places a call to SynthModem
 *  2. Runs a virtual originating modem (V.8 originate role)
 *  3. Establishes RTP audio exchange
 *  4. Optionally plays modem audio through system speakers
 *  5. Once the modem handshake completes, provides interactive terminal I/O
 *     that mirrors what a real modem user would experience
 *
 * Usage:
 *   node test-client/index.js [options]
 *
 * Options:
 *   --audio         Enable speaker audio output
 *   --volume N      Set audio volume 0.0-1.0 (default 0.8)
 *   --proto PROTO   Force protocol (V21|V22|V22bis|V23|V32bis|V34)
 *   --auto          Auto-connect using config.testClient.autoConnect
 *   --server HOST   Override server host
 *   --port PORT     Override server SIP port
 *   --verbose       Extra debug output
 *   --help          Show this help
 */

const readline       = require('readline');
const dgram          = require('dgram');
const { EventEmitter } = require('events');

// ─── Parse CLI args before loading config (so we can override) ───────────────

const args   = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = flag => args.includes(flag);

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
SynthModem Test Client

Usage: node test-client/index.js [options]

Options:
  --audio           Enable speaker audio output
  --volume <n>      Audio volume 0.0-1.0  (default: 0.8)
  --proto  <name>   Force protocol: V21 V22 V22bis V23 V32bis V34
  --auto            Auto-connect to address in config.testClient.autoConnect
  --server <host>   Override SIP server host
  --port   <port>   Override SIP server port
  --verbose         Enable verbose/trace logging
  --help            Show this help
`);
  process.exit(0);
}

// Apply CLI overrides to config before other modules load it
const config = require('../config');
if (hasFlag('--audio'))            config.testClient.audioOutput   = true;
if (getArg('--volume', null))      config.testClient.audioOutputVolume = parseFloat(getArg('--volume', '0.8'));
if (getArg('--proto',  null)) {
  // Use advertiseProtocol so V.8 negotiation still runs but the CM
  // only lists the requested protocol. The server decodes the CM and
  // selects the matching protocol. Both sides end up on the same one.
  config.modem.advertiseProtocol = getArg('--proto', null);
}
if (getArg('--server', null))      config.testClient.serverHost    = getArg('--server', config.testClient.serverHost);
if (getArg('--port',   null))      config.testClient.serverPort    = parseInt(getArg('--port', String(config.testClient.serverPort)), 10);
if (hasFlag('--verbose'))          config.logging.level            = 'trace';
if (hasFlag('--auto'))             ; // handled below

const { makeLogger }       = require('../src/logger');
const { SipClient }        = require('./SipClient');
const { ModemEmulator }    = require('./ModemEmulator');
const { AudioOutput }      = require('./AudioOutput');
const { RtpSession, allocateRtpPort, releaseRtpPort } = require('../src/rtp/RtpSession');

const log = makeLogger('TestClient');
const tc  = config.testClient;

// ─── Colour helpers ───────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  grey:   '\x1b[90m',
  magenta:'\x1b[35m',
};

function banner() {
  console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════════════════╗
║     SynthModem Test Client  v1.0                 ║
║     Virtual Originating Modem + SIP UAC          ║
╚══════════════════════════════════════════════════╝${C.reset}
`);
}

function status(msg) {
  process.stdout.write(`${C.yellow}[STATUS]${C.reset} ${msg}\n`);
}

function success(msg) {
  process.stdout.write(`${C.green}[OK]${C.reset} ${msg}\n`);
}

function error(msg) {
  process.stdout.write(`${C.red}[ERROR]${C.reset} ${msg}\n`);
}

function info(msg) {
  process.stdout.write(`${C.grey}[INFO]${C.reset} ${msg}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner();

  info(`Server:     ${tc.serverHost}:${tc.serverPort} (${tc.serverTransport.toUpperCase()})`);
  info(`From:       sip:${tc.fromUser}@${tc.fromDomain}`);
  info(`To:         sip:${tc.toUser}@${tc.toDomain}`);
  info(`Protocol:   ${config.modem.advertiseProtocol || config.modem.forceProtocol || 'auto (V.8 negotiation)'}`);
  info(`Audio out:  ${tc.audioOutput ? `enabled (volume ${tc.audioOutputVolume})` : 'disabled (use --audio to enable)'}`);
  console.log('');

  // ── Set up audio output ────────────────────────────────────────────────────
  const audioOut = new AudioOutput();
  const audioAvail = await audioOut.init();
  if (tc.audioOutput && !audioAvail) {
    status('Speaker not available — continuing without audio output');
  }

  // ── Set up RTP ─────────────────────────────────────────────────────────────
  const rtpPort = tc.localRtpPort;
  const rtp     = new RtpSession();

  try {
    await rtp.open(rtpPort);
  } catch (err) {
    error(`Failed to open RTP port ${rtpPort}: ${err.message}`);
    process.exit(1);
  }
  info(`RTP listening on port ${rtpPort}`);

  // ── Set up modem emulator ──────────────────────────────────────────────────
  const modem = new ModemEmulator();

  // Modem audio out → RTP send
  modem.on('audioOut', samples => {
    rtp.send(samples);
    if (audioAvail) audioOut.push(samples);
  });

  // RTP audio in → modem
  rtp.on('audio', samples => {
    modem.receiveAudio(samples);
  });

  // ── Set up SIP client ──────────────────────────────────────────────────────
  const sip = new SipClient();

  try {
    await sip.start();
  } catch (err) {
    error(`Failed to start SIP client: ${err.message}`);
    process.exit(1);
  }

  // ── Wire SIP events ────────────────────────────────────────────────────────

  sip.on('ringing', () => {
    status('Ringing…');
  });

  sip.on('connected', (dialog) => {
    success(`SIP connected — remote RTP: ${dialog.remoteRtpAddr}:${dialog.remoteRtpPort}`);
    const codec = dialog.negotiatedCodec || config.rtp.preferredCodecs[0];
    success(`Codec: ${codec.name} (PT ${codec.payloadType})`);

    // Point RTP at remote
    rtp.setRemote(dialog.remoteRtpAddr, dialog.remoteRtpPort);
    rtp.setCodec(codec.name, codec.payloadType);

    // Start modem handshake
    status('Starting modem handshake…');
    if (tc.verbose) info('Sending CI tones / waiting for ANSam…');
    modem.start();
  });

  sip.on('failed', reason => {
    error(`Call failed: ${reason}`);
    cleanup(1);
  });

  sip.on('hungup', () => {
    status('Remote hung up');
    cleanup(0);
  });

  // ── Wire modem events ──────────────────────────────────────────────────────

  modem.on('connected', info => {
    const proto = info.protocol;
    const bps   = info.bps;
    console.log('');
    console.log(`${C.green}${C.bold}CONNECT ${bps}${C.reset}`);
    console.log(`${C.grey}Protocol: ${proto} | Speed: ${bps} bps${C.reset}`);
    console.log('');
    startTerminal(modem, sip);
  });

  modem.on('silenceHangup', () => {
    status('Silence timeout — hanging up');
    sip.hangup();
    setTimeout(() => cleanup(0), 500);
  });

  // ── Place the call ─────────────────────────────────────────────────────────
  status(`Calling sip:${tc.toUser}@${tc.serverHost}:${tc.serverPort}…`);
  try {
    await sip.call();
  } catch (err) {
    error(`Failed to place call: ${err.message}`);
    cleanup(1);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  function cleanup(code) {
    modem.stop();
    rtp.close();
    audioOut.close();
    sip.stop();
    if (rl) rl.close();
    process.exit(code);
  }

  process.on('SIGINT',  () => { console.log('\n'); sip.hangup(); setTimeout(() => cleanup(0), 300); });
  process.on('SIGTERM', () => { sip.hangup(); setTimeout(() => cleanup(0), 300); });
}

// ─── Interactive terminal ─────────────────────────────────────────────────────

let rl = null;

function startTerminal(modem, sip) {
  // Put stdin in raw mode so we pass characters immediately
  const tc_cfg = config.terminal;

  // Receive data from modem → write to stdout
  modem.on('data', buf => {
    // Filter QAM idle-noise bytes (high-bit single bytes that aren't valid UTF-8).
    // Allow: printable ASCII, CR/LF/TAB/ESC, and valid UTF-8 multi-byte sequences.
    let out = Buffer.alloc(buf.length);
    let outLen = 0;
    let i = 0;
    while (i < buf.length) {
      const b = buf[i];
      if (b < 0x80) {
        // ASCII: pass printable chars and common control chars
        if (b >= 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x1B) {
          out[outLen++] = b;
        }
        i++;
      } else if (b >= 0xC2 && b < 0xF0 && i + 1 < buf.length) {
        // Valid UTF-8 multi-byte start — pass the whole sequence
        const seqLen = b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4;
        let valid = true;
        for (let j = 1; j < seqLen && i + j < buf.length; j++) {
          if ((buf[i+j] & 0xC0) !== 0x80) { valid = false; break; }
        }
        if (valid && i + seqLen <= buf.length) {
          for (let j = 0; j < seqLen; j++) out[outLen++] = buf[i+j];
          i += seqLen;
        } else { i++; } // invalid sequence — skip
      } else {
        i++; // high-bit byte not part of valid UTF-8 — discard
      }
    }
    const str = out.slice(0, outLen).toString('utf8').replace(/\r?\n/g, '\r\n');
    if (str.length > 0) process.stdout.write(str);
  });

  // Auto-connect mode
  if (hasFlag('--auto') && config.testClient.autoConnect) {
    const target = config.testClient.autoConnect;
    info(`Auto-connect: sending "${target}"`);
    // Send the target address as if typed + Enter
    setTimeout(() => {
      modem.write(Buffer.from(target + '\r\n'));
    }, 500);
    // Still set up stdin so user can interact after connect
  }

  // Switch stdin to raw mode for byte-by-byte input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', buf => {
      // Ctrl+C / Ctrl+D → hangup
      if (buf[0] === 0x03 || buf[0] === 0x04) {
        console.log('\n');
        sip.hangup();
        setTimeout(() => {
          modem.stop();
          sip.stop();
          process.exit(0);
        }, 400);
        return;
      }
      // Pass all other bytes to modem
      modem.write(buf);
    });

    info('Terminal active. Ctrl+C to hang up.');
  } else {
    // Non-TTY (piped input) — line mode
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', line => {
      modem.write(Buffer.from(line + '\r\n'));
    });
    rl.on('close', () => {
      sip.hangup();
      setTimeout(() => process.exit(0), 400);
    });
    info('Non-TTY mode: line-buffered input');
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
