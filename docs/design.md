# uPeerJS Design Document

## 1. Overview & Positioning

### What uPeerJS Is

uPeerJS is a **generic, serverless peer-to-peer communication library** for the browser. It provides WebRTC connection management with pluggable signaling (MQTT or WebSocket), end-to-end encryption, and raw DataChannel transport with backpressure — all without requiring a centralized server.

### Comparison with PeerJS

| | PeerJS | uPeerJS |
|---|---|---|
| **Signaling** | Requires PeerServer (centralized) | Pluggable: MQTT broker or WebSocket relay (serverless) |
| **Encryption** | None on signaling | AES-GCM E2E encryption on signaling |
| **DataChannel** | Basic send/receive | Raw DataChannel with backpressure |
| **Media + Data** | Separate connection types | Single connection multiplexes media + DataChannel |
| **Transport** | Hardcoded WebSocket to PeerServer | Pluggable signaling transport (MQTT default) |
| **Serialization** | JSON only | MessagePack for signaling; raw bytes on DataChannel |
| **Server** | Requires PeerServer deployment | Any MQTT broker (e.g. EMQX, Mosquitto, HiveMQ) |

### Core Differentiators

1. **Serverless MQTT signaling** — No custom server to deploy. Any standard MQTT-over-WebSocket broker works.
2. **E2E encryption** — Signaling messages are AES-GCM encrypted before hitting the broker. The broker never sees plaintext SDP/ICE.
3. **Raw DataChannel transport** — Thin wrapper around RTCDataChannel with backpressure management. No framing, no serialization — applications send and receive raw bytes.
4. **Single RTCPeerConnection** — Media tracks and DataChannel share one connection, reducing ICE negotiation overhead.

---

## 2. Architecture

```
┌─────────────────────────────────────────┐
│ Application Layer (NOT in uPeerJS)      │
│ RPC, state sync, business logic...      │
└──────────────┬──────────────────────────┘
               │ Events + send/receive
┌──────────────▼──────────────────────────┐
│ Peer (connection orchestrator)          │
├─────────────────────────────────────────┤
│ RtcSession        │  DataConnection     │
│ (RTCPeerConnection│  (Raw DataChannel   │
│  + media tracks)  │   with backpressure)│
├───────────────────┴─────────────────────┤
│ SignalingBatcher (signal pass-through)  │
├─────────────────────────────────────────┤
│ ISignalingTransport ←── MqttTransport   │
│                    ←── (custom)         │
├─────────────────────────────────────────┤
│ IEncryption ←── AesGcmEncryption        │
│             ←── (none / custom)         │
└─────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Responsibility |
|---|---|
| **Peer** | Entry point. Creates/manages sessions, data connections, routes signaling messages, emits typed events. Extends EventEmitter3. |
| **RtcSession** | Manages a single RTCPeerConnection lifecycle: offer/answer creation, ICE candidate handling, track management, DataChannel creation. One per remote peer. Emits `stream`, `iceStateChanged`, `close`, `signaling`, `dataChannel` events. |
| **DataConnection** | Thin wrapper around RTCDataChannel with backpressure. Sends and receives raw `Uint8Array` / `ArrayBuffer` — no framing or serialization. |
| **SignalingBatcher** | Thin pass-through that forwards each signaling message (Offer, Answer, Candidate) immediately. Preserves the interface for future batching if needed. |
| **MqttTransport** | Default `ISignalingTransport` implementation. Publishes/subscribes to MQTT topics for signaling and broadcast. Extends EventEmitter3, emits `open`, `close`, `error`, `disconnected`. |
| **AesGcmEncryption** | Default `IEncryption` implementation using Web Crypto AES-GCM. |

---

## 3. Package Structure

```
upeerjs/
├── src/
│   ├── index.ts                  # Public API exports
│   ├── types.ts                  # All TypeScript interfaces and types
│   ├── peer.ts                   # Main entry, connection orchestrator
│   │
│   ├── transport/
│   │   └── mqtt-transport.ts     # MQTT-over-WebSocket implementation
│   │
│   ├── security/
│   │   └── aes-gcm-encryption.ts # AES-GCM implementation
│   │
│   ├── connection/
│   │   ├── rtc-session.ts        # RTCPeerConnection lifecycle
│   │   └── signaling-batcher.ts  # Signal pass-through (no batching)
│   │
│   ├── data/
│   │   └── data-connection.ts    # Raw DataChannel wrapper with backpressure
│   │
│   └── util/
│       ├── id-generator.ts       # nanoid peer ID generation
│       ├── codec.ts              # JSON + MsgPack codecs (MsgPack is default)
│       └── constants.ts          # VERSION, PROTOCOL_VERSION, PROTOCOL_FEATURES, DEFAULT_RTC_CONFIG
│
├── test/                        # Tests mirror src/ structure
├── docs/
│   └── design.md                # This document
├── package.json
├── tsconfig.json
└── README.md
```

Single package (not monorepo). Simple, like PeerJS.

---

## 4. Core TypeScript Interfaces

### PeerOptions

The primary API is intentionally simple. Users only need a `securityKey` — encryption and transport are handled internally:

```typescript
interface PeerOptions {
  /** MQTT broker URL (wss://...). Defaults to wss://broker.emqx.io:8084/mqtt */
  brokerUrl?: string;

