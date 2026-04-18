'use strict';

/**
 * SipParser — parse and serialise SIP messages.
 * Handles requests and responses, multi-value headers, and SDP bodies.
 */

const CRLF = '\r\n';

class SipMessage {
  constructor() {
    this.isRequest    = false;
    this.method       = null;   // e.g. 'INVITE'
    this.requestUri   = null;   // e.g. 'sip:modem@host'
    this.statusCode   = null;   // e.g. 200
    this.reasonPhrase = null;   // e.g. 'OK'
    this.headers      = {};     // name (lowercase) -> string | string[]
    this.body         = '';
    this.rawHeaders   = [];     // original order preserved [{name, value}]
  }

  /** Get first value for a header (case-insensitive) */
  getHeader(name) {
    const v = this.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }

  /** Get all values for a header */
  getHeaders(name) {
    const v = this.headers[name.toLowerCase()];
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  }

  /** Set header (replaces) */
  setHeader(name, value) {
    const k = name.toLowerCase();
    this.headers[k] = value;
    // Update rawHeaders
    const idx = this.rawHeaders.findIndex(h => h.name.toLowerCase() === k);
    if (idx >= 0) this.rawHeaders[idx].value = value;
    else this.rawHeaders.push({ name, value });
  }

  /** Get parsed Via header(s) as objects */
  get viaList() {
    return this.getHeaders('via').map(parseVia);
  }

  /** Top Via */
  get topVia() {
    return parseVia(this.getHeader('via') || '');
  }

  /** Parsed From */
  get fromParsed() {
    return parseAddressHeader(this.getHeader('from') || '');
  }

  /** Parsed To */
  get toParsed() {
    return parseAddressHeader(this.getHeader('to') || '');
  }

  /** CSeq as {seq, method} */
  get cseqParsed() {
    const v = this.getHeader('cseq') || '';
    const m = v.match(/(\d+)\s+(\S+)/);
    return m ? { seq: parseInt(m[1], 10), method: m[2] } : { seq: 0, method: '' };
  }

  /** Content-Length as number */
  get contentLength() {
    return parseInt(this.getHeader('content-length') || '0', 10);
  }

  /** Serialise to string */
  toString() {
    const lines = [];
    if (this.isRequest) {
      lines.push(`${this.method} ${this.requestUri} SIP/2.0`);
    } else {
      lines.push(`SIP/2.0 ${this.statusCode} ${this.reasonPhrase}`);
    }
    // Write headers in original insertion order, Content-Length always last
    const skipCl = new Set(['content-length']);
    for (const { name, value } of this.rawHeaders) {
      if (skipCl.has(name.toLowerCase())) continue;
      if (Array.isArray(value)) {
        for (const v of value) lines.push(`${name}: ${v}`);
      } else {
        lines.push(`${name}: ${value}`);
      }
    }
    const bodyStr = this.body || '';
    lines.push(`Content-Length: ${Buffer.byteLength(bodyStr, 'utf8')}`);
    lines.push('');
    lines.push(bodyStr);
    return lines.join(CRLF);
  }

  toBuffer() {
    return Buffer.from(this.toString(), 'utf8');
  }
}

// ─── Short-form header name expansion ─────────────────────────────────────────
const COMPACT_HEADERS = {
  v: 'via',
  f: 'from',
  t: 'to',
  m: 'contact',
  i: 'call-id',
  e: 'content-encoding',
  l: 'content-length',
  c: 'content-type',
  s: 'subject',
  k: 'supported',
};

