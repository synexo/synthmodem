'use strict';

/**
 * win-timer-resolution — wrapper around the optional native addon.
 *
 * On Windows, raise the system timer resolution to 1 ms (or the
 * requested period) so that setInterval/setTimeout fire at sub-quantum
 * accuracy. Required for the native modem backend's RTP TX pacing —
 * see src/dsp/ModemDSP.js for context.
 *
 * If the native addon failed to build or isn't present, this module
 * exports no-op functions and logs a one-shot warning. The rest of
 * the application can call begin/end unconditionally.
 *
 * Usage:
 *   const tres = require('./native/win-timer-resolution');
 *   tres.begin(1);   // raise to 1 ms (returns 0 on success)
 *   ...
 *   tres.end();      // release on shutdown
 *
 * On non-Windows, the addon's begin/end are themselves no-ops so this
 * is safe to call unconditionally.
 */

const path = require('path');
const { makeLogger } = require('../../src/logger');
const log = makeLogger('TimerRes');

let native = null;
let lastError = null;
let warned = false;

function tryLoad() {
  if (native !== null || lastError !== null) return native;

  // Search order:
  //
  //  1. Prebuilt binaries committed to the repo at
  //     prebuilt/<platform>-<arch>/win_timer_resolution.node — these
  //     are committed by the maintainers and let users `npm install`
  //     and immediately use the addon without any build tools.
  //     N-API ABI stability means a single binary built once works
  //     across all subsequent Node major versions.
  //
  //  2. Locally-built node-gyp output — falls back to this if the
  //     user (or `npm install` hook) ran the build themselves. Useful
  //     for unsupported platform/arch combinations and for verifying
  //     a prebuilt binary against a freshly-built one.
  //
  // Either path is fine; the addon is the same compiled code.
  const plat = process.platform;
  const arch = process.arch;
  const candidates = [
    path.join(__dirname, 'prebuilt', `${plat}-${arch}`, 'win_timer_resolution.node'),
    path.join(__dirname, 'build', 'Release', 'win_timer_resolution.node'),
    path.join(__dirname, 'build', 'Debug', 'win_timer_resolution.node'),
  ];
  for (const p of candidates) {
    try {
      native = require(p);
      return native;
    } catch (e) {
      lastError = e;
    }
  }
  return null;
}

function warnOnce() {
  if (warned) return;
  warned = true;
  if (process.platform === 'win32') {
    log.warn('win-timer-resolution native addon not available — falling back ' +
             'to default timer resolution. On Windows this means setInterval ' +
             'has 15.6 ms quantum, which causes RTP TX packet jitter that ' +
             'can disrupt modem connections during long idle. ' +
             'A prebuilt binary should ship with the repo at ' +
             'native/win-timer-resolution/prebuilt/win32-x64/. If you are on ' +
             'win32-arm64 or another arch, run `npm run build:native` to ' +
             'build it locally.');
    if (lastError) {
      log.debug(`Load error: ${lastError.message}`);
    }
  } else {
    // On non-Windows, the addon is irrelevant. Don't spam.
    log.debug(`Timer resolution module not loaded (platform: ${process.platform}, no-op).`);
  }
}

/**
 * Raise the system timer resolution to `periodMs` (default 1 ms).
 * Returns 0 on success, non-zero on failure (or 0 if no-op).
 */
function begin(periodMs = 1) {
  const m = tryLoad();
  if (!m) { warnOnce(); return -1; }
  return m.begin(periodMs >>> 0);
}

/**
 * Release a previous begin() claim. Idempotent: safe to call when nothing
 * is active.
 */
function end() {
  const m = tryLoad();
  if (!m) return -1;
  return m.end();
}

function isActive() {
  const m = tryLoad();
  return m ? m.isActive() : false;
}

function platform() {
  const m = tryLoad();
  return m ? m.platform() : 'unloaded';
}

function isAvailable() {
  return tryLoad() !== null;
}

module.exports = { begin, end, isActive, platform, isAvailable };