  /** Optional MQTT client options */
  mqttOptions?: Omit<IClientOptions, 'will'>;

  /** E2E encryption key (raw string, must be 16/24/32 bytes for AES) */
  securityKey?: string;

  /** WebRTC configuration (ICE servers, etc.) */
  rtcConfig?: RTCConfiguration;

  /** Custom codec for signaling messages (default: MessagePack) */
  codec?: ICodec;

  /** Custom encryption implementation */
  encryption?: IEncryption;

  /** DataChannel label (default: "dc:upeer") */
  dataChannelLabel?: string;

  /** DataChannel configuration (default: { ordered: true }) */
  dataChannelInit?: RTCDataChannelInit;

  /** Enable debug logging */
  debug?: boolean;
}
```

**Design rationale:** Most users want P2P with encryption — they should not need to import `MqttTransport` or `AesGcmEncryption`. Provide `securityKey` and it just works. Omit `securityKey` for plaintext signaling. If `encryption` is provided, it takes precedence over `securityKey`.

```typescript
// Simple API — most users
const peer = new Peer('my-id', { securityKey: 'room-secret' });

// Custom encryption
const peer = new Peer('my-id', { encryption: new MyEncryption() });

// Custom broker
const peer = new Peer('my-id', {
  securityKey: 'room-secret',
  brokerUrl: 'wss://mqtt.example.com:8084/mqtt',
});
```

### ISignalingTransport

```typescript
interface ISignalingTransport {
  /** Whether the transport is connected and subscribed */
  readonly connected: boolean;

  /** Connect to the signaling service */
  connect(): void;

  /** Send encrypted/encoded data to a remote peer */
  send(peerId: string, data: Uint8Array): void;

  /** Register a handler for incoming signaling messages */
  onMessage(handler: TransportMessageHandler): void;

  /** Disconnect from the signaling service */
  disconnect(): void;
}

type TransportMessageHandler = (message: SignalingMessage) => void;
```

**Note:** The transport receives and dispatches already-decoded `SignalingMessage` objects (codec decode + encryption decrypt happen inside `MqttTransport`). The `send()` method takes pre-encoded `Uint8Array` (codec encode happens in `Peer`, encryption happens inside `MqttTransport`).

### IEncryption

```typescript
interface IEncryption {
  /** Whether encryption is ready to use */
  readonly ready: boolean;

  /** Wait until encryption is initialized */
  waitReady(): Promise<void>;

  /** Encrypt a Uint8Array payload */
  encrypt(data: Uint8Array): Promise<Uint8Array>;

  /** Decrypt a Uint8Array payload */
  decrypt(data: Uint8Array): Promise<Uint8Array>;
}
```

### ICodec

```typescript
interface ICodec {
  /** Encode data to binary */
  encode(data: any): Uint8Array;

  /** Decode binary to data */
  decode(data: Uint8Array): any;
}
```

### SignalingMessage

```typescript
enum SignalingType {
  Candidate = 'candidate',
  Offer = 'offer',
  Answer = 'answer',
}

interface SignalingMessage {
  /** Signaling message type */
  type: SignalingType;

  /** Type-specific payload */
  data: any;

  /** Source peer ID */
  src: string;

}
```

### PeerEvents

```typescript
interface PeerEvents {
  /** Signaling transport connected, peer is reachable */
  open: (peerId: string) => void;

  /** Signaling transport disconnected */
  close: () => void;

  /** Error occurred */
  error: (err: any) => void;

  /** Incoming or outgoing media call */
  call: (event: { peerId: string; call: RtcSession }) => void;

  /** Remote media stream received */
  stream: (event: { peerId: string; stream: MediaStream; call: RtcSession }) => void;

  /** Media connection closed */
  hangup: (event: { peerId: string; call: RtcSession }) => void;

  /** Incoming data connection opened */
  dataConnection: (event: { peerId: string; conn: DataConnection }) => void;

  /** Data received on any connection */
  data: (event: { peerId: string; data: Uint8Array; conn: DataConnection }) => void;

  /** Data connection closed */
  dataDisconnect: (event: { peerId: string; conn: DataConnection }) => void;

