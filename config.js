'use strict';

/**
 * SynthModem Central Configuration
 * All tuneable parameters live here. Restart required after changes unless noted.
 *
 * ─────────────────────────────────────────────────────────────────────
 * NAVIGATION
 * ─────────────────────────────────────────────────────────────────────
 * The COMMON CONFIG block immediately below collects the settings most
 * users edit. Every entry there is the single source of truth — the
 * sections further down (sip, modem, etc.) reference these constants
 * rather than duplicating values.
 *
 * For fine-grained tuning, edit the relevant section further down.
 * Each section is heavily commented in-file.
 *
 * Sections (in file order):
 *   sip           — SIP server bind address, ports, NAT
 *   rtp           — RTP port range, jitter buffer, codec preference
 *   modem         — backend selection + per-backend tuning
 *   telnet        — TCP target, connection policy
 *   terminal      — banner, menus, idle timing
 *   logging       — host-side log level and feature toggles
 *   testClient    — settings used only by test-client/index.js
 */

// ═════════════════════════════════════════════════════════════════════
//  COMMON CONFIG — most users only edit these
// ═════════════════════════════════════════════════════════════════════
//
// These are referenced by name from the structured sections below.
// Editing here changes the value everywhere it's used.

// ── Network ──────────────────────────────────────────────────────────
const HOST          = '0.0.0.0';         // interface to bind on; '0.0.0.0' = all interfaces
const PUBLIC_HOST   = '';                // IP advertised in SIP Via/Contact and SDP. Empty = auto-resolve per call (recommended); set to a specific IP only if you need to pin behind NAT/SBC. See `sip.publicHost` below for the resolution chain.
const SIP_PORT      = 5060;              // SIP UDP/TCP port (5060 is standard)

// ── Modem backend selection ──────────────────────────────────────────
const BACKEND       = 'auto';  // 'native' | 'slmodemd-pjsip' | 'auto'   (see modem.* section for details)
const ROLE          = 'answer';          // 'answer' | 'originate' // This is the virtual Modem role, opposite of your dialing modem.

// ── slmodemd-pjsip — only relevant when BACKEND === 'slmodemd-pjsip' ─
// (For BACKEND === 'native' tuning, see modem.native.* further down.)
const QEMU_PATH     = '.\\win\\qemu\\qemu-system-i386.exe';   // null on Linux/macOS to use $PATH or $QEMU_SYSTEM_I386
const VM_ACCEL      = null;              // 'kvm' (Linux), 'hvf' (macOS), 'whpx' (Windows), 'tcg' (any), null = autodetect
const AT_INIT       = ['AT&E0'];  // pre-ATA AT command sequence; [''] for slmodemd defaults
const AUDIO_PORT    = 25800;             // host TCP port for guest's RTP tunnel — change only on conflict
const CONTROL_PORT  = 25801;             // host TCP port for guest's control tunnel — change only on conflict

// ── Diagnostics ──────────────────────────────────────────────────────
const LOG_LEVEL          = 'info';                              // host-side log level: 'error' | 'warn' | 'info' | 'debug' | 'trace'
const GUEST_LOG_LEVEL    = 'debug';                               // guest-side log level for slmodemd-pjsip helpers
const CAPTURE_AUDIO      = false;                                  // per-call WAV capture (native backend; slmodemd-pjsip support is Phase 4-5 work)
const BOOT_LOG_PATH      = '';        // QEMU stdout/stderr → file; null to disable

// ═════════════════════════════════════════════════════════════════════
//  STRUCTURED CONFIG — full settings, organized by section
// ═════════════════════════════════════════════════════════════════════

