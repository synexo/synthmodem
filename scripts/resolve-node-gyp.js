'use strict';

// resolve-node-gyp.js — find the path to node-gyp's main JS so we can
// invoke it directly with the running node binary instead of via
// `npx.cmd` or `node-gyp.cmd`.
//
// This is necessary because of CVE-2024-27980 (April 2024) — Node 18.20.2+,
// 20.12.2+, 21.7.3+, and all later versions refuse to spawn .cmd / .bat
// targets unless `shell: true` is set, which has a deprecation warning
// and a security caveat. The clean workaround is to invoke node-gyp's
// underlying JS file directly with `node node-gyp.js …`, which is a
// plain executable file and never triggers the .cmd guard.
//
// node-gyp is bundled with npm; we don't need to install anything.

const path = require('path');
const fs   = require('fs');

function exists(p) {
  try { return fs.statSync(p).isFile(); }
  catch { return false; }
}

/**
 * Return absolute path to node-gyp's bin/node-gyp.js, or null if not
 * found. Searches typical npm install layouts on Windows, Linux, macOS.
 */
function resolveNodeGyp() {
  const nodeDir = path.dirname(process.execPath);

  const candidates = [
    // Windows system-wide: C:\Program Files\nodejs\node_modules\npm\…
    path.join(nodeDir, 'node_modules', 'npm', 'node_modules',
              'node-gyp', 'bin', 'node-gyp.js'),
    // Unix system-wide: /usr/bin/node + /usr/lib/node_modules/npm/…
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'node_modules',
              'node-gyp', 'bin', 'node-gyp.js'),
    // Some Linux distros: /usr/local/bin/node + /usr/local/lib/node_modules/…
    path.join(nodeDir, '..', 'lib', 'node_modules', 'node-gyp',
              'bin', 'node-gyp.js'),
  ];

  for (const c of candidates) {
    if (exists(c)) return path.resolve(c);
  }

  // Last resort: walk require.resolve.paths('node-gyp') if we're being
  // called from a context where node-gyp is also installed locally.
  try {
    const paths = require.resolve.paths('node-gyp') || [];
    for (const p of paths) {
      const c = path.join(p, 'node-gyp', 'bin', 'node-gyp.js');
      if (exists(c)) return path.resolve(c);
    }
  } catch { /* ignore */ }

  return null;
}

module.exports = { resolveNodeGyp };
