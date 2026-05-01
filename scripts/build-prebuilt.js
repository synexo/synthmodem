#!/usr/bin/env node
'use strict';

// Maintainer helper: build the native addon AND copy the resulting
// .node binary into native/win-timer-resolution/prebuilt/<plat>-<arch>/.
// Commit the prebuilt file so end users don't need build tools.
//
// Run on a Windows x64 machine (or any platform/arch where you want to
// generate / refresh a prebuilt). Invoked by `npm run build:prebuilt`.
//
// Implementation: invokes node-gyp by spawning its bin/node-gyp.js with
// the current `node`, dodging the .cmd EINVAL issue on modern Node on
// Windows. See scripts/resolve-node-gyp.js for the resolver.

const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

const { resolveNodeGyp } = require('./resolve-node-gyp');

const ADDON_DIR    = path.join(__dirname, '..', 'native', 'win-timer-resolution');
const PLAT         = process.platform;
const ARCH         = process.arch;
const PREBUILT_DIR = path.join(ADDON_DIR, 'prebuilt', `${PLAT}-${ARCH}`);
const SRC_BUILT    = path.join(ADDON_DIR, 'build', 'Release', 'win_timer_resolution.node');
const DST_FILE     = path.join(PREBUILT_DIR, 'win_timer_resolution.node');

const nodeGyp = resolveNodeGyp();
if (!nodeGyp) {
  console.error('[synthmodem] Could not locate node-gyp.');
  console.error('[synthmodem]   Expected to find it bundled with npm at one of:');
  console.error('[synthmodem]     <node-dir>/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js');
  console.error('[synthmodem]     <node-dir>/../lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js');
  console.error('[synthmodem]   Try `npm install -g node-gyp` and retry.');
  process.exit(1);
}

console.log(`[synthmodem] Building prebuilt addon for ${PLAT}-${ARCH}…`);
console.log(`[synthmodem]   Using node-gyp: ${nodeGyp}`);

const r = spawnSync(process.execPath, [nodeGyp, 'rebuild'], {
  cwd: ADDON_DIR,
  stdio: 'inherit',
  shell: false,
});

if (r.error) {
  console.error(`[synthmodem] Failed to spawn node-gyp: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`[synthmodem] node-gyp build failed (exit code ${r.status}).`);
  console.error('[synthmodem]   Check the output above for the underlying compiler error.');
  console.error('[synthmodem]   Most common cause on Windows: missing Visual Studio Build');
  console.error('[synthmodem]   Tools (C++ workload) or Python 3.');
  process.exit(r.status || 1);
}

if (!fs.existsSync(SRC_BUILT)) {
  console.error(`[synthmodem] Build claimed success but expected output not found: ${SRC_BUILT}`);
  process.exit(1);
}

fs.mkdirSync(PREBUILT_DIR, { recursive: true });
fs.copyFileSync(SRC_BUILT, DST_FILE);

const stats = fs.statSync(DST_FILE);
console.log(`[synthmodem] Prebuilt copied: ${path.relative(process.cwd(), DST_FILE)} (${stats.size} bytes)`);
console.log('[synthmodem] Commit this file to make the addon available to all users on this platform.');
