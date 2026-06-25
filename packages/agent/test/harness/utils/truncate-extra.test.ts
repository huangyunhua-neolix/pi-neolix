import { describe, expect, it } from "vitest";
import { formatSize, truncateLine } from "../../../src/harness/utils/truncate.ts";

describe("formatSize", () => {
	it("formats bytes below 1KB as bytes", () => {
		expect(formatSize(0)).toBe("0B");
		expect(formatSize(1)).toBe("1B");
		expect(formatSize(1023)).toBe("1023B");
	});

	it("formats bytes in the KB range with one decimal", () => {
		expect(formatSize(1024)).toBe("1.0KB");
		expect(formatSize(1536)).toBe("1.5KB");
		expect(formatSize(1048575)).toBe("1024.0KB");
	});

	it("formats bytes in the MB range with one decimal", () => {
		expect(formatSize(1048576)).toBe("1.0MB");
		expect(formatSize(1572864)).toBe("1.5MB");
		expect(formatSize(10485760)).toBe("10.0MB");
	});

	it("handles values just above and below KB boundary", () => {
		expect(formatSize(1023)).toBe("1023B");
		expect(formatSize(1024)).toBe("1.0KB");
	});

	it("handles values just above and below MB boundary", () => {
		expect(formatSize(1048575)).toBe("1024.0KB");
		expect(formatSize(1048576)).toBe("1.0MB");
	});
});

describe("truncateLine", () => {
	it("returns the line unchanged when within the default max chars", () => {
		const line = "a".repeat(100);
		const result = truncateLine(line);
		expect(result.text).toBe(line);
		expect(result.wasTruncated).toBe(false);
	});

	it("returns the line unchanged when exactly at the default max chars", () => {
		const line = "a".repeat(500);
		const result = truncateLine(line);
		expect(result.text).toBe(line);
		expect(result.wasTruncated).toBe(false);
	});

	it("truncates and appends the marker when exceeding the default max chars", () => {
		const line = "a".repeat(501);
		const result = truncateLine(line);
		expect(result.wasTruncated).toBe(true);
		expect(result.text).toBe("a".repeat(500) + "... [truncated]");
	});

	it("respects a custom max chars argument", () => {
		const line = "abcdefgh";
		const result = truncateLine(line, 5);
		expect(result.wasTruncated).toBe(true);
		expect(result.text).toBe("abcde... [truncated]");
	});

	it("does not truncate when length equals custom max chars", () => {
		const line = "abcde";
		const result = truncateLine(line, 5);
		expect(result.wasTruncated).toBe(false);
		expect(result.text).toBe(line);
	});

	it("handles an empty line", () => {
		const result = truncateLine("");
		expect(result.text).toBe("");
		expect(result.wasTruncated).toBe(false);
	});

	it("handles a max chars of zero by truncating any non-empty line", () => {
		const result = truncateLine("a", 0);
		expect(result.wasTruncated).toBe(true);
		expect(result.text).toBe("... [truncated]");
	});

	it("handles CJK characters by character count rather than display width", () => {
		const line = "中".repeat(600);
		const result = truncateLine(line);
		expect(result.wasTruncated).toBe(true);
		expect(result.text).toBe("中".repeat(500) + "... [truncated]");
	});

	it("handles a huge line without crashing", () => {
		const line = "x".repeat(100_000);
		const result = truncateLine(line, 100);
		expect(result.wasTruncated).toBe(true);
		expect(result.text.length).toBe(100 + "... [truncated]".length);
		expect(result.text.endsWith("... [truncated]")).toBe(true);
	});
});
