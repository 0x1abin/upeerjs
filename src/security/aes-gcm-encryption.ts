import type { IEncryption } from "../types";

export class AesGcmEncryption implements IEncryption {
	private _cryptoKey: CryptoKey | undefined;
	private _readyPromise: Promise<void>;
	private _isReady = false;

	get ready(): boolean {
		return this._isReady;
	}

	constructor(securityKey: string) {
		this._readyPromise = this._importKey(securityKey);
	}

	async waitReady(): Promise<void> {
		await this._readyPromise;
	}

	private async _importKey(securityKey: string): Promise<void> {
		const raw = new TextEncoder().encode(securityKey);
		this._cryptoKey = await crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "AES-GCM" },
			false,
			["encrypt", "decrypt"],
		);
		this._isReady = true;
	}

	async encrypt(data: Uint8Array): Promise<Uint8Array> {
		await this._readyPromise;
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encrypted = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			this._cryptoKey!,
			data as Uint8Array<ArrayBuffer>,
		);
		const result = new Uint8Array(12 + encrypted.byteLength);
		result.set(iv, 0);
		result.set(new Uint8Array(encrypted), 12);
		return result;
	}

	async decrypt(data: Uint8Array): Promise<Uint8Array> {
		await this._readyPromise;
		const iv = data.subarray(0, 12) as Uint8Array<ArrayBuffer>;
		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			this._cryptoKey!,
			data.subarray(12) as Uint8Array<ArrayBuffer>,
		);
		return new Uint8Array(decrypted);
	}
}