  /** ICE connection state changed */
  iceConnectionStateChange: (event: {
    peerId: string;
    iceConnectionState: RTCIceConnectionState;
    peerConnection: RTCPeerConnection;
  }) => void;
}
```

### MediaConnectionEvents (on RtcSession)

```typescript
// RtcSession emits these events:
interface RtcSessionEvents {
  stream: (stream: MediaStream) => void;
  iceStateChanged: (state: RTCIceConnectionState) => void;
  close: () => void;
  signaling: (type: SignalingType, data: any) => void;
  dataChannel: (dc: RTCDataChannel) => void;
}
```

### DataConnectionEvents

```typescript
interface DataConnectionEvents {
  open: () => void;
  data: (data: Uint8Array) => void;
  close: () => void;
}
```

---

## 5. Signaling Protocol

### MQTT Topic Structure

Each peer subscribes to its own peer ID as an MQTT topic:

```
{peerId}      ← peer subscribes here to receive signaling messages
{peerId}:ff   ← encrypted broadcast channel (pub/sub for presence, etc.)
```

To send a signaling message to a peer, publish to their peer ID topic. Broadcast messages use the `{peerId}:ff` topic with the same encryption and codec as signaling. `publish()` always publishes to the caller's own `peerId` channel; `subscribe()` explicitly specifies which peer's channel to listen to.

### MQTT Connection Configuration

| Parameter | Value |
|-----------|-------|
| Protocol | WSS (WebSocket Secure) |
| MQTT Version | 4 (`protocolVersion` in MqttTransport) |
| Client ID | `upeer@{VERSION}-{peerId.slice(0,8)}` |
| Keepalive | 60s |
| Reconnect Period | 30s (client default) |
| Connect Timeout | 32s (client default) |
| Clean Session | true |

### Message Format

Messages are serialized with the codec (default: MessagePack), optionally encrypted with AES-GCM (with replay protection) before publishing:

Each signaling message is a flat object with `type` directly on the message. One MQTT message carries one signaling type:

```typescript
// Wire format (Codec.encode → encrypt → MQTT publish)

// Offer
{ type: "offer", data: { sdp: RTCSessionDescriptionInit, config?: RTCConfiguration, protocol?: ProtocolMeta }, src: "sender-peer-id" }

// Answer
{ type: "answer", data: { sdp: RTCSessionDescriptionInit, protocol?: ProtocolMeta }, src: "sender-peer-id" }

// Candidate (sent individually, same encoding as Offer/Answer)
{ type: "candidate", data: { candidate: RTCIceCandidateInit }, src: "sender-peer-id" }
```

The dispatch validation on the receiving side uses a structural check (`msg?.type && msg?.src`) to identify valid signaling messages.

### Signal Pass-Through

Each signaling message (Offer, Answer, Candidate) is sent individually as a single MQTT message. The `SignalingBatcher` is a thin pass-through that forwards every `push()` call to the flush callback immediately — no queuing, debouncing, or array wrapping:

```typescript
class SignalingBatcher {
  private _onFlush: (type: SignalingType, data: any) => void;

  constructor(onFlush: (type: SignalingType, data: any) => void) { ... }

  push(type: SignalingType, payload: any): void {
    this._onFlush(type, payload);
  }

  destroy(): void {}
}
```

### Message Processing Flow

**Receiving side (MqttTransport → Peer)**:

```
MQTT message arrives on peer's topic
       │
       ▼
  Decrypt (if encryption configured)
    → strip IV(12B), verify seq/ts replay protection
       │
       ▼
  Codec.decode() → JavaScript object
       │
       ▼
  Structural validation: msg?.type && msg?.src
       │
       ▼
  Switch on message.type
       │
       ├─ 'offer'     → peer._handleIncomingOffer(src, data)
       │                   → Create RtcSession (answerer)
       │                   → emit('call')
       │
       └─ other        → session.handleSignaling(type, data)
                            ├─ 'candidate' → addIceCandidate(candidate)
                            └─ 'answer'    → setRemoteDescription(sdp)
```

---

## 6. Connection Modes

### Media + Data (Full WebRTC)

The default mode when calling `peer.call(remotePeerId, stream)`:

1. Create a single `RTCPeerConnection`
2. Add local MediaStream tracks (audio + video) if provided
3. Add `recvonly` transceivers for audio/video if not already present
4. Create a DataChannel (label from `dataChannelLabel` option, default `dc:upeer`) on the same connection
5. Generate SDP offer and send via signaling
6. Remote peer receives offer, adds their tracks, creates answer
7. ICE candidates trickle via signaling batcher
8. Once connected: media flows via RTP, data flows via DataChannel

If no stream is passed, it falls back to `peer.localStream` if set.

### Data-Only

When calling `peer.connect(remotePeerId)`:

1. Create a single `RTCPeerConnection`
2. No media tracks or recvonly transceivers added
3. Create a DataChannel (label from `dataChannelLabel` option, default `dc:upeer`)
4. Generate SDP offer with no media
5. Standard ICE negotiation

Both modes use the same `RtcSession` — the only difference is whether tracks are added and whether recvonly transceivers are created before offer creation.

### WebRTC Negotiation Sequence

```
  Viewer (Caller)                    MQTT Broker                     Node (Callee)
       │                                │                                │
       │  (1) peer.call(nodeId)         │                                │
       │  Create RtcSession             │                                │
       │  Create RTCPeerConnection      │                                │
       │  Create DataChannel('dc:upeer')│                                │
       │  addTrack(localStream)         │                                │
       │                                │                                │
       │  (2) createOffer()             │                                │
       │  setLocalDescription(offer)    │                                │
       │                                │                                │
       │──(3) MQTT publish(nodeId) ────►│──── deliver ──────────────────►│
       │   {type:'offer', sdp, config,  │                                │
       │    protocol}                   │                                │
       │                                │                                │ (4) _handleIncomingOffer()
       │                                │                                │    Create RtcSession (answerer)
       │                                │                                │    emit('call')
       │                                │                                │    addTrack(localStream)
       │                                │                                │    setRemoteDescription(offer)
       │                                │                                │    createAnswer()
       │                                │                                │    setLocalDescription(answer)
       │                                │                                │
       │◄── MQTT publish(viewerId) ─────│◄──────────────────────────────│
       │   {type:'answer', sdp,         │                                │ (5)
       │    protocol}                   │                                │
       │                                │                                │
       │  (6) setRemoteDescription(answer)                               │
       │                                │                                │
       │──── candidate ────────────────►│────────────────────────────────►│ (7)
       │◄─── candidate ────────────────│◄────────────────────────────────│
       │         (ICE candidates exchange, sent individually)                    │
       │                                │                                │
       │═══════════ WebRTC P2P connection established (DTLS handshake) ══│
       │                                                                 │
       │◄─────────── MediaStream (audio/video stream) ──────────────────│ (8)
       │◄═══════════ DataChannel 'dc:upeer' ready ═════════════════════│ (9)
