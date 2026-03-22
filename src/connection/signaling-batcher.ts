import { SignalingType } from "../types";

export class SignalingBatcher {
	private _onFlush: (type: SignalingType, data: unknown) => void;

	constructor(onFlush: (type: SignalingType, data: unknown) => void) {
		this._onFlush = onFlush;
	}

	push(type: SignalingType, payload: unknown): void {
		this._onFlush(type, payload);
	}

	destroy(): void {}
}
