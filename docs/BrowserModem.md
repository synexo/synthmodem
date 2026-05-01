# BrowserModem — Design & Build Plan

**Goal:** extend SynthModem (currently a SIP-to-telnet gateway that talks to real hardware modems over a phone line) with a second entry point: a browser that emulates a dial-up modem in pure JavaScript, streaming its computed PCMU audio bytes over a WebSocket to a variant of the SynthModem server which terminates the modem call and bridges to a telnet backend. The SynthDoor web terminal provides the visible UI once the data phase begins.

The user experience, end to end:

1. User opens `https://synthdoor.example.com/modem.html` in a browser
2. User clicks **DIAL** and picks a protocol (V.21, Bell 103, V.22)
3. Browser renders the full SynthDoor CP437/ANSI terminal; status area shows `DIALING... HANDSHAKING... CONNECT 1200`
4. Behind the scenes: browser is computing PCMU modem audio, streaming bytes over a WebSocket; server is demodulating those bytes through the same handshake engine that handles SIP calls; after training completes, the browser is a dumb byte pipe for a telnet session
5. User types, sees ANSI, feels like it's 1993

No SIP, no WebRTC, no real audio ever plays (optionally, at start of call, the browser can pipe its own TX audio through Web Audio for nostalgia).

---

## Current state

### SynthModem (server)
- Node.js process, SIP server on 192.168.1.148:5060, RTP ports 10000-10100
- Incoming SIP INVITE → `CallSession` → `ModemDSP` → `Handshake` (V.8/forced protocol) → protocol-specific `V21`/`Bell103`/`V22`/`V22bis`/`V32bis` → telnet gateway
- Live-verified protocols: V.21 ✓, Bell 103 ✓, V.22 ✓, V.22bis ✓
- V.32bis: close but failing at R1 (open investigation)
- Audio pipeline: PCMU RTP packets in → μ-law decode → Float32 at 8 kHz → DSP → demodulated bytes → telnet; and the reverse on TX

### Pure-JS modem (file `V22_js.PUREJS` + equivalents for V.21 and Bell 103)
- Developed in earlier sessions as pure-JS references
- V.21 and Bell 103 confirmed working in prior testing
- V.22 working for 1200 bps after the handshake fixes made this session
- V.22bis answer-side only; call-side is TODO
- Clean public API matching `V22Base`: `generateAudio(n)`, `receiveAudio(samples)`, `write(bytes)`, events `data`/`ready`/`remote-detected`/`listening`
- Only Node.js-specific bits: `require('events')`, `Buffer`, `process.env.V32_DEBUG`, `process.stderr.write`, and an internal `require('../Primitives')` for `TWO_PI` and `BiquadFilter`

### SynthDoor web terminal (client)
- ES-module browser app: `App` → `Terminal` → `Renderer` (canvas) → `ANSIParser` → `TelnetFilter`
- Transport layer: `WSConnection` with `sendBytes(Uint8Array)` / `sendString(str)` and `onData(bytes)`/`onStatus(state,label)` callbacks
- `Terminal.onSend` keystroke output → `WSConnection.sendString`; `TelnetFilter.onSend` IAC replies → `WSConnection.sendBytes`
- Uses `ANSIMusic` via Web Audio API for ANSI music (so Web Audio integration pattern is already established)
- CP437 glyphs, full ANSI, scrollback, URL detection, iCE colors, mobile toolbar

