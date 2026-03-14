import { EventEmitter } from "eventemitter3";
import { Encoder, decodeMultiStream } from "@msgpack/msgpack";

export class DataConnection extends EventEmitter {
	private static readonly CHUNK_SIZE = 1024 * 8 * 4; // 32KB
	private static readonly MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024; // 8MB

	private _encoder = new Encoder();
	private _closed = false;
	dataChannel: RTCDataChannel;

	private _splitStream = new TransformStream<Uint8Array>({
		transform: (chunk, controller) => {
			for (let offset = 0; offset < chunk.length; offset += DataConnection.CHUNK_SIZE) {
				controller.enqueue(chunk.subarray(offset, offset + DataConnection.CHUNK_SIZE));
			}
		},
	});

	private _rawSendStream = new WritableStream<ArrayBuffer>({
		write: async (chunk, controller) => {
			if (this._closed || this.dataChannel.readyState !== "open") {
				controller.error(new Error("DataChannel not open"));
				return;
			}

			if (this.dataChannel.bufferedAmount > DataConnection.MAX_BUFFERED_AMOUNT - chunk.byteLength) {
				await new Promise<void>((resolve) =>
					this.dataChannel.addEventListener("bufferedamountlow", () => resolve(), { once: true }),
				);
			}

			try {
				this.dataChannel.send(chunk);
			} catch (e) {
				console.error(`[upeer] DC#${this.dataChannel.id} send error:`, e);
				controller.error(e);
				this.close();
			}
		},
	});

	private _writer = this._splitStream.writable.getWriter();

	private _rawReadStream = new ReadableStream<ArrayBuffer>({
		start: (controller) => {
			this.once("open", () => {
				this.dataChannel.addEventListener("message", (e) => {
					if (this._closed) return;
					controller.enqueue(e.data);
				});
			});
			this.once("close", () => {
				try {
					controller.close();
				} catch {}
			});
		},
	});

	constructor(dataChannel: RTCDataChannel) {
		super();
		this.dataChannel = dataChannel;

		void this._splitStream.readable.pipeTo(this._rawSendStream).catch(() => {});

		this._startDecoding();
		this._initializeDataChannel();
	}

	private async _startDecoding(): Promise<void> {
		try {
			for await (const msg of decodeMultiStream(this._rawReadStream)) {
				if (this._closed) break;
				this.emit("data", msg);
			}
		} catch (e) {
			if (!this._closed) {
				console.error("[upeer] DataConnection decode error:", e);
			}
		}
	}

	private _initializeDataChannel(): void {
		this.dataChannel.binaryType = "arraybuffer";
		this.dataChannel.bufferedAmountLowThreshold = DataConnection.MAX_BUFFERED_AMOUNT / 2;
		this.dataChannel.addEventListener("open", () => this.emit("open"));
		this.dataChannel.addEventListener("close", () => {
			if (!this._closed) this.close();
		});
	}

	send(data: any): Promise<void> {
		if (this._closed) return Promise.resolve();
		return this._writer.write(this._encoder.encode(data));
	}

	close(): void {
		if (this._closed) return;
		this._closed = true;
		try {
			this._writer.close();
		} catch {}
		if (this.dataChannel.readyState === "open") {
			this.dataChannel.close();
		}
		this.emit("close");
	}
}
