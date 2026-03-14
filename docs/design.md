# uPeerJS Design Document

## 1. Overview & Positioning

### What uPeerJS Is

uPeerJS is a **generic, serverless peer-to-peer communication library** for the browser. It provides WebRTC connection management with MQTT-based signaling, end-to-end encryption, and streaming DataChannel support — all without requiring a centralized server.

### What uPeerJS Is Not

uPeerJS is **not** an application framework. It does not include:

- RPC or remote procedure calls
- State synchronization
- Device models or discovery
- Cluster protocols
- Business logic of any kind

Application-level concerns (like uipcatjs) layer on top of uPeerJS.

### Comparison with PeerJS

| | PeerJS | uPeerJS |
|---|---|---|
| **Signaling** | Requires PeerServer (centralized) | MQTT broker relay (serverless, decentralized) |
| **Encryption** | None on signaling | AES-GCM E2E encryption on signaling |
| **DataChannel** | Basic send/receive | Streaming with backpressure, chunking, MessagePack |
| **Media + Data** | Separate connection types | Single connection multiplexes media + DataChannel |
| **Transport** | Hardcoded WebSocket to PeerServer | Pluggable signaling transport (MQTT default) |
| **Serialization** | JSON only | MessagePack (binary) + JSON fallback |
| **Server** | Requires PeerServer deployment | Any MQTT broker (e.g. EMQX, Mosquitto, HiveMQ) |

### Core Differentiators

1. **Serverless MQTT signaling** — No custom server to deploy. Any standard MQTT-over-WebSocket broker works.
2. **E2E encryption** — Signaling messages are AES-GCM encrypted before hitting the broker. The broker never sees plaintext SDP/ICE.
3. **Streaming DataChannel** — Web Streams API with backpressure, 32KB chunking, and MessagePack binary serialization.
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
│ UPeer (connection orchestrator)         │
├─────────────────────────────────────────┤
│ MediaConnection   │  DataConnection     │
│ (WebRTC media)    │  (DataChannel)      │
├───────────────────┴─────────────────────┤
│ RtcSession (RTCPeerConnection wrapper)  │
├─────────────────────────────────────────┤
│ SignalingBatcher (signal batching)      │
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
| **UPeer** | Entry point. Creates/manages connections, routes signaling messages, emits typed events. |
| **MediaConnection** | Represents a media stream connection with a remote peer. Wraps RtcSession for media track management. |
| **DataConnection** | Wraps RTCDataChannel with streaming, backpressure, chunking, and MessagePack serialization. |
| **RtcSession** | Manages a single RTCPeerConnection lifecycle: offer/answer creation, ICE candidate handling, track management. |
| **SignalingBatcher** | Batches signaling items (SDP, ICE candidates) with 16ms debounce to reduce MQTT messages. |
| **ISignalingTransport** | Abstract interface for sending/receiving signaling. Default: MqttTransport. |
| **IEncryption** | Abstract interface for encrypting/decrypting signaling payloads. Default: AesGcmEncryption. |

---

## 3. Package Structure

```
upeerjs/
├── src/
│   ├── index.ts                  # Public API exports
│   ├── types.ts                  # All TypeScript interfaces and types
│   ├── UPeer.ts                  # Main entry, connection orchestrator
│   │
│   ├── transport/
│   │   ├── ISignalingTransport.ts    # Abstract transport interface
│   │   └── MqttTransport.ts         # MQTT-over-WebSocket implementation
│   │
│   ├── security/
│   │   ├── IEncryption.ts           # Encryption interface
│   │   └── AesGcmEncryption.ts      # AES-GCM implementation
│   │
│   ├── connection/
│   │   ├── RtcSession.ts            # RTCPeerConnection lifecycle
│   │   └── SignalingBatcher.ts      # Signal batching/debounce
│   │
│   ├── data/
│   │   └── DataConnection.ts        # DataChannel wrapper with streaming
│   │
│   └── util/
│       ├── IdGenerator.ts           # nanoid peer ID generation
│       └── Codec.ts                 # MessagePack + JSON codec
│
├── docs/
│   └── design.md                 # This document
├── package.json
├── tsconfig.json
└── README.md
```

