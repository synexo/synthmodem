#!/usr/bin/env node
/**
 * V.22bis end-to-end regression test.
 *
 * This test mirrors ModemDSP's actual execution path so that any bug that
 * manifests in the live client/server run also manifests here.
 *
 * Pipeline per block (both directions):
 *
 *     TX modulator.generateAudio(160)
 *       → G.711 PCMU encode (mirrors RTP encode)
 *         → G.711 PCMU decode (mirrors RTP decode at RX)
 *           → AGC.process() if config.modem.agcEnabled   ← NEW
 *             → RX demodulator.process(samples)
 *
 * Three properties are verified:
 *   1. Banner sent by the server arrives at the client with byte-for-byte
 *      equality (no corruption, no missing or extra bytes).
 *   2. User input typed by the client arrives at the server with byte-for-byte
 *      equality.
 *   3. No spurious bytes arrive on either side during the 60-second idle
 *      period following each payload. This catches long-running corruption
 *      that only manifests after tens of seconds of modem idle time.
 *
 * The test runs for 60 seconds of simulated time because historical bugs
 * have been observed to accumulate slowly (symptom appeared 10-60 seconds
 * into the live session). A shorter run would mask them.
 *
 * Exit 0 on pass, 1 on fail.
 */
'use strict';

const { V22bis }  = require('../src/dsp/protocols/V22');
const { AGC }     = require('../src/dsp/Primitives');
const codec       = require('../src/rtp/Codec');
const config      = require('../config');

const SR            = 8000;
const BLOCK         = 160;         // 20ms — production RTP/txTick interval
const TRAIN_MS      = 1024;        // matches config.modem.trainingDurationMs.V22bis
const RUN_MS        = 60000;       // 60 seconds — matches observed live-failure window
const TYPE_AT_MS    = 2000;        // client "types" user input at t=2s

const BANNER =
  '\r\n          S Y N T H M O D E M\r\n' +
  '       Telnet Gateway  v1.0\r\n\r\n' +
  '  Type <host> or <host>:<port> to connect.\r\n' +
  '  Type QUIT to disconnect.\r\nCONNECT> ';
const USER_INPUT = 'google.com\r\n';

// G.711 PCMU round-trip — same encode/decode happens in RtpSession
const encode = s => codec.encode(s, 'PCMU');
const decode = b => codec.decode(b, 'PCMU');

function run() {
  const server = new V22bis('answer');
  const client = new V22bis('originate');
  const agcClient = new AGC(config.modem);
  const agcServer = new AGC(config.modem);

  // Apply the same AGC gate ModemDSP uses: on = config.modem.agcEnabled
  const rxAtClient = audio => {
    const pcm = decode(encode(audio));
    return config.modem.agcEnabled ? agcClient.process(pcm) : pcm;
  };
  const rxAtServer = audio => {
    const pcm = decode(encode(audio));
    return config.modem.agcEnabled ? agcServer.process(pcm) : pcm;
  };

  const clientGot = [], serverGot = [];
  server.on('data', b => { for (const x of b) serverGot.push(x); });
  client.on('data', b => { for (const x of b) clientGot.push(x); });

  // ─── Training phase ────────────────────────────────────────────────────────
  //
  // The handshake engine calls generateAudio(trainSamples) once with a large
  // sample count. trainSamples = 1024 * 8 = 8192. 8192 is deliberately NOT
  // a multiple of SPS (40/3 for V.22bis), so this call ends mid-symbol.
  // The modulator must suspend that symbol and resume it on the next call.
  const trainSamples     = Math.round(TRAIN_MS * SR / 1000);
  const serverTrainAudio = server.generateAudio(trainSamples);
  const clientTrainAudio = client.generateAudio(trainSamples);

  // Deliver in 160-sample chunks (mimicking txTick draining an audio queue)
  for (let pos = 0; pos < trainSamples; pos += BLOCK) {
    const n = Math.min(BLOCK, trainSamples - pos);
    client.receiveAudio(rxAtClient(serverTrainAudio.subarray(pos, pos + n)));
    server.receiveAudio(rxAtServer(clientTrainAudio.subarray(pos, pos + n)));
  }
  const transientClient = clientGot.length;
  const transientServer = serverGot.length;

  // ─── Data phase ────────────────────────────────────────────────────────────
  //
  // txTick pattern: each side generateAudio(160) every 20ms for RUN_MS.
  // To mirror real networks, we drop ~1% of packets server→client and
  // substitute silence (matching RtpSession's concealment behaviour).
  // Phantom bytes on silence substitution was a real bug we regress-test
  // against here — live runs reliably saw 1-3 garbage chars post-banner
  // without silence suppression in the demodulator.
  server.write(Buffer.from(BANNER));
  const inputBlockIdx = Math.round(TYPE_AT_MS / 20);
  const totalBlocks   = Math.round(RUN_MS / 20);
  // Deterministic drop schedule — every 97th block, offset so drops land
  // well after the banner has been fully transmitted (banner = 145 bytes
  // @ 240 bytes/s ≈ 600ms = 30 blocks).
  const DROP_EVERY = 97;
  const DROP_FROM  = 120;  // start dropping at t=2.4s, after user input too
  let silenceInjected = 0;
  for (let i = 0; i < totalBlocks; i++) {
    if (i === inputBlockIdx) client.write(Buffer.from(USER_INPUT));
    let serverAudio = server.generateAudio(BLOCK);
    // Inject silence: simulate RTP concealment of a missing packet.
    if (i >= DROP_FROM && (i - DROP_FROM) % DROP_EVERY === 0) {
      serverAudio = new Float32Array(BLOCK);
      silenceInjected++;
    }
    client.receiveAudio(rxAtClient(serverAudio));
    server.receiveAudio(rxAtServer(client.generateAudio(BLOCK)));
  }

  return {
    clientTransient: transientClient,
    serverTransient: transientServer,
    clientPayload:   Buffer.from(clientGot.slice(transientClient)),
    serverPayload:   Buffer.from(serverGot.slice(transientServer)),
    silenceInjected,
    agcClientGain:   agcClient.gain !== undefined ? agcClient.gain : null,
    agcServerGain:   agcServer.gain !== undefined ? agcServer.gain : null,
  };
}

