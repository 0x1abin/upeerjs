import { describe, it, expect } from "vitest";
import { AesGcmEncryption } from "../../src/security/aes-gcm-encryption";

// AES-GCM requires 16, 24, or 32 byte keys
const TEST_KEY_16 = "1234567890abcdef"; // 16 bytes → AES-128
const TEST_KEY_24 = "123456789012345678901234"; // 24 bytes → AES-192
const TEST_KEY_32 = "12345678901234567890123456789012"; // 32 bytes → AES-256

describe("AesGcmEncryption", () => {
	it("should import raw key and become ready", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		expect(enc.ready).toBe(false);
		await enc.waitReady();
		expect(enc.ready).toBe(true);
	});

	it("should encrypt data to different output", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		await enc.waitReady();

		const plaintext = new TextEncoder().encode("hello world");
		const encrypted = await enc.encrypt(plaintext);

		expect(encrypted).toBeInstanceOf(Uint8Array);
		expect(encrypted.length).toBeGreaterThan(plaintext.length);
		// IV(12) + encrypted(replay_header(12) + plaintext + GCM_tag(16))
		expect(encrypted.length).toBe(12 + 12 + plaintext.length + 16);
	});

	it("should decrypt back to original plaintext", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		await enc.waitReady();

		const original = new TextEncoder().encode("hello world");
		const encrypted = await enc.encrypt(original);
		const decrypted = await enc.decrypt(encrypted);

		expect(new TextDecoder().decode(decrypted)).toBe("hello world");
	});

	it("should produce different ciphertext for same plaintext (random IV)", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
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

	it("should work with 24-byte key (AES-192)", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_24 });
		await enc.waitReady();

		const plaintext = new TextEncoder().encode("aes-192 message");
		const encrypted = await enc.encrypt(plaintext);
		const decrypted = await enc.decrypt(encrypted);

		expect(new TextDecoder().decode(decrypted)).toBe("aes-192 message");
	});

	it("should work with 32-byte key (AES-256)", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_32 });
		await enc.waitReady();

		const plaintext = new TextEncoder().encode("secure message");
		const encrypted = await enc.encrypt(plaintext);
		const decrypted = await enc.decrypt(encrypted);

		expect(new TextDecoder().decode(decrypted)).toBe("secure message");
	});

	it("should throw on invalid key length", () => {
		expect(() => new AesGcmEncryption({ securityKey: "too-short" })).toThrow(/Invalid key length/);
		expect(() => new AesGcmEncryption({ securityKey: "12345678901234567" })).toThrow(/Invalid key length/); // 17 bytes
	});

	it("should fail to decrypt with wrong key", async () => {
		const enc1 = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		const enc2 = new AesGcmEncryption({ securityKey: "abcdefghijklmnop" });
		await Promise.all([enc1.waitReady(), enc2.waitReady()]);

		const plaintext = new TextEncoder().encode("secret");
		const encrypted = await enc1.encrypt(plaintext);

		await expect(enc2.decrypt(encrypted)).rejects.toThrow();
	});

	it("should handle empty data", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		await enc.waitReady();

		const empty = new Uint8Array(0);
		const encrypted = await enc.encrypt(empty);
		const decrypted = await enc.decrypt(encrypted);
		expect(decrypted.length).toBe(0);
	});

	it("should handle large data", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		await enc.waitReady();

		const large = new Uint8Array(64 * 1024); // 64KB
		crypto.getRandomValues(large);

		const encrypted = await enc.encrypt(large);
		const decrypted = await enc.decrypt(encrypted);
		expect(decrypted).toEqual(large);
	});

	it("should encrypt/decrypt before explicit waitReady (auto-waits)", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		// Don't call waitReady — encrypt/decrypt internally await the promise
		const plaintext = new TextEncoder().encode("auto-wait test");
		const encrypted = await enc.encrypt(plaintext);
		const decrypted = await enc.decrypt(encrypted);
		expect(new TextDecoder().decode(decrypted)).toBe("auto-wait test");
	});

	it("should detect replay attacks via sequence numbers", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		await enc.waitReady();

		const plaintext = new TextEncoder().encode("replay-test");
		const encrypted = await enc.encrypt(plaintext, "sender-A");

		// First decrypt should succeed
		const decrypted = await enc.decrypt(encrypted, "sender-A");
		expect(new TextDecoder().decode(decrypted)).toBe("replay-test");

		// Replaying the same message should fail (seq already seen)
		await expect(enc.decrypt(encrypted, "sender-A")).rejects.toThrow(/Replay detected/);
	});

	it("should reset replay state", async () => {
		const enc = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		await enc.waitReady();

		const plaintext = new TextEncoder().encode("reset-test");
		const encrypted = await enc.encrypt(plaintext, "sender-B");
		await enc.decrypt(encrypted, "sender-B");

		// Reset state
		enc.resetReplayState();

		// After reset, a new message with seq=1 should work (fresh encryption instance)
		const enc2 = new AesGcmEncryption({ securityKey: TEST_KEY_16 });
		await enc2.waitReady();
		const encrypted2 = await enc2.encrypt(plaintext, "sender-B");
		// Use enc for decrypt - its replay state was reset
		const decrypted = await enc.decrypt(encrypted2, "sender-B");
		expect(new TextDecoder().decode(decrypted)).toBe("reset-test");
	});
});
