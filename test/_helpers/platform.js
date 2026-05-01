'use strict';

/*
 * test/_helpers/platform.js — shared test platform guards.
 *
 * Several of our VM integration tests build custom test initrds
 * on the fly by invoking Unix shell pipelines (`zcat | cpio`,
 * `find | cpio | gzip`). These don't exist natively on Windows.
 * Users on Windows who need to run these tests should use WSL2;
 * this helper skips them with a clear message instead of crashing
 * with `spawn /bin/sh ENOENT`.
 *
 * Tests that DON'T need shell pipelines (e.g. `slmodem-pjsip/at`
 * uses the prebuilt production rootfs directly) do not need this
 * guard and run natively on Windows.
 */

const { execSync } = require('child_process');

/**
 * Check whether the host can run the Unix shell pipelines these
 * tests use. Looks for `/bin/sh`, `zcat`, and `cpio` on PATH.
 *
 * Returns { ok: true } if all available.
 * Returns { ok: false, reason: string } otherwise.
 */
function checkUnixInitrdTools() {
  if (process.platform === 'win32') {
    return {
      ok: false,
      reason: 'Windows host: /bin/sh, zcat, and cpio are not available. ' +
              'This test rebuilds a custom test initrd using Unix shell ' +
              'pipelines. Run under WSL2 or on a Linux host.',
    };
  }
  /* On macOS BSD cpio supports `--quiet --make-directories` but the
   * newc format flag `-H newc` works; good enough. Just verify the
   * binaries exist. */
  for (const bin of ['/bin/sh']) {
    try { execSync(`${bin} -c "true"`, { stdio: 'ignore' }); }
    catch (_) {
      return { ok: false, reason: `${bin} not available or not functional` };
    }
  }
  for (const bin of ['zcat', 'cpio']) {
    try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
    catch (_) {
      return { ok: false, reason: `${bin} not on PATH` };
    }
  }
  return { ok: true };
}

/**
 * Exit cleanly with a skip message if the host can't run Unix
 * initrd-building tools. Call at the top of a test module —
 * before any tool-dependent setup — so the test prints a
 * skip banner and exits 0 (not 1) on unsupported platforms.
 *
 * Exit code 0 keeps CI / batch runners happy; they treat "passing
 * 0 tests" as not-a-failure, same as if the file were absent.
 *
 * @param {string} testName  Friendly name for the skip banner.
 */
function skipIfNoUnixInitrdTools(testName) {
  const check = checkUnixInitrdTools();
  if (check.ok) return;
  console.log(`${testName}`);
  console.log('');
  console.log(`  SKIP: ${check.reason}`);
  console.log('');
  console.log('  0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

module.exports = { checkUnixInitrdTools, skipIfNoUnixInitrdTools };
