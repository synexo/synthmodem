# vm/Makefile — synthmodem VM image builder
#
# Copyright (C) 2026 synthmodem contributors
# License: GPL-2.0-or-later
#
# ─────────────────────────────────────────────────────────────────────────
#
# Produces a bootable minimal Linux VM image for the slmodemd-pjsip
# backend: slmodemd + d-modem (PJSIP-paced audio) + modemd-tunnel +
# modemd-ctrl in an i386 Debian-bookworm-derived initramfs.
#
#   Image:   images/rootfs-slmodemd-pjsip.cpio.gz
#   Kernel:  images/bzImage (verbatim copy of vm/kernel/bzImage)
#
# Targets:
#   make                — builds rootfs-slmodemd-pjsip.cpio.gz + bzImage
#                         (alias: `make rootfs-pjsip`)
#   make rootfs-pjsip   — same as default
#   make clean          — removes images/ and intermediate build dirs
#   make distclean      — also removes extracted binaries (forces re-fetch)
#   make inventory      — prints what's in the initramfs
#
# ARCHITECTURE
#
#   Kernel:    i386 (Debian bookworm linux-image-6.1.0-42-686-pae)
#   Userspace: i386 (Debian busybox-static, Debian glibc, i386-built
#              slmodemd + d-modem + modemd-tunnel + modemd-ctrl)
#
#   Everything is 32-bit. The host can be anything as long as it can
#   run the build toolchain (gcc with -m32 support).
#
# PATH B vs BUILDROOT
#
#   This Makefile implements "Path B": assemble an initramfs from
#   prebuilt distro binaries + our own slmodemd/d-modem/tunnel/ctrl.
#   Fast to build (seconds, not minutes), easy to iterate. GPL
#   compliant via source tarballs vendored under vm/sources/.
#
#   A future "Path A" using Buildroot would build a fully custom
#   toolchain, kernel, and userspace. We keep Path A as a nice-to-have
#   for reproducibility — see vm/buildroot/ (empty scaffold).
#
# HISTORICAL NOTE
#
#   An earlier "backend A" (slmodemd + modemd-shim, host-paced audio)
#   produced a separate rootfs.cpio.gz from this Makefile. That backend
#   was removed in cleanup-phase-1; this Makefile now only produces
#   the slmodemd-pjsip rootfs.
#
# ─────────────────────────────────────────────────────────────────────────

REPO_ROOT := $(abspath ..)
VM_DIR    := $(abspath .)

# Outputs
IMAGES_DIR         := $(VM_DIR)/images
BZIMAGE_OUT        := $(IMAGES_DIR)/bzImage
INITRAMFS_PJSIP    := $(IMAGES_DIR)/rootfs-slmodemd-pjsip.cpio.gz
# Minimal base rootfs used by scripts/build-*-in-vm.sh as the foundation
# they layer the bookworm toolchain on top of. Contains busybox + libc +
# virtio modules + standard mount points; nothing synthmodem-specific.
INITRAMFS_BUILDER  := $(IMAGES_DIR)/rootfs-builder-base.cpio.gz

# Inputs — shared
KERNEL_BZIMAGE := $(VM_DIR)/kernel/bzImage
KMOD_DIR       := $(VM_DIR)/kernel/modules
BUSYBOX_BIN    := $(VM_DIR)/busybox/busybox
LIBC_DIR       := $(VM_DIR)/libc
SLMODEMD_SRC   := $(VM_DIR)/slmodemd

# Inputs — slmodemd-pjsip
DMODEM_SRC         := $(VM_DIR)/d-modem
OVERLAY_DIR_PJSIP  := $(VM_DIR)/overlay-pjsip

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

