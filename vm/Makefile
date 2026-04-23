# vm/Makefile — synthmodem VM image builder
#
# Copyright (C) 2026 synthmodem contributors
# License: GPL-2.0-or-later
#
# ─────────────────────────────────────────────────────────────────────────
#
# Produces a bootable minimal Linux VM that runs slmodemd + modemd-shim
# in 32-bit user mode on a 32-bit (i386) kernel.
#
#   make                — builds images/rootfs.cpio.gz + copies bzImage
#   make clean          — removes images/ and intermediate build dirs
#   make distclean      — also removes extracted binaries (forces re-fetch)
#   make inventory      — prints what's in the built initramfs
#
# ARCHITECTURE
#
#   Kernel:    i386 (Debian bookworm linux-image-6.1.0-42-686-pae)
#   Userspace: i386 (Debian busybox-static, Debian glibc, i386-built
#              slmodemd + modemd-shim)
#
#   Everything is 32-bit. The host can be anything as long as it can
#   run the build toolchain (gcc with -m32 support).
#
# PATH B vs BUILDROOT
#
#   This Makefile implements "Path B": assemble an initramfs from
#   prebuilt distro binaries + our own shim/slmodemd. Fast to build
#   (seconds, not minutes), easy to iterate. GPL compliant via source
#   tarballs vendored under vm/sources/.
#
#   A future "Path A" using Buildroot would build a fully custom
#   toolchain, kernel, and userspace. We keep Path A as a nice-to-have
#   for reproducibility — see vm/buildroot/ (empty scaffold).
#
# ─────────────────────────────────────────────────────────────────────────

REPO_ROOT := $(abspath ..)
VM_DIR    := $(abspath .)

# Outputs
IMAGES_DIR   := $(VM_DIR)/images
BZIMAGE_OUT  := $(IMAGES_DIR)/bzImage
INITRAMFS    := $(IMAGES_DIR)/rootfs.cpio.gz

# Inputs
KERNEL_BZIMAGE := $(VM_DIR)/kernel/bzImage
KMOD_DIR       := $(VM_DIR)/kernel/modules
BUSYBOX_BIN    := $(VM_DIR)/busybox/busybox
LIBC_DIR       := $(VM_DIR)/libc
SLMODEMD_SRC   := $(VM_DIR)/slmodemd
SHIM_SRC       := $(VM_DIR)/shim
OVERLAY_DIR    := $(VM_DIR)/overlay

# Shim binary selection — same policy as slmodemd. The shim hits the
# same glibc 2.38 __isoc23_ problem on modern build hosts (through
# atoi→strtol and similar), so we default to the prebuilt built in
# the build VM alongside slmodemd.
PREBUILT_SHIM := $(VM_DIR)/prebuilt/modemd-shim-i386
ifneq ($(wildcard $(PREBUILT_SHIM)),)
SHIM_BIN := $(PREBUILT_SHIM)
SHIM_SOURCE_LABEL := prebuilt
else
SHIM_BIN := $(SHIM_SRC)/modemd-shim-i386
SHIM_SOURCE_LABEL := host-built
endif

# slmodemd binary selection.
#
# We prefer the committed prebuilt at vm/prebuilt/slmodemd, built inside
# a Debian bookworm i386 VM so it links against the exact glibc 2.36 we
# ship in the runtime VM. See scripts/build-slmodemd-in-vm.sh for the
# recipe used to produce it. If the prebuilt isn't present, we fall back
# to a host build — this WILL produce a binary referencing newer glibc
# symbols on modern hosts (Ubuntu 24.04+, Fedora, Arch), which then won't
# load inside the runtime VM. The fallback is only safe when the build
# host itself runs glibc ≤ 2.36 (e.g. a Debian bookworm dev machine).
PREBUILT_SLMODEMD := $(VM_DIR)/prebuilt/slmodemd
ifneq ($(wildcard $(PREBUILT_SLMODEMD)),)
SLMODEMD_BIN := $(PREBUILT_SLMODEMD)
SLMODEMD_SOURCE_LABEL := prebuilt
else
SLMODEMD_BIN := $(SLMODEMD_SRC)/slmodemd
SLMODEMD_SOURCE_LABEL := host-built
endif

# Staging root where we lay out the entire filesystem before cpio.
ROOTFS_DIR := $(VM_DIR)/.rootfs-build

