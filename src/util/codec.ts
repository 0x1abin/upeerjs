import type { ICodec } from "../types";

export class JsonCodec implements ICodec {
	private _encoder = new TextEncoder();
	private _decoder = new TextDecoder();

	encode(data: any): Uint8Array {
		return this._encoder.encode(JSON.stringify(data));
	}

	decode(data: Uint8Array): any {
		return JSON.parse(this._decoder.decode(data));
	}
}
