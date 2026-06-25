import { describe, expect, it } from "vitest";
import { sanitizeBinaryOutput } from "../../../src/harness/utils/shell-output.ts";

describe("sanitizeBinaryOutput", () => {
	it("passes through plain ASCII text unchanged", () => {
		expect(sanitizeBinaryOutput("hello world\n")).toBe("hello world\n");
	});

	it("preserves tab, line feed, and carriage return control characters", () => {
		const input = "a\tb\nc\rd";
		expect(sanitizeBinaryOutput(input)).toBe(input);
	});

	it("strips C0 control characters other than tab, LF, CR", () => {
		const input = "a\x00b\x07c\x1fd";
		const result = sanitizeBinaryOutput(input);
		expect(result).toBe("abcd");
	});

	it("strips NUL bytes from binary-ish output", () => {
		const input = "before\x00\x00\x00after";
		expect(sanitizeBinaryOutput(input)).toBe("beforeafter");
	});

	it("strips interlinear separator and similar special plane characters", () => {
		const input = "a￹b￺c￻d";
		expect(sanitizeBinaryOutput(input)).toBe("abcd");
	});

	it("preserves non-ASCII printable characters such as CJK and accented letters", () => {
		const input = "你好 émoji 🙂 text";
		expect(sanitizeBinaryOutput(input)).toBe(input);
	});

	it("returns an empty string for an empty input", () => {
		expect(sanitizeBinaryOutput("")).toBe("");
	});

	it("returns an empty string for an input that is entirely stripped", () => {
		expect(sanitizeBinaryOutput("\x00\x01\x02\x1F")).toBe("");
	});

	it("handles a mix of binary and valid chunks", () => {
		const input = "log line\x00\nmore\x07\nok";
		expect(sanitizeBinaryOutput(input)).toBe("log line\nmore\nok");
	});

	it("handles supplementary-plane characters (4-byte UTF-8) without splitting surrogates", () => {
		const input = "emoji 🙂 here";
		expect(sanitizeBinaryOutput(input)).toBe(input);
	});
});