```

### DataChannel Creation

The **offerer** (caller) creates the application DataChannel during session setup:

```typescript
// RtcSession.startAsOfferer()
this.dataChannel = pc.createDataChannel("dc:upeer", { ordered: true });
```

The **answerer** (callee) receives the DataChannel via the `ondatachannel` event on the `RTCPeerConnection`:

```typescript
// RtcSession._setupListeners()
pc.ondatachannel = (evt) => {
    if (evt.channel.label === "dc:upeer") {
        this.dataChannel = evt.channel;
        this.emit("dataChannel", evt.channel);
    }
};
```

Both the label and `RTCDataChannelInit` options are configurable via `PeerOptions.dataChannelLabel` and `PeerOptions.dataChannelInit`.

### ICE State Management

| ICE State | Handling |
|-----------|----------|
| `connected` | Clear recovery timer, set state to `Connected`, reset reconnect attempts, start heartbeat |
| `completed` | Same as `connected` |
| `disconnected` | If currently `Connected` → set state to `Recovering`, attempt ICE restart |
| `failed` | Set state to `Disconnected`, stop heartbeat, clear recovery timer |

---

## 7. DataConnection

### Design

DataConnection is a thin wrapper around `RTCDataChannel` that adds backpressure management. It carries **raw bytes** — no framing protocol, no serialization, no chunking. Applications send and receive `Uint8Array` / `ArrayBuffer` directly.

```
  send(data: Uint8Array | ArrayBuffer)
      │
      ▼
  Backpressure check (bufferedAmount > MAX - data.byteLength?)
      │
      ├─ Over threshold → await 'bufferedamountlow' event
      │
      └─ Under threshold → RTCDataChannel.send(data)

  ════════════════════════

  RTCDataChannel.onmessage
      │
      ▼
  emit('data', new Uint8Array(event.data))
```

The DataConnection exposes:

- **`send(data: Uint8Array | ArrayBuffer)`** — Send raw bytes with backpressure. Returns a `Promise<void>` that resolves when the data has been queued (may await backpressure relief).
- **`close()`** — Close the underlying DataChannel.
- **Events:** `open`, `data` (emits `Uint8Array`), `close`.

### DataChannel Configuration

Applications can customize the DataChannel label and initialization options via `PeerOptions`:

```typescript
const peer = new Peer('my-id', {
  securityKey: 'secret',
  // Custom DataChannel label (default: "dc:upeer")
  dataChannelLabel: 'my-channel',
  // Custom RTCDataChannelInit (default: { ordered: true })
  dataChannelInit: { ordered: false, maxRetransmits: 0 },
});
```

- **`dataChannelLabel`** — The label passed to `RTCPeerConnection.createDataChannel()`. Default: `"dc:upeer"`. The answerer side matches incoming DataChannels by this label.
- **`dataChannelInit`** — The `RTCDataChannelInit` dictionary passed to `createDataChannel()`. Default: `{ ordered: true }`. Use this to configure ordered/unordered delivery, max retransmits, max packet lifetime, etc.

### Backpressure

| Parameter | Value | Rationale |
|---|---|---|
| Max buffered amount | 8MB (8,388,608 bytes) | Prevent memory exhaustion on slow connections |
| Low-water mark | 4MB (4,194,304 bytes) | Resume sending at 50% of max buffer |

When `dataChannel.bufferedAmount` exceeds `MAX_BUFFERED_AMOUNT - data.byteLength`:

1. Pause writing (await `bufferedamountlow` event)
2. DataChannel fires `bufferedamountlow` when buffer drops below 4MB
3. Resume writing

This prevents memory buildup when the sender is faster than the network.

### Connection State Machine

The `Peer` class tracks each remote peer's connection state through these transitions:

```
                 call()/connect()
  ┌──────┐ ──────────────────────► ┌────────────┐
  │ Init │                          │ Signaling  │
  └──────┘                          └─────┬──────┘
                                          │ ICE connected/completed
                                          ▼
                                    ┌────────────┐
                          ┌────────►│ Connected  │◄──────────┐
                          │         └─────┬──────┘           │
                          │               │ ICE disconnected  │ ICE connected
                          │               │ or heartbeat fail │ (recovery success)
                          │               ▼                   │
                          │         ┌────────────┐           │
                          │         │ Recovering │───────────┘
                          │         └─────┬──────┘
                          │               │ ICE restart timeout (15s)
                          │               │ or ICE failed
                          │               ▼
                          │         ┌──────────────┐
                          └─────────│ Disconnected │
                                    └──────────────┘
