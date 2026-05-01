licenses/
=========

License texts and notices for every redistributable component of
synthmodem and its bundled third-party pieces. See the top-level
`COPYING` for the master summary and the corresponding-source
statement; see `vm/sources/README.md` for the tree of vendored
upstream source tarballs that back those notices.

| File                  | Covers                                                      |
|-----------------------|-------------------------------------------------------------|
| `GPL-2.0.txt`         | synthmodem itself; D-Modem; PJSIP; modemd-tunnel; modemd-ctrl; QEMU |
| `LGPL-2.1.txt`        | glibc; spandsp upstream (before §3 GPL election — see SPANDSP-NOTICE) |
| `SLMODEMD-BSD-3.txt`  | Original Smart Link slmodemd sources (`vm/slmodemd/`)       |
| `DSPLIBS-NOTICE`      | Proprietary `dsplibs.o` redistribution terms                |
| `D-MODEM-NOTICE`      | Attribution for `d-modem.c` (`vm/d-modem/`)                 |
| `PJSIP-NOTICE`        | Attribution for PJSIP (`vm/pjsip/`, `vm/sources/pjproject-*`) |
| `QEMU-NOTICE`         | Attribution and corresponding-source for QEMU (`win/qemu/`, `win/qemu-source/`) |
| `LINUX-KERNEL-NOTICE` | Attribution and corresponding-source for the Linux kernel image and modules (`vm/kernel/`) |
| `BUSYBOX-NOTICE`      | Attribution and corresponding-source for busybox (`vm/busybox/`) |
| `GLIBC-NOTICE`        | Attribution and corresponding-source for glibc (`vm/libc/`) |
| `SPANDSP-NOTICE`      | Attribution for the JavaScript ports of spandsp source under `src/dsp/` |
| `NODEJS-LICENSE`      | MIT license for Node.js (`win/nodejs/`, `win/nodejs-release/`) |

Every synthmodem release archive must include this directory in
full. The top-level `COPYING` refers to these files by path, so
they should not be renamed or moved.

## Why most GPL components don't have their own full license-text files

PJSIP, D-Modem, QEMU, the Linux kernel, and busybox are all
licensed under variants of GPL-2.0 — the same family of terms as
synthmodem itself. Rather than shipping multiple copies of the GPL
text, `GPL-2.0.txt` is the canonical copy and the `*-NOTICE` files
provide the per-component attribution, copyright holders, version
pins, corresponding-source paths, and any component-specific notes
(e.g. the Linux kernel's `Linux-syscall-note` exception, PJSIP's
dual-licensing with Teluu's commercial option). This mirrors the
pattern used for `DSPLIBS-NOTICE` (proprietary permissive) vs
`SLMODEMD-BSD-3.txt` (a distinctly different license that needs
its own text).

`LGPL-2.1.txt` is shipped as a separate license-text file because
LGPL-2.1 is a distinct license family from GPL-2.0 with its own
relinking and source-distribution provisions. It covers glibc as
distributed in `vm/libc/` and is also the upstream license of the
spandsp code that synthmodem has reimplemented in JavaScript and
relicensed under GPL-2.0-or-later via the LGPL-2.1 §3 election
(see `SPANDSP-NOTICE` for details).

## VM component licenses

The runtime VM embeds GPL/LGPL binaries (the Linux kernel, busybox,
glibc). Each has its own dedicated notice file (`LINUX-KERNEL-NOTICE`,
`BUSYBOX-NOTICE`, `GLIBC-NOTICE`) recording upstream URL, version
pin, and corresponding-source path. Their copyright headers also
travel verbatim with their source trees under `vm/sources/`.

If the set of shipped VM components grows in a way that introduces
a new license family, add a dedicated notice here and extend the
table above.
