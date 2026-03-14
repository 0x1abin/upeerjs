# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

uPeerJS is a serverless P2P communication library for the browser. It uses MQTT for WebRTC signaling (no custom server needed), AES-GCM E2E encryption on signaling messages, and streaming DataChannel with backpressure. Think PeerJS but with pluggable transport and encryption.

For full architecture details, interface specs, protocol design, and usage examples, see [docs/design.md](docs/design.md).

## Commands

```bash
npm install           # Install dependencies
npm run build         # Build with tsdown (ESM + CJS + .d.ts)
npm test              # Run all tests (vitest)
npm test -- test/util/Codec.test.ts  # Run a single test file
npm run typecheck     # Type-check without emitting
npm run dev           # Watch mode build
```

## Architecture

The library is a layered stack where `UPeer` orchestrates everything:

- **UPeer** (`src/UPeer.ts`) — Top-level API. Manages sessions, data connections, and signaling transport. Extends EventEmitter3. Constructor accepts either `(options)` or `(peerId, options)`.
- **RtcSession** (`src/connection/RtcSession.ts`) — Wraps a single `RTCPeerConnection` lifecycle (offer/answer, ICE, media tracks, DataChannel creation). One per remote peer.
- **SignalingBatcher** (`src/connection/SignalingBatcher.ts`) — Debounces signaling messages (ICE candidates) into batched sends at 16ms intervals.
- **DataConnection** (`src/data/DataConnection.ts`) — Wraps `RTCDataChannel` with EventEmitter events (`open`, `data`, `close`).
- **MqttTransport** (`src/transport/MqttTransport.ts`) — Default `ISignalingTransport` implementation. Publishes/subscribes to MQTT topics for peer-to-peer signaling.
- **AesGcmEncryption** (`src/security/AesGcmEncryption.ts`) — Default `IEncryption` implementation using Web Crypto AES-GCM.

### Key interfaces (in `src/types.ts`)

- `ISignalingTransport` — pluggable transport (connect, send, onMessage, disconnect)
- `IEncryption` — pluggable encryption (encrypt/decrypt Uint8Array, async ready)
- `ICodec` — pluggable serialization (encode/decode, default is JSON)

### Data flow

Signaling: `UPeer → Codec.encode → Encryption.encrypt → MqttTransport → MQTT broker → remote peer (reverse path)`

Media/Data: `UPeer.call()/connect() → RtcSession (creates RTCPeerConnection) → DataConnection wraps the DataChannel`

## Build

Uses `tsdown` (not `tsup`). Config in `tsdown.config.ts`. Outputs ESM, CJS, and declaration files to `dist/`. The build script copies `.d.ts` files due to tsdown naming conventions.

## Testing

Tests mirror `src/` structure under `test/`. Vitest with no special config file (uses defaults). Tests run in Node — WebRTC/browser APIs are mocked in test files.