Single package (not monorepo). Simple, like PeerJS.

---

## 4. Core TypeScript Interfaces

### UPeerOptions (Application API)

The primary API is intentionally simple. Users only need a `secretKey` — encryption and transport are handled internally:

```typescript
interface UPeerOptions {
  /** Shared secret for E2E encryption on signaling. AES-GCM is used automatically. */
  secretKey?: string;

  /** MQTT broker configuration. Sensible defaults provided. */
  mqtt?: {
    /** Broker hostname (default: 'mqtt-cn.uipcat.com') */
    hostname?: string;
    /** Broker port (default: 8084) */
    port?: number;
    /** WebSocket path (default: '/mqtt') */
    path?: string;
    /** Use secure WebSocket (default: true) */
    ssl?: boolean;
  };

  /** ICE servers for WebRTC (default: [{ urls: 'stun:stun.cloudflare.com:3478' }]) */
  iceServers?: RTCIceServer[];

  /** Enable debug logging */
  debug?: boolean;
}
```

**Design rationale:** Most users want P2P with encryption — they should not need to import `MqttTransport` or `AesGcmEncryption`. Provide `secretKey` and it just works. Omit `secretKey` for plaintext signaling.

### UPeerAdvancedOptions (Escape Hatch)

For advanced users who need custom transport or encryption, the constructor accepts a second overload:

```typescript
interface UPeerAdvancedOptions {
  /** Custom signaling transport (replaces built-in MQTT) */
  transport: ISignalingTransport;

  /** Custom encryption (replaces built-in AES-GCM). Set to `false` to disable. */
  encryption?: IEncryption | false;

  /** RTCPeerConnection configuration */
  config?: RTCConfiguration;

  /** Enable debug logging */
  debug?: boolean;
}
```

```typescript
// Simple API — most users
const peer = new UPeer('my-id', { secretKey: 'room-secret' });

// Advanced API — custom transport
const peer = new UPeer('my-id', { transport: new WebSocketTransport() });
```

The constructor distinguishes the two overloads by checking for the `transport` property.

### ISignalingTransport

```typescript
interface ISignalingTransport {
  /** Connect to the signaling service and subscribe to messages for this peer */
  connect(peerId: string): Promise<void>;

  /** Send a signaling message to a remote peer */
  send(peerId: string, message: SignalingMessage): Promise<void>;

  /** Register a handler for incoming signaling messages */
  onMessage(handler: (message: SignalingMessage) => void): void;

  /** Disconnect from the signaling service */
  disconnect(): void;

  /** Connection state */
  readonly connected: boolean;
}
```

### MqttTransportOptions

```typescript
interface MqttTransportOptions {
  /** MQTT broker hostname */
  hostname: string;

  /** MQTT broker port (typically 8083 or 8084 for WSS) */
  port: number;

  /** MQTT WebSocket path (default: '/mqtt') */
  path?: string;

  /** Use secure WebSocket (default: true) */
  ssl?: boolean;

  /** MQTT keepalive in seconds (default: 60) */
  keepalive?: number;

  /** MQTT reconnect period in ms (default: 30000) */
  reconnectPeriod?: number;

  /** MQTT connect timeout in ms (default: 32000) */
  connectTimeout?: number;
}
```

### IEncryption

```typescript
interface IEncryption {
  /** Encrypt a Uint8Array payload */
  encrypt(data: Uint8Array): Promise<Uint8Array>;

  /** Decrypt a Uint8Array payload */
  decrypt(data: Uint8Array): Promise<Uint8Array>;

  /** Whether encryption is ready to use */
  readonly ready: boolean;

  /** Wait until encryption is initialized */
  waitReady(): Promise<void>;
}
```

### SignalingMessage