module.exports = {


  // ─────────────────────────────────────────────────────────────────────────────
  // SIP SERVER
  // ─────────────────────────────────────────────────────────────────────────────
  sip: {
    // Interface to bind. '0.0.0.0' listens on all interfaces.
    host: HOST,

    // UDP and TCP SIP port (standard is 5060)
    port: SIP_PORT,

    // IP advertised in SIP Via/Contact and SDP `c=` lines. The caller
    // sends RTP to whatever IP appears in our SDP, so this must be
    // reachable FROM THE CALLER (not just locally bound).
    //
    // Default: empty string ('') — auto-resolved per call:
    //   1. Per-call subnet match: pick the local interface whose IPv4
    //      subnet contains the caller's source IP. Correct in nearly
    //      every multi-NIC LAN deployment.
    //   2. First non-loopback IPv4: when no interface matches, use
    //      the first non-internal IPv4 (sorted by interface name for
    //      determinism). Logged at WARN per call so the operator
    //      knows the heuristic kicked in.
    //   3. 127.0.0.1: only when no non-loopback IPv4 exists at all.
    //      Logged at WARN; works for loopback testing only.
    //
    // Set this to a specific IP string to bypass auto-resolution —
    // useful behind NAT or an SBC where the externally-visible IP
    // doesn't match any local interface. See PublicHostResolver for
    // implementation details.
    publicHost: PUBLIC_HOST,

    // Domain used in From/To headers for generated responses
    domain: 'synthmodem.local',

    // SIP User-Agent string sent in responses
    userAgent: 'SynthModem/1.0',

    // How long (ms) to wait for ACK after sending 200 OK before giving up
    ackTimeoutMs: 5000,

    // How long (ms) of silence on RTP before considering the call dead
    rtpTimeoutMs: 30000,

    // Re-INVITE / re-negotiation: accept or reject
    acceptReInvite: true,

    // SIP OPTIONS keepalive: respond to OPTIONS pings
    respondToOptions: true,

    // Maximum simultaneous SIP dialogs tracked (even if only one is active)
    maxDialogs: 8,
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // RTP
  // ─────────────────────────────────────────────────────────────────────────────
  rtp: {
    // UDP port range for RTP sessions (even ports used, RTCP on port+1)
    portMin: 10000,
    portMax: 10100,

    // Audio sample rate. G.711 is always 8000 Hz.
    sampleRate: 8000,

    // RTP packetisation interval in milliseconds (20ms = 160 samples at 8kHz)
    packetIntervalMs: 20,

    // Jitter buffer size in packets (each packet = packetIntervalMs)
    // Applies only to the legacy adaptive 'buffered' mode.
    jitterBufferPackets: 4,

    // Jitter buffer max size before packets are dropped (legacy 'buffered' mode)
    jitterBufferMaxPackets: 16,

    // ── Fixed-buffered mode parameters (mode === 'fixed-buffered') ──
    //
    // These control the D-Modem-style fixed-depth jitter buffer. The
    // goal is to absorb network jitter with a deep queue rather than
    // adapt the buffer's size dynamically (which would inject or drop
    // samples — fatal for modems).

    // Number of packets to buffer before starting playout. D-Modem
    // uses 40 (800ms at 20ms pkt-time). Higher = more tolerance for
    // burst loss and bad jitter, but more added latency. Modems don't
    // care about latency, so erring high is safe.
    jitterBufferInitDepth: 40,

    // Hard cap on buffer depth. If packets arrive faster than we drain,
    // we drop the oldest beyond this. D-Modem uses 500 (10s). We also
    // default to 500; well above anything a sane network should produce.
    jitterBufferMaxDepth: 500,

    // How many consecutive missed ticks before we give up on the
    // current expected seq and jump to the nearest future seq held in
    // the buffer. Without this the buffer could stall forever if a
    // packet was truly lost in transit. 50 ticks = 1 second at 20ms.
    jitterBufferMissSkipTicks: 50,

    // Payload types to offer in SDP (96+ are dynamic; 0=PCMU, 8=PCMA)
    // Listed in preference order
    preferredCodecs: [
      { name: 'PCMU', payloadType: 0,  clockRate: 8000 }, // G.711 µ-law
      { name: 'PCMA', payloadType: 8,  clockRate: 8000 }, // G.711 a-law
      { name: 'L16',  payloadType: 11, clockRate: 8000 }, // Linear 16-bit (testing)
    ],

    // Drop RTP packets with sequence number gap larger than this
    maxSeqGap: 64,

    // SSRC for outgoing RTP stream (0 = random)
    outboundSsrc: 0,

    // Playout mode — controls how incoming RTP packets reach the DSP.
    //
    //   'buffered'  — adaptive jitter buffer (legacy). Packets go into
    //                 a jitter buffer and are released at
    //                 packetIntervalMs intervals. If a packet is missing
    //                 at tick time, a zero-filled concealment frame is
    //                 emitted to keep a steady cadence. Good for voice;
    //                 the 40-80ms added latency is imperceptible and
    //                 the concealment masks brief network jitter. BAD
    //                 for modems: silence frames break the DSP PLL lock
    //                 and cause NO CARRIER.
    //
    //   'immediate' — skip the jitter buffer and concealment. Emit
    //                 'audio' synchronously the moment a packet is
    //                 decoded. No concealment ever. Originally used
    //                 as a modem workaround. Trade-off: no reorder
    //                 tolerance and duplicate packets slip through.
    //                 On Windows, setInterval(20) drifts enough that
    //                 buffered mode can consume faster than packets
    //                 arrive — which immediate mode side-steps entirely.
    //
    //   'fixed-buffered' — D-Modem-style fixed-depth queue. Packets
    //                 accumulate until jitterBufferInitDepth are held;
    //                 then playback starts at 20ms cadence. On miss,
    //                 we SKIP THE TICK instead of emitting silence
    //                 (so the modem DSP never sees fake samples). On
    //                 severe underrun we re-sync to the next available
    //                 seq. On overflow we drop oldest. This is the
    //                 approach that makes D-Modem connections last
    //                 days instead of minutes. Recommended for modem
    //                 use; cost is a fixed ~800ms of added latency.
    //
    // The slmodemd backend forces 'fixed-buffered' by default (see
    // CallSession), overriding this setting. Native-DSP mode respects
    // this config.
    playoutMode: 'fixed-buffered',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // MODEM DSP ENGINE
  // ─────────────────────────────────────────────────────────────────────────────
  modem: {

    // ─────────────────────────────────────────────────────────────────
    // Backend selection (and shared options that apply to both backends)
    // ─────────────────────────────────────────────────────────────────

    // Which modem engine to use. EXPLICIT — no auto-detection.
    //
    //   'native'          built-in pure-JS modem backend, in-process.
    //                     Active protocols: V.21 / V.22 / Bell 103.
    //                     V.22bis and V.23 also live in the registry as
    //                     TESTING (operators must opt them in via
    //                     `protocolPreference` / `v8ModulationModes` —
    //                     they are not currently known to train against
    //                     real hardware modems and are kept as the basis
    //                     for future fix work). Native answer-side V.8
    //                     and answer-tone signaling come from this
    //                     config section's `native:` subtree below.
    //                     Works on Linux, macOS, and Windows; no native
    //                     addon, no toolchain prerequisite as of
    //                     cleanup-phase-2.
    //
    //   'slmodemd-pjsip'  slmodemd DSP under QEMU, with PJSIP handling
    //                     SIP and RTP inside the VM (via vendored
    //                     d-modem.c). SynthModem acts as a SIP B2BUA
    //                     bridging the external caller's SIP/RTP leg
    //                     to an internal SIP leg terminated by PJSIP +
    //                     d-modem inside the guest. All of D-Modem's
    //                     media optimizations apply — software clock,
    //                     fixed jitter buffer, PLC/VAD/EC off, PCMU
    //                     priority, direct socketpair coupling — giving
    //                     robust handshake reliability for V.32bis
    //                     through V.34/V.90. slmodemd's own
    //                     internal V.8 stack handles negotiation; the
    //                     `native:` keys below have no effect for this
    //                     backend. Requires the bundled QEMU + VM image
    //                     (`make -C vm`).
    //
    //   'auto'            Combines both. Calls start in slmodemd-pjsip
    //                     b2bua mode so V.8-capable callers reach the
    //                     full V.34/V.32bis range. If slmodemd's V.8
    //                     negotiation times out without seeing CM (the
    //                     deterministic ~12-second NO CARRIER pattern
    //                     that vintage non-V.8 callers produce — see
    //                     boot logs captured 2026-04-30 19:44-19:46),
    //                     the VM is recycled, the local RTP socket is
    //                     adopted by an in-process RtpSession, and the
    //                     native backend takes over with V.8 and ANSam
    //                     skipped (the caller has already heard ANSam
    //                     from PJSIP and is sitting in V.25 "answer-
    //                     tone-heard, awaiting training" state). The
    //                     native legacy automode probe chain
    //                     (V.22bis → V.21 → Bell103) handles the rest.
    //                     Capture in this mode covers only the post-
    //                     swap (native) portion — the b2bua portion
    //                     before the swap is currently not captured.
    //
    // If 'slmodemd-pjsip' is selected but the VM image or QEMU is
    // missing, synthmodem will fail at start with a clear message.
    backend: BACKEND,

    // Role: 'answer'    — SynthModem is the answering modem (server use).
    //       'originate' — SynthModem dials out (test client use).
    role: ROLE,

    // Per-call WAV capture for offline analysis.
    //
    // Today this works ONLY for backend === 'native' (where Node owns
    // the decoded PCM stream end-to-end). For 'slmodemd-pjsip' the
    // option is a no-op at runtime: Node only sees raw PCMU bytes
    // moving through RtpBridge, never the decoded audio, so there's
    // no PCM stream to write to a WAV.
    //
    // Future work (Phase 4-5): implement direction-tagged capture for
    // 'slmodemd-pjsip' by snooping RtpBridge._forward, which is the
    // single chokepoint where every RTP packet (both directions)
    // passes through Node. Outputs would be a per-direction WAV with
    // PCMU codec (RFC 7656; WAV mu-law format code 7) and/or a .pcap
    // of the RTP datagrams for replay through the actual stack. The
    // hook is small (~10 lines) but the format and on-disk layout
    // need design — deferred until then.
    //
    // For now, leave true and rely on it for native-backend debugging;
    // the runtime logs "captureAudio requested but ignored in b2bua
    // mode" once per call when slmodemd-pjsip is selected, so it's
    // benign.
    captureAudio: CAPTURE_AUDIO,
    captureDir:   './captures',

    // TX-timing diagnostic trace. When true and captureAudio is also
    // true, the per-call capture will include a `<base>_tx_timing.txt`
    // file containing a high-resolution timestamp + RTP sequence number
    // for every outbound RTP packet. Use tools/analyze-tx-timing.js
    // to read the trace and characterize inter-packet jitter relative
    // to the ideal 20 ms cadence.
    //
    // Off by default — minimal but nonzero overhead per send (one
    // hrtime call + one typed-array store), which is fine for
    // diagnostic runs but unnecessary in production.
    traceTxTiming: false,

    // ─────────────────────────────────────────────────────────────────
    // native — options for backend === 'native'
    // ─────────────────────────────────────────────────────────────────
    //
    // These keys are silently ignored when backend === 'slmodemd-pjsip'
    // (slmodemd's own DSP handles signaling and protocol selection
    // internally over its AT command set; see the `slmodemd-pjsip:`
    // section below for that path's atInit hook).
    native: {

      // ── Protocol selection ────────────────────────────────────────

      // Protocol negotiation order, highest preference first. SynthModem
      // tries these during V.8 handshake when neither `forceProtocol`
      // nor `advertiseProtocol` overrides selection.
      //
      // Active native protocols (validated end-to-end against real
      // hardware modems over SIP/RTP, April 2026):
      //   'V22bis'   — 2400 bps 16-QAM (V.22bis-spandsp port)
      //   'V22'      — 1200 bps DPSK
      //   'V23'      — 1200/75 bps split-speed FSK
      //   'V21'      — 300 bps FSK
      //   'Bell103'  — 300 bps FSK (US legacy)
      //
      // V.32bis and V.34 were removed in cleanup-phase-2 along with
      // the spandsp dependency. The slmodemd-pjsip backend covers
      // those high-speed paths via its proprietary DSP.
      protocolPreference: ['V22bis', 'V22', 'V23', 'V21', 'Bell103'],

      // V.8 menu — list of modulation modes to advertise in CM. Subset
      // of protocolPreference. Advertising a protocol here that we
      // can't actually train will cause the caller to attempt training
      // and fail; only advertise what we can complete.
      v8ModulationModes: ['V22bis', 'V22', 'V23', 'V21', 'Bell103'],

      // Force a specific protocol regardless of negotiation. null =
      // negotiate via V.8 / per protocolPreference. Bypasses V.8 entirely.
      // Example: 'V22'
      forceProtocol: null,

      // Originate-side: advertise only this protocol in our V.8 CM.
      // Useful from the test client to make the answering side select
      // a specific protocol via legitimate V.8 negotiation rather than
      // forceProtocol's bypass. null = advertise the full
      // protocolPreference.
      // Example: 'V22' — answer side will select V22 because we only
      // advertise V22.
      advertiseProtocol: null,

      // ── Answer tone (ITU-T V.25) ──────────────────────────────────

      // Delay between call connect and the start of ANS/ANSam tone, in ms.
      answerToneDelayMs: 1000,

      // Duration of 2100 Hz ANS tone, in ms. ITU spec: 2.6–4 s,
      // 3.3 s typical.
      answerToneDurationMs: 3300,

      // ANSam (phase-reversal) tone instead of plain ANS:
      //   true  — V.8-capable signaling (modern caller modems expect this)
      //   false — legacy V.25 ANS only
      useANSam: true,

      // Phase reversal interval for ANSam, in ms. ITU spec: 450 ms.
      answerTonePhaseReversalMs: 450,

      // ── V.8 handshake ─────────────────────────────────────────────

      // Whether to use V.8 CM/JM call-menu exchange before training.
      // true  — emit V.8 (works with V.8-capable callers; legacy V.25
      //         callers will time out our CM wait and we fall through
      //         to direct training).
      // false — skip V.8 and go straight to the forced protocol's
      //         training sequence.
      enableV8: true,

      // ── Post-training idle hold ("V.42 Penalty Box") ──────────────
      //
      // After modem training completes, we must transmit continuous
      // mark-idle (scrambled binary 1s) for some seconds before sending
      // any real payload. This is NOT optional for modern modems. Two
      // reasons:
      //
      //   1. V.22/V.22bis spec-mandated idle: ITU-T V.22bis §6.3.1.2.2
      //      requires the answerer to transmit scrambled binary 1s for
      //      765 ms so the caller's descrambler can lock and the caller
      //      can assert its own Carrier Detect. spandsp's TIMED_S11
      //      stage handles this internally before firing
      //      TRAINING_SUCCEEDED, so by the time we see the 'connected'
      //      event this requirement is already met.
      //
      //   2. V.42 / LAPM detection window: modern modems default to
      //      V.42 error correction. After physical-layer training they
      //      spend up to 8-10 seconds transmitting V.42 ODP (Originator
      //      Detection Pattern) XID-like frames trying to initiate
      //      LAPM. synthmodem does not implement V.42; we cannot
      //      respond to ODP with an ADP or negotiate LAPM. So we must
      //      simply wait it out. The caller's V.42 state machine will
      //      eventually notice nothing is responding, drop into
      //      Normal/Direct mode, and finally assert DCD to its DTE.
      //
      // During the hold, TWO things must be true:
      //
      //   A. We must NOT transmit payload bytes. To the caller, any
      //      ASCII data arriving during V.42 ODP is line corruption,
      //      and strict modems will drop the call. Our binding's
      //      get_bit callback naturally outputs continuous mark-idle
      //      (all 1s, scrambled by spandsp) when the byte queue is
      //      empty — exactly what the caller needs. Implemented by
      //      deferring the TelnetProxy attach until after the hold.
      //
      //   B. We must DISCARD received bytes. During the hold the
      //      caller fires V.42 XID frames at us; they descramble to
      //      arbitrary bytes that must not reach the TelnetProxy (the
      //      menu would interpret them as user input and try to open
      //      TCP connections to garbage hostnames). Implemented by
      //      deferring the normal _dsp.on('data') → telnet.receive
      //      hookup until after the hold.
      //
      // HOLD STRATEGY — two-phase:
      //
      //   Phase 1 (MIN HOLD): unconditional `postTrainIdleMs` wait.
      //   Covers the V.22 §6.3.1.2.2 tail and the shortest V.42 timers.
      //
      //   Phase 2 (QUIESCENCE WAIT): after the min hold, keep attaching
      //   TelnetProxy deferred AS LONG AS the RX byte stream keeps
      //   flowing. The caller finishes V.42 and drops into mark idle,
      //   which our binding suppresses as 0xFF → no bytes emitted. So
      //   when the byte stream goes quiet for `postTrainQuiescenceMs`,
      //   we attach.
      //
      // This adapts automatically to different modems:
      //   - AT&Q0 (V.42 disabled): no bytes during hold, immediate
      //     attach after postTrainIdleMs elapses.
      //   - Modern modems with 2-3 s V.42 timers: bytes flow 2-3 s
      //     then stop; attach fires ~500 ms after that.
      //   - Pathological modems with 8-9 s V.42 timers: bytes flow
      //     for the full window; attach fires ~500 ms after they stop.
      //   - Something pathological that never stops:
      //     `postTrainAttachMaxMs` cap fires so we never wait forever.
      //
      // Default values are tuned against real modem observations:
      //
      //   - 6000 ms min hold: empirically confirmed sufficient to let
      //     a default-config consumer modem (V.42-enabled) complete
      //     its ODP detection and fall back to Normal/Direct mode.
      //     4000 ms was NOT sufficient on the same modem. 3000 ms
      //     fires the banner mid-V.42, which some modems tolerate and
      //     some don't.
      //
      //   - 500 ms quiescence: after V.42 finishes, the caller drops
      //     into scrambled mark idle (0xFF through our binding,
      //     suppressed), so the RX byte stream goes silent. 500 ms
      //     comfortably beats worst-case inter-frame gaps in active
      //     V.42 ODP transmission.
      //
      //   - 15000 ms hard cap: for pathological modems that never
      //     quiesce. We attach anyway after this; better to leak some
      //     bytes than hang indefinitely.
      postTrainIdleMs:       6000,   // Minimum hold duration (ms)
      postTrainQuiescenceMs: 500,    // Time without RX bytes to declare V.42 done (ms)
      postTrainAttachMaxMs:  15000,  // Hard cap on total wait (ms)

      // ── Per-protocol training sequence duration (ms) ──────────────
      // These are MINIMUMS. Most actual training runs are longer.
      // V22bis and V23 entries are kept because their classes still
      // exist in the registry as TESTING — operators who opt them in
      // need a training duration. V.32bis and V.34 entries were dropped
      // when those protocols left in cleanup-phase-2.
      trainingDurationMs: {
        V21:     0,    // FSK — no training needed
        Bell103: 0,    // FSK — no training needed
        V22:     600,
        V22bis:  600,  // TESTING
        V23:     0,    // TESTING
      },

      // ── DSP internals ─────────────────────────────────────────────

      // Internal processing block size in samples.
      blockSizeSamples: 160,

      // Tolerance (Hz) for slightly mis-tuned carriers.
      carrierToleranceHz: 10,

      // ── Phase-2 note on dropped DSP knobs ─────────────────────────
      //
      // The following keys were removed in cleanup-phase-2 along with
      // the QAM protocols that consumed them:
      //
      //   agcEnabled, agcTargetLevel, agcAttackAlpha, agcDecayAlpha
      //     — AGC class still lives in Primitives.js (retained for any
      //       future native-V.22bis fix work) but no active protocol
      //       uses it; ModemDSP no longer instantiates it.
      //
      //   equalizer.{taps, stepSize, pretrainSymbols}
      //     — LMSEqualizer class retained in Primitives.js for the
      //       same reason; not currently consumed anywhere.
      //
      //   timingRecovery.{loopGain, maxOffsetFraction}
      //     — GardnerTiming class retained in Primitives.js, same
      //       reason.
      //
      //   scramblerPolynomial
      //     — V.34 / V.32bis self-sync scrambler config; the V.22
      //       PUREJS implementation has its own internal V22Scrambler
      //       class so this top-level key was unused by any surviving
      //       protocol.
      //
      // If a future phase fixes V.22bis or revisits a native QAM
      // protocol, restore the keys it actually needs at that time.

      // Signal below this RMS is treated as silence.
      silenceThreshold: 0.001,

      // Hangup detection: consecutive silent packets before declaring
      // call lost. 750 × 20ms = 15 seconds. Increase if your BBS has
      // long pauses between screens.
      silenceHangupPackets: 750,

      // Per-protocol carrier frequencies (Hz). These match ITU-T specs
      // but can be tweaked for gateway quirks.
      // V22bis and V23 entries kept for the TESTING-status classes;
      // V32bis and V34 entries dropped with those protocols.
      carriers: {
        V21: {
          // Channel 1 (originating modem)
          ch1Mark:  1280,
          ch1Space: 1080,
          // Channel 2 (answering modem)
          ch2Mark:  2100,
          ch2Space: 1750,
        },
        V22: {
          // Both use 1200 Hz carrier, DPSK
          origCarrier:   1200,
          answerCarrier: 2400,
        },
        V22bis: {     // TESTING
          origCarrier:   1200,
          answerCarrier: 2400,
        },
        V23: {        // TESTING
          // Forward channel: 1200 bps
          forwardMark:  1300,
          forwardSpace: 2100,
          // Backward channel: 75 bps
          backwardMark:  390,
          backwardSpace: 450,
        },
      },
    },

    // ─────────────────────────────────────────────────────────────────
    // slmodemd-pjsip — options for backend === 'slmodemd-pjsip'
    // ─────────────────────────────────────────────────────────────────
    //
    // Silently ignored when backend === 'native'.
    //
    // The slmodemd-pjsip backend boots a minimal QEMU i386 VM running
    // (in order, inside the guest):
    //   * slmodemd       (the DSP)
    //   * d-modem        (PJSIP pjmedia_port subclass that bridges
    //                    PJSIP audio frames to slmodemd's socketpair)
    //   * modemd-tunnel  (UDP-over-TCP transport for SIP/RTP between
    //                    Node and the guest)
    //   * modemd-ctrl    (PTY ↔ control-channel bridge so Node can
    //                    drive AT commands and exchange data-mode
    //                    bytes with slmodemd)
    //
    // Node terminates the external SIP/RTP leg, then INVITEs d-modem
    // inside the VM as a B2BUA — see PJSIP.md for the design
    // rationale and slmodemd-pjsip.md for the implementation manual.
    'slmodemd-pjsip': {

      // ── QEMU launch ──────────────────────────────────────────────

      qemu: {
        // Path to qemu-system-i386. If null, falls back to QEMU_SYSTEM_I386
        // env var, then a PATH lookup at spawn.
        // Windows: typical install path. Linux/macOS: usually just leave
        // null and put qemu-system-i386 on PATH.
        qemuPath: QEMU_PATH,

        // Kernel image (bzImage). Absolute or relative to repo root.
        kernelPath: './vm/images/bzImage',

        // Initramfs. NOTE: src/index.js currently hardcodes the
        // slmodemd-pjsip rootfs path for the runtime launch, so this
        // key is unused at runtime. Retained for any future caller
        // that wants to override.
        initrdPath: './vm/images/rootfs-slmodemd-pjsip.cpio.gz',

        // Guest RAM in MB. 256 is generous; slmodemd itself needs much
        // less, but PJSIP's pool allocators want headroom.
        vmMemoryMb: 256,

        // Accelerator: 'kvm' (Linux), 'hvf' (macOS), 'whpx' (Windows),
        // 'tcg' (everywhere, software emulation). null = autodetect.
        // Forcing 'tcg' is useful in CI sandboxes without
        // virtualization access.
        vmAccel: VM_ACCEL,

        // Extra tokens appended to the kernel cmdline. Mainly for
        // debug — the VM's init script doesn't read these, but they
        // show up in /proc/cmdline.
        vmAppendExtra: null,
      },

      // ── Guest-side TCP transport (UDP-over-TCP tunnel) ───────────
      //
      // The VM talks to Node over two TCP loopback connections — one
      // carrying audio (RTP) datagrams, one carrying control messages
      // (AT commands, modem status, CONNECT/NO CARRIER lines). Node
      // listens; QEMU's chardev attaches outbound.
      //
      // Earlier iterations used Unix sockets on Linux and named pipes
      // on Windows; both caused platform-specific jitter / buffering
      // issues, especially on Windows where libuv suffered back-to-back
      // small-write corruption and tight kernel buffers. TCP loopback
      // is battle-tested in libuv and QEMU, has generous default
      // buffers (64-128 KB vs pipe ~4 KB), and with TCP_NODELAY set
      // on both ends has no coalescing gotchas.
      //
      // Defaults sit in a quiet zone between the well-known ports and
      // the OS ephemeral ranges (Linux 32768+, Windows 49152+), so
      // there's no risk of the OS pre-allocating them to unrelated
      // outbound sockets. Override only for local port conflicts,
      // running multiple synthmodem instances, or isolating a test run.
      //
      // Both ports must be 1024-65535 and different from each other.
      transport: {
        audioPort:   AUDIO_PORT,
        controlPort: CONTROL_PORT,
        // Host interface to bind. Loopback-only by default — the VM
        // runs on the same machine as Node; there's no reason to
        // expose these ports to the network.
        bindHost:    '127.0.0.1',
      },

      // ── Diagnostics ──────────────────────────────────────────────

      // Log level for processes inside the guest. Propagated via the
      // kernel cmdline (synthmodem_log=<level>) to S99modem-pjsip,
      // which exports it as SYNTHMODEM_LOG_LEVEL for d-modem and
      // modemd-ctrl to read.
      //   'error' — only errors (default; quiet startup)
      //   'info'  — connect/HELLO/AT-received traces
      //   'debug' — per-frame debug, including AT content
      logLevel: GUEST_LOG_LEVEL,

      // Where to put the ephemeral Unix sockets used by the qemu
      // chardev wiring. null = os.tmpdir().
      socketDir: null,

      // If set to a path, every byte QEMU emits on its combined
      // stdout+stderr (guest kernel console + guest userspace +
      // QEMU itself) is appended there. Useful for retroactive boot
      // diagnosis. null = no persistent log. The file is created in
      // append mode; rotate externally if it grows too large.
      bootLogPath: BOOT_LOG_PATH,

      // If set to a directory, when the VM exits uncleanly (non-zero
      // status or unexpected mid-session exit), the last 256 KB of the
      // boot log plus a small metadata sidecar are dumped there. Each
      // dump gets a timestamped filename. Runs even when bootLogPath
      // is null — the in-memory ring buffer is always available.
      crashDumpDir: null,

      // If true, log every wire frame crossing the Node ↔ guest
      // boundary (both directions) at trace level. VERY verbose — a
      // 60-second call emits tens of thousands of audio frames. Use
      // only for protocol-level debugging. Runs host-side; the guest
      // is unaware and unaffected.
      traceWireFrames: false,

      // ── Pre-ATA AT command sequence ──────────────────────────────
      //
      // Array of raw AT commands sent to slmodemd in order BEFORE the
      // automatic ATA. Leave empty (`atInit: []`) for normal operation
      // — slmodemd's defaults run a full V.8 handshake that virtually
      // every modern modem negotiates cleanly (V.34, V.90, V.92 over
      // V.8, with fallback to V.32bis / V.22bis / V.22 / V.21 as
      // needed).
      //
      // Use this only when you have a specific caller configuration
      // that needs an explicit modulation or rate bound. Each entry
      // is passed to slmodemd verbatim and must be a valid AT command
      // as accepted by slmodemd's command interpreter. slmodemd's
      // responses (OK / ERROR) are logged but do not halt the
      // sequence.
      //
      // Useful commands (see slmodemd's modem_at.c for the
      // authoritative list, and the D-Modem README for real-world
      // examples):
      //
      //   AT+MS=<modulation>[,<automode>[,<minrate>[,<maxrate>]]]
      //     Select modulation family and rate window.
      //     modulation: 11=V.21, 22=V.22, 24=V.22bis, 32=V.32,
      //                 132=V.32bis, 138=V.34, 56=K56flex, 90=V.90,
      //                 92=V.92
      //     automode:   0 = disable V.8 (use this modulation directly);
      //                 1 = allow V.8 to pick among capable modulations
      //     Examples:
      //       'AT+MS=132,0,4800,9600'  — V.32bis only, 4800-9600 bps
      //       'AT+MS=138,1,9600,33600' — V.34 preferred via V.8, up to 33.6k
      //       'AT+MS=24,0,1200,2400'   — V.22bis only, 1200-2400 bps
      //
      //   ATS<reg>=<value>
      //     Set an S-register. Most useful:
      //       S7  = wait-for-carrier timeout (seconds)
      //       S10 = carrier-loss disconnect threshold
      //       S38 = V.42 ODP timeout
      //
      //   AT&K<n>   flow control     (0=none, 3=RTS/CTS, 4=XON/XOFF)
      //   AT\N<n>   error correction (0=normal, 3=V.42/MNP, 5=V.42/MNP required)
      //   AT%C<n>   compression      (0=disabled, 3=V.42bis/MNP5)
      //   ATS0=<n>  rings before auto-answer (we already answer via
      //             ATA, so usually irrelevant)
      //
      // Example (V.32bis, 4800-9600 bps only, no error correction):
      //   atInit: ['AT&K3', 'AT+MS=132,0,4800,9600']
      //
      // Example (force V.22 for a V.22-locked caller):
      //   atInit: ['AT+MS=22,0,1200,1200']
      //
      // Errors on any command are logged but do NOT stop the
      // sequence, because some slmodemd builds emit ERROR on command
      // forms that still had the intended side-effect, and we'd
      // rather try ATA than abandon the call at init time.
      atInit: AT_INIT,
    },

  },


  // ─────────────────────────────────────────────────────────────────────────────
  // TELNET PROXY
  // ─────────────────────────────────────────────────────────────────────────────
  telnet: {
    // TCP connect timeout (ms)
    connectTimeoutMs: 10000,

    // Idle timeout — close connection after this many ms of no data (0 = disabled)
    idleTimeoutMs: 300000, // 5 minutes

    // Buffer size for proxy chunks (bytes)
    bufferSize: 4096,

    // Send IAC WILL ECHO / DO SUPPRESS-GO-AHEAD during telnet negotiation
    negotiateOptions: true,

    // Terminal type to advertise during TTYPE negotiation
    terminalType: 'VT100',

    // Terminal dimensions to advertise via NAWS
    terminalCols: 80,
    terminalRows: 24,

    // Allowed hosts (CIDR or hostname patterns). Empty array = allow all.
    // Example: ['192.168.0.0/16', '*.example.com']
    allowedHosts: [],

    // Blocked hosts
    blockedHosts: ['169.254.169.254'], // block AWS metadata etc.

    // DNS resolve timeout (ms)
    dnsTimeoutMs: 5000,

    // CONNECT> menu-idle UART heartbeat. When the user is sitting at the
    // CONNECT> prompt and no data is flowing in either direction, send a
    // single CR (0x0D) every this many ms to keep the receiving modem's
    // UART framer (and indirectly its descrambler) resynced. CR is
    // visually inert on the user's terminal — it just moves the cursor
    // to column 0. Set to 0 to disable. See TelnetProxy._scheduleMenuHeartbeat
    // for the full rationale; in short, pure V.22 scrambled-marking idle
    // looks like random bits to a hardware modem's UART, which can
    // misframe and produce visible-but-bogus characters on the terminal
    // until something resyncs it. The heartbeat does NOT run during a
    // proxied BBS session — real BBS data already exercises the UART.
    menuIdleHeartbeatMs: 0,
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TERMINAL UI (the menu shown to connected modem users)
  // ─────────────────────────────────────────────────────────────────────────────
  terminal: {
    // Greeting banner (shown after modem connect, before the prompt).
    //
    // Supports placeholders that are substituted at attach time using
    // the connection details reported by the modem backend:
    //   {{protocol}}  e.g. 'V32bis', 'V22bis', 'Bell103', 'V34'
    //   {{bps}}       e.g. '14400', '2400', '300', '19200'
    //
    // Example using placeholders:
    //   banner: [
    //     '',
    //     '  CONNECT {{bps}} ({{protocol}})',
    //     '  Welcome to SynthModem',
    //     '',
    //   ].join('\r\n'),
    //
    // If a placeholder appears but the connect info is unavailable
    // for some reason, it renders as 'unknown' / '0' rather than
    // leaving the literal `{{protocol}}` visible.
 
    banner: [
      '',
      '+-----------------------------------+',
      '|        S Y N T H M O D E M        |',
      '|           Telnet Gateway          |',
      '+-----------------------------------+',
      '',
      'Connected using {{protocol}} @ {{bps}} bps.',
      '',
      'Type <host> or <host>:<port> to connect.',
      'Type QUIT to disconnect.',
      '',
      '',
    ].join('\r\n'),
 
    // banner: [ 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' ],
    // Prompt string
    prompt: 'CONNECT> ',

    // Default telnet port if none specified
    defaultPort: 23,

    // Echo typed characters back to user
    localEcho: true,

    // Line ending to send to modem client (\r\n for modems, \n for unix)
    lineEnding: '\r\n',

    // Maximum input line length
    maxInputLength: 256,
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // LOGGING
  // ─────────────────────────────────────────────────────────────────────────────
  logging: {
    // Log levels: 'error', 'warn', 'info', 'debug', 'trace'
    level: LOG_LEVEL,

    // Log SIP message bodies (can be verbose)
    logSipMessages: true,

    // Log RTP packet events (very verbose — only for low-level debugging)
    logRtpPackets: false,

    // Log DSP state transitions
    logDspState: true,

    // Log raw modem data bytes (hex)
    logModemData: false,

    // Timestamp format: 'iso', 'unix', 'relative'
    timestampFormat: 'iso',

    // Colour output (disable if piping to file)
    colorize: true,
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST CLIENT
  // ─────────────────────────────────────────────────────────────────────────────
  testClient: {
    // SIP server to call
    serverHost: '127.0.0.1',
    serverPort: 5060,
    serverTransport: 'udp', // 'udp' or 'tcp'

    // From URI for the outbound call
    fromUser: 'testmodem',
    fromDomain: 'testclient.local',

    // Number/URI to dial
    toUser: 'modem',
    toDomain: '127.0.0.1',

    // Local SIP port for the test client UAC
    localSipPort: 5061,

    // Local RTP port for the test client
    localRtpPort: 20000,

    // Which modem protocol to originate with
    // 'auto' = use V.8 negotiation, or specify e.g. 'V22'
    originateProtocol: 'auto',

    // Local speaker playback was removed from the test client in
    // cleanup-phase-2 (the underlying `speaker` npm package had a
    // security advisory and was the last reason the test client
    // pulled in a native build dependency). The audioOutput,
    // audioOutputDevice, and audioOutputVolume keys that previously
    // lived here are gone with it.

    // After connect: automatically send this string as if typed
    // (useful for scripted testing). null = interactive mode.
    autoConnect: null, // e.g. 'bbs.example.com:23'

    // Timeout waiting for CONNECT from answering modem (ms)
    connectTimeoutMs: 60000,

    // Display raw modem state transitions in the test client
    verbose: true,
  },
};
