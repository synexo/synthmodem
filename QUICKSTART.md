# synthmodem — Quickstart

This tarball is a full snapshot of the synthmodem tree at M2: the VM
integration that offloads V.32bis through V.90 modem negotiation to
slmodemd running inside QEMU.

The prebuilt VM images are included (`vm/images/bzImage` and
`vm/images/rootfs.cpio.gz`), so you can verify end-to-end without
rebuilding anything.

## Prerequisites

- **Linux or Windows host** (macOS theoretically works — guest and
  transport are platform-agnostic — but unverified in this release).
- **Node.js 18+**.
- **qemu-system-i386** installed. Debian/Ubuntu: `apt install qemu-system-x86`.
  Windows: install QEMU from https://www.qemu.org/download/#windows.
- Build toolchain for the native Node modules. Linux: `gcc`, `make`,
  headers. Windows: Visual Studio Build Tools or MSVC (node-gyp will
  guide you if something's missing).

Smoke-checking your environment:

Linux / macOS:
```
node --version                     # 18+
qemu-system-i386 --version         # any recent release
cc --version && make --version     # any
```

Windows (PowerShell):
```
node --version
& 'C:\Program Files\qemu\qemu-system-i386.exe' --version
```

### Windows: tell Node where QEMU lives

QEMU's Windows installer puts the executable at
`C:\Program Files\qemu\qemu-system-i386.exe` and **does not add it to
PATH**. Node's default `spawn('qemu-system-i386')` won't find it.
Fix via one of:

- Set the `QEMU_SYSTEM_I386` environment variable (preferred —
  persists across sessions if set via System Properties):

  ```powershell
  # Session-only:
  $env:QEMU_SYSTEM_I386 = 'C:\Program Files\qemu\qemu-system-i386.exe'

  # Or persistently for your user:
  [Environment]::SetEnvironmentVariable(
      'QEMU_SYSTEM_I386',
      'C:\Program Files\qemu\qemu-system-i386.exe',
      'User')
  ```

- Or, set `config.modem.slmodemd.qemuPath` in `config.js` to the
  same path. Committed-config approach, useful for team defaults.

- Or, add `C:\Program Files\qemu` to your `PATH` (then `node` will
  find `qemu-system-i386.exe` through PATH lookup).

## Fastest path to "it works"

From inside the extracted `synthmodem/` directory:

Linux / macOS:
```
npm install                                 # native Node modules
node test/slmodem/vm-smoke.test.js          # boot the VM, round-trip AT
```

Windows (PowerShell):
```
npm install
$env:QEMU_SYSTEM_I386 = 'C:\Program Files\qemu\qemu-system-i386.exe'
node test/slmodem/vm-smoke.test.js
```

(You can chain the second and third lines with `;` if you prefer
one-line invocation:
`$env:QEMU_SYSTEM_I386 = 'C:\Program Files\qemu\qemu-system-i386.exe'; node test/slmodem/vm-smoke.test.js`)

The last command boots the bundled VM under QEMU-TCG, sends `AT`,
`ATI3`, and an unknown command through the full virtio-serial chain
to slmodemd, and verifies the responses. Expect ~10 seconds total
on TCG, faster with KVM/WHPX/HVF enabled.

Passing output looks like:

```
M2 VM smoke test
  qemu:     qemu-system-i386
  kernel:   /path/to/synthmodem/vm/images/bzImage
  initrd:   /path/to/synthmodem/vm/images/rootfs.cpio.gz

  ok   start() boots VM and receives HELLO
  ok   AT → OK round-trip
  ok   ATI3 → version line
  ok   unknown command → ERROR or OK
  ok   stop() is clean

5 passed, 0 failed
```

## Full test matrix

All 59 tests should pass:

```
# M1 tests (need host-built binaries first)
(cd vm/shim && make)
(cd test/mock-slmodemd && make)

node test/slmodem/wire.test.js          # 21 — wire protocol unit tests
node test/slmodem/backend.test.js       # 12 — SlmodemBackend event wiring
node test/slmodem/smoke.test.js         #  8 — Node ↔ shim via mock slmodemd
node test/slmodem/logging.test.js       # 13 — M2 diagnostic plumbing
node test/slmodem/vm-smoke.test.js      #  5 — VM end-to-end
```

## Running the VM manually (without Node)

Useful for troubleshooting boot issues, exploring the guest
environment, or verifying QEMU options separately from the Node
runner. Three recipes below: one minimal (works everywhere), and
two that fully wire up the virtio-serial channels so slmodemd +
shim start properly.

### Minimal boot test — all platforms

Boots the kernel and runs init, but does not plug in the virtio-
serial devices. S99modem will detect they're missing, log a clear
error, exit, and be respawned by busybox init in a loop. This is
**expected behavior** — the loop tells you userspace is working;
it's the absence of a peer that's failing, not the VM.

Linux/macOS:

```
qemu-system-i386 \
    -M pc -m 256 -display none \
    -kernel vm/images/bzImage \
    -initrd vm/images/rootfs.cpio.gz \
    -append "console=ttyS0 panic=-1" \
    -serial stdio \
    -accel tcg -no-reboot
```

Windows (PowerShell):

```
& 'C:\Program Files\qemu\qemu-system-i386.exe' `
    -M pc -m 256 -display none `
    -kernel vm/images/bzImage `
    -initrd vm/images/rootfs.cpio.gz `
    -append "console=ttyS0 panic=-1" `
    -serial stdio `
    -accel tcg -no-reboot
```

Windows (cmd.exe):

```
"C:\Program Files\qemu\qemu-system-i386.exe" ^
    -M pc -m 256 -display none ^
    -kernel vm\images\bzImage ^
    -initrd vm\images\rootfs.cpio.gz ^
    -append "console=ttyS0 panic=-1" ^
    -serial stdio ^
    -accel tcg -no-reboot
```

Ctrl-C to stop. Expect to see the kernel boot, busybox run rcS,
S99modem emit `virtio-serial devices not found`, exit, be
respawned, repeat. That's correct.

### Full boot with virtio-serial (TCP loopback)

To fully wire up the VM, the host must be listening on two TCP
loopback ports **before** QEMU starts. QEMU is configured as the
client (`server=off`) and connects outbound to those ports. synthmodem
uses TCP loopback on both Linux and Windows — earlier versions used
Unix sockets (Linux) and named pipes (Windows), but both caused
platform-specific jitter and buffering problems that broke modem
symbol timing. TCP with `nodelay=on` has larger kernel buffers, no
Nagle coalescing, and behaves identically on every platform.

The production defaults are `127.0.0.1:25800` (audio) and
`127.0.0.1:25801` (control); override via
`config.modem.slmodemd.transport.{audioPort,controlPort,bindHost}`.

Manual test with `socat` / `ncat` to dump the HELLO + silence frames:

Terminal 1 (audio listener):
```
# Linux/macOS:
socat TCP-LISTEN:25800,bind=127.0.0.1,fork - | hexdump -C

# Windows PowerShell (ncat from nmap, or netcat-win32):
ncat -l -p 25800 | Format-Hex
```

Terminal 2 (control listener):
```
# Linux/macOS:
socat TCP-LISTEN:25801,bind=127.0.0.1,fork - | hexdump -C

# Windows PowerShell:
ncat -l -p 25801 | Format-Hex
```

Terminal 3 (after both listeners are up). The chardev line is
identical on every platform:

Linux/macOS:
```
qemu-system-i386 \
    -M pc -m 256 -display none \
    -kernel vm/images/bzImage \
    -initrd vm/images/rootfs.cpio.gz \
    -append "console=ttyS0 panic=-1" \
    -serial stdio \
    -accel tcg -no-reboot \
    -device virtio-serial-pci,id=s \
    -chardev socket,id=audio,host=127.0.0.1,port=25800,server=off,nodelay=on \
    -device  virtserialport,chardev=audio,name=synthmodem.audio \
    -chardev socket,id=ctrl,host=127.0.0.1,port=25801,server=off,nodelay=on \
    -device  virtserialport,chardev=ctrl,name=synthmodem.control
```

Windows (PowerShell):
```powershell
& 'C:\Program Files\qemu\qemu-system-i386.exe' `
    -M pc -m 256 -display none `
    -kernel vm/images/bzImage `
    -initrd vm/images/rootfs.cpio.gz `
    -append "console=ttyS0 panic=-1" `
    -serial stdio `
    -accel tcg -no-reboot `
    -device virtio-serial-pci,id=s `
    -chardev socket,id=audio,host=127.0.0.1,port=25800,server=off,nodelay=on `
    -device  virtserialport,chardev=audio,name=synthmodem.audio `
    -chardev socket,id=ctrl,host=127.0.0.1,port=25801,server=off,nodelay=on `
    -device  virtserialport,chardev=ctrl,name=synthmodem.control
```

You should see S99modem start slmodemd + modemd-shim cleanly (no
respawn loop), and the control-channel terminal should receive a
HELLO frame containing `modemd-shim v1 build=...`. The audio
channel receives a 3-byte silence frame.

Notes:
- The `nodelay=on` option disables Nagle's algorithm on QEMU's side
  of the TCP socket. This is important for the steady audio stream;
  without it, 40 ms of small-write coalescing delay corrupts modem
  symbol timing.
- Ports can be anything ≥1024; the defaults 25800/25801 sit below
  the OS ephemeral ranges (Linux 32768+, Windows 49152+) so the OS
  won't accidentally pre-allocate them to an unrelated outbound
  connection at boot time.
- `-accel tcg` works everywhere. On Windows 10/11 with virtualization
  enabled, `-accel whpx` boots ~3× faster.
- On Windows, a Windows Defender Firewall prompt may appear the
  first time QEMU connects to loopback; allow it or suppress via
  firewall rule. (Only loopback is involved; no external network.)

To sniff the HELLO frame from the guest, save this as `sniff.js`
and run it (`node sniff.js`) **before** starting QEMU — Node listens,
QEMU connects once it's ready. Works identically on every platform.

```javascript
const net = require('net');
const HOST = '127.0.0.1';

function listen(port, label) {
    const server = net.createServer(sock => {
        console.log(`[${label}] connected`);
        sock.on('data', b => {
            const hex = Array.from(b).map(x => x.toString(16).padStart(2,'0')).join(' ');
            console.log(`[${label}] ${hex}`);
        });
        sock.on('close', () => console.log(`[${label}] closed`));
    });
    server.listen(port, HOST, () => console.log(`[${label}] listening ${HOST}:${port}`));
}

// Both listeners up before QEMU starts; accept order doesn't matter.
listen(25800, 'audio');
listen(25801, 'ctrl');
```

Expected output within ~8 seconds of QEMU booting:
```
[audio] listening 127.0.0.1:25800
[ctrl] listening 127.0.0.1:25801
[audio] connected
[ctrl] connected
[ctrl] 1d 00 10 6d 6f 64 65 6d  64 2d 73 68 69 6d 20 76 ...
[audio] 01 00 02
```

The `[ctrl] 1d 00 10 ...` frame is the HELLO — wire header
(len=0x001d=29, type=0x10=HELLO) followed by ASCII
`modemd-shim v1 build=unknown`. `[audio] 01 00 02` is the 3-byte
initial silence frame.

### Accelerator options per platform

| Host         | Recommended   | Fallback      |
|--------------|---------------|---------------|
| Linux        | `-accel kvm`  | `-accel tcg`  |
| Windows 10/11| `-accel whpx` | `-accel tcg`  |
| macOS        | `-accel hvf`  | `-accel tcg`  |

TCG (pure software emulation) works everywhere and takes ~7 seconds
boot-to-HELLO on a modern host. KVM/WHPX/HVF cut that to ~2 seconds.

### Where the real command lines live

The Node runner in `vm/qemu-runner/QemuVM.js` composes the full
QEMU invocation automatically per platform. `vm/qemu-runner/qemu-args.js`
is the single source of truth for the exact QEMU argv. If the
manual recipes above drift from what Node actually does, trust
`qemu-args.js`.

### Raising the guest log level

Without rebuilding anything, append `synthmodem_log=<level>` to
the kernel cmdline:

```
... -append "console=ttyS0 panic=-1 synthmodem_log=debug" ...
```

S99modem reads `/proc/cmdline` and exports `SYNTHMODEM_LOG_LEVEL`
for the shim, which then emits info- or debug-level traces.
Valid values: `error` (default), `info`, `debug`.

## Rebuilding the VM images

The tarball ships `vm/images/bzImage` and `vm/images/rootfs.cpio.gz`
ready to run. If you change anything in `vm/overlay/`, `vm/shim/`,
or `vm/slmodemd/`, regenerate with:

```
cd vm && make
```

Three consecutive clean builds will produce SHA256
`cf2c7a651b5dc44c0a35804aecc844127ad63be8203bbea0792809add1167e4f`
for `rootfs.cpio.gz` — reproducibility is enforced via deterministic
mtimes, sorted file lists, `cpio --reproducible`, and `gzip -n`.

## Missing files, errors, what to check

If the smoke test fails with `QemuVM: input file missing: .../bzImage`,
either the tarball was extracted incompletely or `make clean` wiped
the images. Regenerate with `make -C vm`.

If `qemu-system-i386` isn't on PATH, set either the `QEMU_SYSTEM_I386`
environment variable or configure `config.modem.slmodemd.qemuPath`
in `config.js`.

If the build fails at `npm install` with a node-gyp error, you're
missing build-essential or equivalent headers for your platform.

## GPL compliance

If you intend to redistribute, you'll also need the corresponding
source tarballs that aren't in this archive (kernel, busybox, glibc).
Run `scripts/fetch-vm-sources.sh` to populate `vm/sources/` from
pinned SHA256s — approximately 275 MB of tarballs.

See `COPYING` and `licenses/` for licensing details.

## Further reading

- `IMPLEMENTATION.md` — architecture, milestones, design decisions.
- `vm/overlay/README.md` — why slmodemd runs as uid 100 and related VM
  design choices.
- `vm/prebuilt/README.md` — what's in vm/prebuilt/ and why.
- `vm/prebuilt/PROVENANCE.txt` — exact SHA256s of every build input
  and output.
- `config.js` — all tuneable configuration options with comments.