```

### Internal Control Channel (Heartbeat)

RtcSession creates a **negotiated** DataChannel (`_ctrl`, id: 0) automatically on both sides of the connection. This channel is used internally for heartbeat ping/pong and is not exposed to applications.

- Both peers create the control channel independently via `pc.createDataChannel("_ctrl", { negotiated: true, id: 0, ordered: true })`. Because it is negotiated, no SDP offer/answer overhead is needed.
- Ping messages (`{ ts: <timestamp> }`) and pong responses (`{ ts: <timestamp>, pong: true }`) are msgpack-encoded and exchanged over this channel at 15-second intervals.
- If 2 consecutive pongs are missed (5-second timeout each), the Peer triggers an ICE restart to attempt connection recovery.

#### Heartbeat Flow

```
Connected peer
  │
  │  every 15s
  ├────► send msgpack({ ts: Date.now() }) on _ctrl channel
  │      start Pong timeout (5s)
  │
  │  ◄── receive msgpack({ ts, pong: true }) on _ctrl channel
  │      clear timeout, reset missedPongs = 0
  │
  │  (timeout, no Pong received)
  │      missedPongs++
  │      if missedPongs >= 2 → ICE restart
```

#### Heartbeat Constants

| Parameter | Value |
|-----------|-------|
| Control channel label | `_ctrl` |
| Control channel id | `0` (negotiated) |
| Encoding | MessagePack |
| Ping interval | 15,000 ms |
| Pong timeout | 5,000 ms |
| Max missed pongs | 2 |
| Action on failure | Enter `Recovering` state, trigger ICE restart |
| Recovery timeout | 15,000 ms |

This is an implementation detail — applications interact only with the application-level DataConnection.

### Serialization

- **Signaling channel:** MessagePack codec (default) via `MsgpackCodec` — pluggable via `ICodec` interface.
- **DataChannel:** No serialization. Raw bytes in, raw bytes out. Applications are responsible for encoding/decoding their own payloads.

---

## 8. Security

### Signaling Encryption (AES-GCM)

All signaling messages (SDP offers/answers, ICE candidates) pass through an MQTT broker. Without encryption, the broker operator can see:

- SDP containing IP addresses, codec preferences
- ICE candidates with IP addresses and ports

uPeerJS encrypts signaling with AES-GCM and includes replay protection:

```
┌──────────────────────────────────────┐
│ Plaintext signaling (MessagePack)    │
└──────────────┬───────────────────────┘
               │ Codec.encode → Uint8Array
               ▼
┌──────────────────────────────────────┐
│ AES-GCM encrypt with replay header  │
│ • Prepend: seq(4B BE) + ts(8B BE)   │
│ • 12-byte random IV (per message)   │
│ • Key imported directly from raw    │
│   bytes (AES-128/192/256 by length) │
│ • Output: [IV(12B)] [ciphertext of  │
│           seq+ts+data]              │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ MQTT publish (binary payload)        │
└──────────────────────────────────────┘
```

### Key Import

The raw security key string is UTF-8 encoded and imported directly as an AES-GCM `CryptoKey` via the Web Crypto API. The AES variant is auto-selected based on key length:

| Key length (bytes) | AES variant |
|---|---|
| 16 | AES-128 |
| 24 | AES-192 |
| 32 | AES-256 |

```typescript
// UTF-8 encode the raw key string
const raw = new TextEncoder().encode(securityKey);
// raw.byteLength must be 16, 24, or 32

// Import directly as AES-GCM key — no HKDF, no salt, no info string
const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
```

There is no key derivation step. The raw key bytes are used as-is.

### Encryption Binary Wire Format

Every encrypted message (signaling or broadcast) uses the following binary layout:

```
┌──────────────┬─────────────────────────────────────────────────────────┐
│ IV (12 B)    │ AES-GCM ciphertext                                     │
│              │  ┌──────────┬──────────────┬──────────────────────────┐ │
│              │  │ seq (4B) │ ts (8B)      │ plaintext (variable)     │ │
│              │  │ BE u32   │ BE u64       │ codec-encoded bytes      │ │
│              │  └──────────┴──────────────┴──────────────────────────┘ │
│              │  (this inner block is what gets encrypted)              │
└──────────────┴─────────────────────────────────────────────────────────┘
 0            12                                                    end
```

- **IV**: 12 random bytes (`crypto.getRandomValues`), unique per message
- **seq**: 4-byte big-endian unsigned integer, monotonically incrementing per sender
- **ts**: 8-byte big-endian unsigned integer, `Date.now()` millisecond timestamp (split into two 32-bit halves)
- **plaintext**: The codec-encoded message bytes (MessagePack by default)

The `seq` and `ts` fields are **inside** the ciphertext — they are integrity-protected by the GCM authentication tag.

### Replay Protection

Each encrypted message includes a `seq` (monotonic counter) and `ts` (millisecond timestamp) inside the ciphertext. The receiver validates:
- **Per-sender sequence tracking:** `seq > lastSeenSeq[sender]` — prevents replay of old messages
- **Timestamp window:** `|now - ts| ≤ 30s` — rejects stale or future-dated messages

**Why no AAD (Additional Authenticated Data)?** The sender's `peerId` is inside the encrypted `SignalingMessage.src` field, creating a chicken-and-egg problem — the receiver cannot know the sender before decryption. The GCM authentication tag combined with seq/ts provides sufficient integrity.

**Replay state reset:** On reconnect, `_sendSeq` resets to 0 and `_lastSeenSeq` map is cleared.

### Media & Data Encryption

- **Media streams:** DTLS-SRTP (WebRTC built-in, always on)
- **DataChannel:** DTLS (WebRTC built-in, always on)
- These are handled by the browser — uPeerJS does not need to implement them.

### Custom Encryption

The `IEncryption` interface allows applications to provide custom encryption:

```typescript
import { Peer } from 'upeerjs';
import type { IEncryption } from 'upeerjs';

