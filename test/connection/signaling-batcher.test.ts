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

	it("should batch candidates and flush after delay", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 16);

		batcher.push(SignalingType.Candidate, { candidate: "c1" });
		batcher.push(SignalingType.Candidate, { candidate: "c2" });

		expect(onFlush).not.toHaveBeenCalled();

		vi.advanceTimersByTime(16);

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Candidate, [
			{ candidate: "c1" },
			{ candidate: "c2" },
		]);
	});

	it("should flush offer immediately", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Offer, { sdp: "offer-sdp" });

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Offer, { sdp: "offer-sdp" });
	});

	it("should flush answer immediately", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Answer, { sdp: "answer-sdp" });

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Answer, { sdp: "answer-sdp" });
	});

	it("should flush leave immediately", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush);

		batcher.push(SignalingType.Leave, {});

		expect(onFlush).toHaveBeenCalledTimes(1);
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Leave, {});
	});

	it("should flush candidates when queue exceeds threshold", () => {
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
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Candidate, [
			{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 },
		]);
	});

	it("should reset timer on subsequent candidate pushes (debounce)", () => {
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
		expect(onFlush).toHaveBeenCalledWith(SignalingType.Candidate, [
			{ n: 1 }, { n: 2 },
		]);
	});

	it("should not flush empty candidate queue", () => {
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

	it("should flush pending candidates before non-candidate type", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 16);

		batcher.push(SignalingType.Candidate, { n: 1 });
		batcher.push(SignalingType.Offer, { sdp: "test" });

		expect(onFlush).toHaveBeenCalledTimes(2);
		// First call: flush pending candidates
		expect(onFlush.mock.calls[0][0]).toBe(SignalingType.Candidate);
		expect(onFlush.mock.calls[0][1]).toEqual([{ n: 1 }]);
		// Second call: the offer itself
		expect(onFlush.mock.calls[1][0]).toBe(SignalingType.Offer);
		expect(onFlush.mock.calls[1][1]).toEqual({ sdp: "test" });
	});

	it("should handle multiple flush cycles", () => {
		const onFlush = vi.fn();
		const batcher = new SignalingBatcher(onFlush, 16);

		batcher.push(SignalingType.Candidate, { n: 1 });
		vi.advanceTimersByTime(16);
		expect(onFlush).toHaveBeenCalledTimes(1);

		batcher.push(SignalingType.Answer, { sdp: "answer" });
		expect(onFlush).toHaveBeenCalledTimes(2);
		expect(onFlush.mock.calls[1]).toEqual([SignalingType.Answer, { sdp: "answer" }]);
	});
});