```typescript
interface SignalingMessage {
  /** Message type identifier */
  type: 'signaling';

  /** Source peer ID */
  src: string;

  /** Batched signaling items */
  data: SignalingItem[];
}

type SignalingItemType = 'offer' | 'answer' | 'candidate' | 'leave';

interface SignalingItem {
  type: SignalingItemType;
  payload: OfferPayload | AnswerPayload | CandidatePayload | LeavePayload;
}

interface OfferPayload {
  sdp: RTCSessionDescriptionInit;
  config?: RTCConfiguration;
}

interface AnswerPayload {
  sdp: RTCSessionDescriptionInit;
}

interface CandidatePayload {
  candidate: RTCIceCandidateInit;
}

interface LeavePayload {}
```

### MediaConnection

```typescript
interface MediaConnectionEvents {
  stream: (remoteStream: MediaStream) => void;
  close: () => void;
  error: (error: Error) => void;
  iceStateChanged: (state: RTCIceConnectionState) => void;
}

declare class MediaConnection {
  /** Remote peer ID */
  readonly peer: string;

  /** Local MediaStream */
  readonly localStream: MediaStream | null;

  /** Remote MediaStream (available after 'stream' event) */
  readonly remoteStream: MediaStream | null;

  /** Underlying RTCPeerConnection */
  readonly peerConnection: RTCPeerConnection | null;

  /** Answer an incoming call with a local stream */
  answer(stream?: MediaStream): void;

  /** Close the media connection */
  close(): void;

  /** Typed event emitter methods */
  on<K extends keyof MediaConnectionEvents>(
    event: K,
    listener: MediaConnectionEvents[K]
  ): this;
}
```

### DataConnection

```typescript
interface DataConnectionEvents {
  open: () => void;
  data: (data: unknown) => void;
  close: () => void;
  error: (error: Error) => void;
}

declare class DataConnection {
  /** Remote peer ID */
  readonly peer: string;

  /** Whether the DataChannel is open */
  readonly open: boolean;

  /** Send data (MessagePack serialized, chunked, backpressure-aware) */
  send(data: unknown): Promise<void>;

  /** Close the data connection */
  close(): void;

  /** Typed event emitter methods */
  on<K extends keyof DataConnectionEvents>(
    event: K,
    listener: DataConnectionEvents[K]
  ): this;
}
```

### UPeerEvents

```typescript
interface UPeerEvents {
  /** Signaling transport connected, peer is reachable */
  open: (peerId: string) => void;

  /** Signaling transport disconnected */
  close: () => void;

  /** Error occurred */
  error: (error: Error) => void;

  /** Incoming media call from remote peer */
  call: (mediaConnection: MediaConnection) => void;

  /** Remote media stream received */
  stream: (event: { peerId: string; stream: MediaStream; call: MediaConnection }) => void;

  /** Media connection closed */
  hangup: (event: { peerId: string; call: MediaConnection }) => void;

  /** Incoming data connection from remote peer */
  connection: (dataConnection: DataConnection) => void;

  /** Data received on any connection */
  data: (event: { peerId: string; data: unknown; conn: DataConnection }) => void;

  /** Data connection closed */
  dataDisconnect: (event: { peerId: string; conn: DataConnection }) => void;

  /** ICE connection state changed */
  iceConnectionStateChange: (event: {
    peerId: string;
    state: RTCIceConnectionState;
    peerConnection: RTCPeerConnection;
  }) => void;
}
```

### Codec

```typescript
interface ICodec {
  /** Encode data to binary */
  encode(data: unknown): Uint8Array;

  /** Decode binary to data */
  decode(data: Uint8Array): unknown;
}
```

---

## 5. Signaling Protocol

### MQTT Topic Structure

Each peer subscribes to its own peer ID as an MQTT topic:

```
{peerId}    ← peer subscribes here to receive signaling messages
```

To send a signaling message to a peer, publish to their peer ID topic.

### Message Format

Messages are serialized with JSON (on the signaling channel), optionally encrypted with AES-GCM before publishing:

```typescript
// Wire format (JSON → encrypt → MQTT publish)
{
  type: "signaling",
  src: "sender-peer-id",
  data: SignalingItem[]
}
```

### SignalingItem Types

