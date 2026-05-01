'use strict';

/**
 * VmRegistrar — in-Node SIP registrar for backend-B's internal SIP leg.
 *
 * ─── Why this exists ────────────────────────────────────────────
 *
 * d-modem's PJSIP binds an ephemeral UDP port (`cfg.port = 0` in
 * upstream d-modem.c, lines 802-810). In its "direct call" mode
 * (no credentials) it accepts inbound INVITEs via `pjsua_acc_add_local`
 * but d-modem exits at boot before reaching that code path unless
 * its dialstr contains '@' (line 724 in d-modem.c). In its
 * "registered" mode (credentials present) it adds an account with
 * `register_on_acc_add = true` and sends REGISTER to the configured
 * server.
 *
 * Upstream's intended inbound-call topology is:
 *   1. d-modem registers with an external SIP server.
 *   2. An external caller sends INVITE to sip:user@server.
 *   3. The server routes the INVITE to d-modem's registered Contact.
 *
 * Our topology has no external server — Node is the only SIP peer
 * on the internal leg. So Node IS the registrar. This class:
 *   - Sees d-modem's REGISTER as a frame on the SIP tunnel channel.
 *   - Extracts the Contact header (d-modem's PJSIP IP:port inside
 *     the VM) and stores it as the current binding.
 *   - Replies 200 OK echoing the Contact + an Expires value so PJSIP
 *     considers registration successful.
 *   - Emits 'registered' on first REGISTER, 'refreshed' on subsequent
 *     refreshes (PJSIP refreshes at ~expires/2 intervals).
 *
 * The learned Contact binding (e.g. sip:modem@127.0.0.1:37291) is
 * what PjsipBackend hands to SipUacInternal as the target URI for
 * placing INVITEs.
 *
 * ─── What this is NOT ──────────────────────────────────────────
 *
 * - Not a full registrar. No digest-auth challenge. We accept any
 *   REGISTER without challenging. Safe because the tunnel is a
 *   private loopback-scoped transport; no external caller can reach
 *   this registrar.
 * - Not persistent. All state is in-memory. Lost on Node restart.
 * - Not multi-user. Exactly one binding is tracked at a time. If
 *   some future d-modem variant registers multiple AORs per VM,
 *   this needs rework.
 *
 * ─── Lifecycle ─────────────────────────────────────────────────
 *
 *   new VmRegistrar({ tunnel })
 *     - `tunnel` is a UdpTcpTunnel already started and connected
 *
 *   .start()
 *     - Subscribes to tunnel 'frame-rx' events. Synchronous.
 *
 *   .stop()
 *     - Unsubscribes. Resets state.
 *
 *   .waitForRegistration(timeoutMs)  -> Promise<binding>
 *     - Resolves when the first REGISTER has been 200-OK'd. Rejects
 *       on timeout.
 *
 *   .currentBinding
 *     - { contactUri, host, port, expires, receivedAt } | null
 *
 *   Events:
 *     'registered' -> binding      // first REGISTER for a call lifecycle
 *     'refreshed'  -> binding      // subsequent REGISTER (refresh)
 *     'error'      -> Error        // malformed REGISTER, send failure, etc.
 *
 * ─── Implementation notes ─────────────────────────────────────
 *
 * The registrar doesn't own a UDP socket. It hooks the tunnel's
 * 'frame-rx' event (emitted for every inbound frame regardless of
 * whether a host-side UDP consumer has been learned) and uses
 * `tunnel.injectFrame()` to send the 200 OK back. This lets
 * VmRegistrar coexist with SipUacInternal on the same tunnel —
 * they share the SIP channel, each processing frames relevant to
 * them (REGISTER for registrar, INVITE/ACK/BYE for UAC).
 *
 * REGISTER refresh handling: PJSIP refreshes registration at
 * roughly expires/2. We keep accepting refreshes indefinitely,
 * updating `currentBinding` each time (it's usually the same but
 * would change if PJSIP rebound its transport).
 */

const { EventEmitter } = require('events');
const { makeLogger }   = require('../logger');
const sip              = require('./SipParser');

const log = makeLogger('VmRegistrar');

const DEFAULT_EXPIRES = 3600;
const CH_SIP = 0;

class VmRegistrar extends EventEmitter {
  /**
   * @param {object} opts
   * @param {UdpTcpTunnel} opts.tunnel  Started tunnel (state !== 'idle').
   * @param {number} [opts.defaultExpires=3600]  Expires value we advertise
   *        in 200 OK if the REGISTER didn't specify one, and the value we
   *        echo back if it did. PJSIP refreshes at ~expires/2.
   */
  constructor(opts = {}) {
    super();
    if (!opts.tunnel) {
      throw new Error('VmRegistrar: opts.tunnel is required');
    }
    this.tunnel = opts.tunnel;
    this.defaultExpires = opts.defaultExpires || DEFAULT_EXPIRES;
    this.currentBinding = null;
    this._started = false;
    this._frameHandler = null;
    this._registrationCount = 0;
  }

  start() {
    if (this._started) return;
    this._frameHandler = (channel, srcPort, dstPort, payload) => {
      if (channel !== CH_SIP) return;
      this._onSipFrame(srcPort, dstPort, payload);
    };
    this.tunnel.on('frame-rx', this._frameHandler);
    this._started = true;
    log.info('registrar started');
  }

  stop() {
    if (!this._started) return;
    this.tunnel.removeListener('frame-rx', this._frameHandler);
    this._frameHandler = null;
    this._started = false;
    this.currentBinding = null;
    log.info('registrar stopped');
  }

