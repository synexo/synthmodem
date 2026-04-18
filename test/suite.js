#!/usr/bin/env node
/**
 * SynthModem — Integration Test Suite
 *
 * QAM loopback tests (V22bis, V32bis, V34) run in child processes to guarantee
 * a clean module environment, free from cross-test contamination.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

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

// Run a QAM loopback in a child process — isolated from module cache pollution
function qamLoopback(proto) {
  const out = execFileSync(process.execPath,
    [path.join(__dirname, 'loopback_qam.js'), proto],
    { encoding: 'utf8', timeout: 10000 }
  ).trim();
  assert(out === 'PASS', out);
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
    const { Scrambler } = require('../src/dsp/Primitives');
    const sc = new Scrambler([18, 23]), dc = new Scrambler([18, 23]);
    const bits = [1,0,1,1,0,0,1,0,1,0,0,1,1,1,0,1,0,0,0,1,1,0,1,0,0,1,1,0,0,1];
    const scr  = bits.map(b => sc.scramble(b));
    const rec  = scr.map(b => dc.descramble(b));
    assert(bits.slice(23).every((b, i) => b === rec[23 + i]), 'tail mismatch');
  });

  // ── Modem Protocols (FSK — safe to run inline) ───────────────────────────────
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

  // ── Modem Protocols (QAM — child process to avoid module cache pollution) ────
  await test('V.22bis 2400 bps QAM-16 loopback', () => qamLoopback('V22bis'));
  await test('V.32bis 3600 bps QAM-64 loopback', () => qamLoopback('V32bis'));
  await test('V.34   3600 bps QAM-64 loopback',  () => qamLoopback('V34'));

  // ── HandshakeEngine real-time event loop ─────────────────────────────────────
  await test('HandshakeEngine V22bis (real-time event loop)', () => new Promise((resolve, reject) => {
    const { HandshakeEngine } = require('../src/dsp/Handshake');
    const aHS = new HandshakeEngine('answer'), oHS = new HandshakeEngine('originate');
    // Both sides forced to V22bis — bypasses V.8 entirely and tests the DSP path
    // directly. V.8 protocol negotiation is covered by the dedicated test below.
    aHS._forced = 'V22bis'; oHS._forced = 'V22bis';
    const got = []; oHS.on('data', b => got.push(...b));
    aHS.on('connected', () => aHS.write(banner));
    aHS.start(); oHS.start();
    const iv = setInterval(() => {
      const a = aHS.generateAudio(160), o = oHS.generateAudio(160);
      oHS.receiveAudio(a); aHS.receiveAudio(o);
    }, 20);
    setTimeout(() => {
      clearInterval(iv); aHS.stop(); oHS.stop();
      const t = got.map(b => b>31&&b<127?String.fromCharCode(b):(b===13||b===10?'↵':'.')).join('');
      (t.includes('SynthModem') || t.includes('CONNECT')) ? resolve() : reject(new Error('got: ' + t.slice(0, 25)));
    }, 5000);
  }));

  // ── HandshakeEngine V.8 protocol negotiation ─────────────────────────────────
  await test('HandshakeEngine V.8 negotiation (advertise V22 → server picks V22)', () => new Promise((resolve, reject) => {
    const { HandshakeEngine } = require('../src/dsp/Handshake');
    const answerHS  = new HandshakeEngine('answer');     // server — does full V.8
    const originHS  = new HandshakeEngine('originate');  // client — forced V22
    originHS._advertise = ['V22'];  // advertise only V22 in CM without bypassing V.8
    let negotiated = null;
    answerHS.on('connected',  info => { negotiated = info.protocol; });
    answerHS.start(); originHS.start();
    const iv = setInterval(() => {
      const a = answerHS.generateAudio(160), o = originHS.generateAudio(160);
      originHS.receiveAudio(a); answerHS.receiveAudio(o);
    }, 20);
    setTimeout(() => {
      clearInterval(iv); answerHS.stop(); originHS.stop();
      negotiated === 'V22' ? resolve() : reject(new Error('server picked ' + negotiated + ' instead of V22'));
    }, 5000);
  }));

  // ── Infrastructure ───────────────────────────────────────────────────────────
  await test('HandshakeEngine — all protocols registered', () => {
    const { PROTOCOLS } = require('../src/dsp/Handshake');
    for (const p of ['V21', 'V22', 'V22bis', 'V23', 'V32bis', 'V34']) assert(p in PROTOCOLS, p + ' missing');
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
    cfg.sip.port = 15063; cfg.sip.publicHost = '127.0.0.1'; cfg.logging.level = 'error';
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
