# vm/d-modem/

Vendored glue code from the D-Modem project. d-modem.c is a PJSIP
`pjmedia_port` subclass that bridges a PJSIP call to slmodemd's
socketpair. It is the integration layer the `slmodemd-pjsip` backend
relies on.

## Contents

| File         | Purpose |
|--------------|---------|
| `d-modem.c`  | The glue file, vendored verbatim from synexo/D-Modem |
| `Makefile`   | Compiles d-modem.c against slmodemd/modem.h and the in-tree PJSIP install |
| `UPSTREAM.txt` | Pins the D-Modem commit and d-modem.c file SHA256 |

## What the glue does

- Presents a `pjmedia_port` to PJSIP whose `put_frame`/`get_frame`
  forward PCM samples to/from slmodemd's socketpair FD.
- Configures `pjsua_media_config` for modem use: software clock on,
  adaptive jitter buffer off (fixed 40-packet prebuffer), VAD off,
  echo cancellation off.
- Provides a minimal PJSUA2 application entry point that accepts
  inbound SIP, allocates a `dmodem_port`, bridges it into PJMEDIA's
  conference bridge, and hands off to slmodemd.

## Relationship to the rest of the repo

- `vm/slmodemd/` — slmodemd source (separate upstream, also vendored)
- `vm/pjsip/`    — PJSIP build customization (tarball in vm/sources/)
- `vm/shim/`     — the legacy shim used by the `slmodemd` backend; still
                    ships, still works, unrelated to d-modem.c
- `vm/prebuilt/` — where the built `d-modem` binary lands after a VM build

See `UPSTREAM.txt` for the pinned commit and the licensing notes.
