import { describe, it, expect, vi, beforeEach } from "vitest";
import { RtcSession } from "../../src/connection/rtc-session";
import { SignalingType } from "../../src/types";

// Mock RTCPeerConnection
function createMockPC() {
	const pc: any = {
		onicecandidate: null,
		oniceconnectionstatechange: null,
		ontrack: null,
		ondatachannel: null,
		iceConnectionState: "new",
		signalingState: "stable",
		createOffer: vi.fn(async () => ({ type: "offer", sdp: "mock-offer-sdp" })),
		createAnswer: vi.fn(async () => ({ type: "answer", sdp: "mock-answer-sdp" })),
		setLocalDescription: vi.fn(async () => {}),
		setRemoteDescription: vi.fn(async () => {}),
		addIceCandidate: vi.fn(async () => {}),
		addTrack: vi.fn(),
		getSenders: vi.fn(() => []),
		getTransceivers: vi.fn(() => []),
		addTransceiver: vi.fn(),
		createDataChannel: vi.fn((label: string, init?: RTCDataChannelInit) => ({
			label,
			readyState: "connecting",
			close: vi.fn(),
			...(init?.negotiated ? { id: init.id } : {}),
		})),
		close: vi.fn(),
	};
	return pc;
}

let mockPC: any;

vi.stubGlobal("RTCPeerConnection", function MockRTCPeerConnection() {
	mockPC = createMockPC();
	return mockPC;
});

vi.stubGlobal("RTCSessionDescription", function MockRTCSessionDescription(init: any) {
	return init;
});

