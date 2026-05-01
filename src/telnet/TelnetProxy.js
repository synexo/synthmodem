'use strict';

/**
 * TelnetProxy
 *
 * Presents a terminal menu to the connected modem user.
 * Accepts "host" or "host:port" input, opens a TCP connection,
 * and proxies bidirectionally between the modem data stream and the TCP socket.
 *
 * Also handles basic Telnet option negotiation (RFC 854/855).
 */

const net            = require('net');
const dns            = require('dns');
const { EventEmitter } = require('events');
const config         = require('../../config');
const { makeLogger } = require('../logger');

const log  = makeLogger('TelnetProxy');
const cfg  = config.telnet;
const tcfg = config.terminal;

// ─── Telnet option codes ──────────────────────────────────────────────────────
const IAC  = 0xFF;
const WILL = 0xFB;
const WONT = 0xFC;
const DO   = 0xFD;
const DONT = 0xFE;
const SB   = 0xFA;
const SE   = 0xF0;

const OPT_ECHO          = 0x01;
const OPT_SUPPRESS_GA   = 0x03;
const OPT_TTYPE         = 0x18;
const OPT_NAWS          = 0x1F;

// ─── Telnet proxy states ──────────────────────────────────────────────────────
const STATE = {
  MENU:       'MENU',       // Showing menu, reading host:port
  CONNECTING: 'CONNECTING', // TCP connect in progress
  PROXYING:   'PROXYING',   // Bidirectional proxy active
  CLOSING:    'CLOSING',
};

class TelnetProxy extends EventEmitter {

  constructor() {
    super();
    this._state        = STATE.MENU;
    this._tcpSocket    = null;
    this._inputBuf     = '';
    this._txCallback   = null; // fn(Buffer) — called to send data to modem
    this._idleTimer    = null;
    this._connectTimer = null;

    // Menu-idle heartbeat — see _scheduleMenuHeartbeat for rationale.
    this._menuHeartbeat = null;
  }

  /**
   * Attach a send function for writing data back to the modem client.
   *
   * @param {Function} sendFn  fn(Buffer)
   * @param {object}   [connectInfo]  Optional connection details for
   *     banner-placeholder substitution. Currently supported:
   *       protocol — string, e.g. 'V32bis', 'Bell103'
   *       bps      — number, e.g. 9600
   *     The banner string may contain `{{protocol}}` and `{{bps}}`
   *     placeholders which are replaced at attach time. Banners with
   *     no placeholders are unaffected (backwards compatible).
   */
  attach(sendFn, connectInfo) {
    this._txCallback = sendFn;
    this._connectInfo = connectInfo || null;
    this._sendBanner();
    this._sendPrompt();
    this._scheduleMenuHeartbeat();
  }

  /**
   * Called when data arrives from the modem (user input or proxied data).
   * @param {Buffer} data
   */
  receive(data) {
    // Any inbound activity from the modem side defers the menu-idle
    // heartbeat — when the user is actively typing, the UART is being
    // exercised by real frames in both directions, so the heartbeat
    // would be redundant. The heartbeat only matters during long
    // periods of NO data flow.
    this._scheduleMenuHeartbeat();

    if (this._state === STATE.PROXYING) {
      // Ctrl+] (0x1D) — escape back to menu
      if (data.length === 1 && data[0] === 0x1D) {
        this._sendLine('\r\n[Escape — returning to menu]');
        this._returnToMenu();
        return;
      }
      // Ctrl+\ (0x1C) also accepted as escape
      if (data.length === 1 && data[0] === 0x1C) {
        this._sendLine('\r\n[Escape — returning to menu]');
        this._returnToMenu();
        return;
      }
      // Forward to remote telnet server
      if (this._tcpSocket && !this._tcpSocket.destroyed) {
        this._tcpSocket.write(data);
        this._resetIdleTimer();
      }
      return;
    }

    if (this._state === STATE.MENU) {
      // Accumulate into line buffer
      for (const byte of data) {
        const ch = String.fromCharCode(byte);
        if (byte === 0x08 || byte === 0x7F) {
          // Backspace
          if (this._inputBuf.length > 0) {
            this._inputBuf = this._inputBuf.slice(0, -1);
            if (tcfg.localEcho) this._send(Buffer.from('\x08 \x08'));
          }
        } else if (byte === 0x0D || byte === 0x0A) {
          // Enter
          if (tcfg.localEcho) this._send(Buffer.from(tcfg.lineEnding));
          this._handleInput(this._inputBuf.trim());
          this._inputBuf = '';
        } else if (byte >= 0x20 && byte < 0x7F) {
          this._inputBuf += ch;
          if (tcfg.localEcho) this._send(Buffer.from(ch));
        }
      }
    }
  }

