'use strict';

/*
 * at-result-line.js — shared utilities for parsing modem AT-result
 * lines and mapping connect rates to protocol names.
 *
 * Used by PjsipBackend (and historically SlmodemBackend, removed in
 * an earlier refactor extracted them here). These are pure functions with no I/O
 * and no module-level state, suitable for any backend that consumes
 * slmodemd-style result codes.
 */

/**
 * Map slmodemd CONNECT rates → protocol family names. Used to populate
 * the `protocol` field of the 'connected' event payload. If the rate
 * doesn't match any mapping, callers should emit "unknown" and let the
 * rate speak for itself.
 *
 * Source: ITU-T modem spec common rates. Rates above 14400 imply
 * V.32bis or newer; rates at/below 2400 imply V.22bis or older.
 */
const RATE_TO_PROTOCOL = Object.freeze({
  300:   'V21',
  1200:  'V22',       // or V23 — same rate, different modulation
  2400:  'V22bis',
  4800:  'V32bis',
  7200:  'V32bis',
  9600:  'V32bis',
  12000: 'V32bis',
  14400: 'V32bis',
  16800: 'V34',
  19200: 'V34',
  21600: 'V34',
  24000: 'V34',
  26400: 'V34',
  28800: 'V34',
  31200: 'V34',
  33600: 'V34',
  // V.90 downstream
  38400: 'V90',
  42000: 'V90',
  44000: 'V90',
  46666: 'V90',
  50000: 'V90',
  52000: 'V90',
  53333: 'V90',
  56000: 'V90',
});

/**
 * Parse a line of AT output from slmodemd for known result codes.
 * Returns {event, rate?} or null for nothing interesting.
 *
 *   CONNECT [rate]   → { event: 'connect', rate: <int> }   (rate 0 if absent)
 *   NO CARRIER       → { event: 'nocarrier' }
 *   BUSY             → { event: 'busy' }
 *   NO DIALTONE      → { event: 'nodialtone' }
 *   RING             → { event: 'ring' }
 *   ERROR            → { event: 'error' }
 *   anything else    → null
 */
function parseResultLine(line) {
  const t = line.trim();
  if (/^CONNECT(\s+(\d+))?$/.test(t)) {
    const m = /^CONNECT(?:\s+(\d+))?/.exec(t);
    const rate = m[1] ? parseInt(m[1], 10) : 0;
    return { event: 'connect', rate };
  }
  if (/^NO\s*CARRIER$/i.test(t)) return { event: 'nocarrier' };
  if (/^BUSY$/i.test(t))         return { event: 'busy' };
  if (/^NO\s*DIALTONE$/i.test(t))return { event: 'nodialtone' };
  if (/^RING$/i.test(t))         return { event: 'ring' };
  if (/^ERROR$/i.test(t))        return { event: 'error' };
  return null;
}

module.exports = {
  RATE_TO_PROTOCOL,
  parseResultLine,
};
