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
import { Peer } from 'upeerjs';

const peer = new Peer('alice', { securityKey: 'shared-secret' });
peer.start();

// Make a call
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const session = peer.call('bob', stream);

// Receive remote stream
peer.on('stream', ({ peerId, stream: remote }) => {
  video.srcObject = remote;
});

// Receive a call
peer.on('call', ({ peerId, call }) => {
  // call is an RtcSession — remote stream arrives via the 'stream' event on Peer
});
```

### Data Only

```typescript
const session = peer.connect('bob');

peer.on('dataConnection', ({ peerId, conn }) => {
  conn.on('data', (data) => console.log(data));
});

// Send data to a specific peer
peer.send('bob', { hello: 'world' });
```

## Features

- **Serverless** — MQTT broker for signaling, no custom server needed
- **E2E Encrypted** — AES-GCM encryption on signaling (SDP, ICE candidates)
- **Streaming DataChannel** — Web Streams API with backpressure and 32KB chunking
- **MessagePack** — Binary serialization, ~30% smaller than JSON
- **Single Connection** — Media + DataChannel over one RTCPeerConnection
- **Pluggable** — Swap codec (JSON → custom) or encryption (AES-GCM → custom)
- **TypeScript** — Full type safety with typed events

## Architecture

```
Application (RPC, state sync, business logic)
    │
    ▼
Peer (connection orchestrator)
    ├── RtcSession (RTCPeerConnection lifecycle)
    ├── DataConnection (DataChannel + streaming)
    ├── SignalingBatcher (16ms debounce)
    ├── MqttTransport (MQTT-over-WebSocket signaling)
    └── AesGcmEncryption (E2E encryption)
```

## API

### `new Peer(id?, options)`

Create a peer instance. Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `brokerUrl` | `string` | `'wss://broker.emqx.io:8084/mqtt'` | MQTT broker URL |
| `mqttOptions` | `IClientOptions` | — | Additional MQTT client options |
| `securityKey` | `string` | — | E2E encryption key (AES-GCM) |
| `rtcConfig` | `RTCConfiguration` | Google STUN + Cloudflare STUN + PeerJS TURN | WebRTC configuration |
| `codec` | `ICodec` | `JsonCodec` | Custom codec for signaling |
| `encryption` | `IEncryption` | — | Custom encryption implementation |
| `debug` | `boolean` | `false` | Enable debug logging |

### `peer.start()`

Connect to the MQTT signaling broker. Emits `'open'` when connected.

### `peer.call(peerId, stream?)` → `RtcSession`

Initiate a media + data call to a peer.

### `peer.connect(peerId)` → `RtcSession`

Open a data-only connection.

### `peer.send(peerId, data)`

Send data to a specific peer via DataChannel.

### `peer.broadcast(data, options?)`

Send data to all connected peers.

### `peer.replaceTrack(peerId, stream)`

Replace media tracks for a specific peer (takes a full MediaStream).

### `peer.setLocalStream(stream)`

Set local stream and update all active sessions.

### `peer.hangup(peerId)` / `peer.dataDisconnect(peerId)`

Close a specific peer connection.

### `peer.destroy()`

Close all connections and signaling.

### Events

| Event | Payload |
|---|---|
| `open` | `peerId: string` |
| `call` | `{ peerId, call: RtcSession }` |
| `stream` | `{ peerId, stream: MediaStream, call: RtcSession }` |
| `hangup` | `{ peerId, call: RtcSession }` |
| `dataConnection` | `{ peerId, conn: DataConnection }` |
| `data` | `{ peerId, data, conn: DataConnection }` |
| `dataDisconnect` | `{ peerId, conn: DataConnection }` |
| `iceConnectionStateChange` | `{ peerId, iceConnectionState, peerConnection }` |
| `close` | — |
| `error` | `Error` |

## Design Document

See [docs/design.md](docs/design.md) for full architecture, interfaces, protocol specs, and usage examples.

## License

MIT
