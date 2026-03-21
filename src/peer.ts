import { EventEmitter } from "eventemitter3";
import { encode, decode } from "@msgpack/msgpack";
import { generatePeerId } from "./util/id-generator";
import { MsgpackCodec } from "./util/codec";
import { AesGcmEncryption } from "./security/aes-gcm-encryption";
import { MqttTransport } from "./transport/mqtt-transport";
import { RtcSession } from "./connection/rtc-session";
import { DataConnection } from "./data/data-connection";
import type { PeerOptions, ICodec, IEncryption } from "./types";
import { SignalingType } from "./types";
import { DEFAULT_RTC_CONFIG } from "./util/constants";
import { createLogger, type Logger } from "./util/logger";

/** Connection lifecycle states */
export enum ConnectionState {
	Init = "init",
	Signaling = "signaling",
	Connected = "connected",
	Recovering = "recovering",
	Disconnected = "disconnected",
}

export class Peer extends EventEmitter {
	readonly peerId: string;
	localStream: MediaStream | null = null;

	private _sessions = new Map<string, RtcSession>();
	private _dataConnections = new Map<string, DataConnection>();
	private _transport: MqttTransport | undefined;
	private _options: PeerOptions;
	private _codec: ICodec;
	private _encryption: IEncryption | undefined;
	private _log: Logger;

	// Broadcast pub/sub: nodeId → (appTopic → Set<handler>)
	private _broadcastSubs = new Map<string, Map<string, Set<(data: any) => void>>>();
	// nodeId → MQTT unsubscribe fn
	private _broadcastUnsubs = new Map<string, () => void>();

	// Connection state machine
	private _connectionStates = new Map<string, ConnectionState>();
	private _recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private _reconnectAttempts = new Map<string, number>();

	// Heartbeat
	private _pingTimers = new Map<string, ReturnType<typeof setInterval>>();
	private _pongTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
	private _missedPongs = new Map<string, number>();

	private static readonly ICE_RECOVERY_TIMEOUT_MS = 15_000;
	private static readonly PING_INTERVAL_MS = 15_000;
	private static readonly PONG_TIMEOUT_MS = 5_000;
	private static readonly MAX_MISSED_PONGS = 2;

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

		this._log = createLogger("upeer", this._options.debug);
		this._codec = this._options.codec ?? new MsgpackCodec();

		if (this._options.encryption) {
			this._encryption = this._options.encryption;
		} else if (this._options.securityKey) {
			this._encryption = new AesGcmEncryption({
				securityKey: this._options.securityKey,
			});
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
			this._log,
		);

		this._transport.onMessage((message) => {
			const peerId = message.src;
			switch (message.type) {
				case SignalingType.Offer:
					this._handleIncomingOffer(peerId, message.data);
					break;
				default: {
					const session = this._sessions.get(peerId);
					if (session) {
						session.handleSignaling(message.type, message.data);
					}
					break;
				}
			}
		});