# Tools
# Prefer system cpio; if it's missing, fall back to busybox cpio. The
# project ships busybox, so users never need to install cpio separately.
CPIO  := $(shell command -v cpio 2>/dev/null)
ifeq ($(CPIO),)
CPIO  := $(VM_DIR)/busybox/busybox cpio
endif
GZIP  := gzip
INSTALL_TOOL := install
DPKG_DEB := dpkg-deb

# Default target
.PHONY: all
all: $(INITRAMFS) $(BZIMAGE_OUT)

# ─── Kernel image copy ──────────────────────────────────────────────────

$(BZIMAGE_OUT): $(KERNEL_BZIMAGE) | $(IMAGES_DIR)
	@echo "  COPY    $(notdir $@)"
	@cp $< $@

$(KERNEL_BZIMAGE):
	@echo "ERROR: $(KERNEL_BZIMAGE) missing. Run scripts/fetch-vm-binaries.sh" >&2
	@exit 1

# ─── Building the initramfs ─────────────────────────────────────────────

$(INITRAMFS): $(SLMODEMD_BIN) $(SHIM_BIN) $(BUSYBOX_BIN) \
              $(wildcard $(KMOD_DIR)/*.ko) \
              $(wildcard $(LIBC_DIR)/*.so.*) \
              $(shell find $(OVERLAY_DIR) -type f 2>/dev/null) \
              | $(IMAGES_DIR)
	@echo "  ROOTFS  assembling staging tree..."
	@rm -rf $(ROOTFS_DIR)
	@mkdir -p $(ROOTFS_DIR)
	@$(MAKE) --no-print-directory populate
	@echo "  CPIO    $(notdir $@)"
	@# Reproducibility: set every staged file's mtime to a constant
	@# before archiving, and strip gzip's own timestamp (-n). Without
	@# this, rootfs.cpio.gz differs byte-for-byte between builds even
	@# with identical content, because cpio stores mtimes verbatim.
	@# SOURCE_DATE_EPOCH=0 (1970-01-01) keeps the archive hash stable
	@# across machines and build times.
	@find $(ROOTFS_DIR) -exec touch -h -d '@0' {} +
	@cd $(ROOTFS_DIR) && find . -print0 \
	   | LC_ALL=C sort -z \
	   | $(CPIO) --null -H newc --create --quiet --reproducible \
	   | $(GZIP) -9 -n > $@
	@echo "  SIZE    $$(du -h $@ | cut -f1)  $@"

# The populate target assembles the full filesystem tree under ROOTFS_DIR.
# Called by the $(INITRAMFS) rule; not usually invoked directly.
#
# Layout:
#   /                       — root
#   /bin/sh, /bin/busybox   — busybox
#   /sbin/init              — busybox (which handles PID 1)
#   /etc/init.d/S99modem    — our script (from overlay)
#   /etc/inittab            — minimal init configuration
#   /etc/fstab              — minimal fstab (essentially a no-op)
#   /lib/ld-linux.so.2      — i386 dynamic loader
#   /lib/i386-linux-gnu/    — libc.so.6, libm.so.6 (glibc search path)
#   /lib/modules/virtio/    — our handful of virtio .ko files
#   /usr/local/bin/slmodemd — our 32-bit slmodemd binary
#   /usr/local/bin/modemd-shim — our 32-bit shim binary
#   /dev, /proc, /sys       — empty dirs; mounted at boot by S99modem

.PHONY: populate
populate:
	@# Directories
	@mkdir -p $(ROOTFS_DIR)/bin
	@mkdir -p $(ROOTFS_DIR)/sbin
	@mkdir -p $(ROOTFS_DIR)/etc/init.d
	@mkdir -p $(ROOTFS_DIR)/lib/i386-linux-gnu
	@mkdir -p $(ROOTFS_DIR)/lib/modules/virtio
	@mkdir -p $(ROOTFS_DIR)/usr/local/bin
	@mkdir -p $(ROOTFS_DIR)/dev
	@mkdir -p $(ROOTFS_DIR)/proc
	@mkdir -p $(ROOTFS_DIR)/sys
	@mkdir -p $(ROOTFS_DIR)/tmp
	@mkdir -p $(ROOTFS_DIR)/root
	@mkdir -p $(ROOTFS_DIR)/var/log
	@chmod 1777 $(ROOTFS_DIR)/tmp

	@# busybox — installed as /bin/busybox; applets as symlinks.
	@cp $(BUSYBOX_BIN) $(ROOTFS_DIR)/bin/busybox
	@chmod +x $(ROOTFS_DIR)/bin/busybox
	@# busybox applet symlinks we actually need. Full --install would
	@# create ~300 symlinks; we whittle to essentials to keep the
	@# initramfs lean and easier to audit.
	@for a in sh ash mount umount mkdir rm cp mv ls cat echo test \
	           [ chmod chown chroot dd dmesg env halt ifconfig \
	           insmod killall ln pidof ps rmmod sleep ln poweroff \
	           reboot hostname date uname stty tty printf find \
	           grep awk sed tr head tail sort wc xargs; do \
	  ln -sf busybox $(ROOTFS_DIR)/bin/$$a; \
	done
	@# /sbin/init is what the kernel execs at boot. busybox's init
	@# honours /etc/inittab and runs /etc/init.d/rcS.
	@ln -sf ../bin/busybox $(ROOTFS_DIR)/sbin/init
	@# /init at the root is what the kernel actually looks for when
	@# using an initramfs. If /init is missing the kernel falls
	@# through to the old-style ramdisk path and tries to mount a
	@# root block device instead — which ends in a VFS panic.
	@# Symlink /init → /sbin/init so the kernel finds it.
	@ln -sf sbin/init $(ROOTFS_DIR)/init

	@# Overlay: copy only the etc/ subtree from vm/overlay/ into the
	@# rootfs. Other files in the overlay dir (README.md, etc.) are
	@# maintainer-facing documentation and must not ship in the VM.
	@cp -r $(OVERLAY_DIR)/etc $(ROOTFS_DIR)/
	@chmod +x $(ROOTFS_DIR)/etc/init.d/rcS
	@chmod +x $(ROOTFS_DIR)/etc/init.d/S99modem

	@# Minimal /etc/inittab for busybox init. This tells init to run
	@# our rcS at boot, and gives us a console for debugging.
	@printf '%s\n' \
	  '# Run boot scripts (sysinit entries complete before respawn fires)' \
	  '::sysinit:/etc/init.d/rcS' \
	  '# Start our service on the serial console' \
	  'ttyS0::respawn:/etc/init.d/S99modem' \
	  '# On shutdown, terminate cleanly' \
	  '::shutdown:/bin/umount -a -r' \
	  '# On ctrl-alt-del, reboot' \
	  '::ctrlaltdel:/sbin/reboot' \
	  > $(ROOTFS_DIR)/etc/inittab

	@# Tiny fstab so "mount -a" has something to read if someone drops
	@# into a shell. rcS mounts these directly (more reliable than
	@# depending on fstab).
	@printf '%s\n' \
	  'proc       /proc    proc     defaults   0 0' \
	  'sysfs      /sys     sysfs    defaults   0 0' \
	  'devtmpfs   /dev     devtmpfs defaults   0 0' \
	  'devpts     /dev/pts devpts   defaults   0 0' \
	  'tmpfs      /tmp     tmpfs    defaults   0 0' \
	  > $(ROOTFS_DIR)/etc/fstab

	@# Our binaries
	@cp $(SLMODEMD_BIN) $(ROOTFS_DIR)/usr/local/bin/slmodemd
	@cp $(SHIM_BIN)     $(ROOTFS_DIR)/usr/local/bin/modemd-shim
	@chmod +x $(ROOTFS_DIR)/usr/local/bin/slmodemd
	@chmod +x $(ROOTFS_DIR)/usr/local/bin/modemd-shim

	@# glibc: dynamic loader at /lib/ld-linux.so.2 and libc.so.6 +
	@# libm.so.6 in /lib/i386-linux-gnu/. Slmodemd is linked with
	@# /lib/ld-linux.so.2 as the interpreter; the loader then
	@# searches the standard runtime paths including
	@# /lib/i386-linux-gnu/. No /etc/ld.so.conf needed for this set.
	@cp $(LIBC_DIR)/ld-linux.so.2   $(ROOTFS_DIR)/lib/ld-linux.so.2
	@cp $(LIBC_DIR)/libc.so.6       $(ROOTFS_DIR)/lib/i386-linux-gnu/libc.so.6
	@if [ -f $(LIBC_DIR)/libm.so.6 ]; then \
	  cp $(LIBC_DIR)/libm.so.6 $(ROOTFS_DIR)/lib/i386-linux-gnu/libm.so.6; \
	fi
	@chmod +x $(ROOTFS_DIR)/lib/ld-linux.so.2

	@# Virtio modules into /lib/modules/virtio/ (matches S99modem's
	@# MOD_DIR). We don't need a full modules.dep because insmod-by-
	@# path handles dependency order explicitly in the init script.
	@for k in $(KMOD_DIR)/virtio*.ko; do \
	  cp "$$k" $(ROOTFS_DIR)/lib/modules/virtio/; \
	done

	@# /etc/passwd and /etc/group are shipped as overlay files with
	@# entries slmodemd needs (getpwnam 'nobody' for drop-privs, and
	@# getgrnam 'dialout' for the PTY group). See vm/overlay/etc/.

	@# /etc/hostname — nice for ps output and shell prompts
	@printf 'synthmodem-vm\n' > $(ROOTFS_DIR)/etc/hostname

# ─── Build dependencies for the binaries ────────────────────────────────

# slmodemd — only built from source if we're not using the prebuilt.
# Build is inside vm/slmodemd/ via its own Makefile, which auto-selects
# gcc -m32 on x86_64 hosts.
ifeq ($(SLMODEMD_SOURCE_LABEL),host-built)
$(SLMODEMD_BIN):
	@echo "  BUILD   slmodemd (i386, host gcc)"
	@echo "  NOTE    no vm/prebuilt/slmodemd found — falling back to host build."
	@echo "          This only produces a working binary if the host's glibc is ≤ 2.36."
	@echo "          To build a guaranteed-compatible binary, run:"
	@echo "              scripts/build-slmodemd-in-vm.sh"
	@$(MAKE) -C $(SLMODEMD_SRC)
endif

# modemd-shim-i386 — only built from source if we're not using the prebuilt.
# Using the host build produces __isoc23_strtol/__isoc23_sscanf references
# on modern hosts that fail to load inside the VM.
ifeq ($(SHIM_SOURCE_LABEL),host-built)
$(SHIM_BIN):
	@echo "  BUILD   modemd-shim-i386 (host gcc -m32)"
	@echo "  NOTE    no vm/prebuilt/modemd-shim-i386 found — falling back to host build."
	@echo "          On hosts with glibc ≥ 2.38 this produces unusable binaries."
	@echo "          To build a compatible binary, run:"
	@echo "              scripts/build-slmodemd-in-vm.sh"
	@$(MAKE) -C $(SHIM_SRC) modemd-shim-i386
endif

# ─── Output dirs ────────────────────────────────────────────────────────

$(IMAGES_DIR):
	@mkdir -p $@

# ─── Introspection ──────────────────────────────────────────────────────

.PHONY: inventory
inventory: $(INITRAMFS)
	@echo "Kernel:       $(BZIMAGE_OUT)"
	@ls -lh $(BZIMAGE_OUT) 2>/dev/null | awk '{print "              " $$5 "  " $$NF}'
	@echo "Initramfs:    $(INITRAMFS)"
	@ls -lh $(INITRAMFS)  2>/dev/null | awk '{print "              " $$5 "  " $$NF}'
	@echo "Contents:"
	@zcat $(INITRAMFS) | cpio -t --quiet 2>/dev/null | sort | sed 's/^/  /'

# ─── Cleanup ────────────────────────────────────────────────────────────

.PHONY: clean
clean:
	@rm -rf $(ROOTFS_DIR) $(IMAGES_DIR)
	@$(MAKE) -C $(SHIM_SRC)     clean 2>/dev/null || true
	@$(MAKE) -C $(SLMODEMD_SRC) clean 2>/dev/null || true

.PHONY: distclean
distclean: clean
	@rm -rf $(VM_DIR)/kernel/bzImage $(VM_DIR)/kernel/modules \
	        $(VM_DIR)/kernel/config $(VM_DIR)/kernel/System.map \
	        $(VM_DIR)/busybox/busybox \
	        $(VM_DIR)/libc/*.so.*
	@echo "distclean: extracted binaries removed. Run scripts/fetch-vm-binaries.sh to refetch."
