import { describe, expect, it } from "vitest";
import {
	type ShellCaptureOptions,
	type ShellCaptureResult,
	sanitizeBinaryOutput,
} from "../../../src/harness/utils/shell-output.ts";

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

describe("ShellCaptureOptions / ShellCaptureResult types", () => {
	it("accepts an options shape with onChunk and exec options", () => {
		const options: ShellCaptureOptions = {
			onChunk: (_chunk: string) => {},
			cwd: "/tmp",
			abortSignal: undefined,
		};
		expect(typeof options.onChunk).toBe("function");
	});

	it("accepts a result shape with output, exitCode, cancelled, truncated, and fullOutputPath", () => {
		const result: ShellCaptureResult = {
			output: "hello",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			fullOutputPath: undefined,
		};
		expect(result.output).toBe("hello");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.truncated).toBe(false);
		expect(result.fullOutputPath).toBeUndefined();
	});

	it("allows the cancelled and truncated flags to be true together with a path", () => {
		const result: ShellCaptureResult = {
			output: "partial",
			exitCode: undefined,
			cancelled: true,
			truncated: true,
			fullOutputPath: "/tmp/bash-123.log",
		};
		expect(result.cancelled).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBe("/tmp/bash-123.log");
	});
});