class MyEncryption implements IEncryption {
  readonly ready = true;
  async waitReady() {}
  async encrypt(data: Uint8Array): Promise<Uint8Array> { /* ... */ }
  async decrypt(data: Uint8Array): Promise<Uint8Array> { /* ... */ }
}

const peer = new Peer('id', { encryption: new MyEncryption() });
```

To disable encryption entirely, simply omit the `securityKey` option.

---

## 9. API Design

### Creating a Peer

```typescript
import { Peer } from 'upeerjs';

// Minimal — auto-generated ID, no encryption, default MQTT broker
const peer = new Peer({});

// With peer ID + encryption
const peer = new Peer('my-peer-id', { securityKey: 'shared-secret' });

// With custom MQTT broker
const peer = new Peer('my-peer-id', {
  securityKey: 'shared-secret',
  brokerUrl: 'wss://mqtt.example.com:8084/mqtt',
});

// With custom RTC configuration
const peer = new Peer('my-peer-id', {
  securityKey: 'shared-secret',
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'turn:turn.example.com', username: 'user', credential: 'pass' },
    ],
  },
});
```

If no peer ID is provided, one is auto-generated via nanoid:

```typescript
const peer = new Peer({});
// peer.peerId → "V1StGXR8_Z5jdHi6B-myT"
```

### Connection Events

```typescript
// Signaling connected
peer.on('open', (id) => {
  console.log('My peer ID is:', id);
});

// Incoming media call
peer.on('call', ({ peerId, call }) => {
  // call is an RtcSession
  // Remote stream arrives via the 'stream' event on the Peer instance
});

// Remote stream received
peer.on('stream', ({ peerId, stream, call }) => {
  videoElement.srcObject = stream;
});

// Incoming data connection
peer.on('dataConnection', ({ peerId, conn }) => {
  conn.on('data', (data: Uint8Array) => {
    console.log('Received bytes:', data.byteLength);
  });
});

// Errors
peer.on('error', (err) => {
  console.error('Peer error:', err);
});

// Disconnected
peer.on('close', () => {
  console.log('Disconnected');
});
```

### Making a Call (Media + Data)

```typescript
const session = peer.call('remote-peer-id', localStream);

peer.on('stream', ({ peerId, stream }) => {
  videoElement.srcObject = stream;
});

peer.on('hangup', ({ peerId }) => {
  console.log('Call ended with', peerId);
});
```

### Data-Only Connection

```typescript
const session = peer.connect('remote-peer-id');

peer.on('dataConnection', ({ peerId, conn }) => {
  conn.on('open', () => {
    conn.send(new Uint8Array([1, 2, 3])); // Raw bytes
  });
});

// Or use the convenience method
peer.send('remote-peer-id', new Uint8Array([1, 2, 3]));
```

### Replacing Media Tracks

```typescript
// Replace all tracks from a new stream
peer.replaceTrack('remote-peer-id', newStream);

// Set local stream and update all active sessions
peer.setLocalStream(newStream);
```

### Broadcasting Data (DataChannel)

```typescript
// Send raw bytes to all connected peers via DataChannel
peer.broadcast(new Uint8Array([1, 2, 3]));

// Send to all except specific peers
peer.broadcast(data, { excludeId: ['peer-to-skip'] });
```

### Broadcast Pub/Sub (MQTT)

For messages that should reach peers **before** a WebRTC connection is established (e.g., presence), uPeerJS provides an encrypted MQTT broadcast channel:

```typescript
// Publish a broadcast message on this peer's channel ({peerId}:ff)
// Encrypted with the same AES-GCM key as signaling
peer.publish('presence', { status: 'online' });

// Subscribe to a specific app-level topic on another peer's broadcast channel
const unsub = peer.subscribe(remotePeerId, 'presence', (data) => {
  console.log(data.status); // 'online'
});

// Unsubscribe when done
unsub();
```

**Wire format:**
```
MQTT topic: {peerId}:ff
Payload: [IV 12B] [AES-GCM ciphertext of MessagePack({ t: "presence", d: { status: "online" } })]
```

The `topic` parameter (`"presence"`) is an **application-level routing field** inside the encrypted message body — not a separate MQTT topic. Multiple app-level topics share the single `{peerId}:ff` MQTT topic.

### Cleanup

```typescript
// Hang up a specific call
peer.hangup('remote-peer-id');

// Disconnect a data-only connection
peer.dataDisconnect('remote-peer-id');

