import { EventEmitter } from "eventemitter3";
import type {
	IBroadcastTransport,
	ICodec,
	IEncryption,
	ISignalingTransport,
	SignalingMessage,
	TransportMessageHandler,
} from "../types";
import type { Logger } from "../util/logger";

/** Binary frame types for the WebSocket signaling protocol */
const FrameType = {
	Register: 0x01,
	Signaling: 0x02,
	BroadcastSubscribe: 0x03,
	BroadcastUnsubscribe: 0x04,
	BroadcastPublish: 0x05,
	Ping: 0x06,
} as const;

/** Token bucket rate limiter (same as MqttTransport) */
class TokenBucket {
	private _tokens: number;
	private _capacity: number;
	private _refillRate: number;
	private _lastRefill: number;

	constructor(capacity: number, refillRate: number) {
		this._capacity = capacity;
		this._tokens = capacity;
		this._refillRate = refillRate;
		this._lastRefill = Date.now();
	}

	consume(): boolean {
		this._refill();
		if (this._tokens >= 1) {
			this._tokens -= 1;
			return true;
		}
		return false;
	}

	private _refill(): void {
		const now = Date.now();
		const elapsed = (now - this._lastRefill) / 1000;
		this._tokens = Math.min(this._capacity, this._tokens + elapsed * this._refillRate);
		this._lastRefill = now;
	}
}

