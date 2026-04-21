# Spandsp local patches

This folder documents the changes we've applied to the vendored spandsp
tree under `../spandsp/`. Each patch is also already applied to the
in-tree source — these are here so that if we ever re-import upstream
spandsp, we know what to re-apply.

## 0001-v22bis-power-meter-averaging-shift.patch

Fixes V.22 training failure on real modem audio. Increases the RX power
meter averaging shift from 5 (~4ms) to 9 (~64ms) so the carrier-present
detector doesn't spuriously oscillate within its hysteresis band and
call `v22bis_restart()` many times per second.

Without this patch, V.22 training never completes — TX goes silent
within 600ms of first signaling and the modem emits hundreds of
CARRIER_UP/CARRIER_DOWN events per second.

File: `spandsp/src/v22bis_rx.c`, one line changed inside
`v22bis_rx_restart()`.
