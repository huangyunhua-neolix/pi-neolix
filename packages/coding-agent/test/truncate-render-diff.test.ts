import { beforeAll, describe, expect, it } from "vitest";
import { type RenderDiffOptions, renderDiff } from "../src/modes/interactive/components/diff.ts";
import {
	truncateToVisualLines,
	type VisualTruncateResult,
} from "../src/modes/interactive/components/visual-truncate.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
});

describe("truncateToVisualLines", () => {
	it("returns empty visualLines and zero skipped for empty text", () => {
		const result = truncateToVisualLines("", 5, 80);
		expect(result.visualLines).toEqual([]);
		expect(result.skippedCount).toBe(0);
	});

	it("returns all lines with zero skipped when content fits within maxVisualLines", () => {
		const text = "line one\nline two\nline three";
		const result = truncateToVisualLines(text, 10, 80);
		expect(result.skippedCount).toBe(0);
		expect(result.visualLines.length).toBeLessThanOrEqual(10);
		expect(result.visualLines.length).toBeGreaterThanOrEqual(1);
	});

	it("truncates from the end and reports a positive skippedCount when content overflows", () => {
		// Many lines that each fit on a single visual line at width 80.
		const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
		const text = lines.join("\n");
		const result = truncateToVisualLines(text, 5, 80);
		expect(result.skippedCount).toBeGreaterThan(0);
		expect(result.visualLines.length).toBeLessThanOrEqual(5);
		// The last visual line should contain the final line's marker.
		const last = result.visualLines[result.visualLines.length - 1];
		expect(last).toContain("line-49");
	});

	it("returns a result matching the VisualTruncateResult interface shape", () => {
		const result: VisualTruncateResult = truncateToVisualLines("hi\nthere", 5, 40);
		expect(Array.isArray(result.visualLines)).toBe(true);
		expect(typeof result.skippedCount).toBe("number");
	});

	it("handles CJK text (wide characters) without throwing", () => {
		const text = "你好\n世界\n宇宙\n星辰\n大海";
		const result = truncateToVisualLines(text, 2, 20);
		// Should not throw and should produce at most 2 visual lines.
		expect(result.visualLines.length).toBeLessThanOrEqual(2);
		// Either nothing was skipped (fit) or a positive count.
		expect(result.skippedCount).toBeGreaterThanOrEqual(0);
	});

	it("handles ANSI-escaped text without throwing", () => {
		const text = "\x1b[31mred line\x1b[0m\n\x1b[32mgreen line\x1b[0m";
		const result = truncateToVisualLines(text, 5, 40);
		expect(result.visualLines.length).toBeGreaterThanOrEqual(1);
		expect(result.skippedCount).toBeGreaterThanOrEqual(0);
	});
});

describe("renderDiff", () => {
	it("renders an empty diff input as ANSI-only output (strips to empty)", () => {
		// Empty input → one unparseable empty line → context-colored empty string.
		expect(stripAnsi(renderDiff(""))).toBe("");
	});

	it("renders context lines using the toolDiffContext theme (parseable, non-empty)", () => {
		const diffText = " 1 context line\n+2 added line\n-3 removed line";
		const rendered = renderDiff(diffText);
		// Stripping ANSI should yield the original line content with prefixes preserved.
		expect(stripAnsi(rendered)).toContain(" 1 context line");
		expect(stripAnsi(rendered)).toContain("+2 added line");
		expect(stripAnsi(rendered)).toContain("-3 removed line");
	});

	it("renders a paired removed+added block and applies intra-line highlighting", () => {
		const diffText = "-1 old value\n+1 new value";
		const rendered = renderDiff(diffText);
		const stripped = stripAnsi(rendered);
		expect(stripped).toContain("-1 old value");
		expect(stripped).toContain("+1 new value");
		// The rendered output contains ANSI escapes for the change highlight.
		expect(rendered).toContain("\x1b[");
	});

	it("renders standalone added lines (no preceding removed)", () => {
		const diffText = " 1 ctx\n+2 brand new";
		const rendered = renderDiff(diffText);
		const stripped = stripAnsi(rendered);
		expect(stripped).toContain(" 1 ctx");
		expect(stripped).toContain("+2 brand new");
	});

	it("renders multi-line removed+added blocks without intra-line diffing (only single-pair gets it)", () => {
		const diffText = "-1 a\n-2 b\n+1 c\n+2 d";
		const rendered = renderDiff(diffText);
		const stripped = stripAnsi(rendered);
		expect(stripped).toContain("-1 a");
		expect(stripped).toContain("-2 b");
		expect(stripped).toContain("+1 c");
		expect(stripped).toContain("+2 d");
	});

	it("falls back to context-colored output for unparseable lines", () => {
		const diffText = "no leading prefix here";
		const rendered = renderDiff(diffText);
		expect(stripAnsi(rendered)).toBe("no leading prefix here");
	});

	it("replaces tabs with spaces in rendered output", () => {
		const diffText = "+1 \ttabbed";
		const rendered = renderDiff(diffText);
		const stripped = stripAnsi(rendered);
		// Tab should be replaced with 3 spaces; no raw tab remains.
		expect(stripped).not.toContain("\t");
		expect(stripped).toContain("   tabbed");
	});

	it("handles CJK content in diff lines", () => {
		const diffText = "-1 旧值\n+1 新值";
		const rendered = renderDiff(diffText);
		const stripped = stripAnsi(rendered);
		expect(stripped).toContain("-1 旧值");
		expect(stripped).toContain("+1 新值");
		expect(rendered).toContain("\x1b[");
	});

	it("preserves ANSI-escaped content embedded in diff lines (does not double-strip)", () => {
		// A diff line whose content already contains ANSI escapes; renderDiff should not
		// strip it — it only adds its own theme coloring on top.
		const diffText = "+1 \x1b[1mbold\x1b[0m";
		const rendered = renderDiff(diffText);
		expect(rendered).toContain("\x1b[1mbold");
	});

	it("accepts a RenderDiffOptions argument without changing output (filePath is unused)", () => {
		const diffText = "+1 x";
		const without: RenderDiffOptions = {};
		const withPath: RenderDiffOptions = { filePath: "/some/path.txt" };
		expect(renderDiff(diffText, without)).toBe(renderDiff(diffText, withPath));
	});
});