# d-modem binary selection (backend B only). Unlike slmodemd and the
# shim, there is NO host-build fallback path for d-modem — it must be
# built inside the bookworm VM because PJSIP is huge and hits both the
# glibc 2.38 __isoc23_ trap and various autoconf probe mismatches on
# modern hosts. If the prebuilt is missing, the pjsip rootfs target
# fails with a clear pointer to scripts/build-pjsip-in-vm.sh.
PREBUILT_DMODEM := $(VM_DIR)/prebuilt/d-modem
ifneq ($(wildcard $(PREBUILT_DMODEM)),)
DMODEM_BIN := $(PREBUILT_DMODEM)
DMODEM_SOURCE_LABEL := prebuilt
else
DMODEM_BIN :=
DMODEM_SOURCE_LABEL := missing
endif

# modemd-tunnel and modemd-ctrl — backend-B helpers. Same build-in-VM
# story as d-modem (glibc 2.34 cap for runtime VM compatibility). Both
# are produced by scripts/build-pjsip-in-vm.sh alongside d-modem.
PREBUILT_TUNNEL := $(VM_DIR)/prebuilt/modemd-tunnel-i386
ifneq ($(wildcard $(PREBUILT_TUNNEL)),)
TUNNEL_BIN := $(PREBUILT_TUNNEL)
TUNNEL_SOURCE_LABEL := prebuilt
else
TUNNEL_BIN :=
TUNNEL_SOURCE_LABEL := missing
endif

PREBUILT_CTRL := $(VM_DIR)/prebuilt/modemd-ctrl-i386
ifneq ($(wildcard $(PREBUILT_CTRL)),)
CTRL_BIN := $(PREBUILT_CTRL)
CTRL_SOURCE_LABEL := prebuilt
else
CTRL_BIN :=
CTRL_SOURCE_LABEL := missing
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

# Default target — builds the slmodemd-pjsip rootfs and the kernel.
.PHONY: default
default: $(INITRAMFS_PJSIP) $(BZIMAGE_OUT)

# Convenience alias retained because scripts and developer muscle memory
# both reach for `make rootfs-pjsip` explicitly.
.PHONY: rootfs-pjsip
rootfs-pjsip: $(INITRAMFS_PJSIP)

# Builder base — minimal cpio used by scripts/build-*-in-vm.sh. Has no
# synthmodem-specific binaries; the build scripts layer the bookworm
# toolchain on top to produce the in-VM build environment.
.PHONY: rootfs-builder-base
rootfs-builder-base: $(INITRAMFS_BUILDER)

# `all` is now equivalent to default; kept for compatibility with any
# external invocations that use it.
.PHONY: all
all: default

# ─── Kernel image copy ──────────────────────────────────────────────────

$(BZIMAGE_OUT): $(KERNEL_BZIMAGE) | $(IMAGES_DIR)
	@echo "  COPY    $(notdir $@)"
	@cp $< $@

$(KERNEL_BZIMAGE):
	@echo "ERROR: $(KERNEL_BZIMAGE) missing. Run scripts/fetch-vm-binaries.sh" >&2
	@exit 1

# ─── Building the slmodemd-pjsip initramfs ─────────────────────────────
#
# Assembles the runtime rootfs:
#   - Uses vm/overlay-pjsip/ as the source of /etc init scripts
#   - Installs vm/prebuilt/{slmodemd, d-modem, modemd-tunnel-i386,
#     modemd-ctrl-i386} into /usr/local/bin/