```typescript
// Offer — initiator sends SDP offer
{ type: "offer",     payload: { sdp: RTCSessionDescriptionInit, config?: RTCConfiguration } }

// Answer — responder sends SDP answer
{ type: "answer",    payload: { sdp: RTCSessionDescriptionInit } }

// Candidate — ICE candidate trickle
{ type: "candidate", payload: { candidate: RTCIceCandidateInit } }

// Leave — peer is disconnecting
{ type: "leave",     payload: {} }
```

### Signal Batching

ICE candidates arrive in rapid succession. Sending each as a separate MQTT message wastes bandwidth. The `SignalingBatcher` coalesces them:

- **Debounce window:** 16ms (one frame)
- **Max batch size:** 10 items — flush immediately if exceeded
- **Immediate flush:** Offer and Answer are sent immediately (no batching delay)
- **Explicit flush:** `flush()` method for application-triggered sends

```typescript
class SignalingBatcher {
  private _queue: SignalingItem[] = [];
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _delay = 16;
  private _maxBatch = 10;

  constructor(private _send: (items: SignalingItem[]) => void) {}

  push(item: SignalingItem, options?: { immediate?: boolean }): void {
    this._queue.push(item);

    if (options?.immediate || this._queue.length >= this._maxBatch) {
      this.flush();
    } else {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this.flush(), this._delay);
    }
  }

  flush(): void {
    if (this._queue.length === 0) return;
    const items = this._queue;
    this._queue = [];
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._send(items);
  }

  destroy(): void {
    if (this._timer) clearTimeout(this._timer);
    this._queue = [];
  }
}
```

---

## 6. Connection Modes

### Media + Data (Full WebRTC)

The default mode when calling `peer.call(remotePeerId, localStream)`:

1. Create a single `RTCPeerConnection`
2. Add local MediaStream tracks (audio + video)
3. Create a DataChannel (`dc:upeer`) on the same connection
4. Generate SDP offer and send via signaling
5. Remote peer receives offer, adds their tracks, creates answer
6. ICE candidates trickle via signaling batcher
7. Once connected: media flows via RTP, data flows via DataChannel

```typescript
// Offer constraints
{ offerToReceiveAudio: true, offerToReceiveVideo: true }
```

### Data-Only

When calling `peer.connect(remotePeerId)`:

1. Create a single `RTCPeerConnection`
2. No media tracks added
3. Create a DataChannel (`dc:upeer`)
4. Generate SDP offer with no media
5. Standard ICE negotiation

```typescript
// Offer constraints
{ offerToReceiveAudio: false, offerToReceiveVideo: false }
```

Both modes use the same `RtcSession` — the only difference is whether tracks are added before offer creation.

---

## 7. DataConnection Streaming

### Design

DataConnection wraps RTCDataChannel with the Web Streams API for backpressure-aware streaming:

```
  send(data)
      │
      ▼
  MessagePack encode
      │
      ▼
  TransformStream (32KB chunk splitter)
      │
      ▼
  WritableStream (backpressure-aware sender)
      │
      ▼
  RTCDataChannel.send()

  ════════════════════════

  RTCDataChannel.onmessage
      │
      ▼
  ReadableStream (raw ArrayBuffer)
      │
      ▼
  MessagePack decodeMultiStream (reassembly)
      │
      ▼
  emit('data', decodedObject)
```

### Constants

| Parameter | Value | Rationale |
|---|---|---|
| Chunk size | 32KB (32,768 bytes) | Below SCTP max message size, good throughput |
| Max buffered amount | 8MB (8,388,608 bytes) | Prevent memory exhaustion on slow connections |
| Low-water mark | 4MB (4,194,304 bytes) | Resume sending at 50% of max buffer |

### Backpressure

When `dataChannel.bufferedAmount` exceeds `MAX_BUFFERED_AMOUNT - chunkSize`:

1. Pause writing (await `bufferedamountlow` event)
2. DataChannel fires `bufferedamountlow` when buffer drops below 4MB
3. Resume writing

This prevents memory buildup when the sender is faster than the network.

### Serialization

- **Default:** MessagePack via `@msgpack/msgpack`
  - Binary format, ~30% smaller than JSON for typical payloads
  - Supports all JSON types + binary (Uint8Array, ArrayBuffer)
  - Streaming decode via `decodeMultiStream` for automatic chunk reassembly