		this._transport.onBroadcast((nodeId, decryptedBytes) => {
			const msg = this._codec.decode(decryptedBytes); // { t: string, d: any }
			const topicMap = this._broadcastSubs.get(nodeId);
			if (!topicMap) return;
			const handlers = topicMap.get(msg.t);
			if (handlers) {
				for (const h of handlers) h(msg.d);
			}
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

	/**
	 * Publish a broadcast message to `${this.peerId}:ff`.
	 * @param topic - Application-level topic (e.g. 'presence')
	 * @param data  - Any serializable data
	 */
	publish(topic: string, data: any): void {
		if (!this._transport) {
			this._log.error("Transport not connected");
			return;
		}
		const encoded = this._codec.encode({ t: topic, d: data });
		this._transport.publishBroadcast(this.peerId, encoded);
	}

	/**
	 * Subscribe to a specific application-level topic on a nodeId's broadcast channel.
	 * @returns unsubscribe function
	 */
	subscribe(nodeId: string, topic: string, handler: (data: any) => void): () => void {
		// Register handler
		let topicMap = this._broadcastSubs.get(nodeId);
		if (!topicMap) { topicMap = new Map(); this._broadcastSubs.set(nodeId, topicMap); }
		let handlers = topicMap.get(topic);
		if (!handlers) { handlers = new Set(); topicMap.set(topic, handlers); }
		handlers.add(handler);

		// First subscription for this nodeId → MQTT subscribe
		if (!this._broadcastUnsubs.has(nodeId) && this._transport) {
			const unsub = this._transport.subscribeBroadcast(nodeId);
			this._broadcastUnsubs.set(nodeId, unsub);
		}

		// Return unsubscribe
		return () => {
			handlers!.delete(handler);
			if (handlers!.size === 0) topicMap!.delete(topic);
			if (topicMap!.size === 0) {
				this._broadcastSubs.delete(nodeId);
				this._broadcastUnsubs.get(nodeId)?.();
				this._broadcastUnsubs.delete(nodeId);
			}
		};
	}

	/** Initiate a media + data call to a peer */
	call(peerId: string, stream?: MediaStream): RtcSession {
		this._cleanupPeer(peerId);
		this._setConnectionState(peerId, ConnectionState.Signaling);

		const session = this._createSession(peerId, {
			offerToReceiveAudio: true,
			offerToReceiveVideo: true,
		});
		session.startAsOfferer(stream ?? this.localStream ?? undefined);

		session.on("stream", (remoteStream: MediaStream) => {
			this.emit("stream", { peerId, stream: remoteStream, call: session });
		});

		session.on("close", () => {
			this._handleSessionClose(peerId, session);
		});

		session.on("iceStateChanged", (state: RTCIceConnectionState) => {
			this._handleIceStateChange(peerId, session, state);
		});

		this.emit("call", { peerId, call: session });
		this._initDataChannel(peerId);

		return session;
	}

	/** Initiate a data-only connection (no media) */
	connect(peerId: string): RtcSession {
		this._cleanupPeer(peerId);
		this._setConnectionState(peerId, ConnectionState.Signaling);

		const session = this._createSession(peerId);
		session.startAsOfferer(undefined, true);

		session.on("close", () => {
			this._handleSessionClose(peerId, session);
		});

		session.on("iceStateChanged", (state: RTCIceConnectionState) => {
			this._handleIceStateChange(peerId, session, state);
		});

		this._wrapDataChannel(peerId, session.dataChannel!);
		return session;
	}

	/** Send raw bytes to a specific peer via DataChannel */
	send(peerId: string, data: Uint8Array | ArrayBuffer): void {
		this._dataConnections.get(peerId)?.send(data);
	}

	/** Broadcast raw bytes to all connected peers */
	broadcast(data: Uint8Array | ArrayBuffer, options?: { excludeId?: string[] }): void {
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
		this._stopHeartbeat(peerId);
		this._clearRecoveryTimer(peerId);
		const session = this._sessions.get(peerId);
		if (session) {
			session.close();
			this._sessions.delete(peerId);
			this._dataConnections.delete(peerId);
			this._setConnectionState(peerId, ConnectionState.Disconnected);
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
		this._stopAllHeartbeats();
		this._clearAllRecoveryTimers();
		this._connectionStates.clear();
		this._broadcastUnsubs.forEach((unsub) => unsub());
		this._broadcastUnsubs.clear();
		this._broadcastSubs.clear();
		this._transport?.disconnect();
	}

	/** Fully destroy this peer instance */
	destroy(): void {
		this.disconnect();
		this.removeAllListeners();
	}

	/** Get connection state for a peer */
	getConnectionState(peerId: string): ConnectionState {
		return this._connectionStates.get(peerId) ?? ConnectionState.Init;
	}

	// ── Private: Session Management ──

	private _createSession(peerId: string, constraints?: RTCOfferOptions): RtcSession {
		const session = new RtcSession(peerId, {
			rtcConfig: this._options.rtcConfig ?? DEFAULT_RTC_CONFIG,
			constraints,
			dataChannelLabel: this._options.dataChannelLabel,
			dataChannelInit: this._options.dataChannelInit,
			logger: this._log,
		});

		session.on("signaling", (type: SignalingType, data: any) => {
			this._sendSignaling(peerId, type, data);
		});

		this._sessions.set(peerId, session);
		return session;
	}

	private _handleIncomingOffer(peerId: string, payload: any): void {
		this._cleanupPeer(peerId);
		this._setConnectionState(peerId, ConnectionState.Signaling);

		const session = this._createSession(peerId);
		session.startAsAnswerer(payload.sdp, this.localStream ?? undefined);

		session.on("stream", (remoteStream: MediaStream) => {
			this.emit("stream", { peerId, stream: remoteStream, call: session });
		});

		session.on("close", () => {
			this._handleSessionClose(peerId, session);
		});

		session.on("iceStateChanged", (state: RTCIceConnectionState) => {
			this._handleIceStateChange(peerId, session, state);
		});

		this.emit("call", { peerId, call: session });

		// Listen for incoming DataChannel from offerer
		session.on("dataChannel", (dc: RTCDataChannel) => {
			this._wrapDataChannel(peerId, dc);
		});

	}

	// ── Private: Connection State Machine ──

	private _setConnectionState(peerId: string, state: ConnectionState): void {
		const prev = this._connectionStates.get(peerId);
		if (prev === state) return;
		this._connectionStates.set(peerId, state);
		this._log.debug(`Connection state: ${prev ?? "none"} → ${state} for ${peerId}`);
	}

	private _handleIceStateChange(peerId: string, session: RtcSession, state: RTCIceConnectionState): void {
		this.emit("iceConnectionStateChange", {
			peerId,
			iceConnectionState: state,
			peerConnection: session.peerConnection!,
		});

		const currentState = this._connectionStates.get(peerId);

		switch (state) {
			case "connected":
			case "completed":
				this._clearRecoveryTimer(peerId);
				this._setConnectionState(peerId, ConnectionState.Connected);
				this._reconnectAttempts.set(peerId, 0);
				this._startHeartbeat(peerId);
				break;

			case "disconnected":
				// Attempt ICE restart before giving up
				if (currentState === ConnectionState.Connected) {
					this._setConnectionState(peerId, ConnectionState.Recovering);
					this._attemptIceRestart(peerId, session);
				}
				break;

			case "failed":
				this._setConnectionState(peerId, ConnectionState.Disconnected);
				this._stopHeartbeat(peerId);
				this._clearRecoveryTimer(peerId);
				// Session will close itself on ICE failed
				break;
		}
	}

	private _attemptIceRestart(peerId: string, session: RtcSession): void {
		this._log.debug(`Attempting ICE restart for ${peerId}`);

		session.iceRestart();

		// Set recovery timeout
		this._recoveryTimers.set(peerId, setTimeout(() => {
			const state = this._connectionStates.get(peerId);
			if (state === ConnectionState.Recovering) {
				this._log.warn(`ICE restart timeout for ${peerId}`);
				this._setConnectionState(peerId, ConnectionState.Disconnected);
				session.close();
			}
		}, Peer.ICE_RECOVERY_TIMEOUT_MS));
	}

	private _clearRecoveryTimer(peerId: string): void {
		const timer = this._recoveryTimers.get(peerId);
		if (timer) {
			clearTimeout(timer);
			this._recoveryTimers.delete(peerId);
		}
	}

	private _clearAllRecoveryTimers(): void {
		this._recoveryTimers.forEach((timer) => clearTimeout(timer));
		this._recoveryTimers.clear();
	}

	private _handleSessionClose(peerId: string, session: RtcSession): void {
		this._sessions.delete(peerId);
		this._dataConnections.delete(peerId);
		this._stopHeartbeat(peerId);
		this._clearRecoveryTimer(peerId);
		this._setConnectionState(peerId, ConnectionState.Disconnected);
		this.emit("hangup", { peerId, call: session });
	}

	// ── Private: Heartbeat (via negotiated control channel) ──

	private _startHeartbeat(peerId: string): void {
		this._stopHeartbeat(peerId);
		this._missedPongs.set(peerId, 0);

		const session = this._sessions.get(peerId);
		if (!session?.controlChannel) return;

		// Listen for pong responses on the control channel
		this._setupControlChannelListener(peerId, session);

		const timer = setInterval(() => {
			this._sendPing(peerId);
		}, Peer.PING_INTERVAL_MS);
		this._pingTimers.set(peerId, timer);
	}

	private _setupControlChannelListener(peerId: string, session: RtcSession): void {
		const ctrl = session.controlChannel;
		if (!ctrl) return;
		ctrl.binaryType = "arraybuffer";

		ctrl.onmessage = (e: MessageEvent) => {
			try {
				const msg = decode(new Uint8Array(e.data as ArrayBuffer)) as any;
				if (msg?.pong) {
					this._handlePong(peerId);
				} else if (msg?.ts && !msg.pong) {
					// Received a ping — reply with pong
					this._handlePing(peerId, msg.ts);
				}
			} catch {
				// Ignore malformed control messages
			}
		};
	}

	private _stopHeartbeat(peerId: string): void {
		const pingTimer = this._pingTimers.get(peerId);
		if (pingTimer) {
			clearInterval(pingTimer);
			this._pingTimers.delete(peerId);
		}
		const pongTimeout = this._pongTimeouts.get(peerId);
		if (pongTimeout) {
			clearTimeout(pongTimeout);
			this._pongTimeouts.delete(peerId);
		}
		this._missedPongs.delete(peerId);
	}

	private _stopAllHeartbeats(): void {
		this._pingTimers.forEach((timer) => clearInterval(timer));
		this._pingTimers.clear();
		this._pongTimeouts.forEach((timer) => clearTimeout(timer));
		this._pongTimeouts.clear();
		this._missedPongs.clear();
	}

	private _sendPing(peerId: string): void {
		const session = this._sessions.get(peerId);
		const ctrl = session?.controlChannel;
		if (!ctrl || ctrl.readyState !== "open") return;

		try {
			const payload = encode({ ts: Date.now() });
			ctrl.send(payload instanceof Uint8Array ? payload as Uint8Array<ArrayBuffer> : new Uint8Array(payload));
		} catch {
			// Control channel send failed
			return;
		}

		// Set pong timeout
		const timeout = setTimeout(() => {
			const missed = (this._missedPongs.get(peerId) ?? 0) + 1;
			this._missedPongs.set(peerId, missed);

			if (missed >= Peer.MAX_MISSED_PONGS) {
				this._log.warn(`Heartbeat timeout for ${peerId}, attempting ICE restart`);
				const session = this._sessions.get(peerId);
				if (session) {
					this._setConnectionState(peerId, ConnectionState.Recovering);
					this._attemptIceRestart(peerId, session);
				}
			}
		}, Peer.PONG_TIMEOUT_MS);
		this._pongTimeouts.set(peerId, timeout);
	}

	private _handlePong(peerId: string): void {
		this._missedPongs.set(peerId, 0);
		const timeout = this._pongTimeouts.get(peerId);
		if (timeout) {
			clearTimeout(timeout);
			this._pongTimeouts.delete(peerId);
		}
	}

	private _handlePing(peerId: string, ts: number): void {
		const session = this._sessions.get(peerId);
		const ctrl = session?.controlChannel;
		if (!ctrl || ctrl.readyState !== "open") return;

		try {
			const payload = encode({ ts, pong: true });
			ctrl.send(payload instanceof Uint8Array ? payload as Uint8Array<ArrayBuffer> : new Uint8Array(payload));
		} catch {
			// Control channel send failed
		}
	}

	// ── Private: Signaling & Data ──

	private _sendSignaling(peerId: string, type: SignalingType, data: any): void {
		if (!this._transport) {
			this._log.error("Transport not connected");
			return;
		}
		const encoded = this._codec.encode({
			type,
			data,
			src: this.peerId,
		});
		this._transport.send(peerId, encoded);
	}

	private _wrapDataChannel(peerId: string, dataChannel: RTCDataChannel): DataConnection {
		const dc = new DataConnection(dataChannel);
		dc.on("open", () => {
			this._dataConnections.set(peerId, dc);
			this.emit("dataConnection", { peerId, conn: dc });
		});
		dc.on("data", (data: Uint8Array) => {
			this.emit("data", { peerId, data, conn: dc });
		});
		dc.on("close", () => {
			this._dataConnections.delete(peerId);
			this._stopHeartbeat(peerId);
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
		this._stopHeartbeat(peerId);
		this._clearRecoveryTimer(peerId);
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
