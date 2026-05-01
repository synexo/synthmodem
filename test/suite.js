#!/usr/bin/env node
/**
 * SynthModem — Integration Test Suite (native backend + plumbing)
 *
 * Covers G.711, SIP, RTP, DSP primitives, and native-backend modem
 * protocols that are active or TESTING after cleanup-phase-2.
 *
 * cleanup-phase-2 trimmings:
 *   - Removed V.22bis / V.32bis / V.34 QAM child-process loopback tests
 *     (V.32bis and V.34 left the tree; V.22bis is preserved as TESTING
 *     in V22.js and is not gated here).
 *   - Removed the QAM child-process runner (test/loopback_qam.js).
 *   - Updated the "all protocols registered" check to the post-Phase-2
 *     PROTOCOLS table: V21, V22, V22bis, V23, Bell103.
 *   - Kept the V.21 FSK loopback and the V.8 negotiation real-time
 *     event-loop test (server picks V22 when client advertises V22).
 *
 * NOT COVERED HERE (other test files own these):
 *   - VM-side modemd-ctrl unit tests        (test/ctrl/standalone.test.js)
 *   - RTP jitter buffer (native backend)    (test/rtp/fixed-buffered.test.js)
 *   - RTP bridge (slmodemd-pjsip backend)   (test/rtp/bridge.test.js)
 *   - SIP UAC unit                          (test/sip/uac-unit.test.js)
 *   - CallSession b2bua mode                (test/session/b2bua.test.js)
 *   - VM smoke (boots, AT, clean stop)      (test/slmodem-pjsip/vm-smoke.test.js)
 */
'use strict';

const results = { pass: 0, fail: 0, failures: [] };
const assert  = (c, m) => { if (!c) throw new Error(m); };

async function test(name, fn) {
  try   { await fn(); process.stdout.write('  ✓ ' + name + '\n'); results.pass++; }
  catch (e) {
    process.stdout.write('  ✗ ' + name + ' — ' + e.message + '\n');
    results.fail++;
    results.failures.push(name);
  }
}

const banner = Buffer.from('\r\n  SynthModem\r\n\r\nCONNECT> ');

