import { describe, it, expect } from "vitest";
import { generatePeerId } from "../../src/util/id-generator";

describe("generatePeerId", () => {
	it("should generate a string", () => {
		const id = generatePeerId();
		expect(typeof id).toBe("string");
	});

	it("should generate default 21-char ID", () => {
		const id = generatePeerId();
		expect(id.length).toBe(21);
	});

	it("should generate custom-length IDs", () => {
		expect(generatePeerId(10).length).toBe(10);
		expect(generatePeerId(32).length).toBe(32);
		expect(generatePeerId(5).length).toBe(5);
	});

	it("should generate unique IDs", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generatePeerId()));
		expect(ids.size).toBe(100);
	});

	it("should only contain URL-safe characters", () => {
		const id = generatePeerId(100);
		expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});