// Disconnect from signaling, close all sessions
peer.disconnect();

// Destroy the peer (disconnect + remove all listeners)
peer.destroy();
```

### Full Peer API Summary

```typescript
class Peer extends EventEmitter {
  /** The local peer ID */
  readonly peerId: string;

  /** Local MediaStream (set via setLocalStream or used as fallback in call()) */
  localStream: MediaStream | null;

  /** Whether signaling transport is connected */
  readonly connected: boolean;

  /** Constructor overloads */
  constructor(options: PeerOptions);
  constructor(peerId: string, options: PeerOptions);

  /** Connect to the MQTT signaling broker */
  start(): void;

  /** Initiate a media + data call to a peer */
  call(peerId: string, stream?: MediaStream): RtcSession;

  /** Open a data-only connection to a remote peer */
  connect(peerId: string): RtcSession;

  /** Send raw bytes to a specific peer via DataChannel */
  send(peerId: string, data: Uint8Array | ArrayBuffer): void;

  /** Broadcast raw bytes to all connected peers via DataChannel */
  broadcast(data: Uint8Array | ArrayBuffer, options?: { excludeId?: string[] }): void;

  /** Publish a broadcast message on this peer's MQTT broadcast channel ({peerId}:ff) */
  publish(topic: string, data: any): void;

  /** Subscribe to an app-level topic on a remote peer's MQTT broadcast channel */
  subscribe(nodeId: string, topic: string, handler: (data: any) => void): () => void;

  /** Replace media tracks for a specific peer */
  replaceTrack(peerId: string, stream: MediaStream): void;

  /** Set local stream and update all active sessions */
  setLocalStream(stream: MediaStream): void;

  /** Hang up a specific peer connection */
  hangup(peerId: string): void;

  /** Disconnect a data-only connection */
  dataDisconnect(peerId: string): void;

  /** Disconnect from signaling, close all sessions */
  disconnect(): void;

  /** Fully destroy this peer instance */
  destroy(): void;

  /** Typed event emitter (via eventemitter3) */
  on<K extends keyof PeerEvents>(event: K, listener: PeerEvents[K]): this;
  off<K extends keyof PeerEvents>(event: K, listener: PeerEvents[K]): this;
  once<K extends keyof PeerEvents>(event: K, listener: PeerEvents[K]): this;
}
```

---

## 10. Comparison with Current uIPCat Code

This table maps existing uIPCat composables to uPeerJS components:

| uIPCat Source | uPeerJS Component | Included? | Notes |
|---|---|---|---|
| `overMQTT.ts` → `OverMQTT` | `MqttTransport` + `AesGcmEncryption` | Yes | Split into transport + encryption |
| `peerClient.ts` → `PeerClient` | `Peer` | Yes | Without `notify()` / `watch()` (app layer) |
| `mediaconnection.ts` → `MediaConnection` | `RtcSession` | Yes | No separate MediaConnection — RtcSession handles both media and signaling |
| `negotiator.ts` → `Negotiator` | `RtcSession` | Yes | Unified with MediaConnection |
| `StreamConnection.ts` → `StreamConnection` | `DataConnection` | Yes | Simplified to raw DataChannel wrapper with backpressure (no framing) |
| `jsonpack.ts` → `Encoder/Decoder` | `MsgpackCodec` / `JsonCodec` (pluggable via `ICodec`) | Yes | Default: MessagePack for signaling; DataChannel is raw bytes |
| `peerClient.ts` → `notify()` / `watch()` | `Peer.publish()` / `Peer.subscribe()` | Yes | Generic encrypted broadcast pub/sub via MQTT `{peerId}:ff` topic |
| Msgbus / RpcBus / SyncBus | — | **No** | Application layer concern |
| Motion detection, recording | — | **No** | Application layer concern |

### Key Refactoring Decisions

1. **OverMQTT → MqttTransport + AesGcmEncryption**: The current `OverMQTT` mixes MQTT transport with AES-GCM encryption. uPeerJS separates these into two pluggable interfaces.

2. **MediaConnection + Negotiator → RtcSession**: The current split between `MediaConnection` (state) and `Negotiator` (RTCPeerConnection management) is merged into `RtcSession` which owns the full connection lifecycle. There is no separate `MediaConnection` class — `RtcSession` handles media tracks, DataChannel, and signaling.

3. **Signal pass-through extracted**: The current signal queue in `MediaConnection` becomes a standalone `SignalingBatcher` pass-through that preserves the interface for future batching if needed.

4. **PeerClient → Peer**: The old `notify()` and `watch()` (unencrypted MQTT pub/sub) are replaced with generic, encrypted `publish()` / `subscribe()` methods that share the signaling encryption pipeline. Application-level routing is done via a `topic` field inside the encrypted message body.

---

## 11. Usage Examples

### Basic Video Call (Browser to Browser)

```typescript
import { Peer } from 'upeerjs';

// --- Peer A (caller) ---
const peerA = new Peer('alice', { securityKey: 'room-secret' });
peerA.start();

const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const session = peerA.call('bob', localStream);

peerA.on('stream', ({ peerId, stream }) => {
  document.querySelector<HTMLVideoElement>('#remote')!.srcObject = stream;
});

