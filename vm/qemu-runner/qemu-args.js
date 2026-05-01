'use strict';

/*
 * qemu-args.js — assemble the QEMU command line that spawns the
 *                synthmodem runtime VM.
 *
 * ────────────────────────────────────────────────────────────────────
 *
 * ROLE
 *
 *   Given paths to the kernel, initramfs, and two Unix sockets for
 *   virtio-serial, produce the argv array that QemuVM.js will hand to
 *   child_process.spawn().
 *
 *   Separated from QemuVM itself so the argument construction is pure,
 *   unit-testable, and trivial to audit. Changing the hypervisor
 *   invocation doesn't require touching the process-lifecycle code.
 *
 * PLATFORM NOTES
 *
 *   All production code paths use transport.js to produce the chardev
 *   string, which on every platform is a TCP loopback socket:
 *   `socket,host=127.0.0.1,port=N,server=off,nodelay=on`. See
 *   transport.js for the rationale (named pipes and Unix sockets
 *   caused platform-specific jitter/buffering issues that broke modem
 *   symbol timing).
 *
 *   A legacy POSIX Unix-socket code path remains behind the
 *   audioSockPath/controlSockPath opts for a few tests that still
 *   exercise it directly. New callers should always pass `transport`.
 *
 * VIRTIO-SERIAL TOPOLOGY
 *
 *   The runtime init script (S99modem) inside the VM expects:
 *     /dev/virtio-ports/synthmodem.audio
 *     /dev/virtio-ports/synthmodem.control
 *
 *   Those device nodes are created by virtio_console when it sees the
 *   virtio-serial-pci device with two virtserialport children, each
 *   backed by a chardev. We name the chardevs 'audio' and 'control',
 *   and give each virtserialport the matching `name=synthmodem.X` tag
 *   which the kernel uses as the /dev/virtio-ports/<name> symlink.
 *
 * SERVER MODE CHOICE
 *
 *   Two choices:
 *     a) QEMU listens, guest connects out.
 *     b) Host listens, QEMU connects.
 *
 *   We use (b): SlmodemVM creates Unix socket listeners on the host
 *   (exactly as it does in M1 talking to the mock), and QEMU's chardev
 *   connects as a client (server=off). This means M1 and M2 share the
 *   same Node-side plumbing — only the spawned process changes.
 *
 * ACCELERATION
 *
 *   We prefer the best available accelerator and silently fall back:
 *     Linux:   kvm → tcg
 *     macOS:   hvf → tcg   (hvf for Apple Silicon + Intel)
 *     Windows: whpx → tcg  (Windows Hypervisor Platform)
 *
 *   Callers can force with `accel: 'tcg'` (e.g. for CI sandboxes that
 *   disallow virtualization, like gVisor).
 */

const os   = require('os');
const fs   = require('fs');

/**
 * Figure out the highest-acceleration mode the host supports.
 *
 * Simple heuristics without invoking QEMU itself — QEMU's --help
 * output is noisy and slow. We check for the driver's presence in the
 * ways that are reliable:
 *   - KVM:  /dev/kvm is readable → likely has KVM
 *   - HVF:  Darwin + arm64 or x86_64 → always has HVF on macOS 10.10+
 *   - WHPX: Windows 10+ → check for a registry key or just try
 *
 * For WHPX we can't easily probe, so we fall through to TCG on
 * Windows unless the caller explicitly requests it. This is safe:
 * TCG works everywhere QEMU runs.
 *
 * @returns {'kvm' | 'hvf' | 'whpx' | 'tcg'}
 */
function detectAccelerator() {
  if (process.platform === 'linux') {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      return 'kvm';
    } catch (_) { return 'tcg'; }
  }
  if (process.platform === 'darwin') {
    // Darwin kernels since 10.10 provide HVF via the Hypervisor.framework.
    // There is no simple /dev/ node to test; QEMU itself will fail to
    // start with -accel hvf if the framework isn't usable (rare). We
    // optimistically pick hvf and let the caller fall back if needed.
    return 'hvf';
  }
  // Windows and everything else: pick TCG. WHPX probing is possible
  // but noisy; we'd rather a predictable TCG-always path than a
  // clever-but-fragile auto-detect.
  return 'tcg';
}