$(INITRAMFS_PJSIP): $(SLMODEMD_BIN) $(BUSYBOX_BIN) \
                    $(DMODEM_BIN) $(TUNNEL_BIN) $(CTRL_BIN) \
                    $(wildcard $(KMOD_DIR)/*.ko) \
                    $(wildcard $(LIBC_DIR)/*.so.*) \
                    $(shell find $(OVERLAY_DIR_PJSIP) -type f 2>/dev/null) \
                    | $(IMAGES_DIR)
	@if [ -z "$(DMODEM_BIN)" ]; then \
	  echo "ERROR: vm/prebuilt/d-modem missing."; \
	  echo "       Run scripts/build-pjsip-in-vm.sh to produce it."; \
	  exit 1; \
	fi
	@if [ -z "$(TUNNEL_BIN)" ]; then \
	  echo "ERROR: vm/prebuilt/modemd-tunnel-i386 missing."; \
	  echo "       Run scripts/build-pjsip-in-vm.sh to produce it."; \
	  exit 1; \
	fi
	@if [ -z "$(CTRL_BIN)" ]; then \
	  echo "ERROR: vm/prebuilt/modemd-ctrl-i386 missing."; \
	  echo "       Run scripts/build-pjsip-in-vm.sh to produce it."; \
	  exit 1; \
	fi
	@echo "  ROOTFS  assembling staging tree (pjsip)..."
	@rm -rf $(ROOTFS_DIR)
	@mkdir -p $(ROOTFS_DIR)
	@$(MAKE) --no-print-directory populate-pjsip
	@echo "  CPIO    $(notdir $@)"
	@# Same reproducibility pattern: mtimes to epoch 0,
	@# sorted file list, --reproducible cpio, gzip -n.
	@find $(ROOTFS_DIR) -exec touch -h -d '@0' {} +
	@cd $(ROOTFS_DIR) && find . -print0 \
	   | LC_ALL=C sort -z \
	   | $(CPIO) --null -H newc --create --quiet --reproducible \
	   | $(GZIP) -9 -n > $@
	@echo "  SIZE    $$(du -h $@ | cut -f1)  $@"

# ─── Building the minimal builder-base initramfs ─────────────────────
#
# Used by scripts/build-slmodemd-in-vm.sh and scripts/build-pjsip-in-vm.sh
# as the foundation they layer the bookworm toolchain on top of. Has
# busybox + libc + virtio modules + standard mount points, no
# synthmodem-specific binaries or overlay scripts. Substantially
# slimmer than the runtime rootfs and free of the recursive dependency
# (the runtime rootfs needs prebuilts that the build scripts produce).
$(INITRAMFS_BUILDER): $(BUSYBOX_BIN) \
                      $(wildcard $(KMOD_DIR)/*.ko) \
                      $(wildcard $(LIBC_DIR)/*.so.*) \
                      | $(IMAGES_DIR)
	@echo "  ROOTFS  assembling staging tree (builder-base)..."
	@rm -rf $(ROOTFS_DIR)
	@mkdir -p $(ROOTFS_DIR)
	@$(MAKE) --no-print-directory populate-builder-base
	@echo "  CPIO    $(notdir $@)"
	@find $(ROOTFS_DIR) -exec touch -h -d '@0' {} +
	@cd $(ROOTFS_DIR) && find . -print0 \
	   | LC_ALL=C sort -z \
	   | $(CPIO) --null -H newc --create --quiet --reproducible \
	   | $(GZIP) -9 -n > $@
	@echo "  SIZE    $$(du -h $@ | cut -f1)  $@"

# populate-builder-base — minimal /bin/busybox + applet symlinks +
# /lib glibc + virtio modules + dev/proc/sys/tmp/root mount points.
# No synthmodem binaries, no overlay scripts.
.PHONY: populate-builder-base
populate-builder-base:
	@mkdir -p $(ROOTFS_DIR)/bin
	@mkdir -p $(ROOTFS_DIR)/sbin
	@mkdir -p $(ROOTFS_DIR)/etc
	@mkdir -p $(ROOTFS_DIR)/lib/i386-linux-gnu
	@mkdir -p $(ROOTFS_DIR)/lib/modules/virtio
	@mkdir -p $(ROOTFS_DIR)/dev
	@mkdir -p $(ROOTFS_DIR)/proc
	@mkdir -p $(ROOTFS_DIR)/sys
	@mkdir -p $(ROOTFS_DIR)/tmp
	@mkdir -p $(ROOTFS_DIR)/root
	@mkdir -p $(ROOTFS_DIR)/usr/local/bin
	@chmod 1777 $(ROOTFS_DIR)/tmp

	@# busybox + applet symlinks (same set the runtime rootfs uses).
	@cp $(BUSYBOX_BIN) $(ROOTFS_DIR)/bin/busybox
	@chmod +x $(ROOTFS_DIR)/bin/busybox
	@for a in sh ash mount umount mkdir rm cp mv ls cat echo test \
	           [ chmod chown chroot dd dmesg env halt ifconfig \
	           insmod killall ln pidof ps rmmod sleep ln poweroff \
	           reboot hostname date uname stty tty printf find \
	           grep awk sed tr head tail sort wc xargs; do \
	  ln -sf busybox $(ROOTFS_DIR)/bin/$$a; \
	done
	@ln -sf ../bin/busybox $(ROOTFS_DIR)/sbin/init
	@ln -sf sbin/init $(ROOTFS_DIR)/init

	@# glibc — same files the runtime rootfs uses.
	@cp $(LIBC_DIR)/ld-linux.so.2   $(ROOTFS_DIR)/lib/ld-linux.so.2
	@cp $(LIBC_DIR)/libc.so.6       $(ROOTFS_DIR)/lib/i386-linux-gnu/libc.so.6
	@if [ -f $(LIBC_DIR)/libm.so.6 ]; then \
	  cp $(LIBC_DIR)/libm.so.6 $(ROOTFS_DIR)/lib/i386-linux-gnu/libm.so.6; \
	fi
	@chmod +x $(ROOTFS_DIR)/lib/ld-linux.so.2

	@# Virtio modules — needed for 9p mount in the builder VM.
	@for k in $(KMOD_DIR)/virtio*.ko; do \
	  cp "$$k" $(ROOTFS_DIR)/lib/modules/virtio/; \
	done

	@# /etc/passwd and /etc/group — minimal so anything that calls
	@# getpwuid(0) inside the builder VM still works.
	@printf 'root:x:0:0:root:/root:/bin/sh\n' > $(ROOTFS_DIR)/etc/passwd
	@printf 'root:x:0:\n' > $(ROOTFS_DIR)/etc/group
	@printf 'synthmodem-builder\n' > $(ROOTFS_DIR)/etc/hostname

# populate-pjsip — assembles the slmodemd-pjsip runtime rootfs.
# Distinct from populate-builder-base because this one needs the
# synthmodem helper binaries and the overlay's init scripts.
.PHONY: populate-pjsip
populate-pjsip:
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

	@# busybox
	@cp $(BUSYBOX_BIN) $(ROOTFS_DIR)/bin/busybox
	@chmod +x $(ROOTFS_DIR)/bin/busybox
	@for a in sh ash mount umount mkdir rm cp mv ls cat echo test \
	           [ chmod chown chroot dd dmesg env halt ifconfig \
	           insmod killall ln pidof ps rmmod sleep ln poweroff \
	           reboot hostname date uname stty tty printf find \
	           grep awk sed tr head tail sort wc xargs; do \
	  ln -sf busybox $(ROOTFS_DIR)/bin/$$a; \
	done
	@ln -sf ../bin/busybox $(ROOTFS_DIR)/sbin/init
	@ln -sf sbin/init $(ROOTFS_DIR)/init

	@# Overlay: copy only etc/ from vm/overlay-pjsip/
	@cp -r $(OVERLAY_DIR_PJSIP)/etc $(ROOTFS_DIR)/
	@chmod +x $(ROOTFS_DIR)/etc/init.d/rcS
	@# Make the pjsip init script executable
	@# if present. The wildcard tolerates early-development images
	@# where S99modem-pjsip may not exist yet.
	@for s in $(ROOTFS_DIR)/etc/init.d/S??*; do \
	  [ -f "$$s" ] && chmod +x "$$s"; \
	done

	@# /etc/inittab — invokes the pjsip
	@# init script instead.
	@printf '%s\n' \
	  '# Run boot scripts (sysinit entries complete before respawn fires)' \
	  '::sysinit:/etc/init.d/rcS' \
	  '# Start our service on the serial console' \
	  'ttyS0::respawn:/etc/init.d/S99modem-pjsip' \
	  '# On shutdown, terminate cleanly' \
	  '::shutdown:/bin/umount -a -r' \
	  '# On ctrl-alt-del, reboot' \
	  '::ctrlaltdel:/sbin/reboot' \
	  > $(ROOTFS_DIR)/etc/inittab

	@# /etc/fstab
	@printf '%s\n' \
	  'proc       /proc    proc     defaults   0 0' \
	  'sysfs      /sys     sysfs    defaults   0 0' \
	  'devtmpfs   /dev     devtmpfs defaults   0 0' \
	  'devpts     /dev/pts devpts   defaults   0 0' \
	  'tmpfs      /tmp     tmpfs    defaults   0 0' \
	  > $(ROOTFS_DIR)/etc/fstab

	@# Our binaries: slmodemd (shared) + d-modem + modemd-tunnel +
	@# modemd-ctrl. d-modem is the slmodemd helper for this backend.
	@cp $(SLMODEMD_BIN) $(ROOTFS_DIR)/usr/local/bin/slmodemd
	@cp $(DMODEM_BIN)   $(ROOTFS_DIR)/usr/local/bin/d-modem
	@cp $(TUNNEL_BIN)   $(ROOTFS_DIR)/usr/local/bin/modemd-tunnel
	@cp $(CTRL_BIN)     $(ROOTFS_DIR)/usr/local/bin/modemd-ctrl
	@chmod +x $(ROOTFS_DIR)/usr/local/bin/slmodemd
	@chmod +x $(ROOTFS_DIR)/usr/local/bin/d-modem
	@chmod +x $(ROOTFS_DIR)/usr/local/bin/modemd-tunnel
	@chmod +x $(ROOTFS_DIR)/usr/local/bin/modemd-ctrl

	@# glibc
	@cp $(LIBC_DIR)/ld-linux.so.2   $(ROOTFS_DIR)/lib/ld-linux.so.2
	@cp $(LIBC_DIR)/libc.so.6       $(ROOTFS_DIR)/lib/i386-linux-gnu/libc.so.6
	@if [ -f $(LIBC_DIR)/libm.so.6 ]; then \
	  cp $(LIBC_DIR)/libm.so.6 $(ROOTFS_DIR)/lib/i386-linux-gnu/libm.so.6; \
	fi
	@chmod +x $(ROOTFS_DIR)/lib/ld-linux.so.2

	@# Virtio modules
	@for k in $(KMOD_DIR)/virtio*.ko; do \
	  cp "$$k" $(ROOTFS_DIR)/lib/modules/virtio/; \
	done

	@# /etc/hostname
	@printf 'synthmodem-vm-pjsip\n' > $(ROOTFS_DIR)/etc/hostname

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

# ─── Output dirs ────────────────────────────────────────────────────────

$(IMAGES_DIR):
	@mkdir -p $@

# ─── Introspection ──────────────────────────────────────────────────────

.PHONY: inventory
inventory: $(INITRAMFS_PJSIP)
	@echo "Kernel:       $(BZIMAGE_OUT)"
	@ls -lh $(BZIMAGE_OUT) 2>/dev/null | awk '{print "              " $$5 "  " $$NF}'
	@echo "Initramfs:    $(INITRAMFS_PJSIP)"
	@ls -lh $(INITRAMFS_PJSIP)  2>/dev/null | awk '{print "              " $$5 "  " $$NF}'
	@echo "Contents:"
	@zcat $(INITRAMFS_PJSIP) | cpio -t --quiet 2>/dev/null | sort | sed 's/^/  /'

# ─── Cleanup ────────────────────────────────────────────────────────────

.PHONY: clean
clean:
	@rm -rf $(ROOTFS_DIR) $(IMAGES_DIR)
	@$(MAKE) -C $(SLMODEMD_SRC) clean 2>/dev/null || true

.PHONY: distclean
distclean: clean
	@rm -rf $(VM_DIR)/kernel/bzImage $(VM_DIR)/kernel/modules \
	        $(VM_DIR)/kernel/config $(VM_DIR)/kernel/System.map \
	        $(VM_DIR)/busybox/busybox \
	        $(VM_DIR)/libc/*.so.*
	@echo "distclean: extracted binaries removed. Run scripts/fetch-vm-binaries.sh to refetch."
