'use strict';

/**
 * SipUacInternal — Node-side SIP UAC for backend B (slmodemd-pjsip).
 *
 * Places an outbound INVITE against an in-VM PJSIP instance and
 * drives the dialog: INVITE → (1xx →) 200 OK → ACK, then holds until
 * either side sends BYE. Handles BYE from the peer by responding 200
 * and emitting 'ended'. Supports caller-initiated hangup via the
 * `hangup()` method, which sends BYE and awaits 200.
 *
 * ─── Role in the overall architecture ────────────────────────────
 *
 *   External caller          Node (host)                VM
 *   ───────────────          ───────────                ──
 *   SIP UAC     ───INVITE───► SipServer
 *                                │ (hands off to CallSession)
 *                                ▼
 *                             CallSession
 *                             (B2BUA mode, step 4b)
 *                                │
 *                                ▼
 *                             SipUacInternal      ◄── this module
 *                                │
 *                                │ (UDP via tunnel)
 *                                ▼
 *                             UdpTcpTunnel:5062
 *                                │
 *                                │ (TCP-over-virtio-serial)
 *                                ▼
 *                             modemd-tunnel
 *                                │
 *                                ▼
 *                             PJSIP (d-modem)
 *
 * ─── What this class IS ──────────────────────────────────────────
 *
 * A minimal SIP UAC that speaks just the method set we need:
 * INVITE, ACK, BYE, plus an OPTIONS helper for readiness probes.
 * Handles retransmits for requests that carry a transaction (BYE)
 * and has a stateful dialog model (INIT → EARLY → CONFIRMED →
 * TERMINATED) that mirrors SipDialog.js but is tailored for UAC
 * semantics rather than UAS.
 *
 * ─── What this class is NOT ──────────────────────────────────────
 *
 * - Not a general-purpose SIP stack. No registration, no
 *   subscriptions, no authentication, no TLS, no CANCEL. If we ever
 *   need those we can extend or replace.
 * - Not an RTP engine. The INVITE offer and 200 OK answer contain
 *   media descriptions, but this class only parses them and exposes
 *   the negotiated address/port on the returned promise. An outer
 *   layer (step 4b) wires the actual audio.
 * - Not a multi-dialog multiplexer. One instance handles one
 *   dialog. The caller (ModemBackendPool) owns one instance per
 *   active call; the pool's one-VM-per-call rule matches up.
 *
 * ─── Transport model ─────────────────────────────────────────────
 *
 * The transport is a plain Node UDP socket. The caller passes in:
 *   - `udpSocket`: a bound dgram.Socket the UAC will send from and
 *     receive on. Typically the caller binds ephemeral on loopback
 *     and this class never rebinds.
 *   - `peerAddress` + `peerPort`: where to send requests. In
 *     production this is `{ address: '127.0.0.1', port: 5062 }` —
 *     the UdpTcpTunnel's host-side SIP port. Replies come from
 *     the same address:port (thanks to the tunnel's learned-peer
 *     logic), which this class verifies on receive.
 *
 * Decoupling transport from the tunnel makes unit testing
 * straightforward: the test can pipe SIP requests to its own stub
 * peer without standing up a VM. All VM-based integration lives in
 * test/pjsip/uac-invite.test.js.
 *
 * ─── Usage ───────────────────────────────────────────────────────
 *
 *   const dgram = require('dgram');
 *   const sock = dgram.createSocket('udp4');
 *   await new Promise(r => sock.bind(0, '127.0.0.1', r));
 *
 *   const uac = new SipUacInternal({
 *     udpSocket: sock,
 *     peerAddress: '127.0.0.1',
 *     peerPort: 5062,
 *     localAddress: '127.0.0.1',
 *     targetUri: 'sip:modem@127.0.0.1:5060',
 *   });
 *
 *   const negotiated = await uac.invite({
 *     localRtpPort: 10002,
 *     offerCodecs: [
 *       { payloadType: 0, name: 'PCMU', clockRate: 8000 },
 *     ],
 *   });
 *   // negotiated = { remoteRtpAddr, remoteRtpPort, codec }
 *
 *   // ... call runs; audio bridging happens in an outer layer ...
 *
 *   await uac.hangup();  // sends BYE, awaits 200 OK
 */

const { EventEmitter }  = require('events');
const { makeLogger }    = require('../logger');
const sip               = require('./SipParser');

const log = makeLogger('SipUacInternal');