/**
 * Build the QEMU argv.
 *
 * @param {object} opts
 * @param {string} opts.kernelPath     - Absolute path to bzImage.
 * @param {string} opts.initrdPath     - Absolute path to rootfs.cpio.gz.
 * @param {string} opts.audioSockPath  - Unix socket path the shim will
 *                                       connect to for the audio channel.
 * @param {string} opts.controlSockPath- Unix socket path for control.
 * @param {number} [opts.memoryMb=256] - Guest RAM. 128 is usually enough
 *                                       for just slmodemd + shim;
 *                                       default is 256 to leave headroom.
 * @param {string} [opts.accel]        - Force 'kvm' | 'hvf' | 'whpx' |
 *                                       'tcg'. Default: autodetect.
 * @param {string} [opts.appendExtra]  - Extra kernel cmdline tokens.
 * @param {string} [opts.guestLogLevel] - Propagated to the guest as
 *                                       synthmodem_log=<level> on the
 *                                       kernel cmdline. S99modem parses
 *                                       /proc/cmdline and exports it as
 *                                       SYNTHMODEM_LOG_LEVEL for the shim.
 *                                       Values: 'error' (default)|'info'|'debug'.
 * @param {boolean}[opts.noGraphic=true] - `-nographic` flag. Default on.
 * @returns {{ args: string[], accel: string }}
 * @param {object} opts
 * @param {string} opts.kernelPath     - Absolute path to bzImage.
 * @param {string} opts.initrdPath     - Absolute path to rootfs.cpio.gz.
 * @param {object} [opts.transport]    - Transport descriptor from
 *                                       transport.createTransport().
 *                                       If given, chardev strings come
 *                                       from transport.qemuChardevFor().
 *                                       Supersedes audioSockPath /
 *                                       controlSockPath if both are
 *                                       provided.
 * @param {string} [opts.audioSockPath]- POSIX socket path (legacy/test).
 *                                       Ignored if opts.transport is set.
 * @param {string} [opts.controlSockPath] - POSIX socket path (legacy/test).
 * @param {number} [opts.memoryMb=256]
 * @param {string} [opts.accel]        - 'kvm' | 'hvf' | 'whpx' | 'tcg' |
 *                                       'tcg,thread=single'. Default:
 *                                       'tcg'. Autodetect.
 * @param {string} [opts.appendExtra]  - Extra kernel cmdline tokens.
 * @param {string} [opts.guestLogLevel] - Propagated to the guest as
 *                                       synthmodem_log=<level> on the
 *                                       kernel cmdline. S99modem parses
 *                                       /proc/cmdline and exports it as
 *                                       SYNTHMODEM_LOG_LEVEL for the shim.
 *                                       Values: 'error' (default)|'info'|'debug'.
 * @param {boolean}[opts.noGraphic=true] - `-nographic` flag. Default on.
 * @returns {{ args: string[], accel: string }}
 */
