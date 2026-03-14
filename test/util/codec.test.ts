import { describe, it, expect } from "vitest";
import { JsonCodec } from "../../src/util/codec";

describe("JsonCodec", () => {
	const codec = new JsonCodec();

	it("should encode object to Uint8Array", () => {
		const data = { hello: "world", num: 42 };
		const encoded = codec.encode(data);
		expect(encoded).toBeInstanceOf(Uint8Array);
		expect(encoded.length).toBeGreaterThan(0);
	});

	it("should decode Uint8Array back to object", () => {
		const data = { hello: "world", num: 42, nested: { a: [1, 2, 3] } };
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(data);
	});

	it("should handle empty object", () => {
		const encoded = codec.encode({});
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual({});
	});

	it("should handle string data", () => {
		const encoded = codec.encode("hello");
		const decoded = codec.decode(encoded);
		expect(decoded).toBe("hello");
	});

	it("should handle array data", () => {
		const data = [1, "two", { three: 3 }];
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(data);
	});

	it("should handle null", () => {
		const encoded = codec.encode(null);
		const decoded = codec.decode(encoded);
		expect(decoded).toBeNull();
	});

	it("should handle unicode characters", () => {
		const data = { msg: "你好世界 🌍" };
		const encoded = codec.encode(data);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(data);
	});

	it("should roundtrip signaling-like messages", () => {
		const signalingMsg = {
			type: "signaling",
			src: "peer-abc123",
			data: [
				{ type: "offer", payload: { sdp: { type: "offer", sdp: "v=0..." } } },
				{ type: "candidate", payload: { candidate: { candidate: "a]candidate..." } } },
			],
		};
		const encoded = codec.encode(signalingMsg);
		const decoded = codec.decode(encoded);
		expect(decoded).toEqual(signalingMsg);
	});
});
