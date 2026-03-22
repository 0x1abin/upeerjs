import type { IClientOptions } from "mqtt";

// ── Signaling ──

export enum SignalingType {
	Candidate = "candidate",
	Offer = "offer",
	Answer = "answer",
}

export interface SignalingMessage {
	type: SignalingType;
	data: unknown;
	src: string;
}

// ── Codec ──

export interface ICodec {
	encode(data: unknown): Uint8Array;
	decode(data: Uint8Array): unknown;
}

// ── Encryption ──

export interface IEncryption {
	readonly ready: boolean;
	waitReady(): Promise<void>;
	encrypt(data: Uint8Array): Promise<Uint8Array>;
	decrypt(data: Uint8Array): Promise<Uint8Array>;
}

// ── Transport ──

export type TransportMessageHandler = (message: SignalingMessage) => void;

export interface ISignalingTransport {
	readonly connected: boolean;
	connect(): void;
	send(peerId: string, data: Uint8Array): void;
	onMessage(handler: TransportMessageHandler): void;
	disconnect(): void;
}

// ── Options ──

export interface PeerOptions {
	/** MQTT broker URL (wss://...). Defaults to wss://broker.emqx.io:8084/mqtt */
	brokerUrl?: string;
	/** Optional MQTT client options */
	mqttOptions?: Omit<IClientOptions, "will">;
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

// ── Events ──

export interface PeerEvents {
	open: (peerId: string) => void;
	close: () => void;
	error: (err: unknown) => void;
	call: (event: { peerId: string; call: unknown }) => void;
	stream: (event: { peerId: string; stream: MediaStream; call: unknown }) => void;
	hangup: (event: { peerId: string; call: unknown }) => void;
	dataConnection: (event: { peerId: string; conn: unknown }) => void;
	data: (event: { peerId: string; data: Uint8Array; conn: unknown }) => void;
	dataDisconnect: (event: { peerId: string; conn: unknown }) => void;
	iceConnectionStateChange: (event: {
		peerId: string;
		iceConnectionState: RTCIceConnectionState;
		peerConnection: RTCPeerConnection;
	}) => void;
}

export interface MediaConnectionEvents {
	stream: (stream: MediaStream) => void;
	close: () => void;
	iceStateChanged: (state: RTCIceConnectionState) => void;
}

export interface DataConnectionEvents {
	open: () => void;
	data: (data: Uint8Array) => void;
	close: () => void;
}
