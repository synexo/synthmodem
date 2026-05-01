# synthmodem tunnel — wire protocol v1

The tunnel is a bidirectional TCP stream that carries UDP datagrams
between Node (host) and PJSIP (inside the runtime VM for backend B,
config.modem.backend = 'slmodemd-pjsip'). On each side, the tunnel
endpoint exposes a small set of local UDP sockets that the consumer
(PJSIP on the VM side, SipUacInternal and RtpSession on the Node
side) binds to as if they were talking to a normal UDP peer.

This file is the protocol's canonical specification. The C
implementation in `vm/tunnel/modemd-tunnel.c` and the Node
implementation in `src/tunnel/UdpTcpTunnel.js` must stay in sync
with it. If a divergence is discovered, update this document first,
then the two implementations.

## Transport

The tunnel runs over our existing host↔VM transport: a TCP loopback
chardev on the host mapped into the VM as a virtio-serial character
device (`/dev/virtio-ports/synthmodem.tunnel`). This is the same
mechanism backend A uses for its audio and control channels; we add
a third virtio-serial port for backend B's tunnel.

Byte ordering: little-endian (host order on both i386 guest and
amd64 host; no conversion needed in practice).

## Framing

```
 offset  size   field
 ──────  ────   ─────
      0   u16   length      total bytes from `channel` through end of `payload`
      2   u8    channel     demux tag (see below)
      3   u16   src_port    UDP source port on sender side (informational)
      5   u16   dst_port    UDP destination port on receiver side
      7   var   payload     UDP datagram body
```

`length` covers channel + src_port + dst_port + payload, i.e. all
bytes after itself. Total frame length on the wire is `2 + length`.
Minimum payload is 0 bytes (legal but rare). Maximum payload is
`65535 - 5 = 65530` bytes; for our use the real max is limited by
PJSIP's media RTP payload size (~200 bytes) and SIP message size
(usually under 2 KB, worst case ~4 KB).

### Fields

- **length** — 16-bit little-endian byte count of everything that
  follows this field. Readers stream: they read 2 bytes, interpret
  as length, then loop-read exactly `length` more bytes to complete
  the frame. The length is the framing's self-synchronization anchor;
  a single corrupted length desynchronizes the stream and both
  endpoints must tear down and reconnect. (TCP checksums mean this
  never happens on loopback in practice.)

- **channel** — 8-bit demux tag. Currently assigned:

    |  ID  | Name  | Used by                                   |
    | :-:  | :---  | :---                                      |
    |  0   | SIP   | SIP signaling (INVITE, 200 OK, ACK, BYE)  |
    |  1   | RTP   | Audio RTP (PCMU, 20 ms frames)            |
    |  2   | RTCP  | RTCP reports (currently unused; reserved) |
    | 255  | ECHO  | Test echo — the receiver replays the      |
    |      |       | payload back on the same channel ID with  |
    |      |       | src_port and dst_port swapped.            |

  Unassigned IDs are reserved for future use. Implementations MUST
  drop frames with unknown channel IDs without tearing down the
  stream — a forward-compatibility hedge if we ever extend the
  protocol within a single binary's lifetime.

