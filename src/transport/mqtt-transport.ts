import { EventEmitter } from "eventemitter3";
import mqtt from "mqtt";
import type { MqttClient, IClientOptions } from "mqtt";
import type { ICodec, IEncryption, ISignalingTransport, SignalingMessage, TransportMessageHandler } from "../types";
import { VERSION } from "../util/constants";

/**
 * Token bucket rate limiter for signaling messages.
 * Prevents signaling flood/DDoS by limiting outbound message rate.
 */
class TokenBucket {
	private _tokens: number;
	private _capacity: number;
	private _refillRate: number; // tokens per second
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

export class MqttTransport extends EventEmitter implements ISignalingTransport {
	private _disconnected = true;
	private _subscribed = false;
	private _peerId: string;
	private _messagesQueue: Array<{ topic: string; message: Uint8Array }> = [];
	private _mqtt: MqttClient | undefined;
	private _mqttOptions: IClientOptions;
	private _codec: ICodec;
	private _encryption: IEncryption | undefined;
	private _messageHandler: TransportMessageHandler | undefined;
	private _debug: boolean;
	private _rateLimiter: TokenBucket;

	// Broadcast: encrypted shared topic subscriptions
	private static readonly BROADCAST_SUFFIX = ":ff";
	private _broadcastTopics: Set<string> = new Set();
	private _broadcastHandler: ((nodeId: string, data: Uint8Array) => void) | undefined;

	private static readonly MAX_QUEUE_SIZE = 128;

	get connected(): boolean {
		return !this._disconnected && this._subscribed;
	}

	constructor(
		peerId: string,
		options: IClientOptions,
		codec: ICodec,
		encryption?: IEncryption,
		debug?: boolean,
	) {
		super();
		this._peerId = peerId;
		this._mqttOptions = options;
		this._codec = codec;
		this._encryption = encryption;
		this._debug = debug ?? false;
		// Rate limiter: capacity 50 tokens, refill 10 tokens/second
		this._rateLimiter = new TokenBucket(50, 10);
	}

	onMessage(handler: TransportMessageHandler): void {
		this._messageHandler = handler;
	}

	/**
	 * Register a handler for incoming broadcast messages.
	 * Transport layer decrypts, then passes raw bytes to the handler.
	 */
	onBroadcast(handler: (nodeId: string, data: Uint8Array) => void): void {
		this._broadcastHandler = handler;
	}

	/**
	 * Subscribe to the broadcast MQTT topic for a nodeId (`${nodeId}:ff`).
	 * Returns an unsubscribe function.
	 */
	subscribeBroadcast(nodeId: string): () => void {
		const topic = nodeId + MqttTransport.BROADCAST_SUFFIX;
		this._broadcastTopics.add(topic);

		if (this._mqtt && !this._disconnected) {
			this._mqtt.subscribe(topic);
		}

		return () => {
			this._broadcastTopics.delete(topic);
			if (this._mqtt && !this._disconnected) {
				this._mqtt.unsubscribe(topic);
			}
		};
	}

	/**
	 * Publish an encrypted broadcast message to `${nodeId}:ff`.
	 */
	async publishBroadcast(nodeId: string, data: Uint8Array): Promise<void> {
		const topic = nodeId + MqttTransport.BROADCAST_SUFFIX;
		let payload: Uint8Array = data;
		if (this._encryption) {
			payload = await this._encryption.encrypt(data);
		}
		this._publish(topic, payload);
	}

	connect(): void {
		if (!this._disconnected || this._mqtt) {
			console.warn("[upeer] Already connected");
			return;
		}

		const options: IClientOptions = {
			keepalive: 60,
			clientId: "upeer@" + VERSION + "-" + this._peerId.slice(0, 8),
			protocolId: "MQTT",
			protocolVersion: 4,
			clean: true,
			connectTimeout: 1000 * 32,
			reconnectPeriod: 1000 * 30,
			...this._mqttOptions,
		};

		this._mqtt = mqtt.connect(options);

		this._mqtt.on("connect", () => {
			if (this._debug) console.warn("[upeer] MQTT connected");
			this._disconnected = false;

			// Subscribe to signaling topic (own peerId)
			this._mqtt!.subscribe(this._peerId, (err: any) => {
				if (err) {
					console.error("[upeer] Subscribe error:", err);
					this.emit("error", err);
					return;
				}
				this._subscribed = true;

				// Re-subscribe to any broadcast topics
				for (const topic of this._broadcastTopics) {
					this._mqtt!.subscribe(topic);
				}

				this._sendQueuedMessages();
				this.emit("open");
			});
		});

		this._mqtt.on("message", (topic, message) => {
			// Rate limit inbound messages
			if (!this._rateLimiter.consume()) {
				if (this._debug) console.warn("[upeer] Rate limited inbound message");
				return;
			}

			const raw = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);

			// Broadcast topic: encrypted, route to broadcast handler
			if (this._broadcastTopics.has(topic)) {
				const nodeId = topic.slice(0, -MqttTransport.BROADCAST_SUFFIX.length);
				if (this._encryption) {
					this._encryption.decrypt(raw).then((decrypted) => {
						this._broadcastHandler?.(nodeId, decrypted);
					}).catch((error) => {
						if (this._debug) console.warn("[upeer] Broadcast decrypt failed:", error.message);
					});
				} else {
					this._broadcastHandler?.(nodeId, raw);
				}
				return;
			}

			// Signaling topic: only process messages on own topic
			if (topic !== this._peerId) return;

			try {
				if (this._encryption) {
					this._encryption.decrypt(raw).then((decrypted) => {
						this._dispatchMessage(this._codec.decode(decrypted));
					}).catch((error) => {
						if (this._debug) console.warn("[upeer] Decrypt failed, ignoring message:", error.message);
					});
				} else {
					this._dispatchMessage(this._codec.decode(raw));
				}
			} catch (error) {
				console.error("[upeer] Message error:", error);
				this.emit("error", error);
			}
		});

		this._mqtt.on("disconnect", () => {
			console.warn("[upeer] MQTT disconnected");
			this._subscribed = false;
			this._disconnected = true;
			this.emit("disconnected");
		});

		this._mqtt.on("close", () => this.emit("close"));
		this._mqtt.on("error", (err: any) => this.emit("error", err));
	}

	private _dispatchMessage(msg: any): void {
		if (this._messageHandler && msg?.type && msg?.src) {
			this._messageHandler(msg as SignalingMessage);
		}
	}

	private _sendQueuedMessages(): void {
		const queued = this._messagesQueue.splice(0);
		for (const { topic, message } of queued) {
			this._mqtt!.publish(topic, message as any);
		}
	}

	async send(peerId: string, data: Uint8Array): Promise<void> {
		if (this._encryption) {
			data = await this._encryption.encrypt(data);
		}
		this._publish(peerId, data);
	}

	private _publish(topic: string, message: Uint8Array): void {
		if (!this._mqtt || this._disconnected || !this._subscribed) {
			if (this._messagesQueue.length < MqttTransport.MAX_QUEUE_SIZE) {
				this._messagesQueue.push({ topic, message });
			} else {
				console.warn("[upeer] Message queue full, dropping message");
			}
			return;
		}
		this._mqtt.publish(topic, message as any);
	}

	disconnect(): void {
		if (this._disconnected) return;
		this._disconnected = true;
		this._subscribed = false;
		if (this._mqtt) {
			this._mqtt.end();
			this._mqtt = undefined;
		}
	}
}
