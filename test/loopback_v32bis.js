#!/usr/bin/env node
/**
 * V.32bis end-to-end regression test.
 *
 * This test mirrors ModemDSP's actual execution path so bugs that manifest
 * in the live client/server run also manifest here.
 *
 * The key scenarios beyond the basic V.22bis regression:
 *
 *  1. SAMPLE-PHASE SHIFT at the RX. The live two-process system introduces
 *     phase offsets (via RTP jitter buffer, asymmetric handshake timing,
 *     independent clocks) that a synchronous single-process test can miss.
 *     A 1-sample phase offset at 2400 Hz carrier rotates the 64-QAM
 *     constellation by 108°, turning every symbol into garbage. We test
 *     all 5 possible sample-phase shifts.
 *
 *  2. HANDSHAKE TONES BEFORE V.32BIS. The live handshake engine appears
 *     to feed the protocol's demodulator ALL received audio, including
 *     the V.8 negotiation tones (ANSam 2100 Hz, CM/JM at ~1375 Hz) that
 *     arrive BEFORE the actual V.32bis training signal. A demodulator
 *     that blindly phase-acquires on whatever it sees first will lock
 *     onto the wrong phase based on those tones. We simulate this by
 *     injecting 1.5 s of handshake tones before real V.32bis audio.
 *
 *  3. Silence blocks during the data phase (existing test).
 *
 *  4. 60 seconds of sustained duplex operation (existing test).
 *
 * Verified:
 *   - Banner sent by server arrives byte-for-byte at client.
 *   - User input typed by client arrives byte-for-byte at server.
 *   - No spurious bytes on either side during idle periods.
 *   - Decoding is robust to ANY initial sample phase (0..SPS-1).
 *   - Decoding is robust to handshake-tone preamble.
 *
 * This test ALWAYS displays what each side received, even on pass,
 * so a human can eyeball it for anomalies that pass the automated check.
 *
 * Exit 0 on pass, 1 on fail.
 */
'use strict';

const { V32bis }  = require('../src/dsp/protocols/V32bis');
const { AGC }     = require('../src/dsp/Primitives');
const codec       = require('../src/rtp/Codec');
const config      = require('../config');

const SR            = 8000;
const BLOCK         = 160;
const TRAIN_MS      = 1024;
const RUN_MS        = 60000;
const TYPE_AT_MS    = 2000;
const V32_SPS       = 5;

const BANNER =
  '\r\n          S Y N T H M O D E M\r\n' +
  '       Telnet Gateway  v1.0\r\n\r\n' +
  '  Type <host> or <host>:<port> to connect.\r\n' +
  '  Type QUIT to disconnect.\r\nCONNECT> ';
const USER_INPUT = 'google.com\r\n';

const encode = s => codec.encode(s, 'PCMU');
const decode = b => codec.decode(b, 'PCMU');

// Generate a pure tone at given frequency for nSamples.
function generateTone(freq, nSamples, amp = 0.3) {
  const out = new Float32Array(nSamples);
  const inc = 2 * Math.PI * freq / SR;
  for (let i = 0; i < nSamples; i++) out[i] = amp * Math.cos(i * inc);
  return out;
}

