import { EventEmitter } from "eventemitter3";
import { generatePeerId } from "./util/id-generator";
import { JsonCodec } from "./util/codec";
import { AesGcmEncryption } from "./security/aes-gcm-encryption";
import { MqttTransport } from "./transport/mqtt-transport";
import { RtcSession } from "./connection/rtc-session";
import { DataConnection } from "./data/data-connection";
import type { PeerOptions, PeerEvents, SignalingItem, ICodec, IEncryption } from "./types";
import { SignalingType } from "./types";
import { DEFAULT_RTC_CONFIG } from "./util/constants";

export class Peer extends EventEmitter {
	readonly peerId: string;
	localStream: MediaStream | null = null;

	private _sessions = new Map<string, RtcSession>();
	private _dataConnections = new Map<string, DataConnection>();
	private _transport: MqttTransport | undefined;
	private _options: PeerOptions;
	private _codec: ICodec;
	private _encryption: IEncryption | undefined;
	private _debug: boolean;

	constructor(options: PeerOptions);
	constructor(peerId: string, options: PeerOptions);
	constructor(peerIdOrOptions: string | PeerOptions, maybeOptions?: PeerOptions) {
		super();

		if (typeof peerIdOrOptions === "string") {
			this.peerId = peerIdOrOptions;
			this._options = maybeOptions!;
		} else {
			this.peerId = generatePeerId();
			this._options = peerIdOrOptions;
		}

		this._debug = this._options.debug ?? false;
		this._codec = this._options.codec ?? new JsonCodec();

		if (this._options.encryption) {
			this._encryption = this._options.encryption;
		} else if (this._options.securityKey) {
			this._encryption = new AesGcmEncryption(this._options.securityKey);
		}
	}

	get connected(): boolean {
		return this._transport?.connected ?? false;
	}

	/** Connect to the MQTT signaling broker */
	start(): void {
		const brokerUrl = this._options.brokerUrl ?? "wss://broker.emqx.io:8084/mqtt";
		const mqttOptions = {
			...this._options.mqttOptions,
			url: brokerUrl,
		};

		this._transport = new MqttTransport(
			this.peerId,
			mqttOptions,
			this._codec,
			this._encryption,
			this._debug,
		);

		this._transport.onMessage((message) => {
			const peerId = message.src;
			message.data.forEach((item: SignalingItem) => {
				if (item.type === SignalingType.Offer) {
					this._handleIncomingOffer(peerId, item.payload);
				} else {
					const session = this._sessions.get(peerId);
					if (session) {
						session.handleSignaling(item.type, item.payload);
					}
				}
			});
		});

		this._transport.on("open", () => {
			this.emit("open", this.peerId);
		});
		this._transport.on("close", () => {
			this.emit("close");
		});
		this._transport.on("error", (err: any) => {
			this.emit("error", err);
		});

		this._transport.connect();
	}

	/** Initiate a media + data call to a peer */
	call(peerId: string, stream?: MediaStream): RtcSession {
		this._cleanupPeer(peerId);

		const session = this._createSession(peerId, {
			offerToReceiveAudio: true,
			offerToReceiveVideo: true,
		});
		session.startAsOfferer(stream ?? this.localStream ?? undefined);

		session.on("stream", (remoteStream: MediaStream) => {
			this.emit("stream", { peerId, stream: remoteStream, call: session });
		});

		session.on("close", () => {
			this._sessions.delete(peerId);
			this.emit("hangup", { peerId, call: session });
		});

		session.on("iceStateChanged", (state: RTCIceConnectionState) => {
			this.emit("iceConnectionStateChange", {
				peerId,
				iceConnectionState: state,
				peerConnection: session.peerConnection!,
			});
		});

		this.emit("call", { peerId, call: session });
		this._initDataChannel(peerId);

		return session;
	}

	/** Initiate a data-only connection (no media) */
	connect(peerId: string): RtcSession {
		this._cleanupPeer(peerId);

		const session = this._createSession(peerId);
		session.startAsOfferer(undefined, true);

		session.on("close", () => {
			this._sessions.delete(peerId);
			this._dataConnections.delete(peerId);
			this.emit("dataDisconnect", { peerId, conn: session });
		});

		this._wrapDataChannel(peerId, session.dataChannel!);
		return session;
	}

