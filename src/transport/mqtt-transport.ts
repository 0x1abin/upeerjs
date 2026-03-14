import { EventEmitter } from "eventemitter3";
import mqtt from "mqtt";
import { Buffer } from "buffer";
import type { MqttClient, IClientOptions } from "mqtt";
import type { ICodec, IEncryption, ISignalingTransport, SignalingMessage, TransportMessageHandler } from "../types";
import { VERSION } from "../util/constants";

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
	}

	onMessage(handler: TransportMessageHandler): void {
		this._messageHandler = handler;
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
			this._mqtt!.subscribe(this._peerId, (err: any) => {
				if (err) {
					console.error("[upeer] Subscribe error:", err);
					this.emit("error", err);
					return;
				}
				this._subscribed = true;
				this._sendQueuedMessages();
				this.emit("open");
			});
		});

		this._mqtt.on("message", (topic, message) => {
			if (topic !== this._peerId) return;
			try {
				const raw = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
				if (this._encryption) {
					this._encryption.decrypt(raw).then((decrypted) => {
						this._dispatchMessage(this._codec.decode(decrypted));
					}).catch((error) => {
						console.error("[upeer] Decrypt error:", error);
						this.emit("error", error);
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
		if (this._messageHandler && msg?.type === "signaling") {
			this._messageHandler(msg as SignalingMessage);
		}
	}

	private _sendQueuedMessages(): void {
		const queued = this._messagesQueue.splice(0);
		for (const { topic, message } of queued) {
			this._mqtt!.publish(topic, Buffer.from(message));
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
		this._mqtt.publish(topic, Buffer.from(message));
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
