import { SignalingType } from "../types";

export class SignalingBatcher {
	private _candidateQueue: any[] = [];
	private _timer: ReturnType<typeof setTimeout> | null = null;
	private _delay: number;
	private _flushThreshold: number;
	private _onFlush: (type: SignalingType, data: any) => void;

	constructor(
		onFlush: (type: SignalingType, data: any) => void,
		delay: number = 16,
		flushThreshold: number = 10,
	) {
		this._onFlush = onFlush;
		this._delay = delay;
		this._flushThreshold = flushThreshold;
	}

	push(type: SignalingType, payload: any): void {
		if (type === SignalingType.Candidate) {
			this._candidateQueue.push(payload);
			if (this._candidateQueue.length > this._flushThreshold) {
				this._flushCandidates();
			} else {
				if (this._timer) clearTimeout(this._timer);
				this._timer = setTimeout(() => this._flushCandidates(), this._delay);
			}
		} else {
			this._flushCandidates(); // flush pending candidates first
			this._onFlush(type, payload);
		}
	}

	private _flushCandidates(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		if (this._candidateQueue.length === 0) return;
		const candidates = this._candidateQueue;
		this._candidateQueue = [];
		this._onFlush(SignalingType.Candidate, candidates);
	}

	destroy(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		this._candidateQueue = [];
	}
}
