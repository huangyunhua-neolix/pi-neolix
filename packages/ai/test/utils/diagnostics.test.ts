import { describe, expect, it } from "vitest";
import type { AssistantMessageDiagnostic, DiagnosticErrorInfo } from "../../src/utils/diagnostics.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	extractDiagnosticError,
	formatThrownValue,
} from "../../src/utils/diagnostics.ts";

describe("formatThrownValue", () => {
	it("returns the message of an Error instance", () => {
		const error = new Error("boom");
		expect(formatThrownValue(error)).toBe("boom");
	});

	it("falls back to the Error name when the message is empty", () => {
		const error = new Error();
		expect(formatThrownValue(error)).toBe("Error");
	});

	it("returns string thrown values as-is", () => {
		expect(formatThrownValue("a plain string")).toBe("a plain string");
	});

	it("stringifies non-Error, non-string thrown values", () => {
		expect(formatThrownValue(42)).toBe("42");
		expect(formatThrownValue(true)).toBe("true");
		expect(formatThrownValue(null)).toBe("null");
		expect(formatThrownValue(undefined)).toBe("undefined");
		expect(formatThrownValue({ x: 1 })).toBe("[object Object]");
		expect(formatThrownValue([1, 2, 3])).toBe("1,2,3");
	});

	it("uses the message of a subclassed Error", () => {
		const error = new TypeError("bad type");
		expect(formatThrownValue(error)).toBe("bad type");
	});
});

describe("extractDiagnosticError", () => {
	it("extracts name, message, and stack from an Error", () => {
		const error = new Error("kaboom");
		const info = extractDiagnosticError(error);
		const expected: DiagnosticErrorInfo = {
			name: "Error",
			message: "kaboom",
			stack: error.stack,
			code: undefined,
		};
		expect(info).toEqual(expected);
	});

	it("falls back to the name when message is empty", () => {
		const error = new Error();
		const info = extractDiagnosticError(error);
		expect(info.name).toBe("Error");
		expect(info.message).toBe("Error");
	});

	it("preserves subclass name and includes code when present", () => {
		const error = new TypeError("nope");
		(error as Error & { code?: unknown }).code = "E_CUSTOM";
		const info = extractDiagnosticError(error);
		expect(info.name).toBe("TypeError");
		expect(info.message).toBe("nope");
		expect(info.code).toBe("E_CUSTOM");
	});

	it("preserves numeric error codes", () => {
		const error = new Error("sys");
		(error as Error & { code?: unknown }).code = 13;
		const info = extractDiagnosticError(error);
		expect(info.code).toBe(13);
	});

	it("drops non-string/non-number codes", () => {
		const error = new Error("sys");
		(error as Error & { code?: unknown }).code = { random: "object" };
		const info = extractDiagnosticError(error);
		expect(info.code).toBeUndefined();
	});

	it("wraps non-Error thrown values as a ThrownValue with formatted message", () => {
		const info = extractDiagnosticError("a string thrown");
		expect(info).toEqual({
			name: "ThrownValue",
			message: "a string thrown",
			stack: undefined,
			code: undefined,
		});

		const numberInfo = extractDiagnosticError(7);
		expect(numberInfo).toEqual({
			name: "ThrownValue",
			message: "7",
			stack: undefined,
			code: undefined,
		});
	});
});

describe("createAssistantMessageDiagnostic", () => {
	it("builds a diagnostic with type, timestamp, and extracted error", () => {
		const before = Date.now();
		const error = new Error("fail");
		const diagnostic = createAssistantMessageDiagnostic("tool_error", error);
		const after = Date.now();

		expect(diagnostic.type).toBe("tool_error");
		expect(diagnostic.timestamp).toBeGreaterThanOrEqual(before);
		expect(diagnostic.timestamp).toBeLessThanOrEqual(after);
		expect(diagnostic.error).toEqual({
			name: "Error",
			message: "fail",
			stack: error.stack,
			code: undefined,
		});
		expect(diagnostic.details).toBeUndefined();
	});

	it("attaches optional details verbatim", () => {
		const details = { tool: "search", query: "x" };
		const diagnostic = createAssistantMessageDiagnostic("search_error", "bad query", details);
		expect(diagnostic.error?.name).toBe("ThrownValue");
		expect(diagnostic.error?.message).toBe("bad query");
		expect(diagnostic.details).toEqual({ tool: "search", query: "x" });
	});
});

describe("appendAssistantMessageDiagnostic", () => {
	it("appends a diagnostic to a message that has no prior diagnostics", () => {
		const message: { diagnostics?: AssistantMessageDiagnostic[] } = {};
		const diagnostic = createAssistantMessageDiagnostic("first", new Error("a"));

		appendAssistantMessageDiagnostic(message, diagnostic);

		expect(message.diagnostics).toEqual([diagnostic]);
	});

	it("appends to an existing diagnostics array without dropping earlier entries", () => {
		const first = createAssistantMessageDiagnostic("first", new Error("a"));
		const second = createAssistantMessageDiagnostic("second", "b");
		const third = createAssistantMessageDiagnostic("third", 42);
		const message: { diagnostics?: AssistantMessageDiagnostic[] } = {
			diagnostics: [first],
		};

		appendAssistantMessageDiagnostic(message, second);
		appendAssistantMessageDiagnostic(message, third);

		expect(message.diagnostics).toEqual([first, second, third]);
	});

	it("does not mutate the original diagnostics array reference", () => {
		const first = createAssistantMessageDiagnostic("first", new Error("a"));
		const originalArray = [first];
		const message: { diagnostics?: AssistantMessageDiagnostic[] } = {
			diagnostics: originalArray,
		};
		const second = createAssistantMessageDiagnostic("second", "b");

		appendAssistantMessageDiagnostic(message, second);

		// appendAssistantMessageDiagnostic replaces the array with a new one
		// rather than pushing into the old reference.
		expect(originalArray).toEqual([first]);
		expect(message.diagnostics).toEqual([first, second]);
		expect(message.diagnostics).not.toBe(originalArray);
	});

	it("round-trips with formatThrownValue on the embedded error message", () => {
		const error = new TypeError("round trip");
		const diagnostic = createAssistantMessageDiagnostic("rt", error);
		const message: { diagnostics?: AssistantMessageDiagnostic[] } = {};

		appendAssistantMessageDiagnostic(message, diagnostic);

		const embedded = message.diagnostics?.[0]?.error;
		expect(embedded).toBeDefined();
		expect(formatThrownValue(error)).toBe(embedded?.message);
		expect(embedded?.name).toBe("TypeError");
	});
});
