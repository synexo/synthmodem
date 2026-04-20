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
    jitterBufferPackets: 4,

    // Jitter buffer max size before packets are dropped
    jitterBufferMaxPackets: 16,

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
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // MODEM DSP ENGINE
  // ─────────────────────────────────────────────────────────────────────────────
  modem: {
    // Role: 'answer' (SynthModem acts as the answering modem, normal for a server)
    //       'originate' (SynthModem initiates - used by test client)
    role: 'answer',
    captureAudio: true,        // Write WAV per call for debugging
    captureDir: './captures',  // Output directory

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

    // ── Training & synchronisation ──
    // Duration of training sequence (ms) — varies per protocol, these are minimums
    trainingDurationMs: {
      V21:    0,    // FSK — no training needed
      V22:    600,
      V22bis: 600,
      V23:    0,
      V32bis: 1024,
      V34:    1500,
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
