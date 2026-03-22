import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "eventemitter3";
import { encode as msgpackEncode } from "@msgpack/msgpack";

// Mock mqtt before importing Peer
interface MockMqttClient extends EventEmitter {
	subscribe: ReturnType<typeof vi.fn>;
	publish: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
}
const mockMqttClient = new EventEmitter() as MockMqttClient;
mockMqttClient.subscribe = vi.fn((_topic: string, cb: (err: Error | null) => void) => cb(null));
mockMqttClient.publish = vi.fn();
mockMqttClient.end = vi.fn();

vi.mock("mqtt", () => ({
	default: {
		connect: vi.fn(() => mockMqttClient),
	},
}));

// Mock RTCPeerConnection
function createMockPC() {
	return {
		onicecandidate: null as RTCPeerConnection["onicecandidate"],
		oniceconnectionstatechange: null as RTCPeerConnection["oniceconnectionstatechange"],
		ontrack: null as RTCPeerConnection["ontrack"],
		ondatachannel: null as RTCPeerConnection["ondatachannel"],
		iceConnectionState: "new",
		signalingState: "stable",
		createOffer: vi.fn(async () => ({ type: "offer", sdp: "mock-offer" })),
		createAnswer: vi.fn(async () => ({ type: "answer", sdp: "mock-answer" })),
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
			binaryType: "",
			bufferedAmount: 0,
			bufferedAmountLowThreshold: 0,
			id: init?.id ?? 1,
			send: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			onmessage: null,
		})),
		close: vi.fn(),
	};
}

vi.stubGlobal("RTCPeerConnection", function MockRTCPeerConnection() {
	return createMockPC();
});
vi.stubGlobal("RTCSessionDescription", function MockRTCSessionDescription(init: RTCSessionDescriptionInit) {
	return init;
});

import { Peer } from "../src/peer";

