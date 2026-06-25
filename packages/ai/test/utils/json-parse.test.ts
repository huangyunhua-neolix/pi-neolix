import { describe, expect, it, vi } from "vitest";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../../src/utils/json-parse.ts";

describe("repairJson", () => {
	it("leaves already-valid JSON unchanged when no string-literal repair is needed", () => {
		const cases: Array<{ input: string; expected: string }> = [
			{ input: '{"a":1}', expected: '{"a":1}' },
			{ input: '{"a":"b","c":3}', expected: '{"a":"b","c":3}' },
			{ input: "[]", expected: "[]" },
			{ input: '"plain"', expected: '"plain"' },
		];
		for (const testCase of cases) {
			expect(repairJson(testCase.input)).toBe(testCase.expected);
		}
	});

	it("escapes raw control characters inside string literals", () => {
		const newlineInput = `{"a":"x${"\n"}y"}`;
		expect(repairJson(newlineInput)).toBe('{"a":"x\\ny"}');

		const tabInput = `{"a":"x${"\t"}y"}`;
		expect(repairJson(tabInput)).toBe('{"a":"x\\ty"}');

		const backspaceInput = `{"a":"x${"\b"}y"}`;
		expect(repairJson(backspaceInput)).toBe('{"a":"x\\by"}');

		const formFeedInput = `{"a":"x${"\f"}y"}`;
		expect(repairJson(formFeedInput)).toBe('{"a":"x\\fy"}');

		const carriageInput = `{"a":"x${"\r"}y"}`;
		expect(repairJson(carriageInput)).toBe('{"a":"x\\ry"}');

		// Control char without dedicated escape -> \uXXXX form.
		const unitSeparator = String.fromCharCode(0x1f);
		const repaired = repairJson(`{"a":"x${unitSeparator}y"}`);
		expect(repaired).toBe('{"a":"x\\u001fy"}');
	});

	it("preserves valid backslash escapes and doubles backslashes before invalid escapes", () => {
		// Valid escape sequences pass through untouched.
		expect(repairJson('"a\\nb"')).toBe('"a\\nb"');
		expect(repairJson('"a\\tb"')).toBe('"a\\tb"');
		expect(repairJson('"a\\u0041b"')).toBe('"a\\u0041b"');
		expect(repairJson('"a\\/b"')).toBe('"a\\/b"');

		// Invalid escape characters get a doubled backslash (so the raw backslash
		// survives a subsequent JSON.parse as a literal backslash).
		expect(repairJson('"a\\xb"')).toBe('"a\\\\xb"');
		expect(repairJson('"a\\zb"')).toBe('"a\\\\zb"');

		// A trailing backslash with no following char is doubled.
		expect(repairJson('"foo\\')).toBe('"foo\\\\');

		// A malformed \u escape (not 4 hex digits) is preserved as-is: "u" is a
		// valid escape char, so repairJson keeps the backslash-u pair intact and
		// lets the trailing non-hex characters flow through unchanged.
		expect(repairJson('"a\\uXYZb"')).toBe('"a\\uXYZb"');
	});

	it("does not alter structure outside string literals", () => {
		// Trailing comma and unclosed bracket are structural issues that
		// repairJson intentionally leaves alone — they are handled downstream
		// by partial-json in the streaming path, not by string-literal repair.
		expect(repairJson('{"a":1,}')).toBe('{"a":1,}');
		expect(repairJson('{"a":1')).toBe('{"a":1');
		expect(repairJson('{"a":1,"b":')).toBe('{"a":1,"b":');
	});
});

