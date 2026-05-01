'use strict';

/*
 * test/pjsip/registrar.test.js — VmRegistrar unit test.
 *
 * Uses a stub tunnel (EventEmitter with an injectFrame method) so
 * the test runs without QEMU. Feeds synthetic REGISTER frames into
 * the registrar via 'frame-rx' events; captures outgoing
 * injectFrame calls; asserts response contents.
 *
 * Run: node test/pjsip/registrar.test.js
 * Expected: 6/6 passing, <1s.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { VmRegistrar } = require('../../src/sip/VmRegistrar');
const sip = require('../../src/sip/SipParser');

let passed = 0, failed = 0;
function ok(msg)   { console.log('  ok  ', msg); passed++; }
function fail(msg, err) {
  console.log('  FAIL', msg);
  if (err) console.log('       ', err.stack || err);
  failed++;
}
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}

/** Build a minimal REGISTER that PJSIP would send. */
function buildRegister({ fromPort = 37291, callId = 'reg-test-1@127.0.0.1',
                          contactPort = 37291, expires = null,
                          cseq = 1, omitContact = false,
                          badContact = false } = {}) {
  const lines = [
    'REGISTER sip:127.0.0.1:5060 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${fromPort};branch=${sip.generateBranch()};rport`,
    'Max-Forwards: 70',
    `From: <sip:modem@127.0.0.1>;tag=${sip.generateTag()}`,
    `To: <sip:modem@127.0.0.1>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
  ];
  if (!omitContact) {
    if (badContact) {
      lines.push('Contact: not-a-valid-uri');
    } else {
      lines.push(`Contact: <sip:modem@127.0.0.1:${contactPort}>`);
    }
  }
  if (expires !== null) lines.push(`Expires: ${expires}`);
  lines.push('User-Agent: PJSUA/2.15.1');
  lines.push('Content-Length: 0');
  lines.push('');
  lines.push('');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

/** Stub tunnel — behaves like UdpTcpTunnel's event surface. */
class StubTunnel extends EventEmitter {
  constructor() {
    super();
    this.injectedFrames = [];
  }
  injectFrame(channel, srcPort, dstPort, payload) {
    this.injectedFrames.push({ channel, srcPort, dstPort,
                                payload: Buffer.from(payload) });
  }
  /** Helper for tests: deliver a synthetic inbound REGISTER. */
  feedInboundSip(payload, srcPort = 37291, dstPort = 5060) {
    this.emit('frame-rx', 0, srcPort, dstPort, payload);
  }
}

async function run() {
  console.log('VmRegistrar unit test');
  console.log('');

  await test('REGISTER with Contact → 200 OK + binding stored', async () => {
    const tunnel = new StubTunnel();
    const reg = new VmRegistrar({ tunnel });
    reg.start();

    let regEvent = null;
    reg.on('registered', b => regEvent = b);

    const registered = reg.waitForRegistration(1000);
    tunnel.feedInboundSip(buildRegister({ contactPort: 44123 }));
    const binding = await registered;

    /* Binding contents */
    assert.strictEqual(binding.host, '127.0.0.1');
    assert.strictEqual(binding.port, 44123);
    assert.strictEqual(binding.contactUri, 'sip:modem@127.0.0.1:44123');
    assert.strictEqual(binding.expires, 3600);  // default

    /* Event fired */
    assert.ok(regEvent, '"registered" event fired');
    assert.strictEqual(regEvent.port, 44123);

    /* currentBinding accessible */
    assert.strictEqual(reg.currentBinding.port, 44123);

    /* One frame injected: the 200 OK */
    assert.strictEqual(tunnel.injectedFrames.length, 1);
    const sent = tunnel.injectedFrames[0];
    assert.strictEqual(sent.channel, 0);

    const response = sip.parse(sent.payload.toString('utf8'));
    assert.ok(!response.isRequest, 'response');
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.reasonPhrase, 'OK');

    /* Contact echoed with expires */
    const contact = response.getHeader('contact');
    assert.match(contact, /sip:modem@127\.0\.0\.1:44123/);
    assert.match(contact, /expires=3600/);

    /* Expires header also present */
    assert.strictEqual(response.getHeader('expires'), '3600');

    /* Via/From/To/Call-ID/CSeq echoed from request */
    assert.ok(response.getHeader('via'));
    assert.match(response.getHeader('cseq'), /REGISTER/);

    reg.stop();
  });

  await test('REGISTER with explicit Expires header is honored', async () => {
    const tunnel = new StubTunnel();
    const reg = new VmRegistrar({ tunnel });
    reg.start();

    const p = reg.waitForRegistration(1000);
    tunnel.feedInboundSip(buildRegister({ contactPort: 50001, expires: 1800 }));
    const binding = await p;

    assert.strictEqual(binding.expires, 1800);
    const resp = sip.parse(tunnel.injectedFrames[0].payload.toString('utf8'));
    assert.strictEqual(resp.getHeader('expires'), '1800');

    reg.stop();
  });

  await test('second REGISTER fires "refreshed" not "registered"', async () => {
    const tunnel = new StubTunnel();
    const reg = new VmRegistrar({ tunnel });
    reg.start();

    let registeredFires = 0, refreshedFires = 0;
    reg.on('registered', () => registeredFires++);
    reg.on('refreshed',  () => refreshedFires++);

    /* First REGISTER */
    const p1 = reg.waitForRegistration(1000);
    tunnel.feedInboundSip(buildRegister({ contactPort: 44123, cseq: 1 }));
    await p1;

    /* Second REGISTER (refresh) — same port, later CSeq */
    tunnel.feedInboundSip(buildRegister({ contactPort: 44123, cseq: 2 }));
    await new Promise(r => setImmediate(r)); // let event loop drain

    assert.strictEqual(registeredFires, 1, 'registered fires once');
    assert.strictEqual(refreshedFires, 1, 'refreshed fires once');
    assert.strictEqual(reg._registrationCount, 2);
    assert.strictEqual(tunnel.injectedFrames.length, 2);  // two 200 OKs

    reg.stop();
  });

  await test('REGISTER with updated Contact updates binding', async () => {
    const tunnel = new StubTunnel();
    const reg = new VmRegistrar({ tunnel });
    reg.start();

    tunnel.feedInboundSip(buildRegister({ contactPort: 40000, cseq: 1 }));
    await new Promise(r => setImmediate(r));

    /* Simulate PJSIP rebinding its transport on refresh (rare on
     * loopback, but VmRegistrar is supposed to handle it). */
    tunnel.feedInboundSip(buildRegister({ contactPort: 40001, cseq: 2 }));
    await new Promise(r => setImmediate(r));

    assert.strictEqual(reg.currentBinding.port, 40001);

    reg.stop();
  });

  await test('REGISTER without Contact → 400 Bad Request, no binding', async () => {
    const tunnel = new StubTunnel();
    const reg = new VmRegistrar({ tunnel });
    reg.start();

    tunnel.feedInboundSip(buildRegister({ omitContact: true }));
    await new Promise(r => setImmediate(r));

    assert.strictEqual(reg.currentBinding, null);
    assert.strictEqual(tunnel.injectedFrames.length, 1);
    const resp = sip.parse(tunnel.injectedFrames[0].payload.toString('utf8'));
    assert.strictEqual(resp.statusCode, 400);

    reg.stop();
  });

  await test('non-REGISTER frames (e.g. INVITE) are ignored', async () => {
    const tunnel = new StubTunnel();
    const reg = new VmRegistrar({ tunnel });
    reg.start();

    let regFires = 0;
    reg.on('registered', () => regFires++);

    const invite = Buffer.from([
      'INVITE sip:x@127.0.0.1:5060 SIP/2.0',
      'Via: SIP/2.0/UDP 127.0.0.1:9999;branch=z9hG4bKtest',
      'From: <sip:a@x>;tag=t1',
      'To: <sip:b@y>',
      'Call-ID: inv@x',
      'CSeq: 1 INVITE',
      'Contact: <sip:a@127.0.0.1:9999>',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n'), 'utf8');
    tunnel.feedInboundSip(invite);

    await new Promise(r => setImmediate(r));

    assert.strictEqual(regFires, 0, 'no registration event');
    assert.strictEqual(tunnel.injectedFrames.length, 0,
                       'no response injected');
    assert.strictEqual(reg.currentBinding, null);

    reg.stop();
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('fatal:', err); process.exit(2); });
