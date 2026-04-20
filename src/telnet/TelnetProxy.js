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
  }

  /**
   * Attach a send function for writing data back to the modem client.
   * @param {Function} sendFn  fn(Buffer)
   */
  attach(sendFn) {
    this._txCallback = sendFn;
    this._sendBanner();
    this._sendPrompt();
  }

  /**
   * Called when data arrives from the modem (user input or proxied data).
   * @param {Buffer} data
   */
  receive(data) {
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
    this._sendStr(tcfg.banner);
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
  }

  disconnect() {
    this._closeConnection();
    this._state = STATE.CLOSING;
  }

  get state() { return this._state; }
}

module.exports = { TelnetProxy };
