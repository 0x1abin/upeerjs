# uPeerJS

Serverless P2P communication library for the browser. Inspired by [PeerJS](https://github.com/peers/peerjs), but **no dedicated signaling server required** — just connect to any existing MQTT broker and start communicating peer-to-peer.

## Why uPeerJS?

PeerJS requires you to deploy and maintain a dedicated [PeerServer](https://github.com/peers/peerjs-server) for signaling. uPeerJS eliminates this dependency entirely by using MQTT as the signaling transport. Any public or private MQTT-over-WebSocket broker (EMQX, Mosquitto, HiveMQ, etc.) can serve as the signaling layer — **zero backend code, zero server deployment**.

| | PeerJS | uPeerJS |
|---|---|---|
| **Signaling** | Requires dedicated PeerServer | Any MQTT broker — no custom server |
| **Encryption** | None on signaling | AES-GCM E2E |
| **DataChannel** | Basic send/receive | Streaming + backpressure + MessagePack |
| **Transport** | Hardcoded WebSocket | Pluggable (MQTT default) |

## Install

```bash
pnpm add upeerjs
```

## Quick Start

### Video Call

```typescript
import { UPeer } from 'upeerjs';

const peer = new UPeer('alice', { secretKey: 'shared-secret' });
await peer.start();

// Make a call
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const call = peer.call('bob', stream);
call.on('stream', (remote) => { video.srcObject = remote; });

// Receive a call
peer.on('call', (conn) => {
  conn.answer(localStream);
  conn.on('stream', (remote) => { video.srcObject = remote; });
});
```

### Data Only

```typescript
const conn = peer.connect('bob');
conn.on('open', () => conn.send({ hello: 'world' }));

peer.on('connection', (conn) => {
  conn.on('data', (data) => console.log(data));
});
```

## Features

- **Serverless** — MQTT broker for signaling, no custom server needed
- **E2E Encrypted** — AES-GCM encryption on signaling (SDP, ICE candidates)
- **Streaming DataChannel** — Web Streams API with backpressure and 32KB chunking
- **MessagePack** — Binary serialization, ~30% smaller than JSON
- **Single Connection** — Media + DataChannel over one RTCPeerConnection
- **Pluggable** — Swap transport (MQTT → WebSocket) or encryption (AES-GCM → custom)
- **TypeScript** — Full type safety with typed events

## Architecture

```
Application (RPC, state sync, business logic)
    │
    ▼
UPeer (connection orchestrator)
    ├── MediaConnection (WebRTC media)
    ├── DataConnection (DataChannel + streaming)
    ├── RtcSession (RTCPeerConnection lifecycle)
    ├── SignalingBatcher (16ms debounce)
    ├── ISignalingTransport ← MqttTransport
    └── IEncryption ← AesGcmEncryption
```

## API

### `new UPeer(id?, options)`

Create a peer instance.

### `peer.call(remotePeerId, stream)` → `MediaConnection`

Call a remote peer with media.

### `peer.connect(remotePeerId)` → `DataConnection`

Open a data-only connection.

### `peer.send(peerId, data)`

Send data to a specific peer.

### `peer.broadcast(data, options?)`

Send data to all connected peers.

### `peer.replaceTrack(peerId, kind, track)`

Replace a media track without renegotiation.

### Events

| Event | Payload |
|---|---|
| `open` | `peerId: string` |
| `call` | `MediaConnection` |
| `connection` | `DataConnection` |
| `stream` | `{ peerId, stream, call }` |
| `data` | `{ peerId, data, conn }` |
| `close` | — |
| `error` | `Error` |

## Design Document

See [docs/design.md](docs/design.md) for full architecture, interfaces, protocol specs, and usage examples.

## License

MIT
