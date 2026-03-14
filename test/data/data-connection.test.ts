import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "eventemitter3";
import { DataConnection } from "../../src/data/data-connection";

class MockDataChannel extends EventTarget {
	label = "dc:upeer";
	readyState = "connecting";
	binaryType = "";
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	id = 1;

	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = "closed";
		this.dispatchEvent(new Event("close"));
	});
}

describe("DataConnection", () => {
	let mockDC: MockDataChannel;

	beforeEach(() => {
		mockDC = new MockDataChannel();
	});

	it("should initialize data channel settings", () => {
		new DataConnection(mockDC as any);

		expect(mockDC.binaryType).toBe("arraybuffer");
		expect(mockDC.bufferedAmountLowThreshold).toBe(4 * 1024 * 1024); // MAX/2
	});

	it("should emit open when data channel opens", () => {
		const dc = new DataConnection(mockDC as any);
		const openHandler = vi.fn();
		dc.on("open", openHandler);

		mockDC.dispatchEvent(new Event("open"));
		expect(openHandler).toHaveBeenCalledTimes(1);
	});

	it("should emit close event and clean up", () => {
		const dc = new DataConnection(mockDC as any);
		const closeHandler = vi.fn();
		dc.on("close", closeHandler);

		mockDC.readyState = "open";
		dc.close();

		expect(closeHandler).toHaveBeenCalledTimes(1);
		expect(mockDC.close).toHaveBeenCalledTimes(1);
	});

	it("should not close twice", () => {
		const dc = new DataConnection(mockDC as any);
		const closeHandler = vi.fn();
		dc.on("close", closeHandler);

		mockDC.readyState = "open";
		dc.close();
		dc.close();

		expect(closeHandler).toHaveBeenCalledTimes(1);
	});

	it("should handle DC close event from remote", () => {
		const dc = new DataConnection(mockDC as any);
		const closeHandler = vi.fn();
		dc.on("close", closeHandler);

		mockDC.readyState = "open";
		mockDC.dispatchEvent(new Event("close"));

		expect(closeHandler).toHaveBeenCalledTimes(1);
	});

	it("should resolve send immediately when closed", async () => {
		const dc = new DataConnection(mockDC as any);
		dc.close();
		// Should not throw, just resolve
		await dc.send({ test: true });
	});
});
