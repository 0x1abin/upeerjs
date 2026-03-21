import { EventEmitter } from "eventemitter3";
import { createLogger, type Logger } from "../util/logger";

export class DataConnection extends EventEmitter {
	private static readonly MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024; // 8MB

	private _closed = false;
	private _log: Logger;
	dataChannel: RTCDataChannel;

	constructor(dataChannel: RTCDataChannel, logger?: Logger) {
		super();
		this._log = logger ?? createLogger("upeer:dc");
		this.dataChannel = dataChannel;
		this._initializeDataChannel();
	}

	private _initializeDataChannel(): void {
		this.dataChannel.binaryType = "arraybuffer";
		this.dataChannel.bufferedAmountLowThreshold = DataConnection.MAX_BUFFERED_AMOUNT / 2;

		if (this.dataChannel.readyState === "open") {
			queueMicrotask(() => this.emit("open"));
		} else {
			this.dataChannel.addEventListener("open", () => this.emit("open"));
		}
		this.dataChannel.addEventListener("close", () => {
			if (!this._closed) this.close();
		});
		this.dataChannel.addEventListener("message", (e) => {
			if (this._closed) return;
			this.emit("data", new Uint8Array(e.data as ArrayBuffer));
		});
	}

	/** Send raw bytes with backpressure */
	async send(data: Uint8Array | ArrayBuffer): Promise<void> {
		if (this._closed || this.dataChannel.readyState !== "open") return;

		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

		// Backpressure
		if (this.dataChannel.bufferedAmount > DataConnection.MAX_BUFFERED_AMOUNT - bytes.byteLength) {
			await new Promise<void>((resolve) =>
				this.dataChannel.addEventListener("bufferedamountlow", () => resolve(), { once: true }),
			);
		}

		try {
			this.dataChannel.send(bytes as Uint8Array<ArrayBuffer>);
		} catch (e) {
			this._log.error(`DC#${this.dataChannel.id} send error:`, e);
			this.close();
		}
	}

	close(): void {
		if (this._closed) return;
		this._closed = true;
		if (this.dataChannel.readyState === "open") {
			this.dataChannel.close();
		}
		this.emit("close");
	}
}
