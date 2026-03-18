import { EventEmitter } from "eventemitter3";
import { SignalingBatcher } from "./signaling-batcher";
import { SignalingType } from "../types";

export interface RtcSessionOptions {
	rtcConfig?: RTCConfiguration;
	constraints?: RTCOfferOptions;
	sdpTransform?: (sdp: string) => string;
	dataChannelLabel?: string;
	dataChannelInit?: RTCDataChannelInit;
	debug?: boolean;
}

export interface RtcSessionEvents {
	stream: (stream: MediaStream) => void;
	iceStateChanged: (state: RTCIceConnectionState) => void;
	close: () => void;
	signaling: (type: SignalingType, data: any) => void;
}

export class RtcSession extends EventEmitter {
	readonly peerId: string;
	peerConnection: RTCPeerConnection | null = null;
	dataChannel: RTCDataChannel | null = null;
	controlChannel: RTCDataChannel | null = null;
	bulkChannel: RTCDataChannel | null = null;

	private _batcher: SignalingBatcher;
	private _options: RtcSessionOptions;
	private _dataChannelLabel: string;
	private _dataChannelInit: RTCDataChannelInit;
	private _debug: boolean;

	constructor(peerId: string, options: RtcSessionOptions = {}) {
		super();
		this.peerId = peerId;
		this._options = options;
		this._dataChannelLabel = options.dataChannelLabel ?? "dc:upeer";
		this._dataChannelInit = options.dataChannelInit ?? { ordered: true };
		this._debug = options.debug ?? false;
		this._batcher = new SignalingBatcher(
			(type, data) => this.emit("signaling", type, data),
		);
	}

	startAsOfferer(stream?: MediaStream, dataOnly?: boolean): void {
		const pc = this._createPeerConnection();

		if (stream && !dataOnly) {
			this._addTracks(stream, pc);
		}

		// Ensure recvonly transceivers exist for media we want to receive
		if (!dataOnly) {
			const hasAudio = pc.getTransceivers().some((t) => t.receiver.track?.kind === "audio");
			const hasVideo = pc.getTransceivers().some((t) => t.receiver.track?.kind === "video");
			if (!hasAudio) pc.addTransceiver("audio", { direction: "recvonly" });
			if (!hasVideo) pc.addTransceiver("video", { direction: "recvonly" });
		}

		this.dataChannel = pc.createDataChannel(this._dataChannelLabel, this._dataChannelInit);

		void this._makeOffer();
	}

	startAsAnswerer(offerSdp: RTCSessionDescriptionInit, stream?: MediaStream): void {
		const pc = this._createPeerConnection();

		if (stream) {
			this._addTracks(stream, pc);
		}

		// Answerer doesn't create DataChannel — listens via ondatachannel
		void this._handleSDP("offer", offerSdp);
	}

	handleSignaling(type: SignalingType, payload: any): void {
		switch (type) {
			case SignalingType.Answer:
				void this._handleSDP("answer", payload.sdp);
				break;
			case SignalingType.Candidate:
				void this._handleCandidate(payload.candidate);
				break;
		}
	}

	/** Trigger ICE restart to recover from network changes */
	iceRestart(): void {
		if (!this.peerConnection) return;
		if (this._debug) console.warn(`[upeer] ICE restart for ${this.peerId}`);
		void this._makeOffer(true);
	}

	replaceTrack(stream: MediaStream): void {
		if (!this.peerConnection) return;
		const senders = this.peerConnection.getSenders();
		const videoSender = senders.find((s) => s.track?.kind === "video");
		const audioSender = senders.find((s) => s.track?.kind === "audio");
		const videoTrack = stream.getVideoTracks()[0];
		const audioTrack = stream.getAudioTracks()[0];
		if (videoSender && videoTrack) videoSender.replaceTrack(videoTrack);
		if (audioSender && audioTrack) audioSender.replaceTrack(audioTrack);
	}

