import type { SignalingItem, SignalingType } from "../types";

export class SignalingBatcher {
	private _queue: SignalingItem[] = [];
	private _timer: ReturnType<typeof setTimeout> | null = null;
	private _delay: number;
	private _flushThreshold: number;
	private _onFlush: (items: SignalingItem[]) => void;

	constructor(
		onFlush: (items: SignalingItem[]) => void,
		delay: number = 16,
		flushThreshold: number = 10,
	) {
		this._onFlush = onFlush;
		this._delay = delay;
		this._flushThreshold = flushThreshold;
	}

	push(type: SignalingType, payload: any, immediate?: boolean): void {
		this._queue.push({ type, payload });

		if (immediate || this._queue.length > this._flushThreshold) {
			this._flush();
		} else {
			if (this._timer) clearTimeout(this._timer);
			this._timer = setTimeout(() => this._flush(), this._delay);
		}
	}

	private _flush(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		if (this._queue.length === 0) return;
		const items = this._queue;
		this._queue = [];
		this._onFlush(items);
	}

	destroy(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		this._queue = [];
	}
}