- **src_port** — 16-bit little-endian. The UDP source port from
  which the sender received the datagram (or, for synthetic frames,
  the sender's choice of source port). Primarily informational — a
  receiver can log it for debugging and, for channels where it
  matters, use it as a reply address. For RTP both endpoints are
  fixed (loopback:10000 on both sides), so src_port there is
  effectively a redundant echo of the expected value.

- **dst_port** — 16-bit little-endian. The UDP destination port to
  deliver this datagram to on the receiver side. For our fixed-port
  routing, this is the local UDP port the receiver's tunnel endpoint
  binds to (see "Port bindings" below).

- **payload** — raw UDP datagram bytes, zero or more. No further
  framing inside.

## Port bindings

Both tunnel endpoints bind three fixed UDP ports per channel. These
fixed ports simplify the implementation substantially — there's no
dynamic dialog multiplexing to manage — at the cost of not being able
to host more than one simultaneous PJSIP session per tunnel. That's
fine for backend B because `ModemBackendPool` allocates one VM per
call.

| Channel | VM-side tunnel port | Host-side tunnel port |
| :--     | :--                 | :--                   |
| SIP     | 127.0.0.1:5060      | 127.0.0.1:5062        |
| RTP     | 127.0.0.1:10000     | 127.0.0.1:10002       |
| RTCP    | 127.0.0.1:10001     | 127.0.0.1:10003       |

**Symmetric model (step 5c+).** Both endpoints bind well-known ports.
Their consumers — PJSIP (d-modem) inside the VM, SipUacInternal /
RtpBridge / VmRegistrar on the host — bind ephemeral sockets and
`sendto` the tunnel's well-known port for that channel. Each tunnel
endpoint learns its consumer's source address on the first inbound
packet and uses it as the destination for VM↔host frames it needs
to deliver back in the other direction.

**Why this isn't symmetric with pre-5a designs.** Earlier iterations
had modemd-tunnel binding ephemeral on the VM side to accommodate
`pjsip-test-peer` which explicitly binds 5060. Real `d-modem` binds
ephemeral for its PJSIP transport (upstream's `cfg.port = 0`), so
modemd-tunnel is free to take 5060. `pjsip-test-peer` now binds on
port 5090 (configurable) to keep tests working alongside the
production binding model. The code in pre-5c checkouts used the
asymmetric layout; as of step 5c both sides are symmetric.

**Peer learning.** Each tunnel endpoint tracks the last-observed
source address per channel. Before a peer has been learned, deliveries
on that channel to the UDP side are dropped with a log (there's no
valid target). In practice this is never a sustained problem because
the REGISTER flow drives SIP-channel learning inside the first second
of VM boot, and RTP/RTCP learning happens during the INVITE/200 OK
negotiation before media flows.

Offset choice: VM side uses the standard SIP/RTP ports so PJSIP's
default config reaches them without special flags. Host side uses
+2 offsets to avoid conflicting with any real SIP/RTP client that
happens to be running on the host — Node isn't doing external SIP
on these sockets (external SIP stays on :5060 through the
SipServer, unchanged), so +2 is just for hygiene.

The echo channel (255) doesn't bind anywhere; it's a control path
processed directly by the tunnel endpoint itself.

## Semantics

### Host → VM

1. Node consumer (e.g. SipUacInternal) sends a UDP datagram to
   127.0.0.1:5062 (the host side's SIP port).
2. Host tunnel endpoint recv()s, wraps into a frame with channel=0,
   src_port=<ephemeral>, dst_port=5060, writes frame to TCP.
3. VM tunnel endpoint reads frame, sends a UDP datagram from its
   bound 127.0.0.1:5060 socket to PJSIP's learned ephemeral port.
4. PJSIP recv()s on its bound ephemeral socket.

### VM → Host

Symmetric. PJSIP sends UDP to its peer address (which is the VM-side
tunnel endpoint's source). The VM tunnel endpoint wraps and forwards.
The host tunnel endpoint delivers to 127.0.0.1:5062 where Node's
consumer is listening.

### Echo (channel 255)

Either side can send a frame with channel=255 and any payload. The
receiving tunnel endpoint:

1. Does NOT forward the payload to any UDP socket.
2. Reverses src_port / dst_port.
3. Writes the frame back onto the same TCP stream.

This is the primary testing hook used by `test/tunnel/echo.test.js`
to validate the transport without needing PJSIP running inside the
VM. It's always on; there's no flag to disable it. Production use
should not generate channel-255 frames.

## Error handling

- **Unknown channel** → drop the frame (including its payload) and
  continue. Log the event if possible.
- **Length longer than sane** → our practical cap is 64 KB; a frame
  claiming more indicates a desynchronized stream. The implementation
  closes the TCP connection. Node's `ModemBackendPool` discards the
  affected VM and fetches another from the warm pool.
- **Short read on the TCP stream (EOF mid-frame)** → close the
  connection. Same recovery as above.
- **UDP sendto() failure on delivery** → drop the datagram silently.
  UDP is lossy by definition; PJSIP has retransmit semantics for SIP
  and RTP has none. No error propagation upstream.
- **UDP recvfrom() returning a datagram larger than 65530 bytes** —
  truncate and log. In practice this never happens.

## Versioning

This is protocol v1. Neither endpoint announces a version; both
assume v1. If we ever extend the frame format, we will either:

- Add a new channel ID with the new format inside its payload; old
  readers drop it per "unknown channel" handling above.
- Bump the framing scheme and introduce a version handshake on
  connection (first frame is a magic+version record on a reserved
  channel). Needs both endpoints rebuilt.

For now, the simple approach: the protocol is what this document
says, and both implementations track this file.
