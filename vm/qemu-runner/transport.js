'use strict';

/**
 * transport.js — host↔guest transport via TCP loopback sockets
 *
 * Two channels are required for every VM: audio and control.
 * Each is an independent TCP connection carrying wire-framed data
 * (see vm/shim/wire.h and vm/qemu-runner/wire.js for framing).
 *
 * ─── Why TCP (and not named pipes or Unix sockets) ──────────────
 *
 * Earlier iterations of this project used Unix domain sockets on
 * POSIX and Windows named pipes on Windows. That split caused two
 * classes of problems:
 *
 *   1. Windows named pipes have well-documented jitter, buffering,
 *      and back-to-back-small-write issues with libuv/Node. We hit
 *      a concrete bug where "AT+MS=…" and "ATA" sent in quick
 *      succession on the control channel had the first command's
 *      payload corrupted. We papered over it with a 50ms delay, but
 *      the underlying pipe semantics remained unreliable for the
 *      steady 8kHz audio stream — V.32/V.22 handshakes failed in
 *      ways consistent with microsecond-scale timing jitter.
 *
 *   2. Two platforms, two transport implementations, more places
 *      for subtle differences to hide.
 *
 * Loopback TCP:
 *   - Has larger kernel buffers by default (64-128 KB vs pipe ~4 KB)
 *   - Behaves identically on Windows and Unix
 *   - Has TCP_NODELAY available to defeat Nagle's 40 ms coalescing
 *   - Is extensively battle-tested in libuv and QEMU
 *   - Simplifies our code (one transport, not two)
 *
 * ─── Transport topology ─────────────────────────────────────────
 *
 *   Node (host)          QEMU (spawned child)
 *   ────────────         ────────────────────
 *   net.createServer()   -chardev socket,host=127.0.0.1,port=N,
 *      .listen(port)          server=off,nodelay=on
 *         ↓                        ↓
 *      accept  ← ← ← ← ← ← ← ← connect
 *         ↓                        ↓
 *   Socket (server end)      Socket (client end)
 *
 * Node listens; QEMU connects. The listeners must exist BEFORE
 * spawning QEMU so the connect doesn't fail with ECONNREFUSED.
 *
 * ─── Port selection ─────────────────────────────────────────────
 *
 * Defaults are 25800 (audio) and 25801 (control). Both are below
 * the Linux (32768+) and Windows (49152+) OS ephemeral port ranges,
 * so there's no risk of the OS pre-allocating them to random
 * outbound connections. They're also outside the common-dev-tool
 * clutter zone (Postgres 5432, Redis 6379, etc.).
 *
 * If you need to run multiple synthmodem instances on one host, or
 * the defaults clash with a local service, override via
 * config.modem.slmodemd.transport.{audioPort,controlPort}.
 */

const net = require('net');

const DEFAULT_AUDIO_PORT   = 25800;
const DEFAULT_CONTROL_PORT = 25801;
const DEFAULT_BIND_HOST    = '127.0.0.1';

/**
 * Create a transport descriptor. Ports are fixed at creation time
 * (not dynamic per-VM) because QEMU's chardev takes literal host/port
 * values in argv before the VM is spawned.
 *
 * @param {object} [opts]
 * @param {number} [opts.audioPort=25800]
 * @param {number} [opts.controlPort=25801]
 * @param {string} [opts.bindHost='127.0.0.1']
 * @returns {TransportDescriptor}
 */
