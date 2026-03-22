import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "eventemitter3";
import { MqttTransport } from "../../src/transport/mqtt-transport";
import { JsonCodec } from "../../src/util/codec";

// Mock mqtt module
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

describe("MqttTransport", () => {
	const codec = new JsonCodec();
	let transport: MqttTransport;

	beforeEach(() => {
		vi.clearAllMocks();
		mockMqttClient.removeAllListeners();
		mockMqttClient.subscribe = vi.fn((_topic: string, cb: (err: Error | null) => void) => cb(null));
		transport = new MqttTransport("test-peer", { url: "wss://test.com/mqtt" }, codec);
	});

	it("should start disconnected", () => {
		expect(transport.connected).toBe(false);
	});

	it("should connect and emit open after subscribe", () => {
		const onOpen = vi.fn();
		transport.on("open", onOpen);

		transport.connect();
		mockMqttClient.emit("connect");

		expect(transport.connected).toBe(true);
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("should emit error on subscribe failure", () => {
		mockMqttClient.subscribe = vi.fn((_topic: string, cb: (err: Error | null) => void) =>
			cb(new Error("sub failed")),
		);

		const onError = vi.fn();
		transport.on("error", onError);

		transport.connect();
		mockMqttClient.emit("connect");

		expect(onError).toHaveBeenCalledTimes(1);
		expect(transport.connected).toBe(false);
	});

	it("should dispatch signaling messages to handler", () => {
		const handler = vi.fn();
		transport.onMessage(handler);

		transport.connect();
		mockMqttClient.emit("connect");

		const signalingMsg = {
			type: "offer",
			data: { sdp: "test" },
			src: "remote-peer",
		};
		const encoded = codec.encode(signalingMsg);
		const buf = Buffer.from(encoded);

		mockMqttClient.emit("message", "test-peer", buf);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
			type: "offer",
			src: "remote-peer",
			data: signalingMsg.data,
		}));
	});

	it("should ignore messages for other topics", () => {
		const handler = vi.fn();
		transport.onMessage(handler);

		transport.connect();
		mockMqttClient.emit("connect");

		const buf = Buffer.from(codec.encode({ type: "offer", src: "x", data: {} }));
		mockMqttClient.emit("message", "other-peer", buf);

		expect(handler).not.toHaveBeenCalled();
	});

	it("should ignore messages without src field", () => {
		const handler = vi.fn();
		transport.onMessage(handler);

		transport.connect();
		mockMqttClient.emit("connect");

		const buf = Buffer.from(codec.encode({ type: "offer", data: { sdp: "test" } }));
		mockMqttClient.emit("message", "test-peer", buf);

		expect(handler).not.toHaveBeenCalled();
	});

	it("should ignore messages without type field", () => {
		const handler = vi.fn();
		transport.onMessage(handler);

		transport.connect();
		mockMqttClient.emit("connect");

		const buf = Buffer.from(codec.encode({ src: "remote-peer", data: {} }));
		mockMqttClient.emit("message", "test-peer", buf);

		expect(handler).not.toHaveBeenCalled();
	});

	it("should queue messages when not connected", async () => {
		transport.connect();
		// Not yet connected — no "connect" event emitted

		const data = codec.encode({ test: true });
		await transport.send("remote-peer", data);

		expect(mockMqttClient.publish).not.toHaveBeenCalled();

		// Now connect
		mockMqttClient.emit("connect");

		// Queued messages should be flushed
		expect(mockMqttClient.publish).toHaveBeenCalledTimes(1);
	});

	it("should send messages directly when connected", async () => {
		transport.connect();
		mockMqttClient.emit("connect");

		const data = codec.encode({ hello: "world" });
		await transport.send("remote-peer", data);

		expect(mockMqttClient.publish).toHaveBeenCalledTimes(1);
		expect(mockMqttClient.publish.mock.calls[0][0]).toBe("remote-peer");
	});

	it("should disconnect and clean up", () => {
		transport.connect();
		mockMqttClient.emit("connect");
		expect(transport.connected).toBe(true);

		transport.disconnect();
		expect(transport.connected).toBe(false);
		expect(mockMqttClient.end).toHaveBeenCalledTimes(1);
	});

	it("should not connect twice", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		transport.connect();
		mockMqttClient.emit("connect");

		transport.connect(); // second call should warn
		expect(warnSpy).toHaveBeenCalledWith("W", "[upeer:mqtt]:", "Already connected");

		warnSpy.mockRestore();
	});

	it("should handle disconnect event", () => {
		const onDisconnected = vi.fn();
		transport.on("disconnected", onDisconnected);

		transport.connect();
		mockMqttClient.emit("connect");
		mockMqttClient.emit("disconnect");

		expect(onDisconnected).toHaveBeenCalledTimes(1);
		expect(transport.connected).toBe(false);
	});

	it("should emit close on mqtt close", () => {
		const onClose = vi.fn();
		transport.on("close", onClose);

		transport.connect();
		mockMqttClient.emit("close");

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("should drop messages when queue is full", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		transport.connect();
		// Don't emit "connect" so messages go to queue

		const data = codec.encode({ x: 1 });
		for (let i = 0; i < 129; i++) {
			await transport.send(`peer-${i}`, data);
		}

		// 128 should be queued, 129th dropped
		expect(warnSpy).toHaveBeenCalledWith("W", "[upeer:mqtt]:", "Message queue full, dropping message");
		warnSpy.mockRestore();
	});

	it("should work with encryption", async () => {
		const mockEncryption = {
			ready: true,
			waitReady: vi.fn(),
			encrypt: vi.fn(async (data: Uint8Array) => {
				// Simple "encryption": prepend 0xFF
				const result = new Uint8Array(data.length + 1);
				result[0] = 0xff;
				result.set(data, 1);
				return result;
			}),
			decrypt: vi.fn(async (data: Uint8Array) => data.subarray(1)),
		};

		const encTransport = new MqttTransport(
			"enc-peer",
			{ url: "wss://test.com/mqtt" },
			codec,
			mockEncryption,
		);

		encTransport.connect();
		mockMqttClient.emit("connect");

		const data = codec.encode({ secret: true });
		await encTransport.send("remote", data);

		expect(mockEncryption.encrypt).toHaveBeenCalledTimes(1);
		expect(mockMqttClient.publish).toHaveBeenCalledTimes(1);
	});
});
