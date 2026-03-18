import type { IEncryption } from "../types";

export interface AesGcmEncryptionOptions {
	/** Raw symmetric key (must be exactly 16, 24, or 32 bytes for AES-128/192/256) */
	securityKey: string;
}

const VALID_KEY_LENGTHS = new Set([16, 24, 32]);

export class AesGcmEncryption implements IEncryption {
	private _cryptoKey: CryptoKey | undefined;
	private _readyPromise: Promise<void>;
	private _isReady = false;

	// Replay protection state
	private _sendSeq = 0;
	private _lastSeenSeq: Map<string, number> = new Map();

	get ready(): boolean {
		return this._isReady;
	}

	constructor(options: AesGcmEncryptionOptions) {
		const raw = new TextEncoder().encode(options.securityKey);
		if (!VALID_KEY_LENGTHS.has(raw.byteLength)) {
			throw new Error(
				`Invalid key length: ${raw.byteLength} bytes. AES-GCM requires 16 (AES-128), 24 (AES-192), or 32 (AES-256) bytes.`,
			);
		}
		this._readyPromise = this._importKey(raw);
	}

	async waitReady(): Promise<void> {
		await this._readyPromise;
	}

	private async _importKey(raw: Uint8Array): Promise<void> {
		this._cryptoKey = await crypto.subtle.importKey(
			"raw",
			raw as Uint8Array<ArrayBuffer>,
			{ name: "AES-GCM" },
			false,
			["encrypt", "decrypt"],
		);
		this._isReady = true;
	}

	/**
	 * Encrypt data with replay protection.
	 *
	 * Wire format: [IV(12)] [ciphertext of (seq(4) + ts(8) + data)]
	 *
	 * Note: AAD is intentionally NOT used. The sender peerId is inside the
	 * encrypted payload (in the SignalingMessage.src field), so the receiver
	 * cannot know it before decryption — a chicken-and-egg problem.
	 * Replay protection via seq/ts and the GCM auth tag provide sufficient
	 * integrity guarantees.
	 */
	async encrypt(data: Uint8Array): Promise<Uint8Array> {
		await this._readyPromise;

		const seq = ++this._sendSeq;
		const ts = Date.now();

		// Build header: seq (4 bytes, big-endian) + timestamp (8 bytes, big-endian)
		const header = new ArrayBuffer(12);
		const headerView = new DataView(header);
		headerView.setUint32(0, seq, false);
		// Split 64-bit timestamp into two 32-bit parts
		headerView.setUint32(4, Math.floor(ts / 0x100000000), false);
		headerView.setUint32(8, ts >>> 0, false);

		// Prepend header to plaintext
		const plaintext = new Uint8Array(12 + data.byteLength);
		plaintext.set(new Uint8Array(header), 0);
		plaintext.set(data, 12);

		const iv = crypto.getRandomValues(new Uint8Array(12));

		const encrypted = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			this._cryptoKey!,
			plaintext as Uint8Array<ArrayBuffer>,
		);

		const result = new Uint8Array(12 + encrypted.byteLength);
		result.set(iv, 0);
		result.set(new Uint8Array(encrypted), 12);
		return result;
	}

	/**
	 * Decrypt data with replay protection.
	 *
	 * Validates: seq > lastSeenSeq[sender] AND |ts - now| < 30s
	 * @param senderPeerId — if provided, enables per-sender seq tracking
	 */
	async decrypt(data: Uint8Array, senderPeerId?: string): Promise<Uint8Array> {
		await this._readyPromise;

		const iv = data.subarray(0, 12) as Uint8Array<ArrayBuffer>;

		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			this._cryptoKey!,
			data.subarray(12) as Uint8Array<ArrayBuffer>,
		);

		const plainBytes = new Uint8Array(decrypted);

		// Extract header: seq (4 bytes) + timestamp (8 bytes)
		const headerView = new DataView(
			plainBytes.buffer,
			plainBytes.byteOffset,
			12,
		);
		const seq = headerView.getUint32(0, false);
		const tsHigh = headerView.getUint32(4, false);
		const tsLow = headerView.getUint32(8, false);
		const ts = tsHigh * 0x100000000 + tsLow;

		// Replay protection: validate sequence number
		if (senderPeerId) {
			const lastSeq = this._lastSeenSeq.get(senderPeerId) ?? 0;
			if (seq <= lastSeq) {
				throw new Error(`Replay detected: seq=${seq} <= lastSeen=${lastSeq} from ${senderPeerId}`);
			}
			this._lastSeenSeq.set(senderPeerId, seq);
		}

		// Replay protection: validate timestamp (±30s window)
		const now = Date.now();
		if (Math.abs(now - ts) > 30_000) {
			throw new Error(`Message too old or from the future: ts=${ts}, now=${now}`);
		}

		// Return payload without header
		return plainBytes.subarray(12);
	}

	/** Reset replay protection state (e.g., on reconnect) */
	resetReplayState(): void {
		this._sendSeq = 0;
		this._lastSeenSeq.clear();
	}
}