/* ─── Timers ──────────────────────────────────────────────────────
 *
 * SIP T1 is the RTT estimate used to schedule retransmits. RFC 3261
 * defaults T1 to 500ms but in our world everything is on loopback
 * so we can use much tighter timers. The values below are carefully
 * chosen to be pessimistic enough that a brief TCG stall doesn't
 * spuriously trigger retransmits, but tight enough that an actually-
 * lost BYE gets retried before a user notices a hang. */
const T1_MS      = 200;    /* initial retransmit interval           */
const T_INVITE   = 10000;  /* total INVITE timeout                  */
const T_BYE      = 4000;   /* total BYE timeout                     */
const T_OPTIONS  = 1500;   /* total OPTIONS timeout (readiness use) */

/* Maximum number of retransmits before giving up. With T1=200ms
 * and exponential back-off (T1, 2T1, 4T1, 8T1) we cover ~3 seconds
 * of lost-packet recovery, which is way more than loopback needs. */
const MAX_RETRANSMITS = 4;

class SipUacInternal extends EventEmitter {

  /**
   * @param {object} opts
   * @param {dgram.Socket} opts.udpSocket  Bound UDP socket; caller owns.
   * @param {string} opts.peerAddress      Where to send requests.
   * @param {number} opts.peerPort         Where to send requests.
   * @param {string} opts.localAddress     Our side's address for Via/From.
   *                                       Defaults '127.0.0.1'.
   * @param {string} opts.targetUri        SIP URI of the modem/peer.
   *                                       E.g. 'sip:modem@127.0.0.1:5060'.
   * @param {string} [opts.localUser='caller'] User portion of From/Contact.
   * @param {string} [opts.userAgent='synthmodem/1.0']
   */
  constructor(opts) {
    super();
    if (!opts || !opts.udpSocket) {
      throw new Error('SipUacInternal: opts.udpSocket is required');
    }
    if (!opts.peerAddress || !opts.peerPort) {
      throw new Error('SipUacInternal: opts.peerAddress/peerPort required');
    }
    if (!opts.targetUri) {
      throw new Error('SipUacInternal: opts.targetUri required');
    }

    this.sock          = opts.udpSocket;
    this.peerAddress   = opts.peerAddress;
    this.peerPort      = opts.peerPort;
    this.localAddress  = opts.localAddress || '127.0.0.1';
    this.targetUri     = opts.targetUri;
    this.localUser     = opts.localUser  || 'caller';
    this.userAgent     = opts.userAgent  || 'synthmodem/1.0';

    /* Dialog identity (populated on INVITE) */
    this.callId    = null;
    this.localTag  = null;
    this.remoteTag = null;
    this.cseq      = 0;
    this.contactUri = null;

    /* Dialog lifecycle */
    this.state = 'INIT';   /* INIT | TRYING | EARLY | CONFIRMED | TERMINATED */

    /* Transaction state — one in-flight request at a time. */
    this._inflight = null;  /* { method, branch, onResponse, timer, ... } */

    /* Bind our message handler to the socket. The caller is
     * responsible for removing this listener on teardown if they
     * plan to reuse the socket. */
    this._onMessageBound = (msg, rinfo) => this._onMessage(msg, rinfo);
    this.sock.on('message', this._onMessageBound);

    /* Our local port — captured once. If the socket isn't bound yet
     * we'll read it lazily on first send. */
    this._localPort = null;
  }

  /* ─── Public API ─────────────────────────────────────────────── */

