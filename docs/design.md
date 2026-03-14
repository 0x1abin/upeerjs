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
│ Peer (connection orchestrator)          │
├─────────────────────────────────────────┤
│ RtcSession        │  DataConnection     │
│ (RTCPeerConnection│  (DataChannel)      │
│  + media tracks)  │                     │
├───────────────────┴─────────────────────┤
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
| **Peer** | Entry point. Creates/manages sessions, data connections, routes signaling messages, emits typed events. Extends EventEmitter3. |
| **RtcSession** | Manages a single RTCPeerConnection lifecycle: offer/answer creation, ICE candidate handling, track management, DataChannel creation. One per remote peer. Emits `stream`, `iceStateChanged`, `close`, `signaling`, `dataChannel` events. |
| **DataConnection** | Wraps RTCDataChannel with streaming, backpressure, chunking, and MessagePack serialization. |
| **SignalingBatcher** | Batches signaling items (SDP, ICE candidates) with 16ms debounce to reduce MQTT messages. |
| **MqttTransport** | Default `ISignalingTransport` implementation. Publishes/subscribes to MQTT topics for signaling. Extends EventEmitter3, emits `open`, `close`, `error`, `disconnected`. |
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
│   │   └── signaling-batcher.ts  # Signal batching/debounce
│   │
│   ├── data/
│   │   └── data-connection.ts    # DataChannel wrapper with streaming
│   │
│   └── util/
│       ├── id-generator.ts       # nanoid peer ID generation
│       ├── codec.ts              # JSON codec (default)
│       └── constants.ts          # VERSION, DEFAULT_RTC_CONFIG
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

  /** Custom codec for signaling messages (default: JSON) */
  codec?: ICodec;

  /** Custom encryption implementation */
  encryption?: IEncryption;

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
  Leave = 'leave',
}

interface SignalingMessage {
  /** Message type identifier */
  type: 'signaling';

  /** Source peer ID */
  src: string;

  /** Batched signaling items */
  data: SignalingItem[];
}

interface SignalingItem {
  type: SignalingType;
  payload: any;
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
  data: (event: { peerId: string; data: any; conn: DataConnection }) => void;

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
  signaling: (items: SignalingItem[]) => void;
  dataChannel: (dc: RTCDataChannel) => void;
}
```

### DataConnectionEvents

```typescript
interface DataConnectionEvents {
  open: () => void;
  data: (data: any) => void;
  close: () => void;
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

Messages are serialized with the codec (default: JSON), optionally encrypted with AES-GCM before publishing:

```typescript
// Wire format (Codec.encode → encrypt → MQTT publish)
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
- **Flush threshold:** 10 items — flush immediately if exceeded (queue.length > threshold)
- **Immediate flush:** Offer and Answer are sent immediately (no batching delay)

```typescript
class SignalingBatcher {
  private _queue: SignalingItem[] = [];
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _delay: number;
  private _flushThreshold: number;
  private _onFlush: (items: SignalingItem[]) => void;

  constructor(
    onFlush: (items: SignalingItem[]) => void,
    delay: number = 16,
    flushThreshold: number = 10,
  ) { ... }

  push(type: SignalingType, payload: any, immediate?: boolean): void {
    this._queue.push({ type, payload });

    if (immediate || this._queue.length > this._flushThreshold) {
      this._flush();
    } else {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this._flush(), this._delay);
    }
  }

  private _flush(): void { ... }
  destroy(): void { ... }
}
```

---

## 6. Connection Modes

### Media + Data (Full WebRTC)

The default mode when calling `peer.call(remotePeerId, stream)`:

1. Create a single `RTCPeerConnection`
2. Add local MediaStream tracks (audio + video) if provided
3. Add `recvonly` transceivers for audio/video if not already present
4. Create a DataChannel (`dc:upeer`) on the same connection
5. Generate SDP offer and send via signaling
6. Remote peer receives offer, adds their tracks, creates answer
7. ICE candidates trickle via signaling batcher
8. Once connected: media flows via RTP, data flows via DataChannel

If no stream is passed, it falls back to `peer.localStream` if set.

### Data-Only

When calling `peer.connect(remotePeerId)`:

1. Create a single `RTCPeerConnection`
2. No media tracks or recvonly transceivers added
3. Create a DataChannel (`dc:upeer`)
4. Generate SDP offer with no media
5. Standard ICE negotiation

Both modes use the same `RtcSession` — the only difference is whether tracks are added and whether recvonly transceivers are created before offer creation.

---

## 7. DataConnection Streaming

### Design

DataConnection wraps RTCDataChannel with the Web Streams API for backpressure-aware streaming:

```
  send(data)
      │
      ▼
  MessagePack encode (via @msgpack/msgpack Encoder)
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