function buildQemuArgs(opts) {
  if (!opts) throw new TypeError('buildQemuArgs: opts required');
  const { kernelPath, initrdPath } = opts;

  // Validate kernel/initrd always.
  for (const [k, v] of Object.entries({ kernelPath, initrdPath })) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new TypeError(`buildQemuArgs: opts.${k} must be a non-empty string`);
    }
  }

  // Chardev generation: prefer transport if given, else fall back to
  // the legacy audioSockPath/controlSockPath (used by some tests and
  // the M1 code path that predates transport.js).
  let audioChardev, controlChardev;
  if (opts.transport) {
    audioChardev   = opts.transport.qemuChardevFor('audio',   'audio');
    controlChardev = opts.transport.qemuChardevFor('control', 'control');
  } else {
    const { audioSockPath, controlSockPath } = opts;
    for (const [k, v] of Object.entries({ audioSockPath, controlSockPath })) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new TypeError(
          `buildQemuArgs: opts.${k} must be a non-empty string ` +
          `(or pass opts.transport instead)`);
      }
    }
    // Legacy path — assumes POSIX Unix socket semantics.
    audioChardev   = `socket,id=audio,path=${audioSockPath},server=off`;
    controlChardev = `socket,id=control,path=${controlSockPath},server=off`;
  }

  const memoryMb      = opts.memoryMb      ?? 256;
  const accel         = opts.accel         ?? detectAccelerator();
  const noGraphic     = opts.noGraphic     ?? true;
  const guestLogLevel = opts.guestLogLevel ?? null;
  if (guestLogLevel && !['error','info','debug'].includes(guestLogLevel)) {
    throw new TypeError(
      `buildQemuArgs: guestLogLevel must be error|info|debug, got ${guestLogLevel}`);
  }

  // Kernel cmdline:
  //   console=ttyS0    — route kernel printk to the first serial port
  //                      so we can capture boot logs from stderr
  //   panic=-1         — reboot immediately on panic instead of hanging
  //                      (we have -no-reboot too, so the VM just exits)
  //   loglevel=3       — quiet: errors + critical only, no info noise
  //   init=/sbin/init  — use busybox init explicitly (overrides our
  //                      /init symlink, which already points there;
  //                      belt-and-braces)
  const appendParts = [
    'console=ttyS0',
    'panic=-1',
    'loglevel=3',
    'init=/sbin/init',
  ];
  if (guestLogLevel) appendParts.push(`synthmodem_log=${guestLogLevel}`);
  if (opts.appendExtra) appendParts.push(opts.appendExtra);
  const append = appendParts.join(' ');

  const args = [
    // Base machine type. 'pc' is the classic i440FX-based PC, maximally
    // compatible with QEMU's default BIOS and kernels. 'q35' is newer
    // and nicer but not always present.
    '-M', 'pc',

    // Guest RAM
    '-m', String(memoryMb),

    // No display output; we're headless and the kernel console is on
    // the serial port which we'll capture separately.
    ...(noGraphic ? ['-nographic'] : []),

    // Kernel + initramfs (the two-file model)
    '-kernel', kernelPath,
    '-initrd', initrdPath,

    // Kernel command line
    '-append', append,

    // Acceleration. -accel replaces the older -enable-kvm/-no-kvm.
    '-accel', accel,

    // Don't auto-reboot on panic/exit. Combined with panic=-1 in the
    // kernel cmdline, this means any fatal condition in the VM
    // causes QEMU to exit cleanly.
    '-no-reboot',

    // virtio-serial-pci: the bus/controller that holds virtual ports.
    // -device virtio-serial-pci is simple and sufficient; advanced
    // options like 'max_ports' aren't needed for 2 ports.
    '-device', 'virtio-serial-pci,id=synthmodem-vserial',

    // Audio channel:
    //   chardev backend: TCP loopback socket, QEMU as client. Node
    //                    listens on the configured audio port and
    //                    accepts QEMU's connect. See transport.js.
    //   device binding:  virtserialport attached to our virtio-serial
    //                    bus, exposed inside the guest as
    //                    /dev/virtio-ports/synthmodem.audio
    '-chardev', audioChardev,
    '-device',
      'virtserialport,chardev=audio,name=synthmodem.audio',

    // Control channel: same pattern, different name.
    '-chardev', controlChardev,
    '-device',
      'virtserialport,chardev=control,name=synthmodem.control',

    // Monitor + serial: silence the monitor (no interactive console),
    // keep serial running so kernel oops / shell output shows in stderr.
    '-monitor', 'none',
    // With -nographic, -serial defaults to stdio. We don't override
    // unless the caller asks, so kernel console goes to the parent's
    // stdout. QemuVM.js captures it via child.stdout.
  ];

  return { args, accel };
}

module.exports = {
  buildQemuArgs,
  detectAccelerator,
};
