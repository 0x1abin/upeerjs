import { describe, it, expect, vi } from "vitest";
import { SignalingBatcher } from "../../src/connection/signaling-batcher";
import { SignalingType } from "../../src/types";

describe("SignalingBatcher", () => {
	it("should pass candidate through immediately", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Candidate, { candidate: "c1" });

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Candidate, { candidate: "c1" });
	});

	it("should pass offer through immediately", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Offer, { sdp: "offer-sdp" });

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Offer, { sdp: "offer-sdp" });
	});

	it("should pass answer through immediately", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Answer, { sdp: "answer-sdp" });

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Answer, { sdp: "answer-sdp" });
	});

	it("should pass multiple candidates through individually", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Candidate, { candidate: "c1" });
		batcher.push(SignalingType.Candidate, { candidate: "c2" });
		batcher.push(SignalingType.Candidate, { candidate: "c3" });

		expect(onFlush).toHaveBeenCalledTimes(3);
		expect(onFlush.mock.calls[0]).toEqual([SignalingType.Candidate, { candidate: "c1" }]);
		expect(onFlush.mock.calls[1]).toEqual([SignalingType.Candidate, { candidate: "c2" }]);
		expect(onFlush.mock.calls[2]).toEqual([SignalingType.Candidate, { candidate: "c3" }]);
	});

	it("should handle interleaved types in order", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Candidate, { candidate: "c1" });
		batcher.push(SignalingType.Offer, { sdp: "test" });
		batcher.push(SignalingType.Candidate, { candidate: "c2" });

		expect(onFlush).toHaveBeenCalledTimes(3);
		expect(onFlush.mock.calls[0]).toEqual([SignalingType.Candidate, { candidate: "c1" }]);
		expect(onFlush.mock.calls[1]).toEqual([SignalingType.Offer, { sdp: "test" }]);
		expect(onFlush.mock.calls[2]).toEqual([SignalingType.Candidate, { candidate: "c2" }]);
	});

	it("destroy should be callable without error", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);
		expect(() => batcher.destroy()).not.toThrow();
	});
});