(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  SynthModem — Integration Test Suite');
  console.log('═══════════════════════════════════════════════════');

  // ── G.711 Codec ─────────────────────────────────────────────────────────────
  await test('G.711 PCMU roundtrip', () => {
    const { encode, decode } = require('../src/rtp/Codec');
    const s = new Float32Array([-1, -0.5, 0, 0.5, 1]);
    decode(encode(s, 'PCMU'), 'PCMU').forEach((v, i) => assert(Math.abs(v - s[i]) < 0.03, 'PCMU['+i+']'));
  });
  await test('G.711 PCMA roundtrip', () => {
    const { encode, decode } = require('../src/rtp/Codec');
    const s = new Float32Array([-1, -0.5, 0, 0.5, 1]);
    decode(encode(s, 'PCMA'), 'PCMA').forEach((v, i) => assert(Math.abs(v - s[i]) < 0.02, 'PCMA['+i+']'));
  });

  // ── SIP ──────────────────────────────────────────────────────────────────────
  await test('SIP INVITE parse + 200 OK', () => {
    const p = require('../src/sip/SipParser');
    const m = p.parse('INVITE sip:m@h SIP/2.0\r\nVia: SIP/2.0/UDP h:5060;branch=z\r\nFrom: <sip:a@h>;tag=t\r\nTo: <sip:b@h>\r\nCall-ID: c@h\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n');
    assert(m.method === 'INVITE', 'method');
    const r = p.buildResponse(m, 200, 'OK');
    assert(r.statusCode === 200, 'status'); assert(r.getHeader('call-id') === 'c@h', 'call-id');
  });
  await test('SDP build + parse', () => {
    const p = require('../src/sip/SipParser');
    const s = p.buildSdp({ addr: '127.0.0.1', port: 10000, codecs: [{ name: 'PCMU', payloadType: 0, clockRate: 8000 }] });
    const d = p.parseSdp(s);
    assert(d.media[0].port === 10000, 'port'); assert(d.media[0].formats.includes('0'), 'PT');
  });

  // ── DSP Primitives ───────────────────────────────────────────────────────────
  await test('Goertzel + RMS + ANSam', () => {
    const { generateTone, goertzel, rms, generateANSam } = require('../src/dsp/Primitives');
    const t = generateTone(2100, 100, 8000, 0.5);
    assert(goertzel(t, 2100, 8000) > 0.20, 'on-freq');
    assert(goertzel(t, 1300, 8000) < 0.01, 'off-freq');
    assert(Math.abs(rms(t) - 0.3536) < 0.001, 'rms');
    assert(generateANSam(200, 8000, 450, 0.4).length === 1600, 'ANSam len');
  });
  await test('Scrambler self-sync roundtrip', () => {
    // The Primitives-level Scrambler is retained in cleanup-phase-2 as a
    // building block for any future native-V.22bis fix work; nothing
    // active uses it today, but the contract is worth keeping covered.
    const { Scrambler } = require('../src/dsp/Primitives');
    const sc = new Scrambler([18, 23]), dc = new Scrambler([18, 23]);
    const bits = [1,0,1,1,0,0,1,0,1,0,0,1,1,1,0,1,0,0,0,1,1,0,1,0,0,1,1,0,0,1];
    const scr  = bits.map(b => sc.scramble(b));
    const rec  = scr.map(b => dc.descramble(b));
    assert(bits.slice(23).every((b, i) => b === rec[23 + i]), 'tail mismatch');
  });

  // ── Modem Protocols (FSK — pure-JS, fast, safe to run inline) ────────────────
  await test('V.21 300 bps FSK loopback', () => {
    const { V21Modulator, V21Demodulator } = require('../src/dsp/protocols/V21');
    const m = new V21Modulator(2), d = new V21Demodulator(1), rx = [];
    d.on('data', b => rx.push(...b));
    d.process(m.generate(800));
    m.write(Buffer.from([0x41, 0x42, 0x43, 0x55, 0xAA]));
    d.process(m.generate(8000));
    assert(rx.length >= 5, 'count: ' + rx.length);
    assert(rx[0] === 0x41 && rx[1] === 0x42 && rx[2] === 0x43, 'bytes: ' + rx.slice(0, 3).map(b => b.toString(16)).join(' '));
  });

  // V.23 forward channel: 1200 bps, mark=1300, space=2100. The most
  // demanding self-loopback case in this suite — only ~6.7 samples
  // per symbol at 8 kHz, requiring the spandsp-style coherent
  // quadrature-correlator demod from FskCommon.js.
  await test('V.23 forward 1200 bps FSK loopback (coherent demod)', () => {
    const { FskModulator, CoherentFskDemodulator } = require('../src/dsp/protocols/FskCommon');
    const m = new FskModulator({ markFreq: 1300, spaceFreq: 2100, baud: 1200, amplitude: 0.15 });
    const d = new CoherentFskDemodulator({ markFreq: 1300, spaceFreq: 2100, baud: 1200 });
    const rx = [];
    d.on('data', b => rx.push(...b));
    d.process(m.generate(800));
    const msg = Buffer.from('Hello, V.23!');
    m.write(msg);
    d.process(m.generate(2000));
    assert(rx.length === msg.length, 'count: got ' + rx.length + ', want ' + msg.length);
    for (let i = 0; i < msg.length; i++) {
      assert(rx[i] === msg[i], 'byte ' + i + ': got 0x' + rx[i].toString(16) + ', want 0x' + msg[i].toString(16));
    }
  });

  // V.23 backward channel: 75 bps, mark=390, space=450. Tone
  // separation is only 60 Hz, so the coherent matched filter is
  // essential here — a Q=15 bandpass could not discriminate.
  await test('V.23 backward 75 bps FSK loopback (coherent demod)', () => {
    const { FskModulator, CoherentFskDemodulator } = require('../src/dsp/protocols/FskCommon');
    const m = new FskModulator({ markFreq: 390, spaceFreq: 450, baud: 75, amplitude: 0.15 });
    const d = new CoherentFskDemodulator({ markFreq: 390, spaceFreq: 450, baud: 75 });
    const rx = [];
    d.on('data', b => rx.push(...b));
    // 75 baud is slow. Pre-roll, then transmit 'Hi' (2 bytes ≈ 267 ms).
    d.process(m.generate(800));
    const msg = Buffer.from('Hi');
    m.write(msg);
    d.process(m.generate(3000));
    assert(rx.length === msg.length, 'count: got ' + rx.length + ', want ' + msg.length);
    for (let i = 0; i < msg.length; i++) {
      assert(rx[i] === msg[i], 'byte ' + i + ': got 0x' + rx[i].toString(16) + ', want 0x' + msg[i].toString(16));
    }
  });

  // V.23 wrapper class — bidirectional through public role-based API.
  // Verifies the answer↔originate channel-asymmetry mapping.
  await test('V.23 bidirectional via role wrapper (answer↔originate)', () => {
    const { V23 } = require('../src/dsp/protocols/V23');
    const ans = new V23('answer'), ori = new V23('originate');
    const fwdRx = [], bwdRx = [];
    ori.on('data', b => fwdRx.push(...b));
    ans.on('data', b => bwdRx.push(...b));
    // Pre-roll mark idle on both directions.
    ori.receiveAudio(ans.generateAudio(800));
    ans.receiveAudio(ori.generateAudio(800));
    ans.write(Buffer.from('forward'));    // host → terminal at 1200 bps
    ori.write(Buffer.from('hi'));         // terminal → host at 75 bps
    // 5 × 800 samples = 4000 — covers backward 'hi' (~2140 samples)
    // and forward 'forward' (~470 samples).
    for (let i = 0; i < 5; i++) {
      ori.receiveAudio(ans.generateAudio(800));
      ans.receiveAudio(ori.generateAudio(800));
    }
    assert(Buffer.from(fwdRx).toString('utf8') === 'forward',
      'fwd: ' + JSON.stringify(Buffer.from(fwdRx).toString('utf8')));
    assert(Buffer.from(bwdRx).toString('utf8') === 'hi',
      'bwd: ' + JSON.stringify(Buffer.from(bwdRx).toString('utf8')));
  });


  // ── V.8 byte-stream parser ─────────────────────────────────────────────────
  //
  // Regression tests for the V.8 byte-stream parser. The original
  // implementation eagerly emitted CM/JM messages whenever the buffer
  // had `sync + callfn + modn0` available, even if extension octets
  // (modn1 / modn2) hadn't arrived yet. When bytes are delivered one
  // at a time by the V.21 UART decoder (the normal case), the parser
  // would emit a truncated CM with only modn0, then discard the modn1
  // byte as "unknown". Net effect: every CM was decoded as
  // `modes={all false}` even when the encoded mode bits were correct.
  //
  // The fix: only emit a CM/JM when we can prove the message is
  // complete. Two completion signals: (a) we hit a clear terminator
  // (next sync byte 0xE0, or a 0x00 indicating CI-sync / CJ-start),
  // or (b) we've accumulated enough octets to know modn0..modn2 are
  // all in view.
  await test('V.8 — parser holds CM until complete (one-byte-at-a-time)', () => {
    const V8 = require('../src/dsp/V8');
    // Encode a CM advertising V.22bis. Result is `e0 c1 05 12`.
    const full = V8.buildCMBytes({ v22bis: true });
    assert(full.equals(Buffer.from([0xe0, 0xc1, 0x05, 0x12])), 'CM bytes: ' + full.toString('hex'));

    // Feed bytes one at a time. The parser must NOT emit anything until
    // we either supply a 4th candidate octet or a terminator. Without
    // either, an incomplete CM is correctly held.
    const state = {};
    let msgs = V8.parseV8Bytes(state, Buffer.from([0xe0]));     // sync
    assert(msgs.length === 0, 'no emit after sync alone');
    msgs = V8.parseV8Bytes(state, Buffer.from([0xc1]));         // callfn
    assert(msgs.length === 0, 'no emit after callfn alone');
    msgs = V8.parseV8Bytes(state, Buffer.from([0x05]));         // modn0
    assert(msgs.length === 0, 'no emit after modn0 — modn1 might still arrive');
    msgs = V8.parseV8Bytes(state, Buffer.from([0x12]));         // modn1
    assert(msgs.length === 0, 'no emit after modn1 — modn2 might still arrive');

    // A 5th byte signals "no more extensions" by being either a
    // terminator or a 4th octet. Provide a terminator (next sync).
    msgs = V8.parseV8Bytes(state, Buffer.from([0xe0]));
    assert(msgs.length === 1, 'CM emitted on terminator: ' + msgs.length);
    assert(msgs[0].type === 'CM/JM', 'type: ' + msgs[0].type);
    assert(msgs[0].modes.v22bis === true, 'v22bis: ' + msgs[0].modes.v22bis);
  });

  await test('V.8 — parser emits CM when terminator already in buffer', () => {
    const V8 = require('../src/dsp/V8');
    // CM with explicit terminator already present.
    const buf = Buffer.from([0xe0, 0xc1, 0x05, 0x12, 0xe0]);  // CM v22bis + next-sync
    const state = {};
    const msgs = V8.parseV8Bytes(state, buf);
    assert(msgs.length === 1, 'one msg: ' + msgs.length);
    assert(msgs[0].modes.v22bis === true, 'v22bis: ' + JSON.stringify(msgs[0].modes));
  });

  await test('V.8 — parser handles CM without modn1 extension', () => {
    const V8 = require('../src/dsp/V8');
    // CM with only modn0 (V.34 set, no extension octets needed)
    const cm = V8.buildCMBytes({ v34: true });
    // buildCMBytes always uses [sync, callfn, modn0, ...]. With v34
    // alone, no modn1/modn2 needed. Length should be 3 bytes.
    assert(cm.length === 3, 'CM length: ' + cm.length);
    // Followed by terminator so parser knows the CM is done.
    const state = {};
    const msgs = V8.parseV8Bytes(state, Buffer.concat([cm, Buffer.from([0xe0])]));
    assert(msgs.length === 1, 'one msg: ' + msgs.length);
    assert(msgs[0].modes.v34 === true, 'v34: ' + msgs[0].modes.v34);
    assert(msgs[0].modes.v22bis === false, 'v22bis: ' + msgs[0].modes.v22bis);
  });

  await test('V.8 — parser CI/CJ disambiguation', () => {
    const V8 = require('../src/dsp/V8');
    const ci = V8.buildCIBytes();   // [0x00, 0xc1]
    const cj = V8.buildCJBytes();   // [0x00, 0x00, 0x00]
    assert(ci.length === 2, 'CI length: ' + ci.length);
    assert(cj.length === 3, 'CJ length: ' + cj.length);

    let msgs = V8.parseV8Bytes({}, ci);
    assert(msgs.length === 1 && msgs[0].type === 'CI', 'CI: ' + JSON.stringify(msgs));

    msgs = V8.parseV8Bytes({}, cj);
    assert(msgs.length === 1 && msgs[0].type === 'CJ', 'CJ: ' + JSON.stringify(msgs));
  });

  await test('V.8 — parser accepts truncated 2-byte CJ from real modems', () => {
    // Some V.8-capable modems (observed: 2026-04-30 capture from an
    // AT-configurable USR/Conexant modem) send only 2 zero octets of CJ
    // before going silent for V.22bis training, rather than the strict-
    // spec 3+ octets. Our V.21 demod's UART framing also occasionally
    // drops the third zero byte if its stop bit is clipped by the
    // caller's TX-end transient. Either way, we must accept 2 zeros as
    // CJ, not time out waiting for a third.
    const V8 = require('../src/dsp/V8');
    const msgs = V8.parseV8Bytes({}, Buffer.from([0x00, 0x00]));
    assert(msgs.length === 1, 'expected 1 msg, got ' + msgs.length);
    assert(msgs[0].type === 'CJ', 'expected CJ, got ' + msgs[0].type);
  });

  await test('Legacy automode — FskDiscriminator rejects cross-protocol caller mark', () => {
    // V.21 caller mark = 980 Hz; Bell103 caller mark = 1270 Hz. Both
    // protocols' demods (Q=15 biquad bandpass, ~80 Hz BW) have enough
    // skirt response to trip CD on the OTHER protocol's caller mark.
    // The FskDiscriminator runs in parallel during legacy probes and
    // uses tight Goertzels to confirm the in-band frequency dominates
    // before allowing CD-stable to count as a real lock.
    const { FskDiscriminator } = require('../src/dsp/Handshake');
    const SR = 8000;
    function tone(freq, durMs) {
      const n = Math.round(SR * durMs / 1000);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = 0.15 * Math.cos(2*Math.PI*freq*i/SR);
      return out;
    }
    // Discriminator tuned for V.21 answer-side (in-band 980, cross 1270).
    const v21Discr = new FskDiscriminator(980, 1270);
    // Feed 200 ms of pure 980 Hz: should report "in band".
    v21Discr.process(tone(980, 200));
    assert(v21Discr.isInBand() === true, 'V.21 discriminator should accept 980 Hz mark, got isInBand=' + v21Discr.isInBand());
    // Feed 200 ms of pure 1270 Hz (Bell103 caller mark): should reject.
    const v21Discr2 = new FskDiscriminator(980, 1270);
    v21Discr2.process(tone(1270, 200));
    assert(v21Discr2.isInBand() === false, 'V.21 discriminator should reject 1270 Hz Bell103 mark, got isInBand=' + v21Discr2.isInBand());
    // Symmetric: Bell103 discriminator should reject 980 Hz V.21 mark.
    const b103Discr = new FskDiscriminator(1270, 980);
    b103Discr.process(tone(980, 200));
    assert(b103Discr.isInBand() === false, 'Bell103 discriminator should reject 980 Hz V.21 mark, got isInBand=' + b103Discr.isInBand());
    // Bell103 discriminator should accept 1270 Hz Bell103 mark.
    const b103Discr2 = new FskDiscriminator(1270, 980);
    b103Discr2.process(tone(1270, 200));
    assert(b103Discr2.isInBand() === true, 'Bell103 discriminator should accept 1270 Hz mark, got isInBand=' + b103Discr2.isInBand());
  });

  await test('V.22bis — _trackRxDetection accepts QAM, rejects pure 1270 Hz Bell103 mark', () => {
    // V.22bis remote-detection runs on a 50 Hz-resolution Goertzel at
    // 1200 Hz (carrier) and 1800 Hz (ghost). A pure 1270 Hz tone leaks
    // into the 1200 Hz bin enough to pass the existing 3:1 spectral-
    // shape test. We added an explicit anti-Bell-103 test that checks
    // that 1270 Hz energy isn't dramatically larger than 1200 Hz
    // energy — a real V.22 carrier (QAM) has comparable energy at
    // both frequencies, while Bell103 has all energy at 1270.
    const { V22bis } = require('../src/dsp/protocols/V22');
    const SR = 8000;
    function bell103mark(durMs) {
      const n = Math.round(SR * durMs / 1000);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = 0.15 * Math.cos(2*Math.PI*1270*i/SR);
      return out;
    }
    const v22bis = new V22bis('answer');
    let detected = false;
    v22bis.on('remote-detected', () => { detected = true; });
    // Feed 800 ms of pure 1270 Hz (Bell103 mark) to V.22bis answerer.
    // Should NOT trip remote-detected (ratio 1270/1200 is huge).
    const audio = bell103mark(800);
    const BLOCK = 160;
    for (let i = 0; i + BLOCK <= audio.length; i += BLOCK) {
      v22bis.generateAudio(BLOCK);  // also drives _trackRxDetection through the listening path
      v22bis.receiveAudio(audio.subarray(i, i + BLOCK));
    }
    assert(!detected, 'V.22bis must not false-positive on pure 1270 Hz Bell103 mark');
  });

  await test('RtpSession — adoptSocket installs listeners on a pre-bound socket', async () => {
    const dgram = require('dgram');
    const { RtpSession, allocateRtpPort, releaseRtpPort } = require('../src/rtp/RtpSession');

    // Bind a raw socket the way CallSession does in b2bua mode.
    const port = await allocateRtpPort();
    const raw = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      raw.once('error', reject);
      raw.bind(port, '127.0.0.1', () => { raw.removeListener('error', reject); resolve(); });
    });
    try {
      // Adopt and verify it processes packets.
      const rtp = new RtpSession({ playoutMode: 'immediate' });
      rtp.setCodec('PCMU', 0);
      rtp.adoptSocket(raw);

      // Build a minimal RTP packet (12-byte header, payload type 0=PCMU,
      // 160 bytes of mu-law silence = 0xff). Send it from a peer socket.
      const peer = dgram.createSocket('udp4');
      await new Promise(r => peer.bind(0, '127.0.0.1', r));
      const hdr = Buffer.alloc(12);
      hdr[0] = 0x80; hdr[1] = 0x00;     // V=2, PT=0
      hdr.writeUInt16BE(1, 2);          // seq
      hdr.writeUInt32BE(0, 4);          // timestamp
      hdr.writeUInt32BE(0xdeadbeef, 8); // SSRC
      const payload = Buffer.alloc(160, 0xff);
      const pkt = Buffer.concat([hdr, payload]);

      const got = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('adoptSocket: no audio event in 1s')), 1000);
        rtp.once('audio', samples => { clearTimeout(t); resolve(samples); });
        peer.send(pkt, port, '127.0.0.1');
      });
      assert(got instanceof Float32Array, 'adoptSocket: expected Float32Array, got ' + typeof got);
      assert(got.length === 160, 'adoptSocket: expected 160 samples, got ' + got.length);

      rtp.close();
      peer.close();
    } finally {
      releaseRtpPort(port);
    }
  });

  await test('HandshakeEngine — start({skipV8}) jumps directly to legacy probe chain', () => {
    // The `auto` backend uses this entry point after slmodemd-pjsip's
    // V.8 attempt times out. The caller has already heard ANSam from
    // PJSIP; we must NOT play more ANSam, NOT run V.8, just probe.
    const { HandshakeEngine } = require('../src/dsp/Handshake');
    const hs = new HandshakeEngine('answer');
    hs.start({ skipV8: true, skipAnsam: true });
    // After start({skipV8}), state should be TRAINING (we're inside
    // the first probe) and the protocol should be V22bis (first in
    // the legacy probe queue).
    assert(hs.protocol === 'V22bis',
           'expected V22bis as first probe, got: ' + hs.protocol);
    assert(hs.state === 'TRAINING',
           'expected TRAINING state, got: ' + hs.state);
    hs.stop();
  });

  await test('PublicHostResolver — subnet match across multiple interfaces', () => {
    const { PublicHostResolver } = require('../src/sip/PublicHostResolver');
    const ifaces = {
      lo:   [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
      eth0: [{ family: 'IPv4', address: '192.168.1.10', netmask: '255.255.255.0', internal: false }],
      eth1: [{ family: 'IPv4', address: '10.0.0.5',    netmask: '255.255.255.0', internal: false }],
    };
    const r = new PublicHostResolver({ interfaces: ifaces });
    let res = r.resolveFor('192.168.1.50');
    assert(res.address === '192.168.1.10', 'expected eth0 addr, got: ' + res.address);
    assert(res.source === 'subnet', 'expected source=subnet, got: ' + res.source);
    assert(res.interface === 'eth0', 'expected eth0, got: ' + res.interface);
    res = r.resolveFor('10.0.0.99');
    assert(res.address === '10.0.0.5', 'expected eth1 addr, got: ' + res.address);
    assert(res.interface === 'eth1', 'expected eth1, got: ' + res.interface);
  });

  await test('PublicHostResolver — falls back to first-non-loopback when no subnet match', () => {
    const { PublicHostResolver } = require('../src/sip/PublicHostResolver');
    const ifaces = {
      lo:   [{ family: 'IPv4', address: '127.0.0.1',    netmask: '255.0.0.0',       internal: true }],
      eth0: [{ family: 'IPv4', address: '192.168.1.10', netmask: '255.255.255.0',   internal: false }],
    };
    const r = new PublicHostResolver({ interfaces: ifaces });
    const res = r.resolveFor('8.8.8.8');
    assert(res.address === '192.168.1.10', 'expected fallback eth0, got: ' + res.address);
    assert(res.source === 'fallback-first-nonloop', 'expected fallback source, got: ' + res.source);
    assert(res.interface === 'eth0', 'expected eth0, got: ' + res.interface);
  });

  await test('PublicHostResolver — falls back to 127.0.0.1 with no non-loopback', () => {
    const { PublicHostResolver } = require('../src/sip/PublicHostResolver');
    const ifaces = {
      lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    };
    const r = new PublicHostResolver({ interfaces: ifaces });
    const res = r.resolveFor('192.168.1.50');
    assert(res.address === '127.0.0.1', 'expected 127.0.0.1, got: ' + res.address);
    assert(res.source === 'fallback-loopback', 'expected fallback-loopback, got: ' + res.source);
  });

  await test('PublicHostResolver — interface-name sort is deterministic on multi-NIC fallback', () => {
    const { PublicHostResolver } = require('../src/sip/PublicHostResolver');
    const ifaces = {
      eth1: [{ family: 'IPv4', address: '10.0.0.5',    netmask: '255.255.255.0', internal: false }],
      eth0: [{ family: 'IPv4', address: '192.168.1.10', netmask: '255.255.255.0', internal: false }],
    };
    const r = new PublicHostResolver({ interfaces: ifaces });
    const res = r.resolveFor('8.8.8.8');
    assert(res.interface === 'eth0', 'expected eth0 (alpha-sorted), got: ' + res.interface);
    assert(res.address   === '192.168.1.10', 'expected eth0 addr, got: ' + res.address);
  });

  await test('TelnetProxy — banner placeholders {{protocol}} and {{bps}} substitute from connectInfo', () => {
    const { TelnetProxy } = require('../src/telnet/TelnetProxy');
    const config = require('../config');
    const orig = config.terminal.banner;
    config.terminal.banner = ['CONNECT {{bps}} ({{protocol}})'];
    try {
      const tp = new TelnetProxy();
      let written = '';
      tp.attach(buf => { written += buf.toString(); }, { protocol: 'V32bis', bps: 14400 });
      assert(written.includes('CONNECT 14400 (V32bis)'),
             'banner did not substitute placeholders, got: ' + JSON.stringify(written));
    } finally {
      config.terminal.banner = orig;
    }
  });

  await test('TelnetProxy — missing connectInfo renders placeholders as unknown/0', () => {
    const { TelnetProxy } = require('../src/telnet/TelnetProxy');
    const config = require('../config');
    const orig = config.terminal.banner;
    config.terminal.banner = ['CONNECT {{bps}} ({{protocol}})'];
    try {
      const tp = new TelnetProxy();
      let written = '';
      tp.attach(buf => { written += buf.toString(); });   // no info
      assert(written.includes('CONNECT 0 (unknown)'),
             'fallback substitution wrong, got: ' + JSON.stringify(written));
    } finally {
      config.terminal.banner = orig;
    }
  });

  await test('TelnetProxy — banner without placeholders is unchanged (backwards compat)', () => {
    const { TelnetProxy } = require('../src/telnet/TelnetProxy');
    const config = require('../config');
    const orig = config.terminal.banner;
    config.terminal.banner = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    try {
      const tp = new TelnetProxy();
      let written = '';
      tp.attach(buf => { written += buf.toString(); }, { protocol: 'V34', bps: 19200 });
      assert(written.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
             'static banner mangled, got: ' + JSON.stringify(written));
    } finally {
      config.terminal.banner = orig;
    }
  });

  // ── HandshakeEngine V.8 protocol negotiation ─────────────────────────────────
  //
  // Real-time event-loop test that runs both sides of the HandshakeEngine
  // in loopback. Originate advertises V21 only; both sides should agree
  // on V21 via V.8 CI / CM / JM / CJ exchange and connect.
  //
  // Why V21 specifically: the originate side requires a full originate-side
  // training sequence after V.8 negotiation. V21 is the only protocol with
  // a complete originate-side path in the native backend; V22/V22bis only
  // implement the answer-side training sequencer. (For V22/V22bis, end-
  // to-end testing requires a real V.22 hardware modem, which is what
  // the live test environment provides.)
  await test('HandshakeEngine — V.8 negotiation (advertise V21 → both connect on V21)', () => new Promise((resolve, reject) => {
    const { HandshakeEngine } = require('../src/dsp/Handshake');
    const config = require('../config');
    config.logging.level = 'warn';   // quiet during test

    const ans  = new HandshakeEngine('answer');
    const orig = new HandshakeEngine('originate');
    orig._advertise = ['V21'];

    let ansConn = false, origConn = false;
    let ansProtocol = null, origProtocol = null;
    ans.on('connected', info => { ansConn = true; ansProtocol = info.protocol; check(); });
    orig.on('connected', info => { origConn = true; origProtocol = info.protocol; check(); });
    ans.on('handshake-failed',  e => reject(new Error('ans failed: ' + e.reason)));
    orig.on('handshake-failed', e => reject(new Error('orig failed: ' + e.reason)));

    let done = false;
    function check() {
      if (done) return;
      if (ansConn && origConn) {
        done = true;
        ans.stop(); orig.stop();
        assert(ansProtocol === 'V21',  'ans negotiated: ' + ansProtocol);
        assert(origProtocol === 'V21', 'orig negotiated: ' + origProtocol);
        resolve();
      }
    }

    ans.start();
    orig.start();

    const SR = 8000, BLOCK = 160;
    const deadline = Date.now() + 25000;
    function tick() {
      if (done) return;
      if (Date.now() > deadline) {
        done = true;
        ans.stop(); orig.stop();
        return reject(new Error(
          'timeout — ansConn=' + ansConn + ' origConn=' + origConn +
          ' ansProto=' + ansProtocol + ' origProto=' + origProtocol));
      }
      const ansAudio  = ans.generateAudio(BLOCK);
      const origAudio = orig.generateAudio(BLOCK);
      ans.receiveAudio(origAudio);
      orig.receiveAudio(ansAudio);
      setImmediate(tick);
    }
    setImmediate(tick);
  }));

  // ── Infrastructure ───────────────────────────────────────────────────────────
  await test('HandshakeEngine — all protocols registered', () => {
    const { PROTOCOLS } = require('../src/dsp/Handshake');
    // Post-cleanup-phase-2 registry. V22bis and V23 are TESTING-status
    // (kept in the registry for opt-in but not in default advertise list).
    for (const p of ['V21', 'V22', 'V22bis', 'V23', 'Bell103']) assert(p in PROTOCOLS, p + ' missing');
  });
  await test('ModemDSP start/stop/audioOut', () => new Promise(r => {
    const { ModemDSP } = require('../src/dsp/ModemDSP');
    const d = new ModemDSP('answer'); let g = false;
    d.on('audioOut', () => g = true); d.start();
    setTimeout(() => { assert(g, 'no audioOut'); d.stop(); r(); }, 60);
  }));
  await test('TelnetProxy banner + QUIT', () => new Promise(r => {
    const { TelnetProxy } = require('../src/telnet/TelnetProxy');
    const tp = new TelnetProxy(); let disc = false;
    tp.attach(() => {}); tp.on('disconnect', () => disc = true);
    tp.receive(Buffer.from('QUIT\r\n'));
    setTimeout(() => { assert(disc, 'no disconnect'); r(); }, 50);
  }));
  await test('SipDialog state machine', () => {
    const { SipDialog } = require('../src/sip/SipDialog');
    const d = new SipDialog({ callId: 't', localUri: 'sip:a@b', remoteUri: 'sip:c@d', transport: 'udp', remoteAddr: '127.0.0.1', remotePort: 5060 });
    d.setEarly(); d.setConfirmed('r');
    assert(d.canBye(), 'canBye'); d.setTerminated(); assert(!d.canBye(), 'noByeAfterTerminated');
  });
  await test('RTP port allocator', async () => {
    const { allocateRtpPort, releaseRtpPort } = require('../src/rtp/RtpSession');
    const port = await allocateRtpPort();
    assert(port >= 10000 && port <= 10100, 'range: ' + port);
    releaseRtpPort(port);
  });
  await test('Config — all sections present', () => {
    const c = require('../config');
    for (const k of ['sip', 'rtp', 'modem', 'telnet', 'terminal', 'logging', 'testClient']) assert(c[k] !== undefined, k + ' missing');
    assert(c.sip.port === 5060, 'SIP port'); assert(c.rtp.sampleRate === 8000, 'sample rate');
  });
  await test('SIP server INVITE→200→ACK (live UDP)', () => new Promise((resolve, reject) => {
    const cfg = require('../config');
    cfg.sip.port = 15063;
    cfg.sip.host = '127.0.0.1';   // override LAN-IP default so the test runs in any sandbox
    cfg.sip.publicHost = '127.0.0.1';
    cfg.logging.level = 'error';
    const { SipServer } = require('../src/sip/SipServer');
    const parser = require('../src/sip/SipParser');
    const dgram  = require('dgram');
    const srv = new SipServer();
    srv.start().then(() => {
      let done = false;
      srv.on('invite', dlg => { dlg.localRtpPort = 10006; srv.answerCall(dlg, 10006); });
      srv.on('ack', () => {
        if (!done) { done = true; srv.stop().then(() => { cli.close(); resolve(); }); }
      });
      const cli    = dgram.createSocket('udp4');
      const branch = parser.generateBranch(), callId = parser.generateCallId('127.0.0.1');
      const inv    = new parser.SipMessage();
      inv.isRequest = true; inv.method = 'INVITE'; inv.requestUri = 'sip:m@127.0.0.1';
      inv.setHeader('Via',  'SIP/2.0/UDP 127.0.0.1:25063;branch=' + branch);
      inv.setHeader('Max-Forwards', '70');
      inv.setHeader('From', '<sip:a@h>;tag=t'); inv.setHeader('To', '<sip:m@127.0.0.1>');
      inv.setHeader('Call-ID', callId); inv.setHeader('CSeq', '1 INVITE');
      inv.setHeader('Content-Type', 'application/sdp');
      inv.body = parser.buildSdp({ addr: '127.0.0.1', port: 20006, codecs: [{ name: 'PCMU', payloadType: 0, clockRate: 8000 }] });
      cli.bind(25063, () => {
        cli.on('message', buf => {
          const msg = parser.parse(buf);
          if (!msg || msg.statusCode !== 200) return;
          const tag = (msg.getHeader('to') || '').match(/tag=([^\s;>]+)/)?.[1] || 'x';
          const ack = new parser.SipMessage();
          ack.isRequest = true; ack.method = 'ACK'; ack.requestUri = 'sip:m@127.0.0.1';
          ack.setHeader('Via', 'SIP/2.0/UDP 127.0.0.1:25063;branch=' + parser.generateBranch());
          ack.setHeader('Max-Forwards', '70'); ack.setHeader('From', '<sip:a@h>;tag=t');
          ack.setHeader('To', '<sip:m@127.0.0.1>;tag=' + tag);
          ack.setHeader('Call-ID', callId); ack.setHeader('CSeq', '1 ACK');
          const b = ack.toBuffer(); cli.send(b, 0, b.length, 15063, '127.0.0.1');
        });
        const b = inv.toBuffer(); cli.send(b, 0, b.length, 15063, '127.0.0.1');
      });
      setTimeout(() => {
        if (!done) { done = true; srv.stop().then(() => { cli.close(); reject(new Error('timeout')); }); }
      }, 3000);
    });
  }));

  // ── Summary ───────────────────────────────────────────────────────────────────
  const total = results.pass + results.fail;
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  if (results.fail === 0) {
    console.log('  ALL ' + results.pass + '/' + total + ' TESTS PASSED ✓');
  } else {
    console.log('  ' + results.pass + '/' + total + ' passed  |  ' + results.fail + ' FAILED');
    console.log('  Failed: ' + results.failures.join(', '));
  }
  console.log('═══════════════════════════════════════════════════');
  process.exit(results.fail > 0 ? 1 : 0);
})();