### Existing SynthDoor telnet server
- Node.js TelnetTransport accepts TCP connections on its own port, runs `runSession()` with a `TelnetFilterStream`, hands to SynthDoor Terminal engine
- The ModemTelnetProxy (new component we're building) will terminate the modem call and then proxy to this existing telnet server

---

## Target architecture

```
┌──────────────────────────────────────┐           ┌──────────────────────────────────────┐
│         BROWSER                       │           │         SERVER                        │
│                                       │           │                                       │
│  SynthDoor Terminal UI                │           │  ModemTelnetProxy (Node.js)           │
│  (Terminal/Renderer/ANSIParser)       │           │                                       │
│     ▲ text bytes           │ keys     │           │                ▲ bytes        │ bytes │
│     │                      ▼          │           │                │               ▼      │
│  TelnetFilter ◄──────► TelnetFilter   │           │  TelnetGateway ◄──►  Existing telnet   │
│  (IAC negotiation)                    │           │  (runs telnet session →              │
│     ▲ bytes                │ bytes    │           │   SynthDoor engine)                   │
│     │                      ▼          │           │                ▲               │      │
│  ModemRX            ModemTX           │           │                │               ▼      │
│  (QAMDemodulator/   (QAMModulator/    │           │  Handshake engine (unchanged)         │
│   FSKDemod)          FSKMod)          │           │     ▲ audio Float32   │ audio Float32 │
│     ▲ PCMU bytes           │ PCMU     │           │     │                  ▼               │
│     │                      ▼          │           │  μ-law codec          μ-law codec    │
│  μ-law codec        μ-law codec       │           │     ▲ μ-law bytes    │ μ-law bytes   │
│     ▲ bytes                │ bytes    │           │     │                 ▼                │
│     │                      ▼          │           │  WSModemTransport                     │
│  WSConnection.onData  sendBytes       │           │  (wraps ws library)                   │
│     ▲                      │          │           │     ▲                 │                │
│     └─────── WebSocket ────┴──────────┼───────────┼─────┘                 ▼                │
│      (binary frames, μ-law bytes)                 │                                       │
└──────────────────────────────────────┘           └──────────────────────────────────────┘
```

**Wire format:** every WebSocket binary frame is **exactly 160 bytes of μ-law PCMU samples** (one 20 ms RTP-equivalent chunk). Fifty frames per second in each direction. That's 64 kbit/s peak per direction with WebSocket framing overhead adding negligibly. No JSON, no RTP headers, no sequence numbers in v1. TCP handles ordering and reliability.

**Control channel:** a single control message at the very start of each session, before any audio. Option A: first WebSocket frame of the session is a text frame (`ws.send(JSON.stringify({proto: 'V21'}))`), and all subsequent binary frames are audio. Option B: a separate "control" WebSocket on a different URL path. Go with Option A — simpler, fewer connections, browser's `ws.binaryType` doesn't change what kind of frames it *sends*, only what it *receives*.

**Server routing:** the server listens on ws://host:PORT/modem. Browser connects, sends `{proto:'V21'}`, server instantiates a `ModemTelnetProxy` session which wraps the existing `Handshake` machinery in a fake `CallSession` that reads/writes to the WebSocket instead of RTP.

---

## What maps to what

| SynthModem SIP path | BrowserModem WebSocket path |
|--------------------|----------------------------|
| `SipServer` receives INVITE | `ws.on('connection')` receives connection |
| `SipDialog` transitions EARLY → CONFIRMED | First control frame arrives → session active |
| `RTP` socket, port 10000+ | `WebSocket.on('message')` with binary data |
| PCMU μ-law samples in RTP payload | PCMU μ-law samples in WS binary frame |
| `ModemDSP` starts | `ModemDSP` starts (unchanged) |
| `Handshake` with `--force-proto V21` etc. | `Handshake` with protocol from control frame |
| Hand-off to telnet gateway | Hand-off to telnet gateway (same code) |
| BYE or RTP silence timeout | WebSocket close or audio timeout |

Notice: **`Handshake`, `ModemDSP`, and the telnet gateway never change.** We just add a new transport under the audio layer.

---

## Build phases

### Phase 0: Prep (half a day)

**Decide the directory layout.** The browser modem code will share DSP with the server. Two paths:

1. **Copy approach:** `src/dsp/protocols/V22.js` (pure-JS reference version) lives in the server tree; browser has its own copy under `web/src/modem/V22.js`. Simple, no build tooling needed on the server.
2. **Shared package approach:** factor the DSP into `packages/modem-dsp/` consumed by both the server and the browser via relative imports. Cleaner, but now you need a bundler on the server or an ES-modules-friendly Node version.

Recommend #1 for getting to v1. Accept the duplication. Unify later if it bothers you.

**Confirm protocol choice for v1.** V.21 and Bell 103 are trivially symmetric (call side == answer side with mirror frequencies). V.22 is not — calling side sends 1200 Hz carrier, answers on 2400 Hz; the pure-JS file has an `'answer'` role only, and the V.22bis class explicitly notes `TODO(call-side)`. For v1 target **V.21 and Bell 103 only**; add V.22 in a later phase once the end-to-end path is proven.

### Phase 1: Server-side WSModemTransport (1 day)

Add a WebSocket listener alongside the existing SIP server. When a client connects:

1. Wait for first text frame (control message, JSON with `proto`)
2. Set up a synthetic `CallSession` that connects the WebSocket to a `ModemDSP` instance
3. `ModemDSP` is started with `forceProtocol` from the control frame
4. Each binary WebSocket frame arriving = 160 μ-law bytes = 20 ms of RX audio → decode to Float32 → feed to `ModemDSP.receiveAudio()`
5. On a 20 ms interval (or whenever `ModemDSP.generateAudio()` produces samples), take 160 Float32 samples → μ-law encode → `ws.send(buffer)`

**Concretely, new files:**
- `src/transport/WSModemTransport.js` — the WebSocket server, one per server process
- `src/transport/WSModemSession.js` — per-connection session, owns a `ModemDSP` and the ws handle
- A call into your existing `CallSession`-like code to plumb telnet after handshake completes

**Dependencies:** `npm install ws` if not already present.

**What to reuse unchanged:** `src/dsp/ModemDSP.js`, `src/dsp/Handshake.js`, everything under `src/dsp/protocols/`, the telnet gateway. None of these know or care that the audio source is now a WebSocket.

**μ-law codec:** 30-line lookup table in one direction, ~40 lines the other. Bit-exact reference: ITU G.711. Either implement inline or `npm install mulaw-js`. This codec lives in *both* server (new) and browser (new); identical implementations.

**Timing on server:** the existing pipeline is driven by RTP packet arrival (one packet every 20 ms, real-time). For WebSocket, the *browser* drives the pacing — server processes whatever arrives whenever. Keep a small receive jitter buffer (3-5 frames) so transient browser stalls don't cause underrun in the demodulator. For TX, server runs a `setInterval(20)` to pull audio from the modulator and push to the WebSocket, maintaining the 50 Hz cadence the browser expects.

**Testing:** write a Node.js smoke test that opens a WebSocket, sends binary frames containing pre-computed V.21 "answer carrier + scrambled 1s", verifies the server detects remote carrier and emits the `ready` event. Don't wait for browser to exist before testing this.

### Phase 2: Port pure-JS DSP to the browser (2 days for V.21/Bell103, +3 days for V.22)

The pure-JS files need minor platform adjustments. Create `web/src/modem/` directory:

1. Copy `V22.js` (pure-JS version), `Bell103.js` (pure-JS version), `V21.js` (pure-JS version) into `web/src/modem/`
2. Inline `Primitives.js` dependencies: `TWO_PI` (one constant), `BiquadFilter` (~50 lines if actually used; check whether V.21 and Bell 103 use it at all — they're FSK with Goertzel detection, might not need it)
3. Replace `const { EventEmitter } = require('events')` with a minimal browser-side EventEmitter:

   ```js
   export class EventEmitter {
     constructor() { this._handlers = {}; }
     on(ev, fn) { (this._handlers[ev] ||= []).push(fn); return this; }
     off(ev, fn) { const a = this._handlers[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } return this; }
     emit(ev, ...args) { const a = this._handlers[ev]; if (a) for (const fn of a.slice()) fn(...args); return this; }
   }
   ```

4. Replace `Buffer.from([byte])` with `new Uint8Array([byte])`
5. Replace `process.env.V32_DEBUG` with `globalThis.V32_DEBUG` or a build-time constant
6. Replace `process.stderr.write` with `console.debug`
7. Change `module.exports` to `export`

That's usually it. No bundler required if you're willing to write ES modules by hand; pair with a `<script type="module">` load. If the rest of SynthDoor uses a bundler (Vite, esbuild), slot these files into the same build.

**Call side for V.21 / Bell 103:** symmetric protocols — the only difference between caller and answerer is which frequency pair is TX vs RX. The existing `V21` / `Bell103` classes take a `role` parameter; passing `'call'` flips the frequency assignments. If the pure-JS files currently hardcode `'answer'` behavior, add the frequency-flip logic. ~20 lines.

**Call side for V.22:** this is the real work. §6.3.1.1 of V.22bis defines the caller's handshake:
- Transmit silence (or just nothing) until remote's answer tone heard
- On detecting remote's USB1 (unscrambled binary 1 at 2400 Hz), transmit your own USB1 at 1200 Hz for 100 ± 3 ms minimum
- Detect remote's SB1 (scrambled binary 1), switch to transmitting SB1 yourself for 600 ± 10 ms
- Enter DATA phase

Mostly inversion of the existing answer-side state machine. Budget 2 days of focused work. Test against the pure-JS answer-side running on the server before plugging into the real SynthModem.

### Phase 3: Browser transport layer (1 day)

New files under `web/src/modem/`:

**`mulaw.js`** — identical implementation to server's:
```js
export function linearToMulaw(sample /* -1..1 Float */) { /* G.711 lookup */ }
export function mulawToLinear(byte /* 0..255 */) { /* G.711 lookup */ }
```

**`ModemRX.js`** — wraps the demodulator:
```js
export class ModemRX extends EventEmitter {
  constructor({ protocol, role }) {
    super();
    this._demod = new V21Demodulator({ role });  // or Bell103 or V22
    this._demod.on('data', buf => this.emit('data', buf));
    this._demod.on('ready', info => this.emit('ready', info));
  }
  // Call this with 160-byte μ-law frames as they arrive off the WS
  feedMulawFrame(uint8Array) {
    const floats = new Float32Array(uint8Array.length);
    for (let i = 0; i < uint8Array.length; i++) {
      floats[i] = mulawToLinear(uint8Array[i]);
    }
    this._demod.receiveAudio(floats);
  }
}
```

**`ModemTX.js`** — wraps the modulator with a pacing loop:
```js
export class ModemTX extends EventEmitter {
  constructor({ protocol, role, ws }) {
    super();
    this._mod = new V21Modulator({ role });  // or Bell103 or V22
    this._ws = ws;
    this._interval = null;
  }
  start() {
    // 50 Hz: every 20 ms, generate 160 samples, μ-law encode, send
    this._interval = setInterval(() => {
      const floats = this._mod.generateAudio(160);
      const bytes = new Uint8Array(160);
      for (let i = 0; i < 160; i++) bytes[i] = linearToMulaw(floats[i]);
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(bytes);
      }
    }, 20);
  }
  stop() { clearInterval(this._interval); }
  write(bytes) { this._mod.write(bytes); }
}
```

**`ModemConnection.js`** — the drop-in replacement for `WSConnection`:
```js
export class ModemConnection {
  constructor({ onData, onStatus }) {
    this.onData = onData;
    this.onStatus = onStatus;
    this._ws = null;
    this._rx = null;
    this._tx = null;
    this.connected = false;
  }

  connect(url, protocol = 'V21') {
    this.onStatus('connecting', 'DIALING...');
    this._ws = new WebSocket(url);
    this._ws.binaryType = 'arraybuffer';

    this._ws.onopen = () => {
      // Control frame first
      this._ws.send(JSON.stringify({ proto: protocol }));
      this._rx = new ModemRX({ protocol, role: 'call' });
      this._tx = new ModemTX({ protocol, role: 'call', ws: this._ws });
      this._rx.on('ready', info => {
        this.connected = true;
        this.onStatus('connected', `CONNECT ${info.bps}`);
      });
      this._rx.on('data', buf => this.onData(buf));
      this._tx.start();
      this.onStatus('connecting', 'HANDSHAKING...');
    };

    this._ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return;  // ignore control echoes
      this._rx.feedMulawFrame(new Uint8Array(ev.data));
    };

    this._ws.onclose = () => {
      this.connected = false;
      this._tx?.stop();
      this.onStatus('disconnected', 'NO CARRIER');
    };

    this._ws.onerror = () => this.onStatus('error', 'CONNECTION ERROR');
  }

  disconnect() { this._ws?.close(); }
  sendBytes(bytes) { this._tx?.write(bytes); }
  sendString(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    this._tx?.write(bytes);
  }
}
```

Notice: this has **exactly the same public shape** as the existing `WSConnection` (`connect`, `disconnect`, `sendBytes`, `sendString`, `onData`, `onStatus`, `connected`). The `App` constructor passes it the same way. No other changes in the UI.

### Phase 4: UI wiring (half a day)

Minimal changes to the SynthDoor web terminal:

1. In `App.js`, import `ModemConnection` alongside `WSConnection`
2. Add a protocol selector dropdown to the connect modal: `V21`, `Bell103`, `V22`
3. Based on the selection, instantiate `ModemConnection` or `WSConnection`
4. If `WSURL` starts with `ws://…/modem`, use `ModemConnection`; otherwise `WSConnection`. Or make it explicit with a "MODEM" vs "TELNET" toggle

Add status microcopy. The `onStatus` callback is already rendered to the status bar; just make sure the messages feel right: `DIALING...` → `HANDSHAKING... (V.21 300 BPS)` → `CONNECT 300`.

Optional: flash the `CONNECT` message for a moment with a period character typewriter effect, then reveal the welcome banner from the server. That sells the nostalgia.

### Phase 5: End-to-end wiring and debugging (1-2 days)

The parts will have been smoke-tested individually. Now plug them together and watch it fail in novel ways.

Likely issues:

- **Endianness / byte-order confusion** with ArrayBuffer ↔ Uint8Array on the browser side. Always normalize to `new Uint8Array(event.data)`.
- **μ-law reference mismatch** between browser and server. Use the *same* G.711 reference table on both sides. There are two near-equivalent μ-law variants (one inverts the high bit after encoding and one doesn't). Pick one and make sure both ends agree. Easy to verify: encode `-1.0, 0.0, +1.0` on both and compare the resulting bytes.
- **Timing drift.** `setInterval(20)` in the browser drifts by milliseconds. Over a long call this can accumulate. Not a problem for V.21 (slow, FSK, resilient). Could be for V.22. If symptoms appear — slow degradation of bytes received over many minutes — switch the browser pacing loop to a `performance.now()`-based scheduler, or let the server drive. See "Clock Drift" section below.
- **Sample-count mismatch.** 160 samples at 8 kHz = 20 ms exactly only if your modulator produces samples at exactly 8 kHz. The pure-JS modulator uses its own `_sampleCounter` that increments per generated sample; when called with `generateAudio(160)` it will produce exactly 160 samples of real-time audio. Fine.
- **Bit ordering of UART framing.** The telnet bytes travel through the modem's UART framer: start bit, 8 data bits LSB first, stop bit (or 2). Make sure the browser's modulator's UART matches the server's demodulator's UART. Both come from the same reference file, so they should, but verify with a loopback test: browser sends `"ABCD"`, server receives `"ABCD"` byte-for-byte with no bit shifts.

### Phase 6: Telnet plumbing and final polish (1 day)

The telnet phase is unchanged from the existing SIP path. On the server side, once `ModemDSP` fires `ready` with remote-detected, hand the TX/RX byte pipes to the telnet gateway (your existing SynthDoor backend over TCP, or in-process). On the browser, `TelnetFilter` already handles the IAC negotiation the server sends at connect time.

Final polish items:
- `+++ATH` hangup sequence detection (optional; can also just close the WebSocket)
- Reconnect behavior on disconnect
- Visual indicator of the modem's negotiated speed in the status bar
- "Dial another system" flow that resets terminal and reopens the modem

---

## The listen-to-the-call feature (Phase 7, optional)

After everything works, ~half a day to add a speaker toggle that routes the browser's TX audio through the Web Audio API for authentic dial-up sounds.

The ModemTX already produces Float32 audio at 8 kHz. Normally it's just μ-law-encoded and shipped. To also play it:

```js
class ModemSpeaker {
  constructor() {
    this._ctx = null;
    this._playhead = 0;
    this.enabled = false;
  }
  ensureContext() {
    if (this._ctx) return;
    this._ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
    // Note: modern browsers actually don't let you force 8000 Hz AudioContext
    // on many platforms. Fall back to the native rate and resample — cheapest
    // way is duplicate each sample 5-6x to go from 8k to 48k (ugly but works).
    this._playhead = this._ctx.currentTime + 0.05;
  }
  feed(float32) {
    if (!this.enabled) return;
    this.ensureContext();
    const buf = this._ctx.createBuffer(1, float32.length, 8000);
    buf.getChannelData(0).set(float32);
    const src = this._ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this._ctx.destination);
    src.start(this._playhead);
    this._playhead += float32.length / 8000;
  }
}
```

Hook this into the ModemTX pacing loop: after generating each 160-sample block, if the speaker is enabled, also feed it to `ModemSpeaker.feed()`. The answering side's audio is *not* available in the browser without additional wiring — to hear the remote's answer tones, the server would need to echo back its own TX as a second WebSocket stream. That's more complex; skip for v1.

A button that auto-disables the speaker once handshake completes (`ready` event fires) gives you the Trillian/Netscape Navigator modem-initialization-then-silence experience. Clutch detail.

---

## Design decisions and tradeoffs

### Why 160-byte frames?

Matches the RTP PCMU payload size for 20 ms frames, which is what the rest of SynthModem is built around. 50 Hz. Same cadence as a real SIP call. Lets the server treat WS frames and RTP packets interchangeably downstream.

### Why μ-law and not Float32 or Int16?

Two reasons. First, μ-law is what the server's DSP pipeline already expects — no new codec path. Second, 8-bit μ-law at 50 Hz = 64 kbit/s, which is less bandwidth than 16-bit PCM and comparable to real dial-up toll quality. The μ-law companding gives you ~13-bit effective dynamic range where it matters (quiet signals). Perfectly adequate for 1200 bps modem audio, which is anyway designed for 3 kHz telephone bandwidth.

### Why not send the demodulated bytes directly over WebSocket and skip the audio entirely?

Because then you're not building a modem emulator, you're building a thinly disguised byte tunnel. The whole point of the project is retro authenticity — the user's computer really is computing 8 kHz PCMU audio and really is being demodulated on the other end. The handshake timings, the CONNECT cadence, the optional speaker output, the fallback to lower speeds — all of that depends on actually running the modem DSP end to end. A "just send the bytes" shortcut makes the whole exercise pointless.

### Clock drift handling

The browser's `setInterval(20)` is actually accurate to about ±4 ms per call on modern Chrome but drifts cumulatively. Over a long call (say 30 minutes), this can amount to seconds of offset between browser's sample count and server's real-time consumption.

Three mitigations, in increasing order of sophistication:

1. **Accept it.** For V.21 (FSK, half-duplex, very loss-tolerant), a few dropped frames every hour is invisible. Don't engineer for a problem you don't have.

2. **Browser-absolute-clock pacing.** Replace `setInterval(20)` with a loop driven by `performance.now()`:
   ```js
   const tick = () => {
     const now = performance.now();
     while (this._nextTickAt <= now) {
       this.generateAndSendFrame();
       this._nextTickAt += 20;
     }
     requestAnimationFrame(tick);  // or setTimeout(tick, 4)
   };
   ```
   This eliminates cumulative drift from `setInterval`. Still drifts against server's 8 kHz clock but by orders of magnitude less.

3. **Server-driven pacing, full feedback loop.** Server sends a "feed me" signal every 20 ms; browser generates and sends in response. More complex protocol but rock-solid clock alignment. Overkill for v1.

Go with option 1 for V.21/Bell103, option 2 if V.22 shows symptoms.

### Jitter buffer

On the server RX path, add a small buffer (3-5 frames = 60-100 ms). When the demodulator is hungry for audio and no frame has arrived, feed silence (Float32 zeros). When a burst of frames arrives, they queue. This absorbs browser stalls without upsetting the demodulator's continuous sample expectation.

Server TX is easier — server can generate as much as it wants and the WebSocket buffers naturally.

### Protocol selection UI

Current modal has an input field for the WebSocket URL and a terminal-size dropdown. Add:

```html
<label>
  PROTOCOL:
  <select id="modem-proto">
    <option value="V21">V.21 (300 bps)</option>
    <option value="Bell103">Bell 103 (300 bps, US)</option>
    <option value="V22">V.22 (1200 bps)</option>
  </select>
</label>
<label>
  MODE:
  <select id="conn-mode">
    <option value="telnet">TELNET (direct)</option>
    <option value="modem">MODEM (authentic)</option>
  </select>
</label>
```

When MODE=modem, instantiate `ModemConnection` with the selected protocol. When MODE=telnet, instantiate the existing `WSConnection`. This lets you ship the feature without forcing every user through the modem path.

---

## Testing strategy

### Unit tests (server)
- μ-law codec round-trip correctness against G.711 reference vectors
- WSModemTransport smoke test: open a WebSocket, send control frame, send pre-computed V.21 audio frames, verify `ready` event fires with `remoteDetected: true`

### Unit tests (browser, via jest/vitest with a jsdom/happy-dom environment)
- ModemRX: feed pre-computed μ-law bytes, verify correct demodulated output
- ModemTX: call `write('AB')`, run the pacing loop a few times, verify the generated bytes demodulate back to `"AB"` through a local server-side demodulator

### End-to-end loopback test
- Spin up the Node.js server in-process
- Use `ws` client library from a Node test script to simulate a browser
- Instantiate the pure-JS ModemTX/ModemRX in the same test script
- Drive a full handshake + data transfer, assert bytes arrive correctly
- This catches integration bugs before you're debugging in the browser dev tools

### Manual testing in-browser
- Open browser devtools Network tab, filter to WS, watch binary frames flow
- Console-log demodulator state on both sides
- If handshake fails, capture the full μ-law stream on the server side to a `.wav` file for analysis (same capture machinery SynthModem already has for SIP calls)

### Real-modem interop sanity check (optional but fun)
- Run the server with the browser modem path
- Separately, have a real hardware modem dial in over SIP
- Verify both entry points work. This confirms the server pipeline really is transport-agnostic.

---

## Scope we're explicitly not including

- SIP support (browser-side): not doing it, per decision
- V.22bis, V.32bis from browser: not until V.22 is rock-solid, and V.32bis has its own open signal-integrity bugs
- WebRTC: not applicable; we're not using real microphone audio
- Multi-party calls: one WebSocket = one call = one modem, period
- Federation between servers: a separate design discussion (see earlier chat)
- Authentication: the modem carries raw bytes; any auth happens *inside* the telnet session at SynthDoor's normal login prompt
- Mobile browser support: should work in principle; test on iOS Safari before claiming
- Binary compatibility with real telnet-over-WS SynthDoor clients: yes — they're still supported in parallel, just pick MODE=telnet

---

## Timeline estimate

Sequential, part-time (few hours a day):

- Phase 0 (prep): 0.5 day
- Phase 1 (server WSModemTransport): 1 day
- Phase 2 (browser DSP port, V.21/Bell103 only): 2 days
- Phase 3 (browser transport layer): 1 day
- Phase 4 (UI wiring): 0.5 day
- Phase 5 (end-to-end debug): 1-2 days

**Subtotal for V.21 + Bell 103 at 300 bps: 6-7 days.**

Then for V.22:

- V.22 call-side handshake: 2-3 days
- Integration and debug: 1 day

**Subtotal for adding V.22 at 1200 bps: 3-4 days.**

Then optional:

- Phase 7 speaker: 0.5 day
- Polish, status UI, reconnect flow: 1 day

**Total for the full vision: 2.5 weeks of part-time work.**

If you hit problems — and you will, interop is always like this — add 50% buffer. Realistic calendar: 4 weeks.

---

## Key files this project will touch or add

**New (server):**
- `src/transport/WSModemTransport.js`
- `src/transport/WSModemSession.js`
- `src/util/mulaw.js` (if not already present)

**New (browser):**
- `web/src/modem/V21.js` (port of pure-JS reference)
- `web/src/modem/Bell103.js` (port)
- `web/src/modem/V22.js` (port, with call-side added)
- `web/src/modem/mulaw.js`
- `web/src/modem/ModemRX.js`
- `web/src/modem/ModemTX.js`
- `web/src/modem/ModemConnection.js`
- `web/src/modem/EventEmitter.js` (tiny polyfill)

**Modified (browser):**
- `web/src/app.js` — protocol selector, MODE selector, route to ModemConnection or WSConnection
- Connection modal HTML — new dropdowns
- Status-bar CSS and micro-animation if you want the CONNECT flash

**Unchanged:**
- Everything under `src/dsp/` on the server
- `src/dsp/Handshake.js`
- `src/dsp/ModemDSP.js`
- All existing SIP/RTP code (runs in parallel)
- SynthDoor Terminal/Renderer/ANSIParser/TelnetFilter on browser
- Existing telnet backend

That minimal touch on the existing code is the best sign that this architecture is correct. You're adding a new transport, not refactoring anything.