  // ─── Terminal output ──────────────────────────────────────────────────────────

  _send(data) {
    if (this._txCallback) {
      this._txCallback(Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
    // Anything we send is itself a UART frame that exercises the
    // receiving modem's UART — so reset the heartbeat clock. The
    // heartbeat only ticks after a sustained period of zero TX.
    this._scheduleMenuHeartbeat();
  }

  _sendStr(str) {
    // Accept strings, arrays of strings, numbers, anything. Coerce to a
    // single string first. Arrays are joined with the configured line
    // ending so a multi-line banner can be `['line 1', 'line 2']`.
    let text;
    if (Array.isArray(str)) {
      text = str.join(tcfg.lineEnding);
    } else if (typeof str === 'string') {
      text = str;
    } else if (str == null) {
      text = '';
    } else {
      text = String(str);
    }
    this._send(Buffer.from(text.replace(/\n/g, tcfg.lineEnding)));
  }

  _sendBanner() {
    this._sendStr(this._renderBanner(tcfg.banner));
  }

  /**
   * Substitute `{{protocol}}` and `{{bps}}` placeholders in the
   * banner using `this._connectInfo`. Accepts either a string or an
   * array of strings (banner is sometimes configured as a multi-line
   * array). Missing fields render as 'unknown' / '0' rather than
   * leaving the literal placeholder visible — a partially-filled
   * banner is friendlier than `CONNECT {{bps}}` reaching the user.
   *
   * If no connect info is provided, placeholders render as 'unknown'
   * / '0'. This keeps the substitution path uniform regardless of
   * whether the caller supplied info.
   */
  _renderBanner(banner) {
    const info = this._connectInfo || {};
    const protocol = info.protocol != null ? String(info.protocol) : 'unknown';
    const bps      = info.bps      != null ? String(info.bps)      : '0';
    const sub = (s) => String(s)
      .replace(/\{\{protocol\}\}/g, protocol)
      .replace(/\{\{bps\}\}/g, bps);
    if (Array.isArray(banner)) return banner.map(sub);
    return sub(banner == null ? '' : banner);
  }

  _sendPrompt() {
    this._sendStr(tcfg.prompt);
  }

  _sendLine(str) {
    this._sendStr(str + tcfg.lineEnding);
  }

  // ─── Input handling ───────────────────────────────────────────────────────────

  _handleInput(input) {
    if (!input) {
      this._sendPrompt();
      return;
    }

    const upper = input.toUpperCase();

    if (upper === 'QUIT' || upper === 'EXIT' || upper === 'BYE') {
      this._sendLine('Goodbye.');
      this.emit('disconnect');
      return;
    }

    if (upper === 'HELP' || upper === '?') {
      this._sendHelp();
      this._sendPrompt();
      return;
    }

    // Parse host[:port]
    const parsed = this._parseHostPort(input);
    if (!parsed) {
      this._sendLine('Invalid address. Use: hostname or hostname:port');
      this._sendPrompt();
      return;
    }

    this._connect(parsed.host, parsed.port);
  }

  _parseHostPort(input) {
    // IPv6: [::1]:23
    const ipv6 = input.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (ipv6) {
      return { host: ipv6[1], port: parseInt(ipv6[2] || tcfg.defaultPort, 10) };
    }
    // host:port or host
    const parts = input.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      return { host: parts[0], port: parseInt(parts[1], 10) };
    }
    if (parts.length === 1 && parts[0].length > 0) {
      return { host: parts[0], port: tcfg.defaultPort };
    }
    return null;
  }

  _sendHelp() {
    this._sendLine('');
    this._sendLine('Commands:');
    this._sendLine('  <host>        Connect to host on default port (' + tcfg.defaultPort + ')');
    this._sendLine('  <host>:<port> Connect to host:port');
    this._sendLine('  QUIT          Disconnect');
    this._sendLine('  HELP          Show this help');
    this._sendLine('');
    this._sendLine('While connected: press Ctrl+] then type QUIT to return to menu.');
    this._sendLine('');
  }

  // ─── TCP connection ───────────────────────────────────────────────────────────

  _connect(host, port) {
    this._cancelMenuHeartbeat();
    this._state = STATE.CONNECTING;
    this._sendLine(`Connecting to ${host}:${port}...`);
    log.info(`Connecting to ${host}:${port}`);

    // Access control check
    if (!this._checkAllowed(host)) {
      this._sendLine(`Connection to ${host} not permitted.`);
      this._returnToMenu();
      return;
    }

    this._connectTimer = setTimeout(() => {
      this._sendLine('Connection timed out.');
      this._returnToMenu();
    }, cfg.connectTimeoutMs);

    this._tcpSocket = net.connect(port, host, () => {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      this._state = STATE.PROXYING;
      log.info(`Connected to ${host}:${port}`);
      this._sendLine(`Connected to ${host}:${port}. Press Ctrl+] then QUIT to disconnect.`);
      this._sendLine('');
      this._startIdleTimer();

      // Send telnet negotiation if enabled
      if (cfg.negotiateOptions) {
        this._sendTelnetInit();
      }
    });

    this._tcpSocket.on('data', data => {
      // Forward from remote server to modem client
      this._send(data);
      this._resetIdleTimer();
    });

    this._tcpSocket.on('error', err => {
      clearTimeout(this._connectTimer);
      log.warn(`TCP error to ${host}:${port}`, { err: err.message });
      this._sendLine(`\r\nConnection error: ${err.message}`);
      this._returnToMenu();
    });

    this._tcpSocket.on('close', () => {
      if (this._state === STATE.PROXYING) {
        this._sendLine('\r\nConnection closed by remote host.');
        this._returnToMenu();
      }
    });
  }

  _checkAllowed(host) {
    if (cfg.blockedHosts.some(h => host.includes(h))) return false;
    if (cfg.allowedHosts.length === 0) return true;
    return cfg.allowedHosts.some(pattern => {
      if (pattern.startsWith('*.')) {
        return host.endsWith(pattern.slice(1));
      }
      return host === pattern || host.startsWith(pattern.replace(/\/\d+$/, ''));
    });
  }

  // ─── Telnet option negotiation ────────────────────────────────────────────────

  _sendTelnetInit() {
    // WILL ECHO — we handle echo
    // DO SUPPRESS-GO-AHEAD — suppress GA
    // WILL NAWS — send window size
    // WILL TTYPE — terminal type
    const neg = Buffer.from([
      IAC, WILL, OPT_ECHO,
      IAC, WILL, OPT_SUPPRESS_GA,
      IAC, DO,   OPT_SUPPRESS_GA,
      IAC, WILL, OPT_TTYPE,
      IAC, WILL, OPT_NAWS,
      // NAWS: send cols and rows
      IAC, SB, OPT_NAWS,
        (tcfg.terminalCols >> 8) & 0xFF, tcfg.terminalCols & 0xFF,
        (tcfg.terminalRows >> 8) & 0xFF, tcfg.terminalRows & 0xFF,
      IAC, SE,
    ]);
    if (this._tcpSocket && !this._tcpSocket.destroyed) {
      this._tcpSocket.write(neg);
    }
  }

  // ─── Idle timer ───────────────────────────────────────────────────────────────

  _startIdleTimer() {
    if (cfg.idleTimeoutMs <= 0) return;
    this._idleTimer = setTimeout(() => {
      this._sendLine('\r\nIdle timeout — disconnecting.');
      this._closeConnection();
      this._returnToMenu();
    }, cfg.idleTimeoutMs);
  }

  _resetIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._startIdleTimer();
    }
  }

  // ─── Menu-idle heartbeat ──────────────────────────────────────────────────────
  //
  // Background (April 2026, after the v22-fix-phase5 spandsp port).
  //
  // V.22 idle is "scrambled marking": the scrambler input is held at
  // continuous binary 1, and the scrambler output is therefore a
  // pseudorandom 50/50 bit stream on the line. Both ends' scramblers
  // and descramblers stay in sync indefinitely if every line bit is
  // received correctly — the descrambler output is then continuous 1s,
  // and the receiving UART, never seeing a start bit (a 0), emits no
  // bytes. That is the protocol's intended behavior, and it works in
  // self-loopback.
  //
  // Real-world hardware modems behave less ideally during long pure-
  // idle windows. Their UARTs occasionally trip on a "false start bit"
  // — a 0 in the pseudorandom stream — and then attempt to frame the
  // following 8 bits + stop. A pseudorandom stream provides such
  // patterns at moderately high rates: empirically about 1 in 11 bits
  // (the UART overhead) appears to start a "frame" by chance. Once a
  // hardware UART is misframed (it captured a false start bit and 8
  // pseudorandom data bits), it stays misframed because pure scrambled
  // idle never produces 9+ consecutive marks for clean resync.
  //
  // The user-visible effect is the long-standing "garbage at CONNECT>"
  // behaviour: when no data is flowing for tens of seconds, the user's
  // hardware modem's UART produces a stream of bogus characters from
  // the line idle, and any subsequent real data from us (e.g. a fresh
  // CONNECT> prompt re-render after BBS disconnect) arrives partly
  // misframed because the UART hasn't caught up.
  //
  // Mitigation: during long MENU-state idle, periodically transmit a
  // lone CR (0x0D). A CR is:
  //   - a real UART-framed byte (start 0, data 00001011, stop 1) which
  //     gives the receiving UART a clean, deterministic frame to
  //     resync against;
  //   - rendered as "cursor to column 0" by every terminal we care
  //     about, with no visible artefact (the CONNECT> prompt is
  //     already at column 0 from _sendPrompt's lineEnding, and any
  //     mis-decoded garbage on the same line is overwritten cleanly
  //     when the next real prompt re-renders);
  //   - also exercises the line's scrambler/descrambler with real
  //     non-marking input, which keeps both ends' shift registers
  //     resynced if either has drifted.
  //
  // This is a workaround for a property of long V.22 idle as seen by
  // hardware-modem UARTs, not a fix to the V.22 demodulator (which is
  // bit-exact correct against spandsp's reference). The heartbeat
  // does not run during PROXYING — real BBS data already exercises
  // the UART continuously.
  //
  // Cadence: after 5 s of MENU idle with no TX/RX, send one CR. Reset
  // the timer on any send/receive activity. So during normal use
  // (user is typing or BBS data is flowing) the heartbeat never fires.

  _scheduleMenuHeartbeat() {
    this._cancelMenuHeartbeat();
    // Only schedule in MENU state.
    if (this._state !== STATE.MENU) return;
    const interval = (cfg.menuIdleHeartbeatMs | 0);
    if (interval <= 0) return;  // disabled by config
    this._menuHeartbeat = setTimeout(() => {
      this._fireMenuHeartbeat();
    }, interval);
  }

  _cancelMenuHeartbeat() {
    if (this._menuHeartbeat) {
      clearTimeout(this._menuHeartbeat);
      this._menuHeartbeat = null;
    }
  }

  _fireMenuHeartbeat() {
    this._menuHeartbeat = null;
    // Re-check state in case we transitioned out of MENU between the
    // schedule and the fire (e.g. a connect-host command arrived).
    if (this._state !== STATE.MENU) return;
    if (!this._txCallback) return;
    // Send a single CR. Use the raw txCallback (not _send) to avoid
    // the recursive scheduling — _send would re-arm the heartbeat,
    // turning what should be an aperiodic wake into a periodic CR
    // every interval. We want to re-arm only via a separate explicit
    // schedule call below.
    this._txCallback(Buffer.from([0x0D]));
    this._scheduleMenuHeartbeat();
  }

  // ─── Return to menu ───────────────────────────────────────────────────────────

  _closeConnection() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this._tcpSocket) {
      this._tcpSocket.destroy();
      this._tcpSocket = null;
    }
  }

  _returnToMenu() {
    this._state    = STATE.MENU;
    this._inputBuf = '';
    this._closeConnection();
    this._sendLine('');
    this._sendPrompt();
    // Returning to MENU after a TCP-side close is the prime case for the
    // heartbeat: the user may sit at CONNECT> for tens of seconds before
    // typing anything, and during that time the receiving modem's UART
    // can drift. _sendPrompt above will have called _send → schedule,
    // but be explicit for clarity.
    this._scheduleMenuHeartbeat();
  }

  disconnect() {
    this._closeConnection();
    this._cancelMenuHeartbeat();
    this._state = STATE.CLOSING;
  }

  get state() { return this._state; }
}

module.exports = { TelnetProxy };