export class WsTransport
	extends EventEmitter
	implements ISignalingTransport, IBroadcastTransport
{
	private _ws: WebSocket | undefined;
	private _peerId: string;
	private _url: string;
	private _codec: ICodec;
	private _encryption: IEncryption | undefined;
	private _log: Logger;
	private _messageHandler: TransportMessageHandler | undefined;
	private _broadcastHandler: ((nodeId: string, data: Uint8Array) => void) | undefined;
	private _connected = false;
	private _intentionalClose = false;
	private _messagesQueue: Uint8Array[] = [];
	private _rateLimiter: TokenBucket;
	private _pingTimer: ReturnType<typeof setInterval> | undefined;

	// Reconnection state
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _reconnectDelay = 1000;
	private static readonly MAX_RECONNECT_DELAY = 30_000;

	// Broadcast subscriptions to restore on reconnect
	private _broadcastSubscriptions = new Set<string>();

	private static readonly MAX_QUEUE_SIZE = 128;
	private static readonly PING_INTERVAL_MS = 30_000;

	private static readonly _encoder = new TextEncoder();
	private static readonly _decoder = new TextDecoder();

	get connected(): boolean {
		return this._connected;
	}

	constructor(
		peerId: string,
		url: string,
		codec: ICodec,
		encryption?: IEncryption,
		logger?: Logger,
	) {
		super();
		this._peerId = peerId;
		this._url = url;
		this._codec = codec;
		this._encryption = encryption;
		this._log = logger ?? ({ debug() {}, warn() {}, error() {} } as unknown as Logger);
		this._rateLimiter = new TokenBucket(50, 10);
	}

	onMessage(handler: TransportMessageHandler): void {
		this._messageHandler = handler;
	}

	onBroadcast(handler: (nodeId: string, data: Uint8Array) => void): void {
		this._broadcastHandler = handler;
	}

	connect(): void {
		if (this._ws) {
			this._log.warn("Already connected");
			return;
		}

		this._intentionalClose = false;
		this._doConnect();
	}

	subscribeBroadcast(nodeId: string): () => void {
		this._broadcastSubscriptions.add(nodeId);

		if (this._connected && this._ws) {
			const nodeIdBytes = WsTransport._encoder.encode(nodeId);
			const frame = new Uint8Array(1 + nodeIdBytes.length);
			frame[0] = FrameType.BroadcastSubscribe;
			frame.set(nodeIdBytes, 1);
			this._ws.send(frame);
		}

		return () => {
			this._broadcastSubscriptions.delete(nodeId);
			if (this._connected && this._ws) {
				const nodeIdBytes = WsTransport._encoder.encode(nodeId);
				const frame = new Uint8Array(1 + nodeIdBytes.length);
				frame[0] = FrameType.BroadcastUnsubscribe;
				frame.set(nodeIdBytes, 1);
				this._ws.send(frame);
			}
		};
	}

	async publishBroadcast(nodeId: string, data: Uint8Array): Promise<void> {
		if (this._encryption) {
			data = await this._encryption.encrypt(data);
		}

		const nodeIdBytes = WsTransport._encoder.encode(nodeId);
		const frame = new Uint8Array(1 + 2 + nodeIdBytes.length + data.length);
		frame[0] = FrameType.BroadcastPublish;
		frame[1] = (nodeIdBytes.length >> 8) & 0xff;
		frame[2] = nodeIdBytes.length & 0xff;
		frame.set(nodeIdBytes, 3);
		frame.set(data, 3 + nodeIdBytes.length);

		this._sendRaw(frame);
	}

	async send(peerId: string, data: Uint8Array): Promise<void> {
		if (this._encryption) {
			data = await this._encryption.encrypt(data);
		}

		const peerIdBytes = WsTransport._encoder.encode(peerId);
		const frame = new Uint8Array(1 + 2 + peerIdBytes.length + data.length);
		frame[0] = FrameType.Signaling;
		frame[1] = (peerIdBytes.length >> 8) & 0xff;
		frame[2] = peerIdBytes.length & 0xff;
		frame.set(peerIdBytes, 3);
		frame.set(data, 3 + peerIdBytes.length);

		this._sendRaw(frame);
	}

	disconnect(): void {
		this._intentionalClose = true;
		this._connected = false;
		this._clearReconnectTimer();
		this._stopPing();

		if (this._ws) {
			this._ws.close();
			this._ws = undefined;
		}
	}

	// ── Private ──

	private _doConnect(): void {
		const wsUrl = this._url.replace(/^http/, "ws") + "/ws?peerId=" + encodeURIComponent(this._peerId);
		this._log.debug("Connecting to WS signaling:", wsUrl);

		const ws = new WebSocket(wsUrl);
		ws.binaryType = "arraybuffer";
		this._ws = ws;

		ws.addEventListener("open", () => {
			this._log.debug("WebSocket connected to WS signaling");
			this._connected = true;
			this._reconnectDelay = 1000;

			// Send register frame
			const frame = new Uint8Array([FrameType.Register]);
			ws.send(frame);

			// Restore broadcast subscriptions
			for (const nodeId of this._broadcastSubscriptions) {
				const nodeIdBytes = WsTransport._encoder.encode(nodeId);
				const subFrame = new Uint8Array(1 + nodeIdBytes.length);
				subFrame[0] = FrameType.BroadcastSubscribe;
				subFrame.set(nodeIdBytes, 1);
				ws.send(subFrame);
			}

			// Flush queued messages
			const queued = this._messagesQueue.splice(0);
			for (const msg of queued) {
				ws.send(msg);
			}

			this._startPing();
			this.emit("open");
		});

		ws.addEventListener("message", (event) => {
			if (!this._rateLimiter.consume()) {
				this._log.debug("Rate limited inbound message");
				return;
			}

			const raw = new Uint8Array(event.data as ArrayBuffer);
			if (raw.length < 1) return;

			const type = raw[0];

			switch (type) {
				case FrameType.Signaling:
					this._handleSignalingFrame(raw.subarray(1));
					break;
				case FrameType.BroadcastPublish:
					this._handleBroadcastFrame(raw.subarray(1));
					break;
				case FrameType.Ping:
					// Pong: echo back
					ws.send(new Uint8Array([FrameType.Ping]));
					break;
			}
		});

		ws.addEventListener("close", () => {
			this._connected = false;
			this._stopPing();

			if (this._intentionalClose) {
				this.emit("close");
			} else {
				this._log.warn("WebSocket disconnected, scheduling reconnect");
				this.emit("disconnected");
				this._scheduleReconnect();
			}
		});

		ws.addEventListener("error", (event) => {
			this._log.error("WebSocket error:", event);
			this.emit("error", event);
		});
	}

	private async _handleSignalingFrame(payload: Uint8Array): Promise<void> {
		try {
			let data = payload;
			if (this._encryption) {
				data = await this._encryption.decrypt(data);
			}
			const msg = this._codec.decode(data);
			const m = msg as Record<string, unknown>;
			if (this._messageHandler && m?.type && m?.src) {
				this._messageHandler(m as unknown as SignalingMessage);
			}
		} catch (error) {
			this._log.debug("Signaling decode/decrypt error:", (error as Error).message);
		}
	}

	private async _handleBroadcastFrame(data: Uint8Array): Promise<void> {
		if (data.length < 2) return;

		const nodeIdLen = (data[0] << 8) | data[1];
		if (data.length < 2 + nodeIdLen) return;

		const nodeId = WsTransport._decoder.decode(data.subarray(2, 2 + nodeIdLen));
		let payload = data.subarray(2 + nodeIdLen);

		try {
			if (this._encryption) {
				payload = await this._encryption.decrypt(payload);
			}
			this._broadcastHandler?.(nodeId, payload);
		} catch (error) {
			this._log.debug("Broadcast decrypt error:", (error as Error).message);
		}
	}

	private _sendRaw(frame: Uint8Array): void {
		if (!this._ws || !this._connected) {
			if (this._messagesQueue.length < WsTransport.MAX_QUEUE_SIZE) {
				this._messagesQueue.push(frame);
			} else {
				this._log.warn("Message queue full, dropping message");
			}
			return;
		}
		this._ws.send(frame);
	}

	private _scheduleReconnect(): void {
		this._clearReconnectTimer();

		// Exponential backoff with jitter
		const jitter = Math.random() * 0.3 * this._reconnectDelay;
		const delay = this._reconnectDelay + jitter;
		this._reconnectDelay = Math.min(this._reconnectDelay * 2, WsTransport.MAX_RECONNECT_DELAY);

		this._log.debug(`Reconnecting in ${Math.round(delay)}ms`);
		this._reconnectTimer = setTimeout(() => {
			this._ws = undefined;
			this._doConnect();
		}, delay);
	}

	private _clearReconnectTimer(): void {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
	}

	private _startPing(): void {
		this._stopPing();
		this._pingTimer = setInterval(() => {
			if (this._ws && this._connected) {
				this._ws.send(new Uint8Array([FrameType.Ping]));
			}
		}, WsTransport.PING_INTERVAL_MS);
	}

	private _stopPing(): void {
		if (this._pingTimer) {
			clearInterval(this._pingTimer);
			this._pingTimer = undefined;
		}
	}
}
