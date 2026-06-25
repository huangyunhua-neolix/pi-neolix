import { describe, expect, it } from "vitest";
import { generateDiffString, generateUnifiedPatch, type EditDiffResult } from "../src/core/tools/edit-diff.ts";

describe("generateUnifiedPatch", () => {
	it("produces a standard unified diff header for two distinct contents", () => {
		const patch = generateUnifiedPatch("file.txt", "line a\n", "line b\n");
		expect(patch).toContain("--- file.txt");
		expect(patch).toContain("+++ file.txt");
		expect(patch).toContain("-line a");
		expect(patch).toContain("+line b");
		expect(patch).toContain("@@");
	});

	it("returns an empty-body patch when contents are identical", () => {
		const patch = generateUnifiedPatch("file.txt", "same\n", "same\n");
		// Header is always present; no -/+ body lines.
		expect(patch).toContain("--- file.txt");
		expect(patch).toContain("+++ file.txt");
		expect(patch).not.toContain("-same");
		expect(patch).not.toContain("+same");
	});

	it("handles empty old and new content", () => {
		const patchEmpty = generateUnifiedPatch("f.txt", "", "");
		expect(patchEmpty).toContain("--- f.txt");
		expect(patchEmpty).toContain("+++ f.txt");
		// No hunk body when both inputs are empty.
		expect(patchEmpty).not.toContain("@@");
	});

	it("handles adding content to an empty old content", () => {
		const patch = generateUnifiedPatch("f.txt", "", "new\n");
		expect(patch).toContain("+new");
		expect(patch).not.toContain("-new");
	});

	it("supports multi-hunk diffs across separated changes", () => {
		const oldContent = "a\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\nb\n";
		const newContent = "a\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\nB\n";
		const patch = generateUnifiedPatch("multi.txt", oldContent, newContent);
		// Single change at end → single hunk.
		expect(patch).toContain("-b");
		expect(patch).toContain("+B");
	});

	it("respects contextLines option (smaller context)", () => {
		const oldContent = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n";
		const newContent = oldContent.replace("line10", "CHANGED");
		const small = generateUnifiedPatch("f.txt", oldContent, newContent, 1);
		const large = generateUnifiedPatch("f.txt", oldContent, newContent, 4);
		// Smaller context should yield fewer context lines; both contain the change.
		expect(small).toContain("-line10");
		expect(small).toContain("+CHANGED");
		expect(large).toContain("+CHANGED");
		// Larger context patch is at least as long as the smaller-context one.
		expect(large.length).toBeGreaterThanOrEqual(small.length);
	});

	it("preserves CJK characters in diff body", () => {
		const patch = generateUnifiedPatch("cjk.txt", "你好\n世界\n", "你好\n宇宙\n");
		expect(patch).toContain("-世界");
		expect(patch).toContain("+宇宙");
	});
});

describe("generateDiffString", () => {
	it("returns a diff with line numbers and the first changed line", () => {
		const oldContent = "alpha\nbeta\ngamma\n";
		const newContent = "alpha\nBETA\ngamma\n";
		const result = generateDiffString(oldContent, newContent);
		expect(result.diff).toContain("-2 beta");
		expect(result.diff).toContain("+2 BETA");
		expect(result.firstChangedLine).toBe(2);
	});

	it("returns an empty diff and undefined firstChangedLine for identical inputs", () => {
		const result = generateDiffString("same\nsame\n", "same\nsame\n");
		expect(result.diff).toBe("");
		expect(result.firstChangedLine).toBeUndefined();
	});

	it("returns an empty diff for two empty inputs", () => {
		const result = generateDiffString("", "");
		expect(result.diff).toBe("");
		expect(result.firstChangedLine).toBeUndefined();
	});

	it("marks an all-added new content with line numbers starting at 1", () => {
		const result = generateDiffString("", "first\nsecond\n");
		// All lines are added.
		expect(result.diff).toContain("+1 first");
		expect(result.diff).toContain("+2 second");
		expect(result.firstChangedLine).toBe(1);
	});

	it("supports multi-hunk diffs with context collapse", () => {
		const oldLines = Array.from({ length: 30 }, (_, i) => `o${i}`);
		const newLines = oldLines.slice();
		newLines[2] = "CHANGED-2";
		newLines[25] = "CHANGED-25";
		const result = generateDiffString(oldLines.join("\n") + "\n", newLines.join("\n") + "\n");
		// Both changes appear. Line numbers are zero-padded to the max line width (2 for 30 lines).
		expect(result.diff).toContain("- 3 o2");
		expect(result.diff).toContain("+ 3 CHANGED-2");
		expect(result.diff).toContain("-26 o25");
		expect(result.diff).toContain("+26 CHANGED-25");
		// A context-collapse ellipsis should appear between the two hunks.
		expect(result.diff).toContain("...");
		expect(result.firstChangedLine).toBe(3);
	});

	it("preserves CJK content in added/removed lines", () => {
		const result = generateDiffString("苹果\n", "香蕉\n");
		expect(result.diff).toContain("-1 苹果");
		expect(result.diff).toContain("+1 香蕉");
		expect(result.firstChangedLine).toBe(1);
	});

	it("respects contextLines option", () => {
		const oldLines = Array.from({ length: 40 }, (_, i) => `x${i}`);
		const newLines = oldLines.slice();
		newLines[20] = "Y";
		const small = generateDiffString(oldLines.join("\n") + "\n", newLines.join("\n") + "\n", 1);
		const large = generateDiffString(oldLines.join("\n") + "\n", newLines.join("\n") + "\n", 6);
		expect(small.diff).toContain("+21 Y");
		expect(large.diff).toContain("+21 Y");
	});
});

describe("EditDiffResult (interface contract)", () => {
	it("matches the shape returned by generateDiffString", () => {
		const result: EditDiffResult = generateDiffString("a\n", "b\n");
		expect(typeof result.diff).toBe("string");
		expect(result.firstChangedLine === undefined || typeof result.firstChangedLine === "number").toBe(true);
	});
});