describe("RtcSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPC = null;
	});

	it("should create session with peerId", () => {
		const session = new RtcSession("peer-abc");
		expect(session.peerId).toBe("peer-abc");
		expect(session.peerConnection).toBeNull();
		expect(session.dataChannel).toBeNull();
		expect(session.controlChannel).toBeNull();
	});

	it("should create PeerConnection, DataChannel, and control channel as offerer", async () => {
		const session = new RtcSession("peer-abc");
		const signalingHandler = vi.fn();
		session.on("signaling", signalingHandler);

		session.startAsOfferer();

		expect(session.peerConnection).toBe(mockPC);
		expect(session.dataChannel).toBeDefined();
		expect(session.controlChannel).toBeDefined();

		// Control channel is negotiated with id 0
		expect(mockPC.createDataChannel).toHaveBeenCalledWith("_ctrl", { negotiated: true, id: 0, ordered: true });
		// Application DataChannel uses default label and options
		expect(mockPC.createDataChannel).toHaveBeenCalledWith("dc:upeer", { ordered: true });

		// Wait for async offer creation
		await vi.waitFor(() => {
			expect(mockPC.createOffer).toHaveBeenCalled();
			expect(mockPC.setLocalDescription).toHaveBeenCalled();
		});

		// Should emit signaling with offer (immediate flush)
		expect(signalingHandler).toHaveBeenCalled();
		expect(signalingHandler.mock.calls[0][0]).toBe(SignalingType.Offer);
	});

	it("should use custom dataChannelLabel and dataChannelInit", async () => {
		const session = new RtcSession("peer-abc", {
			dataChannelLabel: "custom-dc",
			dataChannelInit: { ordered: false, maxRetransmits: 0 },
		});

		session.startAsOfferer(undefined, true);

		expect(mockPC.createDataChannel).toHaveBeenCalledWith("custom-dc", { ordered: false, maxRetransmits: 0 });
	});

	it("should create PeerConnection as answerer with only control channel", async () => {
		const session = new RtcSession("peer-abc");
		const signalingHandler = vi.fn();
		session.on("signaling", signalingHandler);

		const offerSdp = { type: "offer" as const, sdp: "remote-offer-sdp" };
		session.startAsAnswerer(offerSdp);

		expect(session.peerConnection).toBe(mockPC);
		// Answerer doesn't create application DataChannel
		// Only control channel is created (negotiated)
		expect(session.controlChannel).toBeDefined();
		expect(mockPC.createDataChannel).toHaveBeenCalledTimes(1);
		expect(mockPC.createDataChannel).toHaveBeenCalledWith("_ctrl", { negotiated: true, id: 0, ordered: true });

		await vi.waitFor(() => {
			expect(mockPC.setRemoteDescription).toHaveBeenCalled();
			expect(mockPC.createAnswer).toHaveBeenCalled();
			expect(mockPC.setLocalDescription).toHaveBeenCalled();
		});

		// Should emit signaling with answer
		expect(signalingHandler).toHaveBeenCalled();
		expect(signalingHandler.mock.calls[0][0]).toBe(SignalingType.Answer);
	});

	it("should handle incoming answer signaling", async () => {
		const session = new RtcSession("peer-abc");
		session.startAsOfferer();

		await vi.waitFor(() => expect(mockPC.createOffer).toHaveBeenCalled());

		session.handleSignaling(SignalingType.Answer, {
			sdp: { type: "answer", sdp: "remote-answer" },
		});

		await vi.waitFor(() => {
			expect(mockPC.setRemoteDescription).toHaveBeenCalledWith({
				type: "answer",
				sdp: "remote-answer",
			});
		});
	});

	it("should handle incoming ICE candidate", async () => {
		const session = new RtcSession("peer-abc");
		session.startAsOfferer();

		const candidate = { candidate: "candidate:...", sdpMid: "0" };
		session.handleSignaling(SignalingType.Candidate, { candidate });

		await vi.waitFor(() => {
			expect(mockPC.addIceCandidate).toHaveBeenCalledWith(candidate);
		});
	});

	it("should emit iceStateChanged on state change", () => {
		const session = new RtcSession("peer-abc");
		const iceHandler = vi.fn();
		session.on("iceStateChanged", iceHandler);

		session.startAsOfferer();

		mockPC.iceConnectionState = "connected";
		mockPC.oniceconnectionstatechange();

		expect(iceHandler).toHaveBeenCalledWith("connected");
	});

	it("should close on ICE failed state", () => {
		const session = new RtcSession("peer-abc");
		const closeHandler = vi.fn();
		session.on("close", closeHandler);

		session.startAsOfferer();

		mockPC.iceConnectionState = "failed";
		mockPC.oniceconnectionstatechange();

		expect(closeHandler).toHaveBeenCalled();
		expect(session.peerConnection).toBeNull();
	});

	it("should emit dataChannel event on incoming datachannel with matching label", () => {
		const session = new RtcSession("peer-abc");
		const dcHandler = vi.fn();
		session.on("dataChannel", dcHandler);

		session.startAsOfferer();

		const mockChannel = { label: "dc:upeer" };
		mockPC.ondatachannel({ channel: mockChannel });

		expect(dcHandler).toHaveBeenCalledWith(mockChannel);
		expect(session.dataChannel).toBe(mockChannel);
	});

	it("should ignore datachannel with wrong label", () => {
		const session = new RtcSession("peer-abc");
		const dcHandler = vi.fn();
		session.on("dataChannel", dcHandler);

		session.startAsOfferer();
		mockPC.ondatachannel({ channel: { label: "other-channel" } });

		expect(dcHandler).not.toHaveBeenCalled();
	});

	it("should add tracks when stream provided to offerer", () => {
		const session = new RtcSession("peer-abc");
		const mockTrack1 = { kind: "video" };
		const mockTrack2 = { kind: "audio" };
		const mockStream = {
			getTracks: () => [mockTrack1, mockTrack2],
		} as any;

		session.startAsOfferer(mockStream);

		expect(mockPC.addTrack).toHaveBeenCalledTimes(2);
		expect(mockPC.addTrack).toHaveBeenCalledWith(mockTrack1, mockStream);
		expect(mockPC.addTrack).toHaveBeenCalledWith(mockTrack2, mockStream);
	});

	it("should not add tracks in dataOnly mode", () => {
		const session = new RtcSession("peer-abc");
		const mockStream = { getTracks: () => [{ kind: "video" }] } as any;

		session.startAsOfferer(mockStream, true);

		expect(mockPC.addTrack).not.toHaveBeenCalled();
	});

	it("should clean up on close", () => {
		const session = new RtcSession("peer-abc");
		session.startAsOfferer();

		const closeHandler = vi.fn();
		session.on("close", closeHandler);

		session.close();

		expect(mockPC.close).toHaveBeenCalled();
		expect(session.peerConnection).toBeNull();
		expect(session.dataChannel).toBeNull();
		expect(session.controlChannel).toBeNull();
		expect(closeHandler).toHaveBeenCalled();
	});

	it("should emit stream event on remote track", () => {
		const session = new RtcSession("peer-abc");
		const streamHandler = vi.fn();
		session.on("stream", streamHandler);

		session.startAsOfferer();

		const mockStream = { id: "remote-stream" };
		mockPC.ontrack({ streams: [mockStream] });

		expect(streamHandler).toHaveBeenCalledWith(mockStream);
	});

	it("should replace tracks on existing senders", () => {
		const session = new RtcSession("peer-abc");
		session.startAsOfferer();

		const newVideoTrack = { kind: "video" };
		const newAudioTrack = { kind: "audio" };
		const videoSender = { track: { kind: "video" }, replaceTrack: vi.fn() };
		const audioSender = { track: { kind: "audio" }, replaceTrack: vi.fn() };

		mockPC.getSenders.mockReturnValue([videoSender, audioSender]);

		const mockStream = {
			getVideoTracks: () => [newVideoTrack],
			getAudioTracks: () => [newAudioTrack],
		} as any;

		session.replaceTrack(mockStream);

		expect(videoSender.replaceTrack).toHaveBeenCalledWith(newVideoTrack);
		expect(audioSender.replaceTrack).toHaveBeenCalledWith(newAudioTrack);
	});
});