- **Fallback:** JSON codec available via `Codec` abstraction

---

## 8. Security

### Signaling Encryption (AES-GCM)

All signaling messages (SDP offers/answers, ICE candidates) pass through an MQTT broker. Without encryption, the broker operator can see:

- SDP containing IP addresses, codec preferences
- ICE candidates with IP addresses and ports

uPeerJS encrypts signaling with AES-GCM:

```
┌──────────────────────────────────────┐
│ Plaintext signaling (JSON)           │
└──────────────┬───────────────────────┘
               │ JSON.encode → Uint8Array
               ▼
┌──────────────────────────────────────┐
│ AES-GCM encrypt                     │
│ • 12-byte random IV (per message)   │
│ • 256-bit key from shared secret    │
│ • Output: [IV (12B) | ciphertext]   │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ MQTT publish (binary payload)        │
└──────────────────────────────────────┘
```

### Key Derivation

The shared secret (e.g., from URL hash `#secretKey`) is imported as a raw AES-GCM key:

```typescript
const raw = new TextEncoder().encode(sharedSecret);
const key = await crypto.subtle.importKey(
  'raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
);
```

> **Note:** For production use with user-chosen passwords, applications should layer PBKDF2 or HKDF on top. uPeerJS accepts any `IEncryption` implementation.

### Media & Data Encryption

- **Media streams:** DTLS-SRTP (WebRTC built-in, always on)
- **DataChannel:** DTLS (WebRTC built-in, always on)
- These are handled by the browser — uPeerJS does not need to implement them.

### Custom Encryption

The `IEncryption` interface allows applications to provide custom encryption:

```typescript
import { UPeer } from 'upeerjs';
import type { IEncryption } from 'upeerjs';

class MyEncryption implements IEncryption {
  readonly ready = true;
  async waitReady() {}
  async encrypt(data: Uint8Array): Promise<Uint8Array> { /* ... */ }
  async decrypt(data: Uint8Array): Promise<Uint8Array> { /* ... */ }
}

// Advanced overload — custom encryption replaces built-in AES-GCM
const peer = new UPeer('id', {
  transport: new MqttTransport({ hostname: '...' }),
  encryption: new MyEncryption(),
});
```

To disable encryption entirely, simply omit the `secretKey` option (simple API) or set `encryption: false` (advanced API).

---

## 9. API Design

### Creating a Peer

```typescript
import { UPeer } from 'upeerjs';

// Minimal — auto-generated ID, no encryption, default MQTT broker
const peer = new UPeer();

// With peer ID + encryption
const peer = new UPeer('my-peer-id', { secretKey: 'shared-secret' });

// With custom MQTT broker
const peer = new UPeer('my-peer-id', {
  secretKey: 'shared-secret',
  mqtt: { hostname: 'mqtt.example.com', port: 8084 },
});

// With custom ICE servers
const peer = new UPeer('my-peer-id', {
  secretKey: 'shared-secret',
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:turn.example.com', username: 'user', credential: 'pass' },
  ],
});
```

If no peer ID is provided, one is auto-generated via nanoid:

```typescript
const peer = new UPeer();
// peer.id → "V1StGXR8_Z5jdHi6B-myT"
```

### Connection Events

```typescript
// Signaling connected
peer.on('open', (id) => {
  console.log('My peer ID is:', id);
});

// Incoming media call
peer.on('call', (mediaConn) => {
  // Answer with local stream
  mediaConn.answer(localStream);

  // Receive remote stream
  mediaConn.on('stream', (remoteStream) => {
    videoElement.srcObject = remoteStream;
  });
});

// Incoming data connection
peer.on('connection', (dataConn) => {
  dataConn.on('data', (data) => {
    console.log('Received:', data);
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
const call = peer.call('remote-peer-id', localStream);

call.on('stream', (remoteStream) => {
  videoElement.srcObject = remoteStream;
});

call.on('close', () => {
  console.log('Call ended');
});
```

### Data-Only Connection