function createTransport(opts = {}) {
  const audioPort   = Number.isInteger(opts.audioPort)   ? opts.audioPort   : DEFAULT_AUDIO_PORT;
  const controlPort = Number.isInteger(opts.controlPort) ? opts.controlPort : DEFAULT_CONTROL_PORT;
  const bindHost    = typeof opts.bindHost === 'string' && opts.bindHost.length
    ? opts.bindHost : DEFAULT_BIND_HOST;

  if (audioPort === controlPort) {
    throw new TypeError(
      `transport: audioPort and controlPort must differ (both ${audioPort})`);
  }
  for (const [k, v] of [['audioPort', audioPort], ['controlPort', controlPort]]) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) {
      throw new TypeError(`transport: ${k} must be 1-65535, got ${v}`);
    }
    if (v < 1024) {
      throw new TypeError(
        `transport: ${k}=${v} is in the privileged range (<1024); ` +
        `pick something ≥1024. Defaults: audio=${DEFAULT_AUDIO_PORT}, ` +
        `control=${DEFAULT_CONTROL_PORT}.`);
    }
  }

  return {
    kind: 'tcp-socket',
    ownership: 'node-server-qemu-client',

    audio: {
      host: bindHost,
      port: audioPort,
      // Kept for parity with legacy callers that expect a single
      // address string; we format it like a URL-ish label so logs
      // are readable.
      nodeAddress: `${bindHost}:${audioPort}`,
    },
    control: {
      host: bindHost,
      port: controlPort,
      nodeAddress: `${bindHost}:${controlPort}`,
    },

    /**
     * Return the -chardev argv value for QEMU. Both channels use
     * identical syntax; only host/port differ.
     *
     *   socket,id=<id>,host=127.0.0.1,port=<N>,server=off,nodelay=on
     *
     * Breakdown:
     *   socket      — TCP or Unix; specifying host+port makes it TCP
     *   server=off  — QEMU connects to us as a client (we listen)
     *   nodelay=on  — disable Nagle; small frames flush immediately
     */
    qemuChardevFor(id, channel) {
      const ch = (channel === 'audio') ? this.audio : this.control;
      return `socket,id=${id},host=${ch.host},port=${ch.port},server=off,nodelay=on`;
    },

    /**
     * Prepare to receive QEMU's inbound connections by starting two
     * TCP listeners on the configured ports. Returns a promise that
     * resolves with both accepted sockets once QEMU has connected.
     *
     * The two connects can happen in any order — we await them
     * independently.
     *
     * @returns {Promise<{audio: net.Socket, control: net.Socket,
     *                    servers: net.Server[]}>}
     */
    async connect() {
      const audioResult = await _listen(bindHost, audioPort, 'audio');
      let controlResult;
      try {
        controlResult = await _listen(bindHost, controlPort, 'control');
      } catch (err) {
        try { audioResult.server.close(); } catch (_) {}
        throw err;
      }

      let audioSock, controlSock;
      try {
        [audioSock, controlSock] = await Promise.all([
          audioResult.accepted,
          controlResult.accepted,
        ]);
      } catch (err) {
        try { audioResult.server.close(); } catch (_) {}
        try { controlResult.server.close(); } catch (_) {}
        throw err;
      }

      // Disable Nagle on the accepted sockets — even though QEMU has
      // nodelay=on on its side, the Node-side accept should match to
      // avoid accumulating small outgoing writes toward the VM.
      try { audioSock.setNoDelay(true); }   catch (_) {}
      try { controlSock.setNoDelay(true); } catch (_) {}

      return {
        audio:   audioSock,
        control: controlSock,
        servers: [audioResult.server, controlResult.server],
      };
    },

    /**
     * No filesystem artifacts to clean; TCP sockets are just kernel
     * objects tied to fds, cleaned up when we close().
     */
    cleanup() {
      /* no-op */
    },
  };
}

/**
 * Start a TCP listener and return {server, accepted} where
 * accepted is a promise that resolves on the first 'connection'
 * event. The returned promise is already resolved once the port
 * is bound, so an EADDRINUSE failure is visible to the caller
 * via the initial await of _listen().
 */
function _listen(host, port, label) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    server.once('listening', () => {
      if (settled) return;
      settled = true;
      // Server is bound; arm the 'connection' listener for the
      // accept promise.
      const accepted = new Promise((acceptResolve, acceptReject) => {
        const onConn = (sock) => {
          server.off('connection', onConn);
          server.off('error', onErr);
          acceptResolve(sock);
        };
        const onErr = (err) => {
          server.off('connection', onConn);
          server.off('error', onErr);
          err.message = `transport: ${label} listener error: ${err.message}`;
          acceptReject(err);
        };
        server.on('connection', onConn);
        server.on('error', onErr);
      });
      resolve({ server, accepted });
    });

    server.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `transport: ${label} port ${port} on ${host} is already in use. ` +
          `Configure a different port in config.modem.slmodemd.transport ` +
          `(either audioPort or controlPort) and restart.`));
      } else {
        reject(new Error(
          `transport: ${label} bind failed on ${host}:${port}: ${err.message}`));
      }
    });

    server.listen(port, host);
  });
}

module.exports = {
  createTransport,
  DEFAULT_AUDIO_PORT,
  DEFAULT_CONTROL_PORT,
  DEFAULT_BIND_HOST,
};
