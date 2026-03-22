import { describe, it, expect, vi, beforeEach } from "vitest";
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
		new DataConnection(mockDC as unknown as RTCDataChannel);

		expect(mockDC.binaryType).toBe("arraybuffer");
		expect(mockDC.bufferedAmountLowThreshold).toBe(4 * 1024 * 1024); // MAX/2
	});

	it("should emit open when data channel opens", () => {
		const dc = new DataConnection(mockDC as unknown as RTCDataChannel);
		const openHandler = vi.fn();
		dc.on("open", openHandler);

		mockDC.dispatchEvent(new Event("open"));
		expect(openHandler).toHaveBeenCalledTimes(1);
	});

	it("should emit close event and clean up", () => {
		const dc = new DataConnection(mockDC as unknown as RTCDataChannel);
		const closeHandler = vi.fn();
		dc.on("close", closeHandler);

		mockDC.readyState = "open";
		dc.close();

		expect(closeHandler).toHaveBeenCalledTimes(1);
		expect(mockDC.close).toHaveBeenCalledTimes(1);
	});

	it("should not close twice", () => {
		const dc = new DataConnection(mockDC as unknown as RTCDataChannel);
		const closeHandler = vi.fn();
		dc.on("close", closeHandler);

		mockDC.readyState = "open";
		dc.close();
		dc.close();

		expect(closeHandler).toHaveBeenCalledTimes(1);
	});

	it("should handle DC close event from remote", () => {
		const dc = new DataConnection(mockDC as unknown as RTCDataChannel);
		const closeHandler = vi.fn();
		dc.on("close", closeHandler);

		mockDC.readyState = "open";
		mockDC.dispatchEvent(new Event("close"));

		expect(closeHandler).toHaveBeenCalledTimes(1);
	});

	it("should resolve send immediately when closed", async () => {
		const dc = new DataConnection(mockDC as unknown as RTCDataChannel);
		dc.close();
		// Should not throw, just resolve
		await dc.send(new Uint8Array([1, 2, 3]));
	});

	it("should emit raw Uint8Array on message", () => {
		const dc = new DataConnection(mockDC as unknown as RTCDataChannel);
		const dataHandler = vi.fn();
		dc.on("data", dataHandler);

		const testData = new Uint8Array([1, 2, 3, 4]).buffer;
		mockDC.dispatchEvent(Object.assign(new Event("message"), { data: testData }));

		expect(dataHandler).toHaveBeenCalledTimes(1);
		const received = dataHandler.mock.calls[0][0];
		expect(received).toBeInstanceOf(Uint8Array);
		expect(Array.from(received)).toEqual([1, 2, 3, 4]);
	});

	it("should send raw Uint8Array", async () => {
		const dc = new DataConnection(mockDC as unknown as RTCDataChannel);
		mockDC.readyState = "open";

		await dc.send(new Uint8Array([5, 6, 7]));
		expect(mockDC.send).toHaveBeenCalledTimes(1);
	});
});