```typescript
const conn = peer.connect('remote-peer-id');

conn.on('open', () => {
  conn.send({ hello: 'world' });
  conn.send(new Uint8Array([1, 2, 3])); // Binary data supported
});

conn.on('data', (data) => {
  console.log('Received:', data);
});
```

### Replacing Media Tracks

```typescript
// Replace video track (e.g., switch camera)
peer.replaceTrack('remote-peer-id', 'video', newVideoTrack);

// Replace audio track (e.g., switch microphone)
peer.replaceTrack('remote-peer-id', 'audio', newAudioTrack);
```

### Broadcasting Data

```typescript
// Send to all connected peers
peer.broadcast({ type: 'chat', message: 'Hello everyone!' });

// Send to all except specific peers
peer.broadcast(data, { excludeId: ['peer-to-skip'] });
```

### Cleanup

```typescript
// Hang up a specific call
peer.hangup('remote-peer-id');

// Disconnect a data connection
peer.disconnect('remote-peer-id');

// Destroy the peer (close all connections + signaling)
peer.destroy();
```

### Full UPeer API Summary

```typescript
class UPeer {
  /** The local peer ID */
  readonly id: string;

  /** All active media connections */
  readonly mediaConnections: ReadonlyMap<string, MediaConnection>;

  /** All active data connections */
  readonly dataConnections: ReadonlyMap<string, DataConnection>;

  /** Simple API: peerId + secretKey */
  constructor(id?: string, options?: UPeerOptions);
  /** Advanced API: custom transport/encryption */
  constructor(id?: string, options?: UPeerAdvancedOptions);

  /** Start signaling and listen for connections */
  start(): Promise<void>;

  /** Call a remote peer with a media stream (creates media + data connection) */
  call(remotePeerId: string, stream: MediaStream): MediaConnection;

  /** Open a data-only connection to a remote peer */
  connect(remotePeerId: string): DataConnection;

  /** Send data to a specific peer */
  send(peerId: string, data: unknown): void;

  /** Broadcast data to all connected peers */
  broadcast(data: unknown, options?: { excludeId?: string[] }): void;

  /** Replace a media track for a specific peer */
  replaceTrack(peerId: string, kind: 'audio' | 'video', track: MediaStreamTrack): void;

  /** Hang up a media connection */
  hangup(peerId: string): void;

  /** Disconnect a data connection */
  disconnect(peerId: string): void;

  /** Destroy the peer — close all connections and signaling */
  destroy(): void;

  /** Typed event emitter */
  on<K extends keyof UPeerEvents>(event: K, listener: UPeerEvents[K]): this;
  off<K extends keyof UPeerEvents>(event: K, listener: UPeerEvents[K]): this;
  once<K extends keyof UPeerEvents>(event: K, listener: UPeerEvents[K]): this;
}
```

---

## 10. Comparison with Current uIPCat Code

This table maps existing uIPCat composables to uPeerJS components:

| uIPCat Source | uPeerJS Component | Included? | Notes |
|---|---|---|---|
| `overMQTT.ts` → `OverMQTT` | `MqttTransport` + `AesGcmEncryption` | Yes | Split into transport + encryption |
| `peerClient.ts` → `PeerClient` | `UPeer` | Yes | Without `notify()` / `watch()` (app layer) |
| `mediaconnection.ts` → `MediaConnection` | `MediaConnection` + `RtcSession` | Yes | Merged negotiator into RtcSession |
| `negotiator.ts` → `Negotiator` | `RtcSession` | Yes | Unified with MediaConnection |
| `StreamConnection.ts` → `StreamConnection` | `DataConnection` | Yes | Same streaming/backpressure design |
| `jsonpack.ts` → `Encoder/Decoder` | `Codec` (pluggable) | Yes | Default: MessagePack |
| `peerClient.ts` → `notify()` / `watch()` | — | **No** | Application layer concern |
| Msgbus / RpcBus / SyncBus | — | **No** | Application layer concern |
| Motion detection, recording | — | **No** | Application layer concern |

### Key Refactoring Decisions

1. **OverMQTT → MqttTransport + AesGcmEncryption**: The current `OverMQTT` mixes MQTT transport with AES-GCM encryption. uPeerJS separates these into two pluggable interfaces.

