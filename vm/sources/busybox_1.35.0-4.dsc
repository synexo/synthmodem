-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

Format: 3.0 (quilt)
Source: busybox
Binary: busybox, busybox-static, busybox-udeb, busybox-syslogd, udhcpc, udhcpd
Architecture: any all
Version: 1:1.35.0-4
Maintainer: Debian Install System Team <debian-boot@lists.debian.org>
Uploaders:  Chris Boot <bootc@debian.org>, Christoph Biedl <debian.axhn@manchmal.in-ulm.de>, Michael Tokarev <mjt@tls.msk.ru>,
Homepage: http://www.busybox.net
Standards-Version: 4.1.5
Vcs-Browser: https://salsa.debian.org/installer-team/busybox
Vcs-Git: https://salsa.debian.org/installer-team/busybox.git
Build-Depends: debhelper-compat (= 13), zip <!nocheck>
Package-List:
 busybox deb utils optional arch=any
 busybox-static deb shells optional arch=any
 busybox-syslogd deb utils optional arch=all
 busybox-udeb udeb debian-installer optional arch=any
 udhcpc deb net optional arch=linux-any
 udhcpd deb net optional arch=linux-any
Checksums-Sha1:
 36a1766206c8148bc06aca4e1f134016d40912d0 2480624 busybox_1.35.0.orig.tar.bz2
 cd8bb620dd7002707db78d3bd6b9063cb96c2921 63160 busybox_1.35.0-4.debian.tar.xz
Checksums-Sha256:
 faeeb244c35a348a334f4a59e44626ee870fb07b6884d68c10ae8bc19f83a694 2480624 busybox_1.35.0.orig.tar.bz2
 d611281ea49cfac240a5dfdb0de6f440138e3345490e087d8e39b7434a6bd819 63160 busybox_1.35.0-4.debian.tar.xz
Files:
 585949b1dd4292b604b7d199866e9913 2480624 busybox_1.35.0.orig.tar.bz2
 304c168d4268bd06a9d42bb8aee0f1d4 63160 busybox_1.35.0-4.debian.tar.xz

-----BEGIN PGP SIGNATURE-----

iQFDBAEBCAAtFiEEe3O61ovnosKJMUsicBtPaxppPlkFAmNncJgPHG1qdEB0bHMu
bXNrLnJ1AAoJEHAbT2saaT5ZBigH/2n/wpSt20sO3xp2AsQCJoNUrjpvPahYEC7F
rS99xy/7J5gYp33s2mKJD5emcxIMjl04O5t5Yy9XU664TZ9r/wpuLsTrhWScxk6h
xk8DSaV4ug40oDzsBxVt3RF0aD63d+MLhLolPl3VkJyE2gJxHsstN70L556o3Dxy
14afLAhKU2mz/PLX59+ldyyMWQSuAzyjJXA3ekQ1uoN6aF40X9i7Ce+nnA1xVRwl
dhg40+Ztx3zyk8j0VEYhRhwNTnkdoFhmec4+HTodBIRqxeARunP8Nj6CIJOG7N9R
PTYRwOjAyhkZPp77fEkZsfc/vtzA2tnlpWyn6yXXLCVEi/D0USY=
=+YS7
-----END PGP SIGNATURE-----