function main() {
  const r = run();
  const clientText = r.clientPayload.toString('binary');
  const serverText = r.serverPayload.toString('binary');

  // Three assertions:
  //   1. Client received exactly BANNER (no corruption, no extra bytes after)
  //   2. Server received exactly USER_INPUT (no corruption, no extra bytes)
  //   3. Initial transient was small (scrambler ramp-up only, ~3-5 bytes max)
  const bannerOk     = clientText === BANNER;
  const inputOk      = serverText === USER_INPUT;
  const transientOk  = r.clientTransient <= 6 && r.serverTransient <= 6;

  console.log('─────────────────────────────────────────────────────');
  console.log('  V.22bis end-to-end regression test');
  console.log('─────────────────────────────────────────────────────');
  console.log('  AGC enabled:  ' + config.modem.agcEnabled);
  if (r.agcClientGain !== null) {
    console.log('  AGC gain:     client=' + r.agcClientGain.toFixed(3) +
                ', server=' + r.agcServerGain.toFixed(3));
  }
  console.log('  Run duration: ' + (RUN_MS/1000) + ' s');
  console.log('  Silence blocks injected: ' + r.silenceInjected);
  console.log('');
  console.log('  Scrambler ramp-up bytes (expect <= 6):');
  console.log('    client ← server : ' + r.clientTransient +
              (r.clientTransient <= 6 ? '  OK' : '  EXCESSIVE'));
  console.log('    server ← client : ' + r.serverTransient +
              (r.serverTransient <= 6 ? '  OK' : '  EXCESSIVE'));
  console.log('');
  console.log('  Banner (expect ' + BANNER.length + ' bytes): got ' +
              r.clientPayload.length + '  ' + (bannerOk ? 'OK' : 'CORRUPT'));
  console.log('  Input  (expect ' + USER_INPUT.length + ' bytes): got ' +
              r.serverPayload.length + '  ' + (inputOk ? 'OK' : 'CORRUPT'));

  const show = s => s.replace(/[^\x20-\x7e]/g, ch =>
    ch === '\r' ? '↵' : ch === '\n' ? '↲' : '·');

  if (!bannerOk) {
    console.log('');
    console.log('  Banner expected (' + BANNER.length + '): "' + show(BANNER) + '"');
    console.log('  Banner received (' + clientText.length + '): "' + show(clientText.slice(0, 200)) +
                (clientText.length > 200 ? '...' : '') + '"');
  }
  if (!inputOk) {
    console.log('');
    console.log('  Input expected (' + USER_INPUT.length + '): "' + show(USER_INPUT) + '"');
    console.log('  Input received (' + serverText.length + '): "' + show(serverText.slice(0, 200)) +
                (serverText.length > 200 ? '...' : '') + '"');
  }

  const pass = bannerOk && inputOk && transientOk;
  console.log('─────────────────────────────────────────────────────');
  console.log('  ' + (pass ? 'PASS' : 'FAIL'));
  console.log('─────────────────────────────────────────────────────');
  return pass;
}

process.exit(main() ? 0 : 1);
