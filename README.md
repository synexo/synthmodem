# SynthModem

A software modem-to-Telnet gateway that accepts inbound calls from a SIP gateway connected to a real PSTN modem, negotiates the modem handshake in software, and presents the caller with a Telnet terminal proxy.

```
Physical Modem ──► SIP Gateway ──► SynthModem ──► Telnet Host
  (e.g. V.34)      (e.g. SPA2102)   (this software)   (TCP)
```

All modem DSP (modulation, demodulation, carrier recovery, timing) is implemented in Node.js. V.21 is implemented in pure JavaScript. V.22 and V.22bis are implemented via a compiled native addon (`src/native/`) that wraps a vendored subset of [SpanDSP](https://github.com/freeswitch/spandsp) — no external DSP library is required at runtime; SpanDSP sources are vendored into this repository and built as part of `npm install`.

---

## Features

- **SIP server** — UDP and TCP, handles INVITE / ACK / BYE / CANCEL / OPTIONS
- **RTP audio** — G.711 µ-law (PCMU) and A-law (PCMA), jitter buffer
- **Modem protocols** — V.21 (300 bps, JavaScript), V.22 (1200 bps, native), V.22bis (2400 bps, native), V.23 (1200/75 bps), V.32bis (14400 bps), V.34 (14400 bps cap)
- **V.8 negotiation** — ANSam tone, CI/JM/CM exchange, automatic protocol selection
- **Telnet proxy** — terminal menu, host:port input, bidirectional TCP proxy, Telnet option negotiation (ECHO, SGA, NAWS, TTYPE)
- **Test client** — SIP UAC + virtual originating modem + optional speaker audio output
- **Centralized config** — every tuneable parameter in one file (`config.js`)

---

## Requirements

- Node.js 16 or later
- C/C++ compiler (required for `npm install` to build the V.22/V.22bis native addon):
  - **Linux**: `sudo apt install build-essential`
  - **macOS**: Xcode command-line tools (`xcode-select --install`)
  - **Windows**: Visual Studio Build Tools (C++ workload)
- Optional: `speaker` npm package for audio output in the test client

---

## Installation

```bash
git clone <repo>
cd synthmodem
npm install
```

To enable audio output in the test client:

```bash
npm install speaker
```

> `speaker` requires native build tools (`node-gyp`, a C compiler, and PortAudio headers).
> On Linux: `sudo apt install portaudio19-dev`
> On macOS: `brew install portaudio`
> On Windows: install the Windows Build Tools and PortAudio.

---

## Quick Start

### 1. Start the server

```bash
node src/index.js
```

The server listens on `0.0.0.0:5060` (UDP and TCP) by default.

### 2. Run the test client (same machine)

```bash
node test-client/index.js
```

With audio output:

```bash
node test-client/index.js --audio
```

Force a specific protocol (skip V.8 negotiation):

```bash
node test-client/index.js --proto V22bis
```

Auto-connect to a Telnet host after handshake:

```bash
node test-client/index.js --auto
# Uses config.testClient.autoConnect address
```

### 3. Connect a real modem via SIP gateway

Configure your SIP gateway (e.g. Cisco SPA2102, Grandstream HT series) to forward calls to SynthModem's IP:5060. See [SIP Gateway Setup](#sip-gateway-setup) below.

---

## Test Client Options

```
node test-client/index.js [options]

  --audio           Enable speaker audio output (requires 'speaker' package)
  --volume <n>      Audio output volume 0.0–1.0  (default: 0.8)
  --proto  <name>   Force protocol: V21 V22 V22bis V23 V32bis V34
  --auto            Auto-connect to address in config.testClient.autoConnect
  --server <host>   Override SIP server host
  --port   <port>   Override SIP server SIP port
  --verbose         Enable trace-level logging
  --help            Show help
```

---

## Configuration

All configuration is in **`config.js`** at the project root. The file is extensively commented. Key sections:

### SIP (`config.sip`)

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `0.0.0.0` | Bind address |
| `port` | `5060` | SIP port (UDP and TCP) |
| `publicHost` | `127.0.0.1` | **Set this to your external IP** if behind NAT |
| `domain` | `synthmodem.local` | SIP domain in headers |
| `ackTimeoutMs` | `5000` | Time to wait for ACK before giving up |
| `rtpTimeoutMs` | `30000` | RTP silence before declaring call dead |

> **Important:** Set `publicHost` to the IP address visible to your SIP gateway. If SynthModem and the gateway are on the same LAN, use the LAN IP.

### RTP (`config.rtp`)

| Key | Default | Description |
|-----|---------|-------------|
| `portMin` / `portMax` | `10000` / `10100` | UDP port range for RTP sessions |
| `packetIntervalMs` | `20` | RTP packetisation interval |
| `jitterBufferPackets` | `4` | Jitter buffer depth |
| `preferredCodecs` | PCMU, PCMA, L16 | Codec preference order |

### Modem DSP (`config.modem`)

| Key | Default | Description |
|-----|---------|-------------|
| `role` | `answer` | `answer` (server) or `originate` (test client) |
| `protocolPreference` | `[V34, V32bis, V22bis, V22, V21]` | Negotiation order, highest first |
| `forceProtocol` | `null` | Force a specific protocol, bypassing V.8 |
| `answerToneDelayMs` | `1000` | Delay before sending ANS tone |
| `answerToneDurationMs` | `3300` | ANS/ANSam tone duration |
| `useANSam` | `true` | Send ANSam (V.8 capable) vs plain ANS |
| `enableV8` | `true` | Enable V.8 protocol negotiation |
| `v8HandshakeTimeoutMs` | `5000` | V.8 timeout before fallback |
| `agcEnabled` | `true` | Automatic Gain Control on RX audio |
| `silenceHangupPackets` | `150` | Silent packets (×20ms = 3s) before hangup |

#### Per-protocol carrier frequencies (`config.modem.carriers`)

These match ITU-T specs but can be adjusted for gateway quirks:

```js
V21: {
  ch1Mark: 1280, ch1Space: 1080,   // originating modem
  ch2Mark: 2100, ch2Space: 1750,   // answering modem
},
V22:    { origCarrier: 1200, answerCarrier: 2400 },
V22bis: { origCarrier: 1200, answerCarrier: 2400 },
V23:    { forwardMark: 1300, forwardSpace: 2100,
          backwardMark: 390, backwardSpace: 450 },
V32bis: { carrier: 1800 },
V34:    { carrier: 1800, symbolRate: 2400 },
```

### Telnet (`config.telnet`)

| Key | Default | Description |
|-----|---------|-------------|
| `connectTimeoutMs` | `10000` | TCP connect timeout |
| `idleTimeoutMs` | `300000` | Idle disconnect (0 = disabled) |
| `negotiateOptions` | `true` | Send IAC WILL ECHO etc. |
| `terminalType` | `VT100` | TTYPE advertised |
| `terminalCols` / `Rows` | `80` / `24` | NAWS terminal dimensions |
| `allowedHosts` | `[]` | Allowlist (empty = allow all) |
| `blockedHosts` | `[169.254.169.254]` | Blocklist |

### Terminal UI (`config.terminal`)

| Key | Default | Description |
|-----|---------|-------------|
| `banner` | (see config) | Text shown after modem connects |
| `prompt` | `CONNECT> ` | Input prompt |
| `defaultPort` | `23` | Default Telnet port |
| `localEcho` | `true` | Echo typed characters |
| `lineEnding` | `\r\n` | Line terminator sent to modem |

### Logging (`config.logging`)

| Key | Default | Description |
|-----|---------|-------------|
| `level` | `debug` | `error` `warn` `info` `debug` `trace` |
| `logSipMessages` | `true` | Log SIP message content |
| `logRtpPackets` | `false` | Log every RTP packet (very verbose) |
| `logDspState` | `true` | Log DSP state transitions |
| `logModemData` | `false` | Log raw modem data bytes (hex) |
| `colorize` | `true` | ANSI colour output |

---

## SIP Gateway Setup

### Cisco SPA2102 / SPA112 / PAP2T

1. Log into the gateway web UI (default `http://192.168.0.1`)
2. Go to **PSTN Line** (or **Line 1** if modem is on FXS port)
3. Under **Proxy and Registration**:
   - **Proxy**: `<SynthModem IP>`
   - **Proxy Port**: `5060`
4. Under **Dial Plan**, add a rule to forward all calls:
   ```
   (*xx|[3469]11|0|00|[2-9]xxxxxx|1xxx[2-9]xxxxxxS0|xxxxxxxxxxxx.)
   ```
   Or simply use `(S0<:synthmodem@<IP>>)` to forward all calls immediately.
5. Under **Audio**:
   - **Preferred Codec**: G711u (PCMU) or G711a (PCMA)
   - Disable all compressed codecs (G.729, G.726, iLBC)
   - **Echo Canc Enable**: **No** — critical for modem audio
   - **Silence Supp Enable**: **No** — critical, must be disabled
   - **VAD Enable**: **No**
6. Save and reboot the gateway.

### Grandstream HT701/HT801/HT802

1. Go to **FXS Port** settings
2. **SIP Server**: `<SynthModem IP>`
3. **SIP Destination Port**: `5060`
4. **Preferred Vocoder**: PCMU
5. **Echo Cancellation**: Off
6. **Silence Suppression**: Off
7. **VAD**: Off

### Critical Gateway Settings (all brands)

| Setting | Required Value | Why |
|---------|---------------|-----|
| Echo cancellation | **OFF** | EC corrupts modem tones |
| Silence suppression / VAD | **OFF** | Will clip training sequences |
| Comfort noise | **OFF** | Adds noise to modem signal |
| Codec | **G.711 µ-law or A-law only** | Modem DSP assumes 8kHz PCM |
| Jitter buffer | Adaptive, 60–80ms | Smooth out packet delay variation |
| DTMF mode | RFC 2833 (not in-band) | Prevents DTMF detection mangling modem tones |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SynthModem                              │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                      SipServer                           │  │
│  │   UDP:5060 + TCP:5060  ·  INVITE/ACK/BYE/CANCEL/OPTIONS  │  │
│  └───────────────────────────┬──────────────────────────────┘  │
│                              │ emits: invite, ack, bye          │
│  ┌───────────────────────────▼──────────────────────────────┐  │
│  │                     CallSession                           │  │
│  │   owns SipDialog · RtpSession · ModemDSP · TelnetProxy   │  │
│  └──────┬──────────────────┬──────────────────┬─────────────┘  │
│         │                  │                  │                 │
│  ┌──────▼──────┐   ┌───────▼──────┐   ┌──────▼──────────────┐ │
│  │ RtpSession  │   │   ModemDSP   │   │    TelnetProxy       │ │
│  │             │   │              │   │                      │ │
│  │ UDP socket  │◄──│ HandshakeEng │◄──│ Terminal menu        │ │
│  │ Jitter buf  │   │ V21-V34 DSP  │   │ host:port input      │ │
│  │ G.711 codec │──►│ AGC · EQ     │──►│ TCP proxy            │ │
│  └─────────────┘   └──────────────┘   │ Telnet negotiation   │ │
│                                        └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### DSP Signal Path

```
RTP packet (G.711)
    │
    ▼ Codec.decode()
Float32Array @ 8kHz
    │
    ▼ AGC.process()
Normalised audio
    │
    ▼ HandshakeEngine.receiveAudio()
    │
    ├─[IDLE/ANS/V8]──► Tone detectors (Goertzel)
    │                    CI detection · ANSam detection
    │
    └─[DATA]──────────► Protocol demodulator
                         BandpassFilter → EnvelopeDetect → UART  (V.21/V.23)
                         CostasLoop → LPF → LMSEqualizer → QAM   (V.22/V.22bis)
                         GardnerTiming → 64-QAM slicer            (V.32bis/V.34)
                              │
                              ▼
                         Descrambler (1 + x⁻¹⁸ + x⁻²³)
                              │
                              ▼
                         Decoded bytes → TelnetProxy
```

### Modem Protocols

| Protocol | Modulation | Baud | Bits/sym | Speed |
|----------|-----------|------|----------|-------|
| V.21 | FSK | 300 | 1 | 300 bps |
| V.22 | DPSK | 600 | 2 | 1200 bps |
| V.22bis | 16-QAM | 600 | 4 | 2400 bps |
| V.23 | FSK | 1200/75 | 1 | 1200/75 bps |
| V.32bis | 64-QAM | 2400 | 6 | 14400 bps |
| V.34 | 64-QAM¹ | 2400 | 6 | 14400 bps |

¹ V.34 uses correct Phase 1–4 handshake signalling with INFO0, S-sequence, and PRBS training, but uses the same 64-QAM data plane as V.32bis. This is intentional — the 8kHz RTP channel limits practical throughput to ~14.4 kbps regardless.

---

## Modem Handshake Flow (Answer Mode)

```
Call arrives (SIP INVITE)
    │
    ▼ 100 Trying → 180 Ringing → 200 OK (with SDP)
    │
    ▼ ACK received
    │
Wait answerToneDelayMs (1000ms default)
    │
    ▼ Send ANSam (2100 Hz with 450ms phase reversals, 3.3s)
    │
    ▼ Wait for CI from originating modem
    │
    ├─[CI detected]──► Send JM (Joint Menu, V.8)
    │                   Wait for CM response
    │                   Select highest common protocol
    │
    └─[timeout]──────► Fall back to highest protocol in preference list
    │
    ▼ Protocol training (100ms–1500ms depending on protocol)
    │
    ▼ Data mode — TelnetProxy attached
    │
    ▼ User sees banner and CONNECT> prompt
```

---

## Troubleshooting

### No audio / modem won't connect

1. **Check RTP reaches SynthModem**: Run `node src/index.js` with `logging.logRtpPackets: true` in config. You should see `RTP ←` lines when the call is active.

2. **Echo cancellation**: Verify it is **completely disabled** on the gateway. This is the most common cause of failed handshakes.

3. **Codec mismatch**: Ensure the gateway is using G.711 only. Set `logging.logSipMessages: true` and inspect the SDP offer — look for `m=audio` and `a=rtpmap` lines.

4. **NAT / firewall**: Ensure UDP ports 10000–10100 (RTP range) are reachable from the gateway. Set `config.sip.publicHost` to the correct IP.

### Modem connects but data is corrupt

1. Try forcing a lower protocol: `config.modem.forceProtocol: 'V22bis'` or `'V21'`.

2. Enable `logging.logModemData: true` to see decoded bytes.

3. Increase jitter buffer: `config.rtp.jitterBufferPackets: 8`.

4. Check for VAD / silence suppression — even a single dropped packet during training will corrupt the session.

5. Reduce carrier tolerance: some gateways apply slight pitch shifting. Try `config.modem.carrierToleranceHz: 25`.

### V.8 negotiation fails / falls back to V.21

1. Set `config.modem.forceProtocol: 'V22bis'` to bypass V.8 and test data transfer directly.

2. Try `config.modem.useANSam: false` for older modems that don't support V.8.

3. Increase `v8HandshakeTimeoutMs` to `10000` for slow gateways.

### Test client won't connect

1. Ensure the server is running: `node src/index.js`

2. Check ports aren't blocked: `netstat -uln | grep 5060`

3. Try TCP transport: set `config.testClient.serverTransport: 'tcp'`

4. If both client and server are on the same machine, `publicHost` should be `127.0.0.1` (the default).

### Audio output not working (test client)

```bash
npm install speaker
```

If the build fails, you need PortAudio development headers:
- **Ubuntu/Debian**: `sudo apt install portaudio19-dev build-essential`
- **macOS**: `brew install portaudio`
- **Windows**: Install Visual Studio Build Tools and `vcpkg install portaudio`

---

## Project Structure

```
synthmodem/
├── config.js                    # ← All configuration here
├── package.json
├── src/
│   ├── index.js                 # Server entry point
│   ├── logger.js                # Levelled, colourised logger
│   ├── sip/
│   │   ├── SipParser.js         # SIP message parse/serialise + SDP
│   │   ├── SipDialog.js         # Dialog state machine
│   │   └── SipServer.js         # UDP+TCP SIP server
│   ├── rtp/
│   │   ├── Codec.js             # G.711 µ-law, A-law, L16
│   │   └── RtpSession.js        # RTP send/receive, jitter buffer
│   ├── dsp/
│   │   ├── Primitives.js        # NCO, filters, AGC, Costas, Gardner, LMS
│   │   ├── Handshake.js         # V.8 negotiation, ANSam, protocol selection
│   │   ├── ModemDSP.js          # Top-level DSP coordinator
│   │   └── protocols/
│   │       ├── V21.js           # 300 bps FSK
│   │       ├── V22.js           # 1200 / 2400 bps DPSK + QAM
│   │       ├── V32bis.js        # V.23 + 14400 bps 64-QAM
│   │       └── V34.js           # V.34 shell + 14400 bps data plane
│   ├── session/
│   │   └── CallSession.js       # Wires SIP + RTP + DSP + Telnet
│   └── telnet/
│       └── TelnetProxy.js       # Terminal UI + TCP proxy
└── test-client/
    ├── index.js                 # Test client entry point
    ├── SipClient.js             # SIP UAC (outbound calls)
    ├── ModemEmulator.js         # Virtual originating modem
    └── AudioOutput.js           # Speaker output (optional)
```

---

## Extending SynthModem

### Adding a new modem protocol

1. Create `src/dsp/protocols/VXX.js` with a class that:
   - Extends `EventEmitter`
   - Has `write(buf)`, `generateAudio(n)`, `receiveAudio(samples)` methods
   - Emits `'data'` with decoded `Buffer`
   - Has `get name()` and `get bps()` getters

2. Register it in `src/dsp/Handshake.js`:
   ```js
   const PROTOCOLS = {
     // ...existing...
     VXX: (role) => new VXX(role),
   };
   ```

3. Add it to `config.modem.protocolPreference` and `config.modem.trainingDurationMs`.

### Supporting multiple simultaneous sessions

`src/session/CallSession.js` is already designed as a self-contained object. In `src/index.js`, replace the single `activeSession` variable with a `Map<callId, CallSession>` and remove the busy-reject logic in the SIP server.

### Adding a registrar

The SIP server already responds 200 OK to REGISTER. To track registrations, add a `Map` in `SipServer.js` and populate it in `_handleRegister()`.

---

## Licence

MIT