When `dataChannel.bufferedAmount` exceeds `MAX_BUFFERED_AMOUNT - chunkByteLength`:

1. Pause writing (await `bufferedamountlow` event)
2. DataChannel fires `bufferedamountlow` when buffer drops below 4MB
3. Resume writing

This prevents memory buildup when the sender is faster than the network.

### Serialization

- **Signaling channel:** JSON codec (default) via `JsonCodec` — pluggable via `ICodec` interface
- **DataChannel:** MessagePack via `@msgpack/msgpack`
  - Binary format, ~30% smaller than JSON for typical payloads
  - Supports all JSON types + binary (Uint8Array, ArrayBuffer)
  - Streaming decode via `decodeMultiStream` for automatic chunk reassembly

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
               │ Codec.encode → Uint8Array
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

The security key is imported as a raw AES-GCM key:

```typescript
const raw = new TextEncoder().encode(securityKey);
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
  conn.on('data', (data) => {
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
    conn.send({ hello: 'world' });
    conn.send(new Uint8Array([1, 2, 3])); // Binary data supported
  });
});

// Or use the convenience method
peer.send('remote-peer-id', { hello: 'world' });
```

### Replacing Media Tracks

```typescript
// Replace all tracks from a new stream
peer.replaceTrack('remote-peer-id', newStream);

// Set local stream and update all active sessions
peer.setLocalStream(newStream);
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

  /** Send data to a specific peer via DataChannel */
  send(peerId: string, data: any): void;

  /** Broadcast data to all connected peers */
  broadcast(data: any, options?: { excludeId?: string[] }): void;

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
| `StreamConnection.ts` → `StreamConnection` | `DataConnection` | Yes | Same streaming/backpressure design |
| `jsonpack.ts` → `Encoder/Decoder` | `JsonCodec` (pluggable via `ICodec`) | Yes | Default: JSON, DataChannel uses MessagePack |
| `peerClient.ts` → `notify()` / `watch()` | — | **No** | Application layer concern |
| Msgbus / RpcBus / SyncBus | — | **No** | Application layer concern |
| Motion detection, recording | — | **No** | Application layer concern |

### Key Refactoring Decisions

1. **OverMQTT → MqttTransport + AesGcmEncryption**: The current `OverMQTT` mixes MQTT transport with AES-GCM encryption. uPeerJS separates these into two pluggable interfaces.

2. **MediaConnection + Negotiator → RtcSession**: The current split between `MediaConnection` (state) and `Negotiator` (RTCPeerConnection management) is merged into `RtcSession` which owns the full connection lifecycle. There is no separate `MediaConnection` class — `RtcSession` handles media tracks, DataChannel, and signaling.

3. **Signal batching extracted**: The current signal queue in `MediaConnection` becomes a standalone `SignalingBatcher` that can be reused and tested independently.

4. **PeerClient → Peer**: Drops `notify()` and `watch()` (MQTT pub/sub for presence) — these are uIPCat-specific and belong in the application layer.

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

### Data-Only Connection (File Transfer)

```typescript
import { Peer } from 'upeerjs';

// Sender
const sender = new Peer('sender', { securityKey: 'file-key' });
sender.start();
const session = sender.connect('receiver');

sender.on('dataConnection', ({ conn }) => {
  const file = await fetch('/large-file.bin').then(r => r.arrayBuffer());
  // Automatically chunked and backpressure-managed
  await conn.send(new Uint8Array(file));
});

// Receiver
const receiver = new Peer('receiver', { securityKey: 'file-key' });
receiver.start();

receiver.on('dataConnection', ({ conn }) => {
  conn.on('data', (data) => {
    console.log('Received file:', data);
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
