# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

uPeerJS is a serverless P2P communication library for the browser. It uses MQTT for WebRTC signaling (no custom server needed), AES-GCM E2E encryption on signaling messages, and raw DataChannel transport with backpressure. Think PeerJS but with pluggable transport and encryption. upeerjs provides raw `send(Uint8Array)` — application-level framing and serialization (e.g., cluster protocol) is handled by upper layers.

For full architecture details, interface specs, protocol design, and usage examples, see [docs/design.md](docs/design.md).

## Commands

```bash
npm install           # Install dependencies
npm run build         # Build with tsdown (ESM + CJS + .d.ts)
npm test              # Run all tests (vitest)
npm test -- test/util/codec.test.ts  # Run a single test file
npm run typecheck     # Type-check without emitting
npm run dev           # Watch mode build
```

## Architecture

The library is a layered stack where `Peer` orchestrates everything:

- **Peer** (`src/peer.ts`) — Top-level API. Manages sessions, data connections, and signaling transport. Extends EventEmitter3. Constructor accepts either `(options)` or `(peerId, options)`.
- **RtcSession** (`src/connection/rtc-session.ts`) — Wraps a single `RTCPeerConnection` lifecycle (offer/answer, ICE, media tracks, DataChannel creation). One per remote peer.
- **SignalingBatcher** (`src/connection/signaling-batcher.ts`) — Thin pass-through that forwards each signaling message immediately. No batching or debouncing.
- **DataConnection** (`src/data/data-connection.ts`) — Thin wrapper around `RTCDataChannel` with backpressure. Sends/receives raw `Uint8Array` — no framing or serialization.
- **MqttTransport** (`src/transport/mqtt-transport.ts`) — Default `ISignalingTransport` implementation. Publishes/subscribes to MQTT topics for peer-to-peer signaling and encrypted broadcast (`{nodeId}:ff`). Extends EventEmitter3.
- **AesGcmEncryption** (`src/security/aes-gcm-encryption.ts`) — Default `IEncryption` implementation using Web Crypto AES-GCM.
- **Constants** (`src/util/constants.ts`) — `VERSION` and `DEFAULT_RTC_CONFIG`.
- **Logger** (`src/util/logger.ts`) — Structured logging with `LogLevel` enum and `createLogger(tag, debug?)` factory.

### Key interfaces (in `src/types.ts`)

- `ISignalingTransport` — pluggable transport (`connect()`, `send(peerId, data: Uint8Array)`, `onMessage`, `disconnect`)
- `IEncryption` — pluggable encryption (encrypt/decrypt Uint8Array, async ready)
- `ICodec` — pluggable serialization (encode/decode, default is `JsonCodec`)
- `PeerOptions` — configuration with `brokerUrl`, `securityKey`, `rtcConfig`, `codec`, `encryption`, `dataChannelLabel`, `dataChannelInit`, `debug`. Note: `publish()` uses `this.peerId` as the broadcast channel — no separate `nodeId` option needed.
- `PeerEvents` — typed events: `open`, `close`, `error`, `call`, `stream`, `hangup`, `dataConnection`, `data`, `dataDisconnect`, `iceConnectionStateChange`

### Data flow

Signaling: `Peer → Codec.encode → MqttTransport.send → Encryption.encrypt → MQTT broker → remote peer (reverse path)`

Media/Data: `Peer.call()/connect() → RtcSession (creates RTCPeerConnection + negotiated _ctrl channel) → DataConnection wraps the application DataChannel (dc:upeer). Upper layers can create additional negotiated DataChannels via session.peerConnection`

Heartbeat: `Peer → msgpack({ ts }) → session.controlChannel (negotiated, id: 0) → remote Peer decodes → replies { ts, pong: true }`

Broadcast: `Peer.publish(topic, data) → Codec.encode({t, d}) → MqttTransport.publishBroadcast(peerId, ...) → Encryption.encrypt → MQTT {peerId}:ff`

## Build

Uses `tsdown` (not `tsup`). Config in `tsdown.config.ts`. Outputs ESM, CJS, and declaration files to `dist/`.

## Logging

All logging uses `Logger` from `src/util/logger.ts` — no raw `console.*` calls.

- `PeerOptions.debug: true` → Logger set to `LogLevel.Debug` (verbose connection/ICE/MQTT logs)
- `PeerOptions.debug: false` (default) → `LogLevel.Warnings` (only errors and warnings)
- Tag: `upeer` (Peer shares its logger with RtcSession and MqttTransport via constructor injection)
- Fallback tags when constructed standalone: `upeer:mqtt`, `upeer:rtc`, `upeer:dc`
- Output format: `D [upeer]: ICE state: connected for abc123`

## Testing

Tests mirror `src/` structure under `test/`. Vitest with no special config file (uses defaults). Tests run in Node — WebRTC/browser APIs are mocked in test files.