	/** Send data to a specific peer via DataChannel */
	send(peerId: string, data: any): void {
		this._dataConnections.get(peerId)?.send(data);
	}

	/** Broadcast data to all connected peers */
	broadcast(data: any, options?: { excludeId?: string[] }): void {
		this._dataConnections.forEach((conn, peerId) => {
			if (options?.excludeId?.includes(peerId)) return;
			conn.send(data);
		});
	}

	/** Replace media tracks for a specific peer */
	replaceTrack(peerId: string, stream: MediaStream): void {
		this._sessions.get(peerId)?.replaceTrack(stream);
	}

	/** Set local stream and update all active sessions */
	setLocalStream(stream: MediaStream): void {
		this.localStream = stream;
		this._sessions.forEach((session) => {
			session.replaceTrack(stream);
		});
	}

	/** Hang up a specific peer connection */
	hangup(peerId: string): void {
		const session = this._sessions.get(peerId);
		if (session) {
			session.close();
			this._sessions.delete(peerId);
			this._dataConnections.delete(peerId);
			this.emit("hangup", { peerId, call: session });
		}
	}

	/** Disconnect a data-only connection */
	dataDisconnect(peerId: string): void {
		this.hangup(peerId);
	}

	/** Disconnect from the signaling broker, close all sessions */
	disconnect(): void {
		this._sessions.forEach((session) => session.close());
		this._dataConnections.forEach((conn) => conn.close());
		this._sessions.clear();
		this._dataConnections.clear();
		this._transport?.disconnect();
	}

	/** Fully destroy this peer instance */
	destroy(): void {
		this.disconnect();
		this.removeAllListeners();
	}

	// ── Private ──

	private _createSession(peerId: string, constraints?: RTCOfferOptions): RtcSession {
		const session = new RtcSession(peerId, {
			rtcConfig: this._options.rtcConfig ?? DEFAULT_RTC_CONFIG,
			constraints,
			debug: this._debug,
		});

		session.on("signaling", (items: SignalingItem[]) => {
			this._sendSignaling(peerId, items);
		});

		this._sessions.set(peerId, session);
		return session;
	}

	private _handleIncomingOffer(peerId: string, payload: any): void {
		this._cleanupPeer(peerId);

		const session = this._createSession(peerId);
		session.startAsAnswerer(payload.sdp, this.localStream ?? undefined);

		session.on("stream", (remoteStream: MediaStream) => {
			this.emit("stream", { peerId, stream: remoteStream, call: session });
		});

		session.on("close", () => {
			this._sessions.delete(peerId);
			this._dataConnections.delete(peerId);
			this.emit("hangup", { peerId, call: session });
		});

		this.emit("call", { peerId, call: session });

		// Listen for incoming DataChannel from offerer
		session.on("dataChannel", (dc: RTCDataChannel) => {
			this._wrapDataChannel(peerId, dc);
		});
	}

	private _sendSignaling(peerId: string, items: SignalingItem[]): void {
		if (!this._transport) {
			console.error("[upeer] Transport not connected");
			return;
		}
		const encoded = this._codec.encode({
			type: "signaling",
			src: this.peerId,
			data: items,
		});
		this._transport.send(peerId, encoded);
	}

	private _wrapDataChannel(peerId: string, dataChannel: RTCDataChannel): DataConnection {
		const dc = new DataConnection(dataChannel);
		dc.on("open", () => {
			this._dataConnections.set(peerId, dc);
			this.emit("dataConnection", { peerId, conn: dc });
		});
		dc.on("data", (data: any) => {
			this.emit("data", { peerId, data, conn: dc });
		});
		dc.on("close", () => {
			this._dataConnections.delete(peerId);
			this.emit("dataDisconnect", { peerId, conn: dc });
		});
		return dc;
	}

	private _initDataChannel(peerId: string): void {
		const session = this._sessions.get(peerId);
		if (!session?.dataChannel) return;
		this._wrapDataChannel(peerId, session.dataChannel);
	}

	private _cleanupPeer(peerId: string): void {
		const existingDc = this._dataConnections.get(peerId);
		if (existingDc) {
			existingDc.close();
			this._dataConnections.delete(peerId);
		}
		const existingSession = this._sessions.get(peerId);
		if (existingSession) {
			existingSession.close();
			this._sessions.delete(peerId);
		}
	}
}