  /**
   * Wait for the first successful REGISTER.
   *
   * @param {number} [timeoutMs=20000]
   * @returns {Promise<Binding>}
   */
  waitForRegistration(timeoutMs = 20000) {
    if (this.currentBinding) return Promise.resolve(this.currentBinding);
    return new Promise((resolve, reject) => {
      const onReg = (binding) => {
        clearTimeout(timer);
        resolve(binding);
      };
      const timer = setTimeout(() => {
        this.removeListener('registered', onReg);
        reject(new Error(
          `VmRegistrar: no REGISTER received within ${timeoutMs}ms`));
      }, timeoutMs);
      this.once('registered', onReg);
    });
  }

  /**
   * Process an inbound SIP frame. Parses it; if it's a REGISTER,
   * responds with 200 OK and updates binding state. Non-REGISTER
   * frames are ignored (SipUacInternal or similar handles them).
   */
  _onSipFrame(srcPort, dstPort, payload) {
    let msg;
    try {
      msg = sip.parse(payload.toString('utf8'));
    } catch (e) {
      log.debug(`frame parse failed: ${e.message}`);
      return;
    }
    if (!msg || !msg.isRequest || msg.method !== 'REGISTER') {
      /* Not our concern — SipUacInternal (or nobody) handles other
       * frame kinds. We deliberately don't log here; every INVITE,
       * ACK, BYE on the SIP channel would spam. */
      return;
    }
    this._handleRegister(msg, srcPort, dstPort);
  }

  _handleRegister(msg, srcPort, dstPort) {
    /* Extract Contact. A REGISTER Contact is "<sip:user@host:port>;..."
     * or may have multiple values. We take the first. */
    const contactRaw = msg.getHeader('contact');
    if (!contactRaw) {
      log.info('REGISTER without Contact — responding 400');
      this._sendErrorResponse(msg, srcPort, dstPort, 400, 'Bad Request (no Contact)');
      return;
    }
    const parsed = sip.parseAddressHeader(contactRaw);
    const contactUri = parsed.uri;
    if (!contactUri) {
      log.info('REGISTER with unparseable Contact — responding 400');
      this._sendErrorResponse(msg, srcPort, dstPort, 400, 'Bad Request (bad Contact)');
      return;
    }

    /* Pull the host:port out of the URI. parseAddressHeader strips
     * the port from .host (returns just the hostname). We re-parse
     * the URI to get port separately. Format: sip:user@host:port */
    const uriMatch = /^sip:(?:[^@]+@)?([^:;>]+)(?::(\d+))?/i.exec(contactUri);
    if (!uriMatch) {
      log.info(`REGISTER Contact URI unparseable: ${contactUri}`);
      this._sendErrorResponse(msg, srcPort, dstPort, 400, 'Bad Request');
      return;
    }
    const host = uriMatch[1];
    const port = uriMatch[2] ? parseInt(uriMatch[2], 10) : 5060;

    /* Determine Expires — either per-Contact param, Expires header,
     * or our default. */
    let expires = this.defaultExpires;
    const headerExpires = msg.getHeader('expires');
    if (headerExpires) {
      const v = parseInt(headerExpires, 10);
      if (!Number.isNaN(v)) expires = v;
    }
    if (parsed.params && parsed.params['expires']) {
      const v = parseInt(parsed.params['expires'], 10);
      if (!Number.isNaN(v)) expires = v;
    }

    const isRefresh = this.currentBinding !== null;
    const binding = {
      contactUri,
      host,
      port,
      expires,
      receivedAt: Date.now(),
      registerCount: this._registrationCount + 1,
    };

    /* Send the 200 OK first (so if it fails we don't claim success). */
    const ok = sip.buildResponse(msg, 200, 'OK', {
      /* Echo Contact with expires so PJSIP sees its binding confirmed.
       * Per RFC 3261 §10.3 item 8, the registrar MUST include Contact
       * headers listing all current bindings for the AOR. With a
       * single binding, echoing the received Contact with expires is
       * the conventional response. */
      'Contact': `<${contactUri}>;expires=${expires}`,
      'Expires': String(expires),
    });
    /* 200 OK for REGISTER has no body. */
    ok.body = '';

    const okBuf = ok.toBuffer();
    try {
      /* The VM-side tunnel learns d-modem's ephemeral port from the
       * REGISTER we just received. So by the time we inject our 200
       * OK, peer-learning is already complete and the frame's
       * dst_port is ignored in favor of the learned peer. We still
       * set dst_port correctly (to d-modem's ephemeral port as the
       * tunnel's src_port on receive, which was `srcPort` here) for
       * any future debug trace. */
      this.tunnel.injectFrame(CH_SIP, dstPort, srcPort, okBuf);
    } catch (e) {
      log.error(`failed to send 200 OK: ${e.message}`);
      this.emit('error', e);
      return;
    }

    /* Update binding state AFTER the send succeeds. */
    this.currentBinding = binding;
    this._registrationCount++;

    if (isRefresh) {
      log.debug(`refresh from ${host}:${port} (expires=${expires}, #${binding.registerCount})`);
      this.emit('refreshed', binding);
    } else {
      log.info(`registered ${host}:${port} (expires=${expires})`);
      this.emit('registered', binding);
    }
  }

  _sendErrorResponse(msg, srcPort, dstPort, code, reason) {
    try {
      const resp = sip.buildResponse(msg, code, reason);
      this.tunnel.injectFrame(CH_SIP, dstPort, srcPort, resp.toBuffer());
    } catch (e) {
      log.error(`failed to send ${code} ${reason}: ${e.message}`);
    }
  }
}

module.exports = { VmRegistrar };
