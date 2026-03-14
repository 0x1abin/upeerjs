import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignalingBatcher } from "../../src/connection/signaling-batcher";
import { SignalingType } from "../../src/types";

describe("SignalingBatcher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should batch messages and flush after delay", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 16);

		batcher.push(SignalingType.Candidate, { candidate: "c1" });
		batcher.push(SignalingType.Candidate, { candidate: "c2" });

		expect(onFlush).not.toHaveBeenCalled();

		vi.advanceTimersByTime(16);

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith([
			{ type: SignalingType.Candidate, payload: { candidate: "c1" } },
			{ type: SignalingType.Candidate, payload: { candidate: "c2" } },
		]);
	});

	it("should flush immediately when immediate=true", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Offer, { sdp: "offer-sdp" }, true);

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith([
			{ type: SignalingType.Offer, payload: { sdp: "offer-sdp" } },
		]);
	});

	it("should flush when queue exceeds threshold", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 16, 3); // threshold=3

		batcher.push(SignalingType.Candidate, { n: 1 });
		batcher.push(SignalingType.Candidate, { n: 2 });
		batcher.push(SignalingType.Candidate, { n: 3 });

		// 3 items = threshold, not yet flushed
		expect(onFlush).not.toHaveBeenCalled();

		batcher.push(SignalingType.Candidate, { n: 4 });

		// 4 items > threshold=3, should auto-flush
		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush.mock.calls[0][0]).toHaveLength(4);
	});

	it("should reset timer on subsequent pushes (debounce)", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 50);

		batcher.push(SignalingType.Candidate, { n: 1 });
		vi.advanceTimersByTime(30);
		expect(onFlush).not.toHaveBeenCalled();

		// Push again, timer resets
		batcher.push(SignalingType.Candidate, { n: 2 });
		vi.advanceTimersByTime(30);
		expect(onFlush).not.toHaveBeenCalled();

		vi.advanceTimersByTime(20);
		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush.mock.calls[0][0]).toHaveLength(2);
	});

	it("should not flush empty queue", () => {
		const onFlush = vi.fn();
		new SignalingBatcher(onFlush, 16);
		vi.advanceTimersByTime(100);
		expect(onFlush).not.toHaveBeenCalled();
	});

	it("should clear queue and timer on destroy", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 16);

		batcher.push(SignalingType.Candidate, { n: 1 });
		batcher.destroy();

		vi.advanceTimersByTime(100);
		expect(onFlush).not.toHaveBeenCalled();
	});

	it("should include immediate items with batched ones", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 16);

		batcher.push(SignalingType.Candidate, { n: 1 });
		batcher.push(SignalingType.Offer, { sdp: "test" }, true);

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush.mock.calls[0][0]).toHaveLength(2);
		expect(onFlush.mock.calls[0][0][0].type).toBe(SignalingType.Candidate);
		expect(onFlush.mock.calls[0][0][1].type).toBe(SignalingType.Offer);
	});

	it("should handle multiple flush cycles", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 16);

		batcher.push(SignalingType.Candidate, { n: 1 });
		vi.advanceTimersByTime(16);
		expect(onFlush).toHaveBeenCalledTimes(1);

		batcher.push(SignalingType.Answer, { sdp: "answer" });
		vi.advanceTimersByTime(16);
		expect(onFlush).toHaveBeenCalledTimes(2);
		expect(onFlush.mock.calls[1][0]).toEqual([
			{ type: SignalingType.Answer, payload: { sdp: "answer" } },
		]);
	});
});