describe("parseJsonWithRepair", () => {
	it("returns parsed value for already-valid JSON", () => {
		expect(parseJsonWithRepair('{"a":1}')).toEqual({ a: 1 });
		expect(parseJsonWithRepair("[1,2,3]")).toEqual([1, 2, 3]);
		expect(parseJsonWithRepair('"plain"')).toBe("plain");
		expect(parseJsonWithRepair("42")).toBe(42);
		expect(parseJsonWithRepair("true")).toBe(true);
		expect(parseJsonWithRepair("null")).toBe(null);
	});

	it("repairs and parses JSON containing raw control characters in strings", () => {
		const wellFormed = `{"a":"x${"\n"}y"}`;
		expect(parseJsonWithRepair(wellFormed)).toEqual({ a: "x\ny" });

		const withTab = `{"a":"x${"\t"}y"}`;
		expect(parseJsonWithRepair(withTab)).toEqual({ a: "x\ty" });
	});

	it("repairs and parses JSON containing invalid backslash escapes", () => {
		// After repair the literal backslash survives the parse.
		expect(parseJsonWithRepair('"a\\xb"')).toBe("a\\xb");
		expect(parseJsonWithRepair('"a\\zb"')).toBe("a\\zb");
	});

	it("throws on empty string input", () => {
		expect(() => parseJsonWithRepair("")).toThrow(SyntaxError);
	});

	it("throws on truly unparseable input with no repairable string content", () => {
		expect(() => parseJsonWithRepair("@@@")).toThrow(SyntaxError);
		expect(() => parseJsonWithRepair("not json at all")).toThrow(SyntaxError);
		expect(() => parseJsonWithRepair("{bad}")).toThrow(SyntaxError);
	});

	it("preserves typed result via the generic parameter", () => {
		const result = parseJsonWithRepair<{ a: number; b: string }>('{"a":1,"b":"x"}');
		expect(result.a).toBe(1);
		expect(result.b).toBe("x");
	});
});

describe("parseStreamingJson", () => {
	it("returns an empty object for empty / whitespace-only / undefined input", () => {
		expect(parseStreamingJson(undefined)).toEqual({});
		expect(parseStreamingJson("")).toEqual({});
		expect(parseStreamingJson("   ")).toEqual({});
		expect(parseStreamingJson("\t\n")).toEqual({});
	});

	it("parses a complete JSON chunk", () => {
		expect(parseStreamingJson('{"a":1}')).toEqual({ a: 1 });
		expect(parseStreamingJson('{"a":1,"b":"x","c":[1,2]}')).toEqual({
			a: 1,
			b: "x",
			c: [1, 2],
		});
	});

	it("parses a chunk truncated mid-object via partial-json", () => {
		// Trailing comma + missing close brace.
		expect(parseStreamingJson('{"a":1,}')).toEqual({ a: 1 });
		// Truncated value for next key.
		expect(parseStreamingJson('{"a":1,"b":')).toEqual({ a: 1 });
		// Truncated mid-number.
		expect(parseStreamingJson('{"a":1')).toEqual({ a: 1 });
		// Truncated right after the opening brace / colon.
		expect(parseStreamingJson('{"a":')).toEqual({});
		expect(parseStreamingJson("{")).toEqual({});
		expect(parseStreamingJson("[")).toEqual([]);
	});

	it("repairs raw control characters inside a complete streaming chunk", () => {
		// A raw newline inside an otherwise-complete string: parseJsonWithRepair
		// fails on the raw control char, then partial-json is tried on the raw
		// input (also fails), and finally partial-json is tried on the repaired
		// string, which parses successfully with the newline preserved.
		const raw = `{"a":"x${"\n"}y"}`;
		const result = parseStreamingJson<{ a: string }>(raw);
		expect(result).toEqual({ a: "x\ny" });
	});

	it("returns an empty object for truly unparseable input", () => {
		const result = parseStreamingJson<Record<string, unknown>>("not json at all");
		expect(result).toBeInstanceOf(Object);
		expect(Array.isArray(result)).toBe(false);
		expect(result).toEqual({});
		const result2 = parseStreamingJson<Record<string, unknown>>("@@@");
		expect(result2).toBeInstanceOf(Object);
		expect(Array.isArray(result2)).toBe(false);
		expect(result2).toEqual({});
	});

	it("exercises the error-handling branch: parse is attempted and swallowed, not short-circuited", () => {
		// Prove the input genuinely fails strict parsing — so reaching {} requires
		// the catch chain to run, not an early empty-input return.
		expect(() => parseJsonWithRepair("not json at all")).toThrow(SyntaxError);
		expect(() => parseJsonWithRepair("@@@")).toThrow(SyntaxError);

		// Spy on JSON.parse to confirm parseStreamingJson actually invokes it
		// (i.e. the function attempts a real parse before degrading to {}).
		const parseSpy = vi.spyOn(JSON, "parse");
		try {
			expect(() => parseStreamingJson("not json at all")).not.toThrow();
			expect(parseSpy).toHaveBeenCalled();
			const result = parseStreamingJson<Record<string, unknown>>("not json at all");
			expect(result).toEqual({});
		} finally {
			parseSpy.mockRestore();
		}
	});
});
