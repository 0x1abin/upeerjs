import { encode, decode } from "@msgpack/msgpack";
import type { ICodec } from "../types";

export class JsonCodec implements ICodec {
	private _encoder = new TextEncoder();
	private _decoder = new TextDecoder();

	encode(data: unknown): Uint8Array {
		return this._encoder.encode(JSON.stringify(data));
	}

	decode(data: Uint8Array): unknown {
		return JSON.parse(this._decoder.decode(data));
	}
}

export class MsgpackCodec implements ICodec {
	encode(data: unknown): Uint8Array {
		return encode(data);
	}

	decode(data: Uint8Array): unknown {
		return decode(data);
	}
}
