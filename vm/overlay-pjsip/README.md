# vm/overlay-pjsip/ — Static files for the slmodemd-pjsip rootfs

Files baked into the runtime VM's initramfs
(`vm/images/rootfs-slmodemd-pjsip.cpio.gz`). These are layered on
top of busybox + libc + the synthmodem-built helpers (slmodemd,
d-modem, modemd-tunnel-i386, modemd-ctrl-i386) by `vm/Makefile`'s
`populate-pjsip` target.

## Contents

| Path                              | Purpose |
|-----------------------------------|---------|
| `etc/init.d/rcS`                  | First-stage boot — mounts /proc, /sys, /dev, populates /dev nodes, then chains to S99modem-pjsip. |
| `etc/init.d/S99modem-pjsip`       | Main runtime launcher. Loads virtio modules, creates virtio-port symlinks, starts modemd-tunnel and modemd-ctrl, then execs slmodemd with d-modem as its `-e` audio adapter. |
| `etc/passwd` and `etc/group`     | Minimal `root` / `nobody` so anything that calls `getpwuid` doesn't fail. |

## Customizing the launch

The init scripts read configuration from the kernel cmdline, which
is set on the host side by `vm/qemu-runner/QemuVM.js` based on
`config.modem['slmodemd-pjsip'].*`. Most behavior is configured by
those host-side keys (log level, AT init sequence, transport ports)
rather than by edits in this directory.

If you need to add a new helper binary or change the launch
sequence, the changes go in `etc/init.d/S99modem-pjsip`.

## Why these files live here

Three reasons to keep init scripts in-tree rather than generated:

1. **Reviewability** — the launch sequence is short, readable shell;
   it's easier to audit a real file than a Makefile recipe that
   echoes a heredoc.
2. **Per-rootfs divergence** — early in this work we maintained a
   second rootfs for a host-paced backend whose init differed
   structurally; even though that backend is gone, having the init
   tree sit next to the runtime rootfs (rather than embedded in the
   Makefile) keeps the layout flexible if a different rootfs is
   needed again.
3. **Reproducibility** — the Makefile's CPIO rule is reproducible
   only if its inputs are reproducible. Static tree-on-disk files
   contribute to that more cleanly than `printf` inside a recipe.