function expandHeaderName(name) {
  const lc = name.toLowerCase();
  return COMPACT_HEADERS[lc] || lc;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a SIP message from a Buffer or string.
 * Returns a SipMessage or null on fatal parse failure.
 */
function parse(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;

  // Split on the header/body boundary
  const boundaryIdx = text.indexOf(CRLF + CRLF);
  if (boundaryIdx === -1) return null;

  const headerSection = text.slice(0, boundaryIdx);
  const bodyStart     = boundaryIdx + 4;

  const lines = headerSection.split(CRLF);
  if (lines.length === 0) return null;

  // Unfold header continuations (RFC 3261 §7.3.1)
  const unfolded = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else {
      unfolded.push(line);
    }
  }

  const msg = new SipMessage();
  const startLine = unfolded[0];

  if (startLine.startsWith('SIP/2.0')) {
    // Response
    const m = startLine.match(/^SIP\/2\.0\s+(\d{3})\s*(.*)/);
    if (!m) return null;
    msg.isRequest    = false;
    msg.statusCode   = parseInt(m[1], 10);
    msg.reasonPhrase = m[2].trim();
  } else {
    // Request
    const m = startLine.match(/^([A-Z]+)\s+(\S+)\s+SIP\/2\.0/);
    if (!m) return null;
    msg.isRequest  = true;
    msg.method     = m[1];
    msg.requestUri = m[2];
  }

  // Parse headers
  for (let i = 1; i < unfolded.length; i++) {
    const line = unfolded[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const rawName = line.slice(0, colon).trim();
    const value   = line.slice(colon + 1).trim();
    const name    = expandHeaderName(rawName);

    // Some headers may appear multiple times
    if (msg.headers[name] !== undefined) {
      if (!Array.isArray(msg.headers[name])) {
        msg.headers[name] = [msg.headers[name]];
      }
      msg.headers[name].push(value);
      // Mirror in rawHeaders array
      msg.rawHeaders.push({ name: rawName, value });
    } else {
      msg.headers[name] = value;
      msg.rawHeaders.push({ name: rawName, value });
    }
  }

  // Body
  const cl = parseInt(msg.headers['content-length'] || '0', 10);
  if (cl > 0) {
    msg.body = text.slice(bodyStart, bodyStart + cl);
  }

  return msg;
}

// ─── SDP parser (minimal) ─────────────────────────────────────────────────────

/**
 * Parse an SDP body into a plain object.
 */
function parseSdp(body) {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  const sdp = { version: 0, origin: {}, session: '', media: [] };
  let currentMedia = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const type  = line[0];
    const value = line.slice(2);

    switch (type) {
      case 'v': sdp.version = parseInt(value, 10); break;
      case 'o': {
        const p = value.split(' ');
        sdp.origin = { username: p[0], sessionId: p[1], sessionVersion: p[2],
          netType: p[3], addrType: p[4], address: p[5] };
        break;
      }
      case 's': sdp.session = value; break;
      case 'c': {
        const p = value.split(' ');
        const conn = { netType: p[0], addrType: p[1], address: p[2] };
        if (currentMedia) currentMedia.connection = conn;
        else sdp.connection = conn;
        break;
      }
      case 'm': {
        const p = value.split(' ');
        currentMedia = {
          type: p[0],
          port: parseInt(p[1], 10),
          proto: p[2],
          formats: p.slice(3),
          attributes: [],
          rtpmap: {},
          fmtp: {},
        };
        sdp.media.push(currentMedia);
        break;
      }
      case 'a': {
        const container = currentMedia || sdp;
        if (!container.attributes) container.attributes = [];
        container.attributes.push(value);
        // Parse rtpmap
        const rtpmap = value.match(/^rtpmap:(\d+)\s+(.+)\/(\d+)/);
        if (rtpmap && currentMedia) {
          currentMedia.rtpmap[rtpmap[1]] = { codec: rtpmap[2], rate: parseInt(rtpmap[3], 10) };
        }
        // Parse fmtp
        const fmtp = value.match(/^fmtp:(\d+)\s+(.*)/);
        if (fmtp && currentMedia) {
          currentMedia.fmtp[fmtp[1]] = fmtp[2];
        }
        break;
      }
      default: break;
    }
  }
  return sdp;
}

/**
 * Build a minimal SDP offer/answer for audio.
 */
function buildSdp({ addr, port, codecs, sessionId, sessionVersion }) {
  const id  = sessionId      || (Date.now() % 1e9 | 0);
  const ver = sessionVersion || id;

  const lines = [
    'v=0',
    `o=synthmodem ${id} ${ver} IN IP4 ${addr}`,
    's=SynthModem',
    `c=IN IP4 ${addr}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${codecs.map(c => c.payloadType).join(' ')}`,
  ];

  for (const c of codecs) {
    lines.push(`a=rtpmap:${c.payloadType} ${c.name}/${c.clockRate}`);
  }
  lines.push('a=sendrecv');
  lines.push('');
  return lines.join(CRLF);
}