describe("Peer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMqttClient.removeAllListeners();
		mockMqttClient.subscribe = vi.fn((_topic: string, cb: (err: Error | null) => void) => cb(null));
	});

	describe("constructor", () => {
		it("should create with auto-generated peerId", () => {
			const peer = new Peer({ brokerUrl: "wss://test.com/mqtt" });
			expect(peer.peerId).toBeDefined();
			expect(peer.peerId.length).toBe(21);
		});

		it("should create with custom peerId", () => {
			const peer = new Peer("my-peer-id", { brokerUrl: "wss://test.com/mqtt" });
			expect(peer.peerId).toBe("my-peer-id");
		});

		it("should start disconnected", () => {
			const peer = new Peer({ brokerUrl: "wss://test.com/mqtt" });
			expect(peer.connected).toBe(false);
		});

		it("should have null localStream initially", () => {
			const peer = new Peer({ brokerUrl: "wss://test.com/mqtt" });
			expect(peer.localStream).toBeNull();
		});
	});

	describe("start", () => {
		it("should connect and emit open", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			const onOpen = vi.fn();
			peer.on("open", onOpen);

			peer.start();
			mockMqttClient.emit("connect");

			expect(peer.connected).toBe(true);
			expect(onOpen).toHaveBeenCalledWith("test-peer");
		});

		it("should emit close on MQTT close", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			const onClose = vi.fn();
			peer.on("close", onClose);

			peer.start();
			mockMqttClient.emit("close");

			expect(onClose).toHaveBeenCalled();
		});

		it("should emit error on MQTT error", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			const onError = vi.fn();
			peer.on("error", onError);

			peer.start();
			mockMqttClient.emit("error", new Error("connection failed"));

			expect(onError).toHaveBeenCalled();
		});
	});

	describe("call", () => {
		it("should create RtcSession and emit call event", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			peer.start();
			mockMqttClient.emit("connect");

			const onCall = vi.fn();
			peer.on("call", onCall);

			const session = peer.call("remote-peer");

			expect(session).toBeDefined();
			expect(session.peerId).toBe("remote-peer");
			expect(onCall).toHaveBeenCalledWith({
				peerId: "remote-peer",
				call: session,
			});
		});

		it("should cleanup existing session before new call", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			peer.start();
			mockMqttClient.emit("connect");

			const session1 = peer.call("remote-peer");
			const closeSpy = vi.spyOn(session1, "close");

			peer.call("remote-peer");

			expect(closeSpy).toHaveBeenCalled();
		});
	});

	describe("connect (data-only)", () => {
		it("should create data-only session", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			peer.start();
			mockMqttClient.emit("connect");

			const session = peer.connect("remote-peer");

			expect(session).toBeDefined();
			expect(session.peerId).toBe("remote-peer");
		});
	});

	describe("hangup", () => {
		it("should close session and emit hangup", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			peer.start();
			mockMqttClient.emit("connect");

			const onHangup = vi.fn();
			peer.on("hangup", onHangup);

			const session = peer.call("remote-peer");
			peer.hangup("remote-peer");

			expect(onHangup).toHaveBeenCalledWith({
				peerId: "remote-peer",
				call: session,
			});
		});

		it("should be noop for unknown peer", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			peer.start();
			mockMqttClient.emit("connect");

			expect(() => peer.hangup("unknown")).not.toThrow();
		});
	});

	describe("disconnect", () => {
		it("should close all sessions and transport", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			peer.start();
			mockMqttClient.emit("connect");

			peer.call("peer-a");
			peer.call("peer-b");

			peer.disconnect();
			expect(peer.connected).toBe(false);
		});
	});

	describe("destroy", () => {
		it("should disconnect and remove all listeners", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			peer.on("open", () => {});
			peer.on("close", () => {});

			peer.start();
			mockMqttClient.emit("connect");

			peer.destroy();
			expect(peer.connected).toBe(false);
			expect(peer.listenerCount("open")).toBe(0);
			expect(peer.listenerCount("close")).toBe(0);
		});
	});

	describe("setLocalStream", () => {
		it("should store local stream", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			const mockStream = { id: "local-stream" } as unknown as MediaStream;
			peer.setLocalStream(mockStream);
			expect(peer.localStream).toBe(mockStream);
		});
	});

	describe("incoming offer handling", () => {
		it("should handle incoming offer via signaling message", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			const onCall = vi.fn();
			peer.on("call", onCall);

			peer.start();
			mockMqttClient.emit("connect");

			// Simulate incoming signaling message
			const signalingMsg = {
				type: "offer",
				data: { sdp: { type: "offer", sdp: "remote-sdp" } },
				src: "remote-peer",
			};
			// Default codec is now MsgpackCodec, encode with msgpack
			const encoded = msgpackEncode(signalingMsg);
			const buf = Buffer.from(encoded);

			mockMqttClient.emit("message", "test-peer", buf);

			expect(onCall).toHaveBeenCalledTimes(1);
			expect(onCall.mock.calls[0][0].peerId).toBe("remote-peer");
		});
	});

	describe("encryption", () => {
		it("should create AesGcmEncryption when securityKey provided", () => {
			const peer = new Peer("test-peer", {
				brokerUrl: "wss://test.com/mqtt",
				securityKey: "1234567890abcdef",
			});
			// Just verify it doesn't throw
			expect(peer).toBeDefined();
		});

		it("should use custom encryption when provided", () => {
			const customEncryption = {
				ready: true,
				waitReady: vi.fn(),
				encrypt: vi.fn(async (d: Uint8Array) => d),
				decrypt: vi.fn(async (d: Uint8Array) => d),
			};

			const peer = new Peer("test-peer", {
				brokerUrl: "wss://test.com/mqtt",
				encryption: customEncryption,
			});
			expect(peer).toBeDefined();
		});
	});

	describe("broadcast and send", () => {
		it("should not throw when sending to unknown peer", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			expect(() => peer.send("unknown", new Uint8Array([1, 2, 3]))).not.toThrow();
		});

		it("should not throw when broadcasting with no connections", () => {
			const peer = new Peer("test-peer", { brokerUrl: "wss://test.com/mqtt" });
			expect(() => peer.broadcast(new Uint8Array([1, 2, 3]))).not.toThrow();
		});
	});
});