2. **MediaConnection + Negotiator → RtcSession**: The current split between `MediaConnection` (state) and `Negotiator` (RTCPeerConnection management) is merged into `RtcSession` which owns the full connection lifecycle. `MediaConnection` becomes a thin event-emitting wrapper.

3. **Signal batching extracted**: The current signal queue in `MediaConnection` becomes a standalone `SignalingBatcher` that can be reused and tested independently.

4. **PeerClient → UPeer**: Drops `notify()` and `watch()` (MQTT pub/sub for presence) — these are uIPCat-specific and belong in the application layer.

---

## 11. Usage Examples

### Basic Video Call (Browser to Browser)

```typescript
import { UPeer } from 'upeerjs';

// --- Peer A (caller) ---
const peerA = new UPeer('alice', { secretKey: 'room-secret' });
await peerA.start();

const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const call = peerA.call('bob', localStream);

call.on('stream', (remoteStream) => {
  document.querySelector<HTMLVideoElement>('#remote')!.srcObject = remoteStream;
});

// --- Peer B (callee) ---
const peerB = new UPeer('bob', { secretKey: 'room-secret' });
await peerB.start();

peerB.on('call', async (mediaConn) => {
  const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  mediaConn.answer(localStream);
  mediaConn.on('stream', (remoteStream) => {
    document.querySelector<HTMLVideoElement>('#remote')!.srcObject = remoteStream;
  });
});
```

### Data-Only Connection (File Transfer)

```typescript
import { UPeer } from 'upeerjs';

// Sender
const sender = new UPeer('sender', { secretKey: 'file-key' });
await sender.start();
const conn = sender.connect('receiver');

conn.on('open', async () => {
  const file = await fetch('/large-file.bin').then(r => r.arrayBuffer());
  // Automatically chunked and backpressure-managed
  await conn.send(new Uint8Array(file));
});

// Receiver
const receiver = new UPeer('receiver', { secretKey: 'file-key' });
await receiver.start();

receiver.on('connection', (dataConn) => {
  dataConn.on('data', (data) => {
    console.log('Received file:', data);
  });
});
```

### Custom Transport (Advanced)

```typescript
import type { ISignalingTransport, SignalingMessage } from 'upeerjs';
import { UPeer } from 'upeerjs';

class WebSocketTransport implements ISignalingTransport {
  private _ws: WebSocket | null = null;
  private _handler: ((msg: SignalingMessage) => void) | null = null;

  get connected() { return this._ws?.readyState === WebSocket.OPEN; }

  async connect(peerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(`wss://signal.example.com/${peerId}`);
      this._ws.onopen = () => resolve();
      this._ws.onerror = (e) => reject(e);
      this._ws.onmessage = (e) => {
        this._handler?.(JSON.parse(e.data));
      };
    });
  }

  async send(peerId: string, message: SignalingMessage): Promise<void> {
    this._ws?.send(JSON.stringify({ to: peerId, ...message }));
  }

  onMessage(handler: (message: SignalingMessage) => void): void {
    this._handler = handler;
  }

  disconnect(): void {
    this._ws?.close();
    this._ws = null;
  }
}

// Advanced overload — custom transport replaces built-in MQTT
const peer = new UPeer('my-id', { transport: new WebSocketTransport() });
```

### Integration with Vue (Application Layer Pattern)

```typescript
// composables/usePeer.ts
import { ref, onUnmounted } from 'vue';
import { UPeer } from 'upeerjs';

export function usePeer(peerId: string, secretKey: string) {
  const remoteStreams = ref<Map<string, MediaStream>>(new Map());
  const connected = ref(false);

  const peer = new UPeer(peerId, { secretKey });

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
import { UPeer } from 'upeerjs';

export function usePeer(peerId: string, secretKey: string) {
  const peerRef = useRef<UPeer | null>(null);
  const [connected, setConnected] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

  useEffect(() => {
    const peer = new UPeer(peerId, { secretKey });

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
  }, [peerId, secretKey]);

  return { peer: peerRef, connected, remoteStreams };
}
```