	close(): void {
		this._batcher.destroy();

		if (this.controlChannel && this.controlChannel.readyState !== "closed") {
			this.controlChannel.close();
		}

		if (this.bulkChannel && this.bulkChannel.readyState !== "closed") {
			this.bulkChannel.close();
		}

		if (this.dataChannel && this.dataChannel.readyState !== "closed") {
			this.dataChannel.close();
		}

		if (this.peerConnection && this.peerConnection.signalingState !== "closed") {
			this.peerConnection.onicecandidate =
				this.peerConnection.oniceconnectionstatechange =
				this.peerConnection.ondatachannel =
				this.peerConnection.ontrack =
					() => {};
			this.peerConnection.close();
		}

		this.peerConnection = null;
		this.dataChannel = null;
		this.controlChannel = null;
		this.bulkChannel = null;
		this.emit("close");
	}

	// ── Private ──

	private _createPeerConnection(): RTCPeerConnection {
		const pc = new RTCPeerConnection(this._options.rtcConfig);
		this.peerConnection = pc;

		// Negotiated control channel — both sides create independently, no SDP overhead
		this.controlChannel = pc.createDataChannel("_ctrl", { negotiated: true, id: 0, ordered: true });

		// Negotiated bulk data channel — for large binary transfers (images, videos)
		this.bulkChannel = pc.createDataChannel("dc:bulk", { negotiated: true, id: 1, ordered: true });

		this._setupListeners(pc);
		return pc;
	}

	private _setupListeners(pc: RTCPeerConnection): void {
		pc.onicecandidate = (evt) => {
			if (!evt.candidate || !evt.candidate.candidate) return;
			this._batcher.push(SignalingType.Candidate, {
				candidate: JSON.parse(JSON.stringify(evt.candidate)),
			});
		};

		pc.oniceconnectionstatechange = () => {
			const state = pc.iceConnectionState;
			if (this._debug) console.warn(`[upeer] ICE state: ${state} for ${this.peerId}`);

			switch (state) {
				case "failed":
				case "closed":
					this.close();
					break;
				case "completed":
					pc.onicecandidate = () => {};
					break;
			}

			this.emit("iceStateChanged", state);
		};

		pc.ontrack = (evt) => {
			const stream = evt.streams[0];
			if (stream) {
				this.emit("stream", stream);
			}
		};

		pc.ondatachannel = (evt) => {
			if (evt.channel.label === this._dataChannelLabel) {
				this.dataChannel = evt.channel;
				this.emit("dataChannel", evt.channel);
			}
		};
	}

	private async _makeOffer(iceRestart?: boolean): Promise<void> {
		const pc = this.peerConnection!;
		try {
			const offerOptions = {
				...this._options.constraints,
				...(iceRestart ? { iceRestart: true } : {}),
			};
			const offer = await pc.createOffer(offerOptions);
			await pc.setLocalDescription(offer);

			this._batcher.push(
				SignalingType.Offer,
				{
					sdp: JSON.parse(JSON.stringify(offer)),
					config: this._options.rtcConfig,
				},
			);
		} catch (err: any) {
			if (err?.toString?.().includes("kHaveRemoteOffer")) return;
			console.error("[upeer] Failed to create/set offer:", err);
		}
	}

	private async _makeAnswer(): Promise<void> {
		const pc = this.peerConnection!;
		try {
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);

			this._batcher.push(
				SignalingType.Answer,
				{
					sdp: JSON.parse(JSON.stringify(answer)),
				},
			);
		} catch (err) {
			console.error("[upeer] Failed to create/set answer:", err);
		}
	}

	private async _handleSDP(type: string, sdp: any): Promise<void> {
		const pc = this.peerConnection;
		if (!pc) return;

		try {
			await pc.setRemoteDescription(new RTCSessionDescription(sdp));
			if (type === "offer") {
				await this._makeAnswer();
			}
		} catch (err) {
			console.error("[upeer] Failed to setRemoteDescription:", err);
		}
	}

	private async _handleCandidate(ice: RTCIceCandidateInit): Promise<void> {
		try {
			await this.peerConnection!.addIceCandidate(ice);
		} catch (err) {
			console.error("[upeer] Failed to handleCandidate:", err);
		}
	}

	private _addTracks(stream: MediaStream, pc: RTCPeerConnection): void {
		stream.getTracks().forEach((track) => {
			pc.addTrack(track, stream);
		});
	}
}
