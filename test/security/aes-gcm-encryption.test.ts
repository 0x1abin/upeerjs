import { describe, it, expect } from "vitest";
import { AesGcmEncryption } from "../../src/security/aes-gcm-encryption";

// AES-GCM requires 16, 24, or 32 byte keys
const TEST_KEY_16 = "1234567890abcdef"; // 16 bytes
const TEST_KEY_32 = "12345678901234567890123456789012"; // 32 bytes

describe("AesGcmEncryption", () => {
	it("should import key and become ready", async () => {
		const enc = new AesGcmEncryption(TEST_KEY_16);
		expect(enc.ready).toBe(false);
		await enc.waitReady();
		expect(enc.ready).toBe(true);
	});

	it("should encrypt data to different output", async () => {
		const enc = new AesGcmEncryption(TEST_KEY_16);
		await enc.waitReady();

		const plaintext = new TextEncoder().encode("hello world");
		const encrypted = await enc.encrypt(plaintext);

		expect(encrypted).toBeInstanceOf(Uint8Array);
		expect(encrypted.length).toBeGreaterThan(plaintext.length);
		// First 12 bytes are IV
		expect(encrypted.length).toBe(12 + plaintext.length + 16); // 16 = GCM auth tag
	});

	it("should decrypt back to original plaintext", async () => {
		const enc = new AesGcmEncryption(TEST_KEY_16);
		await enc.waitReady();

		const original = new TextEncoder().encode("hello world");
		const encrypted = await enc.encrypt(original);
		const decrypted = await enc.decrypt(encrypted);

		expect(new TextDecoder().decode(decrypted)).toBe("hello world");
	});

	it("should produce different ciphertext for same plaintext (random IV)", async () => {
		const enc = new AesGcmEncryption(TEST_KEY_16);
		await enc.waitReady();

		const plaintext = new TextEncoder().encode("same data");
		const enc1 = await enc.encrypt(plaintext);
		const enc2 = await enc.encrypt(plaintext);

		// IVs should differ (first 12 bytes)
		const iv1 = enc1.subarray(0, 12);
		const iv2 = enc2.subarray(0, 12);
		expect(iv1).not.toEqual(iv2);

		// Both should decrypt correctly
		expect(new TextDecoder().decode(await enc.decrypt(enc1))).toBe("same data");
		expect(new TextDecoder().decode(await enc.decrypt(enc2))).toBe("same data");
	});

	it("should work with 32-byte key", async () => {
		const enc = new AesGcmEncryption(TEST_KEY_32);
		await enc.waitReady();

		const plaintext = new TextEncoder().encode("secure message");
		const encrypted = await enc.encrypt(plaintext);
		const decrypted = await enc.decrypt(encrypted);

		expect(new TextDecoder().decode(decrypted)).toBe("secure message");
	});

	it("should fail to decrypt with wrong key", async () => {
		const enc1 = new AesGcmEncryption(TEST_KEY_16);
		const enc2 = new AesGcmEncryption("abcdefghijklmnop"); // different 16-byte key
		await Promise.all([enc1.waitReady(), enc2.waitReady()]);

		const plaintext = new TextEncoder().encode("secret");
		const encrypted = await enc1.encrypt(plaintext);

		await expect(enc2.decrypt(encrypted)).rejects.toThrow();
	});

	it("should handle empty data", async () => {
		const enc = new AesGcmEncryption(TEST_KEY_16);
		await enc.waitReady();

		const empty = new Uint8Array(0);
		const encrypted = await enc.encrypt(empty);
		const decrypted = await enc.decrypt(encrypted);
		expect(decrypted.length).toBe(0);
	});

	it("should handle large data", async () => {
		const enc = new AesGcmEncryption(TEST_KEY_16);
		await enc.waitReady();

		const large = new Uint8Array(64 * 1024); // 64KB
		crypto.getRandomValues(large);

		const encrypted = await enc.encrypt(large);
		const decrypted = await enc.decrypt(encrypted);
		expect(decrypted).toEqual(large);
	});

	it("should encrypt/decrypt before explicit waitReady (auto-waits)", async () => {
		const enc = new AesGcmEncryption(TEST_KEY_16);
		// Don't call waitReady — encrypt/decrypt internally await the promise
		const plaintext = new TextEncoder().encode("auto-wait test");
		const encrypted = await enc.encrypt(plaintext);
		const decrypted = await enc.decrypt(encrypted);
		expect(new TextDecoder().decode(decrypted)).toBe("auto-wait test");
	});
});
