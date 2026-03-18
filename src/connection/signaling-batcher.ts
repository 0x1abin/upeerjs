import { SignalingType } from "../types";

export class SignalingBatcher {
	private _onFlush: (type: SignalingType, data: any) => void;

	constructor(onFlush: (type: SignalingType, data: any) => void) {
		this._onFlush = onFlush;
	}

	push(type: SignalingType, payload: any): void {
		this._onFlush(type, payload);
	}

	destroy(): void {}
}
