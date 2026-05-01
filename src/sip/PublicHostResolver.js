'use strict';

/**
 * PublicHostResolver
 *
 * Per-call resolution of the IP address SynthModem advertises to a
 * SIP caller in Contact and SDP headers. Replaces the static
 * `config.sip.publicHost` when that value is empty.
 *
 * ─── The problem ──────────────────────────────────────────────────
 *
 * In Contact and SDP, we advertise an IP that the caller will use to
 * reach us — for SIP requests (REGISTER, BYE) and for RTP packets.
 * That IP must be reachable FROM THE CALLER, not just locally bound.
 *
 * Setting `host: '0.0.0.0'` works for binding (we listen on all
 * interfaces) but breaks SDP because callers will literally try to
 * send RTP to 0.0.0.0. So today's config requires the operator to
 * hand-edit `publicHost` to their machine's LAN IP, which is a
 * deployment friction point.
 *
 * ─── Resolution chain ─────────────────────────────────────────────
 *
 * For each inbound INVITE, the resolver returns an IP via:
 *
 *   1. Per-call subnet match: pick the local interface whose IPv4
 *      subnet contains the caller's source address. This is the
 *      correct answer in essentially every multi-NIC deployment —
 *      a caller from 192.168.1.50/24 is on the same LAN as our
 *      192.168.1.10/24 interface, so we hand them 192.168.1.10.
 *
 *   2. First non-loopback IPv4: when no interface matches the
 *      caller's subnet (typical of NAT'd callers on different
 *      private subnets), fall back to the first non-internal IPv4
 *      we have. The caller's NAT was going to need to translate
 *      whatever we sent anyway, so first-non-loopback is no worse
 *      than any other heuristic. Logged at WARN so the operator
 *      knows the heuristic kicked in for this call.
 *
 *   3. 127.0.0.1: only if the host has zero non-loopback IPv4
 *      interfaces (a truly headless test scenario or a network-
 *      misconfigured machine). Always logged at WARN.
 *
 * ─── When the resolver is bypassed ────────────────────────────────
 *
 * If `config.sip.publicHost` is a non-empty string, the resolver is
 * not consulted — the static value wins. This preserves the existing
 * pinned-IP behavior for operators who have a specific reason (DNAT,
 * SBC behind a public IP, etc.) and don't want auto-detection.
 *
 * ─── Caching ──────────────────────────────────────────────────────
 *
 * Interface lookups are cached on construction. Network interface
 * changes during a long-running synthmodem deployment (DHCP renewal
 * to a new subnet, hot-plugged NIC) won't be picked up automatically.
 * Restarting synthmodem refreshes the cache. This is a reasonable
 * trade-off for a service that's already meant to be long-lived
 * between intentional reconfigurations.
 */

const os = require('os');
const { makeLogger } = require('../logger');

const log = makeLogger('PublicHostResolver');

/* Convert "a.b.c.d" to a 32-bit unsigned integer (host order). Returns
 * null on parse failure. */
function ipv4ToUint(addr) {
  if (typeof addr !== 'string') return null;
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const octet = parseInt(parts[i], 10);
    if (!(octet >= 0 && octet <= 255)) return null;
    n = (n * 256) + octet;
  }
  return n >>> 0;
}

class PublicHostResolver {
  /**
   * @param {object} [opts]
   * @param {object} [opts.interfaces] — Pre-supplied interface map for
   *     testing. If omitted, snapshots os.networkInterfaces().
   */
  constructor(opts = {}) {
    /* Snapshot the interface list. Each entry is
     *   { address, family, netmask, cidr, internal, ... }
     * We retain only IPv4 entries with a parseable netmask. */
    const ifaces = opts.interfaces || os.networkInterfaces();
    this._entries = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!Array.isArray(addrs)) continue;
      for (const a of addrs) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        const ipN   = ipv4ToUint(a.address);
        const maskN = ipv4ToUint(a.netmask);
        if (ipN === null || maskN === null) continue;
        this._entries.push({
          name,
          address:  a.address,
          internal: !!a.internal,
          ipNum:    ipN,
          maskNum:  maskN,
          network:  (ipN & maskN) >>> 0,
        });
      }
    }

    /* Pre-compute the first-non-loopback fallback. Sorted by name for
     * deterministic selection on multi-NIC hosts. */
    const nonLoop = this._entries
      .filter(e => !e.internal)
      .sort((a, b) => a.name.localeCompare(b.name));
    this._fallback = nonLoop.length > 0 ? nonLoop[0] : null;

    log.debug(`Resolver initialized: ${this._entries.length} IPv4 interfaces, ` +
              `${nonLoop.length} non-loopback`);
    if (this._fallback) {
      log.debug(`First-non-loopback fallback: ${this._fallback.address} (${this._fallback.name})`);
    } else {
      log.warn('No non-loopback IPv4 interface found — final fallback is 127.0.0.1');
    }
  }

  /**
   * Resolve the publicHost for a specific caller.
   *
   * @param {string} callerAddr — Caller's source IPv4 (from rinfo).
   * @returns {{address: string, source: 'subnet'|'fallback-first-nonloop'|'fallback-loopback', interface: string|null}}
   *
   * The `source` field tells the caller which step of the chain
   * succeeded — handy for callsite logging (subnet match is silent at
   * INFO; fallbacks are logged at WARN by the caller).
   */
  resolveFor(callerAddr) {
    const callerN = ipv4ToUint(callerAddr);
    if (callerN !== null) {
      /* Step 1: subnet match. */
      for (const e of this._entries) {
        if ((callerN & e.maskNum) >>> 0 === e.network) {
          return {
            address:   e.address,
            source:    'subnet',
            interface: e.name,
          };
        }
      }
    }

    /* Step 2: first non-loopback IPv4. */
    if (this._fallback) {
      return {
        address:   this._fallback.address,
        source:    'fallback-first-nonloop',
        interface: this._fallback.name,
      };
    }

    /* Step 3: loopback. */
    return {
      address:   '127.0.0.1',
      source:    'fallback-loopback',
      interface: null,
    };
  }

  /**
   * Resolve a default publicHost without knowing the caller (used at
   * startup logging, BYE for terminated dialogs we no longer have the
   * caller IP for, etc.). Skips the subnet step and goes straight to
   * the fallback chain.
   */
  resolveDefault() {
    if (this._fallback) {
      return {
        address:   this._fallback.address,
        source:    'fallback-first-nonloop',
        interface: this._fallback.name,
      };
    }
    return {
      address:   '127.0.0.1',
      source:    'fallback-loopback',
      interface: null,
    };
  }
}

module.exports = { PublicHostResolver, ipv4ToUint };
