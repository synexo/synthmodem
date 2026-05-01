'use strict';

/*
 * test/sip/uac-unit.test.js — SipUacInternal unit tests.
 *
 * No VM, no tunnel. Two UDP sockets on loopback play UAC and stub-
 * peer; the stub peer canned-responds to whatever requests the UAC
 * sends, mimicking what pjsip-test-peer does in the integration test.
 * This catches wire-format bugs (SIP headers, ACK routing, BYE tags)
 * in milliseconds instead of requiring a VM boot.
 *
 * Run: node test/sip/uac-unit.test.js
 */

const assert = require('assert');
const dgram  = require('dgram');
const { SipUacInternal } = require('../../src/sip/SipUacInternal');
const sip = require('../../src/sip/SipParser');

let passed = 0, failed = 0;
function ok(m)   { console.log('  ok  ', m); passed++; }
function fail(m, e) { console.log('  FAIL', m); if (e) console.log('       ', e.stack || e); failed++; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

/**
 * StubPeer — a UDP socket that receives SIP messages and lets the
 * test script inspect them and send canned responses.
 */
class StubPeer {
  constructor() {
    this.sock = dgram.createSocket('udp4');
    this.received = [];   /* array of { msg: Buffer, rinfo, parsed } */
    this._waiters = [];   /* { predicate, resolve, timer } */
    this.sock.on('message', (msg, rinfo) => {
      const parsed = sip.parse(msg.toString('utf8'));
      const rec = { msg, rinfo, parsed };
      this.received.push(rec);
      this._pump();
    });
  }
  async bind() {
    await new Promise(r => this.sock.bind(0, '127.0.0.1', r));
    return this.sock.address().port;
  }
  /** Wait for a message matching `predicate`. */
  waitFor(predicate, timeoutMs = 2000, label = 'message') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex(w => w.timer === timer);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new Error(
          `timeout (${timeoutMs}ms) waiting for ${label}. ` +
          `received ${this.received.length} messages so far.`));
      }, timeoutMs);
      this._waiters.push({ predicate, timer, resolve });
      this._pump();
    });
  }
  _pump() {
    for (let i = 0; i < this._waiters.length; i++) {
      const w = this._waiters[i];
      for (let j = 0; j < this.received.length; j++) {
        if (w.predicate(this.received[j])) {
          clearTimeout(w.timer);
          const rec = this.received.splice(j, 1)[0];
          this._waiters.splice(i, 1);
          w.resolve(rec);
          i--;
          break;
        }
      }
    }
  }
  /** Respond to a received request. */
  respond(rec, statusCode, reasonPhrase, extraHeaders = {}, body = '') {
    const req = rec.parsed;
    const via = req.getHeader('via');
    const from = req.getHeader('from');
    let to = req.getHeader('to');
    const callId = req.getHeader('call-id');
    const cseq = req.getHeader('cseq');

    /* If building a response that completes a dialog (200 to INVITE),
     * add a to-tag so the UAC can learn the remote tag. */
    if (statusCode >= 200 && !/;tag=/.test(to)) {
      to = `${to};tag=peer-tag-abc`;
    }

    const hdrs = [
      `SIP/2.0 ${statusCode} ${reasonPhrase}`,
      `Via: ${via}`,
      `From: ${from}`,
      `To: ${to}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq}`,
    ];
    for (const [k, v] of Object.entries(extraHeaders)) {
      hdrs.push(`${k}: ${v}`);
    }
    hdrs.push(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
    hdrs.push('');
    hdrs.push('');
    const msg = hdrs.join('\r\n') + body;
    this.sock.send(Buffer.from(msg, 'utf8'), rec.rinfo.port, rec.rinfo.address);
  }
  /** Send a request (e.g. peer-initiated BYE). */
  sendRequest(method, targetRinfo, dialog) {
    const branch = sip.generateBranch();
    const lines = [
      `${method} sip:caller@${targetRinfo.address}:${targetRinfo.port} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${this.sock.address().port};branch=${branch};rport`,
      `From: <sip:peer@127.0.0.1>;tag=${dialog.peerTag}`,
      `To: <sip:${dialog.localUser}@127.0.0.1>;tag=${dialog.localTag}`,
      `Call-ID: ${dialog.callId}`,
      `CSeq: ${dialog.cseq} ${method}`,
      'Max-Forwards: 70',
      'Content-Length: 0',
      '',
      '',
    ];
    this.sock.send(Buffer.from(lines.join('\r\n'), 'utf8'),
                   targetRinfo.port, targetRinfo.address);
  }
  close() { try { this.sock.close(); } catch (_) {} }
}

/**
 * Basic SDP body for peer's 200-OK answer.
 */