// ─── Header field parsers ─────────────────────────────────────────────────────

function parseVia(via) {
  // SIP/2.0/UDP 192.168.1.1:5060;branch=z9hG4bK-...;rport
  const m = via.match(/SIP\/2\.0\/(\w+)\s+([^;]+)(.*)/);
  if (!m) return {};
  const sentBy  = m[2].trim();
  const [host, port] = sentBy.split(':');
  const params  = {};
  for (const p of m[3].split(';').filter(Boolean)) {
    const eq = p.indexOf('=');
    if (eq >= 0) params[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    else params[p.trim()] = true;
  }
  return {
    transport: m[1],
    host,
    port: port ? parseInt(port, 10) : 5060,
    params,
    raw: via,
  };
}

function parseAddressHeader(value) {
  // "Display Name" <sip:user@host>;tag=xxx
  // sip:user@host;tag=xxx
  let displayName = '';
  let uri         = '';
  let params      = {};

  const angleMatch = value.match(/^(.*?)<([^>]+)>(.*)/);
  if (angleMatch) {
    displayName = angleMatch[1].trim().replace(/^"|"$/g, '');
    uri         = angleMatch[2];
    parseParamString(angleMatch[3], params);
  } else {
    const semi = value.indexOf(';');
    if (semi >= 0) {
      uri = value.slice(0, semi).trim();
      parseParamString(value.slice(semi), params);
    } else {
      uri = value.trim();
    }
  }

  const uriMatch = uri.match(/^sip:(?:([^@]+)@)?(.+)/i);
  return {
    displayName,
    uri,
    user:   uriMatch ? uriMatch[1] || '' : '',
    host:   uriMatch ? uriMatch[2].split(':')[0] : '',
    tag:    params['tag'] || '',
    params,
  };
}

function parseParamString(str, out = {}) {
  for (const p of str.split(';').filter(Boolean)) {
    const eq = p.indexOf('=');
    if (eq >= 0) out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    else if (p.trim()) out[p.trim()] = true;
  }
  return out;
}

// ─── Response builder ─────────────────────────────────────────────────────────

function buildResponse(request, statusCode, reasonPhrase, extraHeaders = {}, body = '') {
  const resp = new SipMessage();
  resp.isRequest    = false;
  resp.statusCode   = statusCode;
  resp.reasonPhrase = reasonPhrase;

  // Copy Via headers (preserve order and values) — RFC 3261 §8.2.6
  const vias = request.getHeaders('via');
  for (const via of vias) {
    resp.setHeader('Via', via);
    // We need multiple Via entries — handle array
  }
  if (vias.length > 1) {
    resp.headers['via'] = vias;
    resp.rawHeaders = resp.rawHeaders.filter(h => h.name.toLowerCase() !== 'via');
    resp.rawHeaders.push({ name: 'Via', value: vias });
  }

  resp.setHeader('From',     request.getHeader('from'));
  resp.setHeader('To',       request.getHeader('to'));
  resp.setHeader('Call-ID',  request.getHeader('call-id'));
  resp.setHeader('CSeq',     request.getHeader('cseq'));

  for (const [k, v] of Object.entries(extraHeaders)) {
    resp.setHeader(k, v);
  }

  if (body) resp.body = body;
  return resp;
}

/** Generate a random SIP branch parameter */
function generateBranch() {
  return 'z9hG4bK-' + Math.random().toString(36).slice(2, 12).toUpperCase();
}

/** Generate a random tag */
function generateTag() {
  return Math.random().toString(36).slice(2, 12);
}

/** Generate a Call-ID */
function generateCallId(host) {
  return Math.random().toString(36).slice(2, 18) + '@' + host;
}

module.exports = {
  SipMessage,
  parse,
  parseSdp,
  buildSdp,
  buildResponse,
  parseVia,
  parseAddressHeader,
  generateBranch,
  generateTag,
  generateCallId,
};
