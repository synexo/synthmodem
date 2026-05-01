#!/usr/bin/env node
'use strict';

// npm install hook for the optional native addon (native/win-timer-resolution).
//
// Strategy: the repo ships a prebuilt N-API .node binary for the most
// common platform (win32-x64). Because N-API is ABI-stable, that
// single binary works on every Node.js major version >= 16 without
// rebuilding.
//
// Behavior:
//   - Prebuilt for current platform-arch is present  → skip build
//   - Windows-but-no-prebuilt-for-this-arch (e.g. ia32, arm64)
//                                                    → try to build
//   - Linux/macOS                                    → skip entirely
//                                                      (the addon is
//                                                      a no-op stub)
//   - SYNTHMODEM_FORCE_BUILD_NATIVE=1                → build anyway
//
// In ALL cases this script exits 0 — it never fails npm install. If a
// build fails or is skipped, the application logs a clear startup
// warning and runs without the timer fix on Windows (Linux doesn't
// need it).
//
// Implementation note: we invoke node-gyp by running its bin/node-gyp.js
// directly with the current `node`. Spawning npx.cmd / node-gyp.cmd
// fails with EINVAL on Node ≥ 18.20.2/20.12.2/21.7.3 (CVE-2024-27980)
// unless `shell: true` is set — which has its own caveats. Going
// straight to node-gyp's JS file dodges all that.

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

const { resolveNodeGyp } = require('./resolve-node-gyp');

const ADDON_DIR = path.join(__dirname, '..', 'native', 'win-timer-resolution');
const FORCE     = process.env.SYNTHMODEM_FORCE_BUILD_NATIVE === '1';
const PLAT      = process.platform;
const ARCH      = process.arch;

const prebuiltPath = path.join(
  ADDON_DIR, 'prebuilt', `${PLAT}-${ARCH}`, 'win_timer_resolution.node'
);
const hasPrebuilt = fs.existsSync(prebuiltPath);

if (PLAT !== 'win32' && !FORCE) {
  console.log('[synthmodem] Native addon (win-timer-resolution) is Windows-only;');
  console.log(`[synthmodem]   skipping build on ${PLAT}.`);
  console.log('[synthmodem]   Set SYNTHMODEM_FORCE_BUILD_NATIVE=1 to build the no-op stub.');
  process.exit(0);
}

if (PLAT === 'win32' && hasPrebuilt && !FORCE) {
  console.log(`[synthmodem] Prebuilt addon found for ${PLAT}-${ARCH} — skipping build.`);
  console.log(`[synthmodem]   Path: ${path.relative(process.cwd(), prebuiltPath)}`);
  console.log('[synthmodem]   Run `npm run build:native` if you want to rebuild from source.');
  process.exit(0);
}

if (!fs.existsSync(path.join(ADDON_DIR, 'binding.gyp'))) {
  console.warn('[synthmodem] native/win-timer-resolution/binding.gyp not found —');
  console.warn('[synthmodem]   skipping build. The addon directory may be incomplete.');
  process.exit(0);
}

console.log(`[synthmodem] No prebuilt for ${PLAT}-${ARCH}; building native addon from source…`);

const nodeGyp = resolveNodeGyp();
if (!nodeGyp) {
  console.warn('[synthmodem] Could not locate node-gyp on this system.');
  console.warn('[synthmodem]   Expected to find it bundled with npm. The application');
  console.warn('[synthmodem]   will install but the native addon is unavailable.');
  console.warn('[synthmodem]   Manual rebuild: `npm install -g node-gyp` then');
  console.warn('[synthmodem]   `npm run build:native`.');
  process.exit(0);
}

console.log(`[synthmodem]   Using node-gyp: ${nodeGyp}`);

const child = spawn(process.execPath, [nodeGyp, 'rebuild'], {
  cwd: ADDON_DIR,
  stdio: 'inherit',
  shell: false,
});

function warnAfterFail() {
  console.warn('[synthmodem] The application will still install and run, but the Windows');
  console.warn('[synthmodem]   multimedia-timer fix will not be active. Native modem backend');
  console.warn('[synthmodem]   RTP TX pacing will be jittery during long modem idle.');
  console.warn('[synthmodem]   To fix: install Visual Studio Build Tools (C++ workload)');
  console.warn('[synthmodem]   and Python 3, then re-run `npm install`.');
  console.warn('[synthmodem]   See native/win-timer-resolution/README.md for details.');
}

child.on('error', (err) => {
  console.warn(`[synthmodem] Native build spawn failed: ${err.message}`);
  warnAfterFail();
  process.exit(0);  // don't fail npm install
});

child.on('close', (code) => {
  if (code === 0) {
    console.log('[synthmodem] Native addon built successfully.');
  } else {
    console.warn(`[synthmodem] Native build exited with code ${code}.`);
    warnAfterFail();
  }
  process.exit(0);  // don't fail npm install regardless
});