const ANSWER_SDP = [
  'v=0',
  'o=peer 111 222 IN IP4 127.0.0.1',
  's=stub-peer',
  'c=IN IP4 127.0.0.1',
  't=0 0',
  'm=audio 17000 RTP/AVP 0',
  'a=rtpmap:0 PCMU/8000',
  'a=sendrecv',
  '',
].join('\r\n');

async function makeUac(peerPort) {
  const sock = dgram.createSocket('udp4');
  await new Promise(r => sock.bind(0, '127.0.0.1', r));
  const uac = new SipUacInternal({
    udpSocket:   sock,
    peerAddress: '127.0.0.1',
    peerPort,
    localAddress: '127.0.0.1',
    targetUri:    `sip:stub@127.0.0.1:${peerPort}`,
  });
  return { uac, sock };
}

async function run() {
  console.log('SipUacInternal unit tests');
  console.log('');

  // ─── INVITE / 200 / ACK happy path ──────────────────────────────
  await test('INVITE → 200 OK → ACK produces correct wire messages', async () => {
    const peer = new StubPeer();
    const peerPort = await peer.bind();
    const { uac, sock } = await makeUac(peerPort);

    try {
      /* Drive it */
      const invitePromise = uac.invite({
        localRtpPort: 10002,
        offerCodecs: [{ payloadType: 0, name: 'PCMU', clockRate: 8000 }],
      });

      /* Await the INVITE on the peer side */
      const inviteRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'INVITE');
      const inv = inviteRec.parsed;
      assert.strictEqual(inv.method, 'INVITE');
      assert.match(inv.requestUri, /^sip:stub@127\.0\.0\.1:\d+$/);
      assert.match(inv.getHeader('via') || '', /;rport/);
      assert.match(inv.getHeader('from') || '', /;tag=/);
      assert.doesNotMatch(inv.getHeader('to') || '', /;tag=/,
        'initial INVITE To must have no tag');
      assert.strictEqual(inv.getHeader('content-type'), 'application/sdp');
      assert.match(inv.body, /^m=audio 10002 RTP\/AVP 0$/m);
      assert.match(inv.body, /^a=rtpmap:0 PCMU\/8000/m);

      /* Send 100 Trying, then 200 OK with SDP */
      peer.respond(inviteRec, 100, 'Trying');
      peer.respond(inviteRec, 200, 'OK',
        { 'Content-Type': 'application/sdp',
          'Contact': '<sip:stub@127.0.0.1:' + peerPort + '>' },
        ANSWER_SDP);

      const negotiated = await invitePromise;
      assert.strictEqual(negotiated.remoteRtpAddr, '127.0.0.1');
      assert.strictEqual(negotiated.remoteRtpPort, 17000);
      assert.deepStrictEqual(negotiated.codec, { codec: 'PCMU', rate: 8000 });
      assert.strictEqual(uac.state, 'CONFIRMED');

      /* UAC should have sent ACK */
      const ackRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'ACK');
      assert.strictEqual(ackRec.parsed.method, 'ACK');
      assert.match(ackRec.parsed.getHeader('to') || '', /;tag=peer-tag-abc/,
        'ACK To header must echo peer tag');
      assert.match(ackRec.parsed.getHeader('cseq') || '', /^\d+ ACK$/);
    } finally {
      uac.close();
      sock.close();
      peer.close();
    }
  });

  // ─── Non-2xx INVITE failure ─────────────────────────────────────
  await test('INVITE rejected with 486 sends ACK and rejects promise', async () => {
    const peer = new StubPeer();
    const peerPort = await peer.bind();
    const { uac, sock } = await makeUac(peerPort);

    try {
      const p = uac.invite({
        localRtpPort: 10002,
        offerCodecs: [{ payloadType: 0, name: 'PCMU', clockRate: 8000 }],
      });
      /* Pre-attach rejection handler so the rejection that fires the
       * instant the 486 arrives doesn't trigger node's unhandled-
       * rejection bail-out before assert.rejects gets to observe it. */
      p.catch(() => {});

      const inviteRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'INVITE');
      peer.respond(inviteRec, 486, 'Busy Here');

      const ackRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'ACK');
      assert.strictEqual(ackRec.parsed.method, 'ACK');

      await assert.rejects(p, /486|Busy Here/);
      assert.strictEqual(uac.state, 'TERMINATED');
    } finally {
      uac.close();
      sock.close();
      peer.close();
    }
  });

  // ─── BYE from UAC ───────────────────────────────────────────────
  await test('hangup() sends BYE and awaits 200', async () => {
    const peer = new StubPeer();
    const peerPort = await peer.bind();
    const { uac, sock } = await makeUac(peerPort);

    try {
      /* Get to CONFIRMED first */
      const invitePromise = uac.invite({
        localRtpPort: 10002,
        offerCodecs: [{ payloadType: 0, name: 'PCMU', clockRate: 8000 }],
      });
      const inviteRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'INVITE');
      peer.respond(inviteRec, 200, 'OK',
        { 'Content-Type': 'application/sdp',
          'Contact': `<sip:stub@127.0.0.1:${peerPort}>` },
        ANSWER_SDP);
      await invitePromise;
      /* Drain the ACK */
      await peer.waitFor(r => r.parsed && r.parsed.method === 'ACK');

      /* Now hangup */
      const byePromise = uac.hangup();
      const byeRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'BYE');
      const b = byeRec.parsed;
      assert.strictEqual(b.method, 'BYE');
      /* BYE To header should carry the peer tag (dialog is established) */
      assert.match(b.getHeader('to') || '', /;tag=peer-tag-abc/);
      assert.match(b.getHeader('from') || '', /;tag=/);
      peer.respond(byeRec, 200, 'OK');

      await byePromise;
      assert.strictEqual(uac.state, 'TERMINATED');
    } finally {
      uac.close();
      sock.close();
      peer.close();
    }
  });

  // ─── Peer-initiated BYE ─────────────────────────────────────────
  await test('peer BYE triggers ended event and 200 response', async () => {
    const peer = new StubPeer();
    const peerPort = await peer.bind();
    const { uac, sock } = await makeUac(peerPort);

    try {
      const invitePromise = uac.invite({
        localRtpPort: 10002,
        offerCodecs: [{ payloadType: 0, name: 'PCMU', clockRate: 8000 }],
      });
      const inviteRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'INVITE');
      peer.respond(inviteRec, 200, 'OK',
        { 'Content-Type': 'application/sdp',
          'Contact': `<sip:stub@127.0.0.1:${peerPort}>` },
        ANSWER_SDP);
      await invitePromise;
      const ackRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'ACK');

      /* Peer sends BYE. We need the UAC's local port for targeting. */
      const endedP = new Promise(resolve => uac.once('ended', resolve));
      peer.sendRequest('BYE', ackRec.rinfo, {
        callId:    uac.callId,
        localTag:  uac.localTag,   /* this is "our" tag from the peer's POV = To tag */
        peerTag:   'peer-tag-abc',
        cseq:      99,
        localUser: 'caller',
      });

      /* UAC should send back a 200 OK for the BYE */
      const resp = await peer.waitFor(r =>
        r.parsed && !r.parsed.isRequest && r.parsed.statusCode === 200 &&
        /BYE/.test(r.parsed.getHeader('cseq') || ''));
      assert.strictEqual(resp.parsed.statusCode, 200);
      const ev = await endedP;
      assert.strictEqual(ev.initiator, 'peer');
      assert.strictEqual(uac.state, 'TERMINATED');
    } finally {
      uac.close();
      sock.close();
      peer.close();
    }
  });

  // ─── INVITE timeout ─────────────────────────────────────────────
  await test('INVITE with no response times out and rejects', async () => {
    const peer = new StubPeer();
    const peerPort = await peer.bind();
    const { uac, sock } = await makeUac(peerPort);

    try {
      const p = uac.invite({
        localRtpPort: 10002,
        offerCodecs: [{ payloadType: 0, name: 'PCMU', clockRate: 8000 }],
        timeoutMs: 500,   /* keep test fast */
      });
      p.catch(() => {});
      await peer.waitFor(r => r.parsed && r.parsed.method === 'INVITE');
      await assert.rejects(p, /INVITE timeout/);
      assert.strictEqual(uac.state, 'TERMINATED');
    } finally {
      uac.close();
      sock.close();
      peer.close();
    }
  });

  // ─── OPTIONS probe ─────────────────────────────────────────────
  await test('probe() round-trips OPTIONS and resolves on 200', async () => {
    const peer = new StubPeer();
    const peerPort = await peer.bind();
    const { uac, sock } = await makeUac(peerPort);

    try {
      const p = uac.probe({ timeoutMs: 1000 });
      const optsRec = await peer.waitFor(r => r.parsed && r.parsed.method === 'OPTIONS');
      assert.strictEqual(optsRec.parsed.method, 'OPTIONS');
      assert.match(optsRec.parsed.getHeader('via') || '', /;rport/);
      peer.respond(optsRec, 200, 'OK');
      const resp = await p;
      assert.strictEqual(resp.statusCode, 200);
    } finally {
      uac.close();
      sock.close();
      peer.close();
    }
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('fatal:', err); process.exit(2); });