function runScenario(opts) {
  const { phaseShift = 0, handshakeTones = false } = opts;
  const server = new V32bis('answer');
  const client = new V32bis('originate');
  const agcClient = new AGC(config.modem);
  const agcServer = new AGC(config.modem);

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

  // ─── Phase-shift injection ────────────────────────────────────────────────
  if (phaseShift > 0) {
    client.receiveAudio(new Float32Array(phaseShift));
    server.receiveAudio(new Float32Array(phaseShift));
  }

  // ─── Handshake-tones preamble ─────────────────────────────────────────────
  // Mimic the live system where the protocol demodulator receives V.8
  // negotiation tones before actual V.32bis audio. 1 second of ANSam
  // (2100 Hz) followed by 0.5 seconds of CM/JM-ish (1375 Hz). These go
  // ONLY to the RX side — the handshake engine wouldn't feed these to
  // the protocol's TX.
  if (handshakeTones) {
    const ansam = generateTone(2100, SR);      // 1 s of 2100 Hz
    const cm    = generateTone(1375, SR / 2);   // 0.5 s of 1375 Hz
    for (let pos = 0; pos < ansam.length; pos += BLOCK) {
      const n = Math.min(BLOCK, ansam.length - pos);
      client.receiveAudio(rxAtClient(ansam.subarray(pos, pos + n)));
      server.receiveAudio(rxAtServer(ansam.subarray(pos, pos + n)));
    }
    for (let pos = 0; pos < cm.length; pos += BLOCK) {
      const n = Math.min(BLOCK, cm.length - pos);
      client.receiveAudio(rxAtClient(cm.subarray(pos, pos + n)));
      server.receiveAudio(rxAtServer(cm.subarray(pos, pos + n)));
    }
  }

  // ─── Training phase ────────────────────────────────────────────────────────
  const trainSamples     = Math.round(TRAIN_MS * SR / 1000);
  const serverTrainAudio = server.generateAudio(trainSamples);
  const clientTrainAudio = client.generateAudio(trainSamples);

  for (let pos = 0; pos < trainSamples; pos += BLOCK) {
    const n = Math.min(BLOCK, trainSamples - pos);
    client.receiveAudio(rxAtClient(serverTrainAudio.subarray(pos, pos + n)));
    server.receiveAudio(rxAtServer(clientTrainAudio.subarray(pos, pos + n)));
  }
  const transientClient = clientGot.length;
  const transientServer = serverGot.length;

  // ─── Data phase ────────────────────────────────────────────────────────────
  server.write(Buffer.from(BANNER));
  const inputBlockIdx = Math.round(TYPE_AT_MS / 20);
  const totalBlocks   = Math.round(RUN_MS / 20);
  const DROP_EVERY = 97;
  const DROP_FROM  = 120;
  let silenceInjected = 0;
  for (let i = 0; i < totalBlocks; i++) {
    if (i === inputBlockIdx) client.write(Buffer.from(USER_INPUT));
    let serverAudio = server.generateAudio(BLOCK);
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
  };
}

function main() {
  const show = s => s.replace(/[^\x20-\x7e]/g, ch =>
    ch === '\r' ? '↵' : ch === '\n' ? '↲' : '·');

  console.log('═════════════════════════════════════════════════════');
  console.log('  V.32bis end-to-end regression test');
  console.log('═════════════════════════════════════════════════════');
  console.log('  AGC enabled:  ' + config.modem.agcEnabled);
  console.log('  Run duration: ' + (RUN_MS/1000) + ' s per scenario');
  console.log('');

  // Build scenario list: every phase shift × [with tones, without tones]
  const scenarios = [];
  for (let p = 0; p < V32_SPS; p++) {
    scenarios.push({ phaseShift: p, handshakeTones: false,
                     name: 'phase=' + p + ' tones=off' });
    scenarios.push({ phaseShift: p, handshakeTones: true,
                     name: 'phase=' + p + ' tones=on' });
  }

  let allPass = true;
  for (const sc of scenarios) {
    const r = runScenario(sc);
    const clientText = r.clientPayload.toString('binary');
    const serverText = r.serverPayload.toString('binary');
    const bannerOk    = clientText === BANNER;
    const inputOk     = serverText === USER_INPUT;
    const transientOk = r.clientTransient <= 6 && r.serverTransient <= 6;
    const ok = bannerOk && inputOk && transientOk;
    allPass = allPass && ok;

    console.log('─────────────────────────────────────────────────────');
    console.log('  Scenario: ' + sc.name + '   silences injected: ' + r.silenceInjected);
    console.log('─────────────────────────────────────────────────────');
    console.log('  Transient (expect <= 6):  C<-S=' + r.clientTransient +
                '  S<-C=' + r.serverTransient + '  ' +
                (transientOk ? 'OK' : 'EXCESSIVE'));
    console.log('');
    console.log('  Banner  expected (' + BANNER.length + ' bytes):');
    console.log('    "' + show(BANNER) + '"');
    console.log('  Banner  received (' + r.clientPayload.length + ' bytes):');
    console.log('    "' + show(clientText.slice(0, 300)) +
                (clientText.length > 300 ? '...' : '') + '"');
    console.log('    ' + (bannerOk ? 'OK — byte-for-byte match' : 'CORRUPT'));
    console.log('');
    console.log('  Input   expected (' + USER_INPUT.length + ' bytes):');
    console.log('    "' + show(USER_INPUT) + '"');
    console.log('  Input   received (' + r.serverPayload.length + ' bytes):');
    console.log('    "' + show(serverText.slice(0, 300)) +
                (serverText.length > 300 ? '...' : '') + '"');
    console.log('    ' + (inputOk ? 'OK — byte-for-byte match' : 'CORRUPT'));
    console.log('');
  }

  console.log('═════════════════════════════════════════════════════');
  console.log('  OVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
  console.log('═════════════════════════════════════════════════════');
  return allPass;
}

process.exit(main() ? 0 : 1);
