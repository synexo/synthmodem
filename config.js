'use strict';

/**
 * SynthModem Central Configuration
 * All tuneable parameters live here. Restart required after changes unless noted.
 */

module.exports = {


  // ─────────────────────────────────────────────────────────────────────────────
  // SIP SERVER
  // ─────────────────────────────────────────────────────────────────────────────
  sip: {
    // Interface to bind. '0.0.0.0' listens on all interfaces.
    host: '192.168.1.148',

    // UDP and TCP SIP port (standard is 5060)
    port: 5060,

    // The hostname/IP advertised in Via, Contact, and SDP headers.
    // Set this to the externally reachable IP if behind NAT.
    publicHost: '192.168.1.148',

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
    // ── Backend selection ──
    // Which modem engine to use:
    //   'native'   — the built-in pure-JS + spandsp backend. No external
    //                process. Works on Windows, Linux, macOS. Supports
    //                V.21/V.22/V.22bis reliably; V.32bis and above are
    //                experimental.
    //   'slmodemd' — offload to slmodemd running under QEMU. Supports
    //                V.21 through V.90. Requires Linux or Windows host
    //                with the bundled QEMU + VM image.
    // This is an EXPLICIT choice — no auto-detection. If 'slmodemd' is
    // selected but the binaries are missing, synthmodem will fail at
    // start with a clear message. See IMPLEMENTATION.md for the rationale.
    backend: 'slmodemd',

    // ── slmodemd backend options (used only when backend === 'slmodemd') ──
    slmodemd: {
      // How to run slmodemd:
      //   'qemu' — spawn qemu-system-i386 with the bundled VM image
      //            (vm/images/bzImage + rootfs.cpio.gz). slmodemd runs
      //            inside the guest; host talks to it over virtio-serial
      //            Unix-socket chardevs. This is the shipping mode.
      //   'host' — spawn slmodemd directly on the host (no VM). Only
      //            works on Linux hosts with Debian bookworm–compatible
      //            glibc. Primarily for M1-era development and debugging.
      mode: 'qemu',

      // ── QEMU mode paths (mode === 'qemu') ──
      // Path to qemu-system-i386. If unset, we look for QEMU_SYSTEM_I386
      // in the environment, then fall through to a PATH lookup at spawn.
      qemuPath: 'C:\\Program Files\\qemu\\qemu-system-i386.exe',
      // Kernel image (bzImage). Absolute or relative to repo root.
      kernelPath:    './vm/images/bzImage',
      // Initramfs (rootfs.cpio.gz).
      initrdPath:    './vm/images/rootfs.cpio.gz',
      // Guest RAM in MB. 256 is generous; slmodemd itself needs much less.
      vmMemoryMb:    256,
      // Accelerator: 'kvm' (Linux), 'hvf' (macOS), 'whpx' (Windows), 'tcg'
      // (everywhere, software emulation). Null = autodetect. Forcing
      // 'tcg' is useful in CI sandboxes without virtualization access.
      vmAccel:       null,
      // Extra tokens appended to the kernel cmdline. Mainly for debug
      // work — S99modem doesn't read these, but they show up in /proc/cmdline.
      vmAppendExtra: null,

      // ── Host mode paths (mode === 'host') ──
      // Path to the slmodemd binary (or mock-slmodemd for testing).
      // Relative paths are resolved against the synthmodem repo root.
      slmodemdPath: './vm/prebuilt/slmodemd',
      // Path to the modemd-shim binary. M1 only — M2 runs the shim
      // inside the VM and inherits it from the initramfs.
      shimPath:     './vm/prebuilt/modemd-shim-i386',
      // Extra args to pass to slmodemd before the `-e <shim>` flag.
      // Typical uses: `-d<level>` for slmodemd's own debug level.
      slmodemdArgs: [],
      // PTY path the shim will open. Must match whatever path
      // slmodemd (or the mock) creates.
      ptyPath:      '/tmp/synthmodem-ttySL0',

      // ── Shared ──
      // Log level for the shim inside the guest. Propagated to the VM
      // via the kernel cmdline (synthmodem_log=<level>), which S99modem
      // reads and exports as SYNTHMODEM_LOG_LEVEL. Values:
      //   'error' — only errors (default; quiet startup)
      //   'info'  — shim connect/HELLO/AT-received traces
      //   'debug' — per-frame debug, including AT content
      logLevel:     'debug',
      // Where to put the Unix sockets for shim ↔ host traffic.
      // Defaults to os.tmpdir() when null.
      socketDir:    null,

      // ── Diagnostic/logging (host side) ──
      // Because the VM is a black box, we offer several layers of
      // visibility. All default off so production stays quiet.

      // If set to a path, every byte QEMU emits on its combined
      // stdout+stderr (guest kernel console + guest userspace stdout +
      // QEMU itself) is appended there. Useful for retroactive boot
      // diagnosis. Null = no persistent log. The file is created in
      // append mode; rotate externally if it grows too large.
      bootLogPath:  './captures/slmodemd-boot.log',

      // If set to a directory, when the VM exits uncleanly (non-zero
      // status or unexpected mid-session exit), the last 256 KB of the
      // boot log plus a small metadata sidecar is dumped there. Each
      // dump gets a timestamped filename. This runs even with
      // bootLogPath=null — the in-memory buffer is always available.
      crashDumpDir: null,

      // If true, log every wire frame crossing the Node↔shim boundary
      // (both directions) at trace level. VERY verbose — a 60-second
      // call emits tens of thousands of audio frames. Use only for
      // protocol-level debugging. This runs host-side; the guest is
      // unaware and unaffected.
      traceWireFrames: false,

      // ── TCP transport between Node and the VM's QEMU chardev ──
      //
      // The VM talks to Node over two TCP loopback connections — one
      // carrying audio samples (via virtio-serial), one carrying
      // control messages (AT commands, modem status JSON, wire-framed
      // data). Node listens; QEMU connects.
      //
      // Earlier iterations used Unix sockets on Linux and named pipes
      // on Windows. Both caused platform-specific jitter/buffering
      // issues — Windows named pipes especially suffered from libuv
      // back-to-back small-write corruption and tight kernel buffers.
      // TCP loopback has been battle-tested in libuv and QEMU, has
      // generous default buffers (64-128 KB vs pipe ~4 KB), and with
      // TCP_NODELAY set on both ends has no coalescing gotchas.
      //
      // The defaults below sit in a quiet zone between the well-known
      // ports and the OS ephemeral ranges (Linux 32768+, Windows
      // 49152+), so there's no risk of the OS pre-allocating them to
      // unrelated outbound sockets. Override only if you have a local
      // port conflict, need to run multiple synthmodem instances, or
      // want to isolate a test run from the defaults.
      //
      // Both ports must be >= 1024 (non-privileged), <= 65535, and
      // different from each other.
      transport: {
        audioPort:   25800,
        controlPort: 25801,
        // Host interface to bind. Loopback-only by default — the VM
        // runs on the same machine as Node; there's no reason to
        // expose these ports on a network interface.
        bindHost:    '127.0.0.1',
      },

      // ── Pre-ATA AT command sequence ──
      //
      // Array of raw AT commands sent to slmodemd in order BEFORE
      // the automatic ATA that starts answering. Leave null/empty for
      // normal operation — slmodemd's defaults run a full V.8
      // handshake that virtually every modern modem negotiates
      // cleanly (V.34, V.90, V.92 over V.8, with fallback to V.32bis
      // / V.22bis / V.22 / V.21 as needed).
      //
      // Use this only when you have a specific caller configuration
      // that needs an explicit modulation or rate bound. Each entry
      // is passed to slmodemd verbatim and must be a valid AT command
      // as accepted by slmodemd's command interpreter. slmodemd's
      // responses (OK / ERROR) are logged but don't halt the sequence.
      //
      // Useful commands (see slmodemd's modem_at.c for the authoritative
      // list, and the D-Modem README for real-world examples):
      //
      //   AT+MS=<modulation>[,<automode>[,<minrate>[,<maxrate>]]]
      //     Select modulation family and rate window.
      //     modulation: 11=V.21, 22=V.22, 24=V.22bis, 32=V.32, 132=V.32bis,
      //                 138=V.34, 56=V.56(K56flex), 90=V.90, 92=V.92
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
      //   AT&K<n>   flow control   (0=none, 3=RTS/CTS, 4=XON/XOFF)
      //   AT\N<n>   error correction (0=normal, 3=V.42/MNP, 5=V.42/MNP required)
      //   AT%C<n>   compression    (0=disabled, 3=V.42bis/MNP5)
      //   ATS0=<n>  rings before auto-answer (we already answer via ATA,
      //             so usually irrelevant)
      //
      // Example (V.32bis, 4800-9600 bps only, no error correction):
      //   atInit: ['AT&Q0', 'AT+MS=132,0,4800,9600']
      //
      // Example (force V.22 for a V.22-locked caller using AT+MS=V22,0):
      //   atInit: ['AT+MS=22,0,1200,1200']
      //
      // Errors on any command are logged but do NOT stop the sequence,
      // because some slmodemd builds emit ERROR on command forms that
      // still had the intended side-effect, and we'd rather try ATA
      // than abandon the call at init time.
      atInit:['AT+MS=132,1,4800,4800'], // same on client (V32B) and disable v.42 (issue AT&Q0) ... 9600 may work
    },

    // Role: 'answer' (SynthModem acts as the answering modem, normal for a server)
    //       'originate' (SynthModem initiates - used by test client)
    role: 'answer',
    captureAudio: true,        // Write WAV per call for debugging
    captureDir: './captures',  // Output directory

    // When true AND backend is 'slmodemd', pull the three diagnostic
    // audio-dump files from inside the VM at hangup time and write
    // them alongside the RX/TX WAVs. Files collected:
    //
    //   <capture>_modem_rx_8k.raw  — 16-bit 8000 Hz mono, pre-resample
    //                                 (what shim wrote to slmodemd)
    //   <capture>_modem_rx.raw     — 16-bit 9600 Hz mono, post-resample
    //                                 (what the DSP blob sees)
    //   <capture>_modem_tx.raw     — 16-bit 9600 Hz mono, pre-resample
    //                                 (what the DSP blob emits)
    //
    // Only used for audio-pipeline-integrity diagnostics. Adds a few
    // hundred ms to hangup while the VM streams the files over the
    // control channel. Default OFF — opt in by setting true when
    // investigating audio-path issues.
    dumpModemPipeline: true,

    // Protocol negotiation order (highest preferred first).
    // SynthModem will try these in order during V.8 handshake.
    // Supported: 'V34', 'V32bis', 'V22bis', 'V22', 'V23', 'V21'
    protocolPreference: ['V34', 'V32bis', 'V22bis', 'V22', 'V21'],

    // Force a specific protocol regardless of negotiation (null = auto-negotiate)
    // Example: 'V22bis'
    // If set, the originate role will advertise only this protocol in its V.8 CM.
    // Use this (via --proto on test-client) instead of forceProtocol so both
    // sides negotiate the same protocol via V.8 rather than bypassing it.
    // Example: 'V22' — server will select V22 because client only advertises V22.
    advertiseProtocol: null,

    forceProtocol: null,

    // ── Answer tone timing (ITU-T V.25) ──
    // Delay before sending ANS tone after call connects (ms)
    answerToneDelayMs: 1000,

    // Duration of 2100 Hz ANS tone (ms) — ITU spec: 2.6–4s, 3.3s typical
    answerToneDurationMs: 3300,

    // ANSam (phase-reversal) tone: true = V.8 capable, false = legacy V.25
    useANSam: true,

    // Phase reversal interval for ANSam (ms) — ITU spec: 450ms
    answerTonePhaseReversalMs: 450,

    // ── V.8 / V.8bis handshake ──
    // Enable V.8 call menu (CM/JM) exchange for protocol negotiation
    enableV8: true,

    // V.8 menu: list of modulation modes to advertise (subset of protocolPreference)
    // Currently only V.22bis, V.22, and V.21 are fully implemented on the
    // answer side. Advertising V.34 or V.32bis here would cause a 56k
    // modem to try training those with us, which would fail. Advertising
    // only what we actually support forces the modem to downshift.
    v8ModulationModes: ['V22bis', 'V22', 'V21'],

    // Timeout waiting for CI (Call Indicator) from originating modem (ms)
    v8CiTimeoutMs: 200,

    // (v8HandshakeTimeoutMs removed — Handshake.js hardcodes 15000 ms
    // since real modems need 5-12s after ANSam ends to complete CM.)

    // ── Post-training idle hold ("V.42 Penalty Box") ──
    // After modem training completes, we must transmit continuous mark-
    // idle (scrambled binary 1s) for some seconds before sending any real
    // payload. This is NOT optional for modern modems. Two reasons:
    //
    //   1. V.22/V.22bis spec-mandated idle: ITU-T V.22bis §6.3.1.2.2
    //      requires the answerer to transmit scrambled binary 1s for
    //      765 ms so the caller's descrambler can lock and the caller
    //      can assert its own Carrier Detect. spandsp's TIMED_S11 stage
    //      handles this internally before firing TRAINING_SUCCEEDED, so
    //      by the time we see the 'connected' event this requirement is
    //      already met.
    //
    //   2. V.42 / LAPM detection window: modern modems default to
    //      V.42 error correction. After physical-layer training they
    //      spend up to 8-10 seconds transmitting V.42 ODP (Originator
    //      Detection Pattern) XID-like frames trying to initiate LAPM.
    //      synthmodem does not implement V.42; we cannot respond to
    //      ODP with an ADP or negotiate LAPM. So we must simply wait it
    //      out. The caller's V.42 state machine will eventually notice
    //      nothing is responding, drop into Normal/Direct mode, and
    //      finally assert DCD to its DTE.
    //
    // During the hold, TWO things must be true:
    //
    //   A. We must NOT transmit payload bytes. To the caller, any
    //      ASCII data arriving during V.42 ODP is line corruption, and
    //      strict modems will drop the call. Our binding's get_bit
    //      callback naturally outputs continuous mark-idle (all 1s,
    //      scrambled by spandsp) when the byte queue is empty — which
    //      is exactly what the caller needs to see. Implemented by
    //      deferring the TelnetProxy attach until after the hold.
    //
    //   B. We must DISCARD received bytes. During the hold the caller
    //      fires V.42 XID frames at us; they descramble to arbitrary
    //      bytes that must not reach the TelnetProxy (the menu would
    //      interpret them as user input and try to open TCP connections
    //      to garbage hostnames). Implemented by deferring the normal
    //      _dsp.on('data') → telnet.receive hookup until after the hold.
    //
    // HOLD STRATEGY — two-phase:
    //
    //   Phase 1 (MIN HOLD): unconditional `postTrainIdleMs` wait. Covers
    //   the V.22 §6.3.1.2.2 tail and the shortest V.42 timers.
    //
    //   Phase 2 (QUIESCENCE WAIT): after the min hold, keep attaching
    //   TelnetProxy deferred AS LONG AS the RX byte stream keeps flowing.
    //   The caller finishes V.42 and drops into mark idle, which our
    //   binding suppresses as 0xFF → no bytes emitted. So when the byte
    //   stream goes quiet for `postTrainQuiescenceMs`, we attach.
    //
    // This adapts automatically to different modems:
    //   - AT&Q0 (V.42 disabled): no bytes during hold, immediate attach
    //     after postTrainIdleMs elapses.
    //   - Modern modems with 2-3s V.42 timers: bytes flow 2-3s then stop;
    //     attach fires ~500ms after that.
    //   - Pathological modems with 8-9s V.42 timers: bytes flow for the
    //     full window; attach fires ~500ms after they stop.
    //   - Something pathological that never stops: `postTrainAttachMaxMs`
    //     cap fires so we never wait forever.
    // Default values here are tuned against real modem observations:
    //
    //   - 6000 ms min hold: empirically confirmed sufficient to let a
    //     default-config consumer modem (V.42-enabled) complete its ODP
    //     detection and fall back to Normal/Direct mode. 4000 ms was
    //     NOT sufficient on the same modem. 3000 ms fires the banner
    //     mid-V.42, which some modems tolerate and some don't.
    //
    //   - 500 ms quiescence: after V.42 finishes, the caller drops into
    //     scrambled mark idle (0xFF through our binding, suppressed),
    //     so the RX byte stream goes silent. 500 ms comfortably beats
    //     worst-case inter-frame gaps in active V.42 ODP transmission.
    //
    //   - 15000 ms hard cap: for pathological modems that never quiesce.
    //     We attach anyway after this; better to leak some bytes than
    //     hang indefinitely.
    postTrainIdleMs:         6000,   // Minimum hold duration (ms)
    postTrainQuiescenceMs:   500,    // Time without RX bytes to declare V.42 done (ms)
    postTrainAttachMaxMs:    15000,  // Hard cap on total wait (ms)


    // Duration of training sequence (ms) — varies per protocol, these are minimums
    trainingDurationMs: {
      V21:     0,    // FSK — no training needed
      Bell103: 0,    // FSK — no training needed
      V22:     600,
      V22bis:  600,
      V23:     0,
      V32bis:  1024,
      V34:     1500,
    },

    // ── DSP internals ──
    // Internal processing block size in samples
    blockSizeSamples: 160,

    // AGC (Automatic Gain Control) — normalise incoming signal level.
    // DISABLED BY DEFAULT. QAM signals (V.22bis, V.32bis, V.34) have
    // non-constant envelope: outer 16-QAM points are 3x the inner-point
    // amplitude, which is information the slicer needs. Classic
    // envelope-tracking AGCs will "smooth out" this amplitude structure
    // and break decoding. The rewritten AGC in Primitives.js uses slow
    // block-RMS measurement and is safe to enable if your SIP gateway
    // produces significantly varying signal levels — but tune
    // agcTargetLevel to match your real signal's RMS, otherwise the
    // slicer's fixed thresholds won't align with the scaled signal.
    agcEnabled: false,
    agcTargetLevel: 0.28,   // Matches natural RMS of V.22bis QAM TX at AMP=0.4.
                            // If AGC is enabled and input matches this level,
                            // gain converges to 1 (no-op). For real channels
                            // with level variation, set to your expected RMS.
    agcAttackAlpha: 0.01,
    agcDecayAlpha: 0.001,

    // Carrier frequency offsets (Hz) — tolerance for slightly mis-tuned carriers
    carrierToleranceHz: 10,

    // LMS equaliser settings (used in V.22bis, V.32bis, V.34)
    equalizer: {
      taps: 15,          // number of equaliser taps
      stepSize: 0.01,    // LMS step size (mu) — smaller = more stable, slower
      pretrainSymbols: 128, // symbols to train before locking
    },

    // Timing recovery (Gardner algorithm)
    timingRecovery: {
      loopGain: 0.01,
      maxOffsetFraction: 0.5, // max timing offset as fraction of symbol period
    },

    // Scrambler polynomial (V.34 default: 1 + x^-18 + x^-23)
    // Expressed as tap positions from MSB
    scramblerPolynomial: [18, 23],

    // Silence threshold — signal below this RMS is treated as silence
    silenceThreshold: 0.001,

    // Hangup detection: consecutive silent packets before declaring call lost
    // 750 × 20ms = 15 seconds. Increase if your BBS has long pauses between screens.
    silenceHangupPackets: 750,

    // ── Per-protocol carrier frequencies (Hz) ──
    // These match ITU-T specs but can be tweaked for gateway quirks
    carriers: {
      V21: {
        // Channel 1 (originating modem)
        ch1Mark:  1280,
        ch1Space: 1080,
        // Channel 2 (answering modem)
        ch2Mark:  2100,
        ch2Space: 1750, // Adjusted from 1750 for better separation
      },
      V22: {
        // Both use 1200 Hz carrier, DPSK
        origCarrier:   1200,
        answerCarrier: 2400,
      },
      V22bis: {
        origCarrier:   1200,
        answerCarrier: 2400,
      },
      V23: {
        // Forward channel: 1200 bps
        forwardMark:  1300,
        forwardSpace: 2100,
        // Backward channel: 75 bps
        backwardMark:  390,
        backwardSpace: 450,
      },
      V32bis: {
        // the V.32bis spec uses a single shared carrier at 1800 Hz both directions — echo cancellation separates the channels
        carrier: 1800
      },
      V34: {
        // Same separation strategy as V32bis.
        answerCarrier:   1800,
        originateCarrier: 1200,
        symbolRate: 2400,
      },
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
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TERMINAL UI (the menu shown to connected modem users)
  // ─────────────────────────────────────────────────────────────────────────────
  terminal: {
    // Greeting banner (shown after modem connect)
    /*
    banner: [
      '',
      '  ╔═══════════════════════════════════════╗',
      '  ║        S Y N T H M O D E M            ║',
      '  ║     Telnet Gateway  v1.0              ║',
      '  ╚═══════════════════════════════════════╝',
      '',
      '  Type <host> or <host>:<port> to connect.',
      '  Type QUIT to disconnect.',
      '',
    ].join('\r\n'),
    */
    banner: ['ABCDEFGHIJKLMNOPQRSTUVWXYZ'],

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
    level: 'debug',

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
    // 'auto' = use V.8 negotiation, or specify e.g. 'V22bis'
    originateProtocol: 'auto',

    // Audio output: play modem audio through speakers
    audioOutput: false,

    // Audio output device index (-1 = default system device)
    audioOutputDevice: -1,

    // Audio output volume (0.0 – 1.0)
    audioOutputVolume: 0.8,

    // After connect: automatically send this string as if typed
    // (useful for scripted testing). null = interactive mode.
    autoConnect: null, // e.g. 'bbs.example.com:23'

    // Timeout waiting for CONNECT from answering modem (ms)
    connectTimeoutMs: 60000,

    // Display raw modem state transitions in the test client
    verbose: true,
  },
};