  /**
   * Place an INVITE with an SDP offer; resolve when the dialog is
   * CONFIRMED (200 OK received, ACK sent). Rejects on any failure:
   * non-2xx final, timeout, transport error.
   *
   * @param {object} opts
   * @param {number} opts.localRtpPort        Our RTP port for the offer.
   * @param {Array<object>} opts.offerCodecs  [{payloadType, name, clockRate}]
   * @param {number} [opts.timeoutMs=T_INVITE]
   * @returns {Promise<{remoteRtpAddr, remoteRtpPort, codec}>}
   */
  invite({ localRtpPort, offerCodecs, timeoutMs = T_INVITE }) {
    if (this.state !== 'INIT') {
      return Promise.reject(new Error(
        `SipUacInternal.invite: wrong state ${this.state}`));
    }
    if (!localRtpPort || !Array.isArray(offerCodecs) || !offerCodecs.length) {
      return Promise.reject(new Error(
        'SipUacInternal.invite: localRtpPort and offerCodecs required'));
    }

    this._ensureLocalPort();

    this.callId    = sip.generateCallId(this.localAddress);
    this.localTag  = sip.generateTag();
    this.cseq      = 1;
    this.contactUri = `sip:${this.localUser}@${this.localAddress}:${this._localPort}`;

    const offer = sip.buildSdp({
      addr:   this.localAddress,
      port:   localRtpPort,
      codecs: offerCodecs,
    });

    const branch = sip.generateBranch();
    const msg = this._buildRequest({
      method:  'INVITE',
      uri:     this.targetUri,
      branch,
      body:    offer,
      contentType: 'application/sdp',
    });

    log.info(`INVITE → ${this.targetUri} (call-id=${this.callId})`);
    this._transition('TRYING');

    return new Promise((resolve, reject) => {
      this._startTransaction({
        method:     'INVITE',
        branch,
        message:    msg,
        timeoutMs,
        /* INVITE is retransmitted for reliability of 2xx delivery
         * to a lossy network; here on loopback retransmit is a
         * belt-and-suspenders. Note: for INVITE, RFC 3261 says
         * the UAC stops retransmitting once a provisional 1xx
         * response arrives. We honor that in _onResponse. */
        retransmit: true,
        onProvisional: (resp) => {
          /* 180 Ringing and 183 Session Progress move us to EARLY.
           * 100 Trying doesn't (it's hop-by-hop, no dialog). */
          if (resp.statusCode >= 101 && this.state === 'TRYING') {
            this._transition('EARLY');
          }
          /* A remote tag in any 1xx response locks our dialog's
           * remote half — this matters if we ever needed to
           * CANCEL an early dialog, which for now we don't. */
          this._maybeLearnRemoteTag(resp);
        },
        onFinal: (resp) => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            this._handle2xxInvite(resp, branch, resolve, reject);
          } else {
            /* 3xx/4xx/5xx/6xx — dialog never confirmed. Still
             * need to send ACK (only for non-2xx; 2xx ACK is a
             * separate transaction). */
            this._sendAckForNon2xx(resp, branch);
            this._transition('TERMINATED');
            reject(new Error(
              `INVITE failed: ${resp.statusCode} ${resp.reasonPhrase}`));
          }
        },
        onTimeout: () => {
          this._transition('TERMINATED');
          reject(new Error(`INVITE timeout after ${timeoutMs}ms`));
        },
      });
    });
  }

  /**
   * Send BYE and await 200 OK. Resolves on success, rejects on
   * timeout or non-2xx.
   */
  hangup({ timeoutMs = T_BYE } = {}) {
    if (this.state !== 'CONFIRMED') {
      /* If we never got to CONFIRMED, there's nothing to BYE. */
      if (this.state === 'TERMINATED') return Promise.resolve();
      return Promise.reject(new Error(
        `SipUacInternal.hangup: wrong state ${this.state}`));
    }
    this._ensureLocalPort();
    this.cseq++;
    const branch = sip.generateBranch();
    const msg = this._buildRequest({
      method: 'BYE',
      uri:    this._remoteTargetUri(),
      branch,
    });
    log.info(`BYE → (call-id=${this.callId})`);
    return new Promise((resolve, reject) => {
      this._startTransaction({
        method:     'BYE',
        branch,
        message:    msg,
        timeoutMs,
        retransmit: true,
        onFinal:    (resp) => {
          this._transition('TERMINATED');
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(
              `BYE got ${resp.statusCode} ${resp.reasonPhrase}`));
          }
        },
        onTimeout: () => {
          /* BYE lost and not retried successfully. We still
           * consider the dialog torn down on our side — the peer
           * may have a stale dialog we can't clean up. Better
           * than keeping our side stuck in CONFIRMED. */
          this._transition('TERMINATED');
          resolve();
        },
      });
    });
  }

  /**
   * Send an OPTIONS to the peer and wait for any 2xx response.
   * Used for readiness probes before issuing INVITE — lets us tell
   * "peer is up" from "peer is starting up" without spinning.
   *
   * This is stateless wrt dialog — does not transition our state.
   */
  probe({ timeoutMs = T_OPTIONS } = {}) {
    this._ensureLocalPort();
    const callId  = sip.generateCallId(this.localAddress);
    const fromTag = sip.generateTag();
    const branch  = sip.generateBranch();
    const viaHost = `${this.localAddress}:${this._localPort}`;
    const lines = [
      `OPTIONS ${this.targetUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${viaHost};branch=${branch};rport`,
      `From: <sip:${this.localUser}@${viaHost}>;tag=${fromTag}`,
      `To: <${this.targetUri}>`,
      `Call-ID: ${callId}`,
      'CSeq: 1 OPTIONS',
      'Max-Forwards: 70',
      `User-Agent: ${this.userAgent}`,
      'Content-Length: 0',
      '',
      '',
    ];
    const msg = Buffer.from(lines.join('\r\n'), 'utf8');
    return new Promise((resolve, reject) => {
      /* OPTIONS doesn't use our dialog transaction slot; use an
       * ad-hoc one-shot matcher keyed by the local branch. */
      const timer = setTimeout(() => {
        this._options = null;
        reject(new Error(`OPTIONS timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this._options = {
        branch,
        onFinal: (resp) => {
          clearTimeout(timer);
          this._options = null;
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            resolve(resp);
          } else {
            reject(new Error(
              `OPTIONS got ${resp.statusCode} ${resp.reasonPhrase}`));
          }
        },
      };
      this._sendRaw(msg);
    });
  }

  /**
   * Release resources. Removes our socket listener. Caller is
   * responsible for closing the socket itself.
   */
  close() {
    this._clearInflight();
    if (this._options && this._options.timer) clearTimeout(this._options.timer);
    this._options = null;
    if (this.sock && this._onMessageBound) {
      this.sock.removeListener('message', this._onMessageBound);
    }
    if (this.state !== 'TERMINATED') this._transition('TERMINATED');
  }

  /* ─── Response handling ──────────────────────────────────────── */

  _onMessage(msg, rinfo) {
    /* Our tunnel delivers every host-bound SIP packet here.
     * Ignore packets from unexpected sources — belt and braces. */
    if (rinfo.address !== this.peerAddress || rinfo.port !== this.peerPort) {
      log.debug(`ignoring stray UDP from ${rinfo.address}:${rinfo.port}`);
      return;
    }
    let parsed;
    try {
      parsed = sip.parse(msg.toString('utf8'));
    } catch (err) {
      log.warn(`parse failure: ${err.message}`);
      return;
    }
    if (!parsed) {
      /* Log the first chunk so we know what's arriving. Printable
       * characters pass through; non-printable get a '.' so control
       * bytes don't mangle the log line. Truncated at 200 bytes to
       * avoid dumping an entire SDP body. */
      const text = msg.toString('utf8');
      const printable = text.slice(0, 200).replace(/[^\x20-\x7e]/g, '.');
      log.debug(`sip.parse returned null (from ${rinfo.address}:${rinfo.port}, ${msg.length}B): ${printable}`);
      return;
    }
    if (parsed.isRequest) {
      this._onRequest(parsed);
    } else {
      this._onResponse(parsed);
    }
  }

  _onResponse(resp) {
    /* Match on branch in the top Via. */
    const via = resp.getHeader('via');
    const viaParsed = via ? sip.parseVia(via) : null;
    const branch = viaParsed && viaParsed.params && viaParsed.params.branch;
    if (!branch) {
      log.warn('response with no Via branch; dropped');
      return;
    }

    /* Dispatch to an in-flight transaction (INVITE/BYE) or to the
     * OPTIONS probe. */
    if (this._inflight && this._inflight.branch === branch) {
      this._handleTxnResponse(resp);
      return;
    }
    if (this._options && this._options.branch === branch) {
      /* OPTIONS: only terminal responses matter (any 2xx or 4xx/5xx). */
      if (resp.statusCode >= 200) {
        this._options.onFinal(resp);
      }
      return;
    }
    log.debug(`unmatched response branch ${branch}; dropped`);
  }

  _handleTxnResponse(resp) {
    const txn = this._inflight;
    if (resp.statusCode < 200) {
      /* Provisional. Stop retransmitting the INVITE (RFC 3261
       * §17.1.1.2: "Once a provisional response is received, the
       * client transaction SHOULD NOT retransmit the request"). */
      if (txn.method === 'INVITE') txn.stopRetransmit = true;
      if (txn.onProvisional) txn.onProvisional(resp);
      return;
    }
    /* Final response. Clear the transaction slot before invoking
     * the callback so the callback can start a follow-up (e.g.
     * ACK + potential new request). */
    this._clearInflight();
    if (txn.onFinal) txn.onFinal(resp);
  }

  _onRequest(req) {
    /* We're a UAC so the only incoming requests we expect within a
     * dialog are BYE (peer hangup) and, in exotic flows, re-INVITE.
     * We handle BYE; everything else we 405 for visibility. */
    if (req.method === 'BYE' && this._isDialogRequest(req)) {
      this._handlePeerBye(req);
      return;
    }
    log.warn(`unexpected incoming ${req.method}; replying 405`);
    this._sendResponse(req, 405, 'Method Not Allowed');
  }

  _isDialogRequest(req) {
    const cid = req.getHeader('call-id');
    const from = req.getHeader('from');
    const to = req.getHeader('to');
    /* Their From is our To (from original INVITE's perspective). */
    const theirFromTag = from && /;tag=([^;\s>]+)/.exec(from);
    const ourToTag = to && /;tag=([^;\s>]+)/.exec(to);
    return cid === this.callId &&
      (!this.remoteTag || (theirFromTag && theirFromTag[1] === this.remoteTag)) &&
      (!this.localTag  || (ourToTag   && ourToTag[1] === this.localTag));
  }

  _handlePeerBye(req) {
    log.info(`peer BYE received (call-id=${this.callId})`);
    this._sendResponse(req, 200, 'OK');
    if (this.state !== 'TERMINATED') {
      this._transition('TERMINATED');
      this.emit('ended', { initiator: 'peer' });
    }
  }

  /* ─── Outbound request machinery ─────────────────────────────── */

  _handle2xxInvite(resp, inviteBranch, resolve, reject) {
    this._maybeLearnRemoteTag(resp);

    /* Extract Contact for remote target URI (for subsequent BYE). */
    const contact = resp.getHeader('contact');
    if (contact) {
      const m = /<([^>]+)>/.exec(contact);
      if (m) this._remoteContact = m[1];
      else   this._remoteContact = contact.trim();
    }

    /* Send ACK. Per RFC 3261, the 2xx-ACK is a new transaction
     * (new branch), not the INVITE's branch. It goes to the
     * Contact URI's address. For our simple direct-dial setup the
     * Contact is already on 127.0.0.1:5060. */
    const ackBranch = sip.generateBranch();
    const ackMsg = this._buildRequest({
      method: 'ACK',
      uri:    this._remoteTargetUri(),
      branch: ackBranch,
      cseqOverride: this.cseq,  /* ACK to 2xx reuses INVITE's CSeq number */
    });
    this._sendRaw(ackMsg);

    /* Parse SDP. If no media section found we still accept the
     * dialog (some flows do late-offer) but report nulls. */
    const sdp = sip.parseSdp(resp.body || '');
    const audio = sdp && sdp.media && sdp.media.find(m => m.type === 'audio');
    const connAddr = audio && (audio.connection?.address || sdp.connection?.address);
    const negotiated = {
      remoteRtpAddr: connAddr || null,
      remoteRtpPort: audio ? audio.port : null,
      codec:         audio && audio.formats && audio.formats[0]
                      ? audio.rtpmap[audio.formats[0]] || null
                      : null,
    };

    this._transition('CONFIRMED');
    resolve(negotiated);
  }

  _sendAckForNon2xx(resp, inviteBranch) {
    /* For non-2xx INVITE responses, the ACK is part of the INVITE
     * transaction — it reuses the INVITE's branch and top Via, and
     * goes to the same place the INVITE went. */
    const via = resp.getHeader('via');
    const toHeader = resp.getHeader('to');
    const toTag = toHeader ? /;tag=([^;\s>]+)/.exec(toHeader) : null;
    const ack = [
      `ACK ${this.targetUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localAddress}:${this._localPort};branch=${inviteBranch};rport`,
      `From: <sip:${this.localUser}@${this.localAddress}:${this._localPort}>;tag=${this.localTag}`,
      toTag ? `To: <${this.targetUri}>;tag=${toTag[1]}` : `To: <${this.targetUri}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseq} ACK`,
      'Max-Forwards: 70',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n');
    this._sendRaw(Buffer.from(ack, 'utf8'));
  }

  _maybeLearnRemoteTag(resp) {
    if (this.remoteTag) return;
    const toHeader = resp.getHeader('to');
    const m = toHeader ? /;tag=([^;\s>]+)/.exec(toHeader) : null;
    if (m) this.remoteTag = m[1];
  }

  _remoteTargetUri() {
    /* Post-INVITE, requests in this dialog go to the Contact URI
     * learned from 200 OK. Before that (or if Contact wasn't
     * provided) fall back to the original targetUri. */
    return this._remoteContact || this.targetUri;
  }

  /* ─── Request builder ────────────────────────────────────────── */

  _buildRequest({ method, uri, branch, body, contentType, cseqOverride }) {
    const contentLength = body ? Buffer.byteLength(body, 'utf8') : 0;
    const cseq = cseqOverride !== undefined ? cseqOverride : this.cseq;
    const viaHost = `${this.localAddress}:${this._localPort}`;
    const lines = [
      `${method} ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${viaHost};branch=${branch};rport`,
      `From: <sip:${this.localUser}@${viaHost}>;tag=${this.localTag}`,
      this.remoteTag
        ? `To: <${this.targetUri}>;tag=${this.remoteTag}`
        : `To: <${this.targetUri}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: <${this.contactUri}>`,
      'Max-Forwards: 70',
      `User-Agent: ${this.userAgent}`,
    ];
    if (contentType) lines.push(`Content-Type: ${contentType}`);
    lines.push(`Content-Length: ${contentLength}`);
    lines.push('');
    lines.push('');
    const header = lines.join('\r\n');
    if (body) {
      return Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(body, 'utf8')]);
    }
    return Buffer.from(header, 'utf8');
  }

  _buildResponse(req, statusCode, reasonPhrase) {
    /* Echo the request's Via, From, Call-ID, CSeq; set our local
     * tag on To if it isn't already present. */
    const via = req.getHeader('via');
    const from = req.getHeader('from');
    const to = req.getHeader('to');
    const callId = req.getHeader('call-id');
    const cseq = req.getHeader('cseq');

    let toFinal = to;
    if (toFinal && !/;tag=/.test(toFinal) && this.localTag) {
      toFinal = `${toFinal};tag=${this.localTag}`;
    }

    const lines = [
      `SIP/2.0 ${statusCode} ${reasonPhrase}`,
      `Via: ${via}`,
      `From: ${from}`,
      `To: ${toFinal}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq}`,
      `User-Agent: ${this.userAgent}`,
      'Content-Length: 0',
      '',
      '',
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8');
  }

  _sendResponse(req, statusCode, reasonPhrase) {
    const buf = this._buildResponse(req, statusCode, reasonPhrase);
    this._sendRaw(buf);
  }

  /* ─── Transaction helpers ───────────────────────────────────── */

  _startTransaction({ method, branch, message, timeoutMs, retransmit,
                      onProvisional, onFinal, onTimeout }) {
    const txn = {
      method, branch, message,
      onProvisional, onFinal, onTimeout,
      stopRetransmit: false,
      retransmitCount: 0,
      overallTimer: null,
      retransmitTimer: null,
    };
    this._inflight = txn;

    /* Fire and schedule. */
    this._sendRaw(message);

    if (retransmit) {
      const scheduleNext = (interval) => {
        if (txn.stopRetransmit || this._inflight !== txn) return;
        txn.retransmitTimer = setTimeout(() => {
          if (txn.stopRetransmit || this._inflight !== txn) return;
          txn.retransmitCount++;
          if (txn.retransmitCount > MAX_RETRANSMITS) return;
          log.debug(`retransmit ${method} #${txn.retransmitCount}`);
          this._sendRaw(message);
          scheduleNext(Math.min(interval * 2, 1000));
        }, interval);
      };
      scheduleNext(T1_MS);
    }

    txn.overallTimer = setTimeout(() => {
      if (this._inflight !== txn) return;
      this._clearInflight();
      if (onTimeout) onTimeout();
    }, timeoutMs);
  }

  _clearInflight() {
    if (!this._inflight) return;
    if (this._inflight.retransmitTimer) clearTimeout(this._inflight.retransmitTimer);
    if (this._inflight.overallTimer)    clearTimeout(this._inflight.overallTimer);
    this._inflight = null;
  }

  /* ─── Wire I/O ──────────────────────────────────────────────── */

  _ensureLocalPort() {
    if (this._localPort) return;
    const addr = this.sock.address();
    if (!addr || !addr.port) {
      throw new Error('SipUacInternal: udpSocket is not bound');
    }
    this._localPort = addr.port;
  }

  _sendRaw(buf) {
    this.sock.send(buf, this.peerPort, this.peerAddress, (err) => {
      if (err) {
        log.error(`send failed: ${err.message}`);
        this.emit('error', err);
      }
    });
  }

  /* ─── State machine ─────────────────────────────────────────── */

  _transition(newState) {
    if (newState === this.state) return;
    const prev = this.state;
    this.state = newState;
    log.debug(`${this.callId || '-'}: ${prev} → ${newState}`);
    this.emit('stateChange', { from: prev, to: newState });
  }
}

module.exports = { SipUacInternal };