// --- Peer B (callee) ---
const peerB = new Peer('bob', { securityKey: 'room-secret' });
peerB.start();

// Set local stream so incoming calls automatically include it
const localStreamB = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
peerB.localStream = localStreamB;

peerB.on('stream', ({ peerId, stream }) => {
  document.querySelector<HTMLVideoElement>('#remote')!.srcObject = stream;
});
```

### Data-Only Connection (Raw Bytes)

```typescript
import { Peer } from 'upeerjs';

// Sender
const sender = new Peer('sender', { securityKey: 'file-key' });
sender.start();
const session = sender.connect('receiver');

sender.on('dataConnection', ({ conn }) => {
  const file = await fetch('/large-file.bin').then(r => r.arrayBuffer());
  // Backpressure-managed raw send
  await conn.send(new Uint8Array(file));
});

// Receiver
const receiver = new Peer('receiver', { securityKey: 'file-key' });
receiver.start();

receiver.on('dataConnection', ({ conn }) => {
  conn.on('data', (data: Uint8Array) => {
    console.log('Received bytes:', data.byteLength);
  });
});
```

### Integration with Vue (Application Layer Pattern)

```typescript
// composables/usePeer.ts
import { ref, onUnmounted } from 'vue';
import { Peer } from 'upeerjs';

export function usePeer(peerId: string, securityKey: string) {
  const remoteStreams = ref<Map<string, MediaStream>>(new Map());
  const connected = ref(false);

  const peer = new Peer(peerId, { securityKey });

  peer.on('open', () => { connected.value = true; });
  peer.on('close', () => { connected.value = false; });

  peer.on('stream', ({ peerId, stream }) => {
    remoteStreams.value.set(peerId, stream);
  });

  peer.on('hangup', ({ peerId }) => {
    remoteStreams.value.delete(peerId);
  });

  peer.start();

  onUnmounted(() => peer.destroy());

  return { peer, remoteStreams, connected };
}
```

### Integration with React (Application Layer Pattern)

```typescript
// hooks/usePeer.ts
import { useEffect, useRef, useState } from 'react';
import { Peer } from 'upeerjs';

export function usePeer(peerId: string, securityKey: string) {
  const peerRef = useRef<Peer | null>(null);
  const [connected, setConnected] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

  useEffect(() => {
    const peer = new Peer(peerId, { securityKey });

    peer.on('open', () => setConnected(true));
    peer.on('close', () => setConnected(false));

    peer.on('stream', ({ peerId, stream }) => {
      setRemoteStreams(prev => new Map(prev).set(peerId, stream));
    });

    peer.on('hangup', ({ peerId }) => {
      setRemoteStreams(prev => {
        const next = new Map(prev);
        next.delete(peerId);
        return next;
      });
    });

    peer.start();
    peerRef.current = peer;

    return () => peer.destroy();
  }, [peerId, securityKey]);

  return { peer: peerRef, connected, remoteStreams };
}
```

---

## Appendix: Constants and File Index

### SignalingType Enum

| Value | String | Description |
|-------|--------|-------------|
| `Candidate` | `"candidate"` | ICE Candidate |
| `Offer` | `"offer"` | SDP Offer |
| `Answer` | `"answer"` | SDP Answer |

### Protocol Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `VERSION` | `"0.1.0"` | Library version |
| `PROTOCOL_VERSION` | `1` | Wire protocol version |
| `PROTOCOL_FEATURES` | `["msgpack-signaling", "aes-gcm", "presence-inline"]` | Negotiated feature set |

### DataConnection Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_BUFFERED_AMOUNT` | 8,388,608 (8 MB) | DataChannel maximum buffer before backpressure |
| Low watermark threshold | 4,194,304 (4 MB) | `bufferedAmountLowThreshold` to trigger `bufferedamountlow` |

### Heartbeat Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `PING_INTERVAL_MS` | 15,000 ms | Interval between pings |
| `PONG_TIMEOUT_MS` | 5,000 ms | Time to wait for pong response |
| `MAX_MISSED_PONGS` | 2 | Missed pongs before ICE restart |
| `ICE_RECOVERY_TIMEOUT_MS` | 15,000 ms | Timeout for ICE restart recovery |

### Key File Index

| File | Responsibility |
|------|---------------|
| `src/peer.ts` | Peer orchestrator: connection state machine, heartbeat, signaling dispatch |
| `src/connection/rtc-session.ts` | RTCPeerConnection lifecycle: offer/answer, ICE, DataChannel creation |
| `src/connection/signaling-batcher.ts` | Signal pass-through (no batching) |
| `src/data/data-connection.ts` | Raw DataChannel wrapper with backpressure |
| `src/transport/mqtt-transport.ts` | MQTT-over-WebSocket signaling transport |
| `src/security/aes-gcm-encryption.ts` | AES-GCM encryption with direct key import and replay protection |
| `src/util/codec.ts` | JsonCodec and MsgpackCodec implementations |
| `src/util/constants.ts` | VERSION, PROTOCOL_VERSION, PROTOCOL_FEATURES, DEFAULT_RTC_CONFIG |
| `src/types.ts` | TypeScript interfaces: SignalingType, ICodec, IEncryption, PeerOptions |
| `src/index.ts` | Public API exports |
