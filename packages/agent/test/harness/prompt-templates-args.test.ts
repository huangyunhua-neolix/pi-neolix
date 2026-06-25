import { describe, expect, it } from "vitest";
import { formatPromptTemplateInvocation, parseCommandArgs, substituteArgs } from "../../src/harness/prompt-templates.ts";

describe("parseCommandArgs", () => {
	it("parses unquoted whitespace-separated args", () => {
		expect(parseCommandArgs("a b c")).toEqual(["a", "b", "c"]);
	});

	it("collapses runs of spaces and tabs", () => {
		expect(parseCommandArgs("a   b\tc")).toEqual(["a", "b", "c"]);
	});

	it("returns an empty array for an empty string", () => {
		expect(parseCommandArgs("")).toEqual([]);
	});

	it("returns an empty array for a whitespace-only string", () => {
		expect(parseCommandArgs("   \t  ")).toEqual([]);
	});

	it("preserves content inside double quotes", () => {
		expect(parseCommandArgs('"hello world" foo')).toEqual(["hello world", "foo"]);
	});

	it("preserves content inside single quotes", () => {
		expect(parseCommandArgs("'hello world' foo")).toEqual(["hello world", "foo"]);
	});

	it("does not treat the other quote type as a delimiter inside quotes", () => {
		expect(parseCommandArgs('"it\'s here"')).toEqual(["it's here"]);
		expect(parseCommandArgs("'say \"hi\"'")).toEqual(['say "hi"']);
	});

	it("keeps the remaining text when a quote is never closed", () => {
		expect(parseCommandArgs('"unterminated text')).toEqual(["unterminated text"]);
	});

	it("supports adjacent quoted and unquoted segments", () => {
		expect(parseCommandArgs('foo"bar baz"qux')).toEqual(["foobar bazqux"]);
	});

	it("does not split on special characters inside args", () => {
		expect(parseCommandArgs("path/to/file --flag=value")).toEqual(["path/to/file", "--flag=value"]);
	});
});

describe("substituteArgs", () => {
	it("substitutes $1..$N positional placeholders", () => {
		expect(substituteArgs("$1 and $2", ["a", "b"])).toBe("a and b");
	});

	it("replaces missing positional args with empty string", () => {
		expect(substituteArgs("$1 $2 $3", ["only"])).toBe("only  ");
	});

	it("substitutes $@ and $ARGUMENTS with all args joined by space", () => {
		expect(substituteArgs("args: $@", ["a", "b", "c"])).toBe("args: a b c");
		expect(substituteArgs("args: $ARGUMENTS", ["a", "b", "c"])).toBe("args: a b c");
	});

	it("substitutes $@ to empty string when no args are provided", () => {
		expect(substituteArgs("args: $@", [])).toBe("args: ");
	});

	it("substitutes ${@:N} with the suffix starting at position N (1-based)", () => {
		expect(substituteArgs("${@:2}", ["a", "b", "c", "d"])).toBe("b c d");
	});

	it("substitutes ${@:N:L} with L args starting at position N", () => {
		expect(substituteArgs("${@:2:2}", ["a", "b", "c", "d"])).toBe("b c");
	});

	it("clamps ${@:N} to empty when N exceeds the arg count", () => {
		expect(substituteArgs("${@:10}", ["a", "b"])).toBe("");
	});

	it("clamps ${@:N} to empty when N is greater than arg count but length is requested", () => {
		expect(substituteArgs("${@:10:3}", ["a", "b"])).toBe("");
	});

	it("treats ${@:0} as starting from the first arg", () => {
		expect(substituteArgs("${@:0}", ["a", "b"])).toBe("a b");
	});

	it("returns the template unchanged when it has no placeholders", () => {
		expect(substituteArgs("plain text", ["a", "b"])).toBe("plain text");
	});

	it("handles an empty template", () => {
		expect(substituteArgs("", ["a", "b"])).toBe("");
	});

	it("substitutes a mix of placeholder kinds in one template", () => {
		const template = "$1: $@ | tail=${@:2} | slice=${@:1:2}";
		expect(substituteArgs(template, ["x", "y", "z"])).toBe("x: x y z | tail=y z | slice=x y");
	});
});

describe("formatPromptTemplateInvocation", () => {
	it("substitutes the template content with the provided args", () => {
		const template = { content: "Run $1 with $2", name: "run", description: "" } as const;
		expect(formatPromptTemplateInvocation(template as never, ["build", "test"])).toBe("Run build with test");
	});

	it("defaults to an empty args array", () => {
		const template = { content: "No args $1", name: "na", description: "" } as const;
		expect(formatPromptTemplateInvocation(template as never)).toBe("No args ");
	});
});
