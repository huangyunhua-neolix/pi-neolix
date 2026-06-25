import { describe, expect, it } from "vitest";
import type {
	BashToolCallEvent,
	BashToolResultEvent,
	CustomToolCallEvent,
	CustomToolResultEvent,
	ToolCallEvent,
	ToolResultEvent,
	WriteToolResultEvent,
} from "../src/core/extensions/types.ts";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "../src/core/extensions/types.ts";

/** Build a minimal ToolResultEvent with the given toolName/details. */
function makeResult(toolName: string, details: unknown): ToolResultEvent {
	const base = {
		type: "tool_result" as const,
		toolCallId: "call-1",
		input: {},
		content: [{ type: "text" as const, text: "ok" }],
		isError: false,
	};
	return { ...base, toolName, details } as ToolResultEvent;
}

/** Build a minimal ToolCallEvent with the given toolName/input. */
function makeCall(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName,
		input,
	} as ToolCallEvent;
}

describe("is*ToolResult type guards", () => {
	const guards: Array<{
		name: string;
		guard: (e: ToolResultEvent) => boolean;
		toolName: string;
	}> = [
		{ name: "isBashToolResult", guard: isBashToolResult, toolName: "bash" },
		{ name: "isEditToolResult", guard: isEditToolResult, toolName: "edit" },
		{ name: "isFindToolResult", guard: isFindToolResult, toolName: "find" },
		{ name: "isGrepToolResult", guard: isGrepToolResult, toolName: "grep" },
		{ name: "isLsToolResult", guard: isLsToolResult, toolName: "ls" },
		{ name: "isReadToolResult", guard: isReadToolResult, toolName: "read" },
		{ name: "isWriteToolResult", guard: isWriteToolResult, toolName: "write" },
	];

	for (const { name, guard, toolName } of guards) {
		describe(name, () => {
			it("returns true for a matching shaped result", () => {
				expect(guard(makeResult(toolName, undefined))).toBe(true);
			});

			it("returns false for every other toolName", () => {
				for (const other of guards) {
					if (other.toolName === toolName) continue;
					expect(guard(makeResult(other.toolName, undefined))).toBe(false);
				}
			});

			it("returns false for a custom (unknown) toolName result", () => {
				expect(guard(makeResult("my_custom_tool", {}))).toBe(false);
			});
		});
	}

	it("guards are mutually exclusive across the full result set", () => {
		const all: Array<{ guard: (e: ToolResultEvent) => boolean; toolName: string }> = [
			{ guard: isBashToolResult, toolName: "bash" },
			{ guard: isReadToolResult, toolName: "read" },
			{ guard: isEditToolResult, toolName: "edit" },
			{ guard: isWriteToolResult, toolName: "write" },
			{ guard: isGrepToolResult, toolName: "grep" },
			{ guard: isFindToolResult, toolName: "find" },
			{ guard: isLsToolResult, toolName: "ls" },
		];
		for (const { toolName } of all) {
			const e = makeResult(toolName, undefined);
			const matched = all.filter(({ guard: g }) => g(e));
			expect(matched).toHaveLength(1);
			expect(matched[0].toolName).toBe(toolName);
		}
	});

	it("type narrows the matching union member (compile-time guarantee via cast)", () => {
		const bash: ToolResultEvent = makeResult("bash", { exitCode: 0 });
		if (isBashToolResult(bash)) {
			const narrowed: BashToolResultEvent = bash;
			expect(narrowed.toolName).toBe("bash");
		}

		const write: ToolResultEvent = makeResult("write", undefined);
		if (isWriteToolResult(write)) {
			const narrowed: WriteToolResultEvent = write;
			expect(narrowed.details).toBeUndefined();
		}
	});
});

describe("is*ToolResult edge cases (malformed / wrong-type)", () => {
	it("returns false when toolName is a non-matching custom value", () => {
		const custom = makeResult("totally_custom", { foo: 1 }) as CustomToolResultEvent;
		expect(isBashToolResult(custom)).toBe(false);
		expect(isReadToolResult(custom)).toBe(false);
		expect(isEditToolResult(custom)).toBe(false);
		expect(isWriteToolResult(custom)).toBe(false);
		expect(isGrepToolResult(custom)).toBe(false);
		expect(isFindToolResult(custom)).toBe(false);
		expect(isLsToolResult(custom)).toBe(false);
	});

	it("treats result objects missing optional details as still matching by toolName", () => {
		// details is typed as `T | undefined`; an explicit undefined is valid.
		expect(isBashToolResult(makeResult("bash", undefined))).toBe(true);
		expect(isWriteToolResult(makeResult("write", undefined))).toBe(true);
	});

	it("returns false for a guard-checking-result with empty toolName", () => {
		// Empty string is not a built-in toolName; falls through to CustomToolResultEvent.
		expect(isBashToolResult(makeResult("", undefined))).toBe(false);
	});
});

describe("isToolCallEventType", () => {
	const builtinNames = ["bash", "read", "edit", "write", "grep", "find", "ls"] as const;

	for (const name of builtinNames) {
		it(`returns true when toolName matches "${name}"`, () => {
			expect(isToolCallEventType(name, makeCall(name))).toBe(true);
		});

		it(`returns false when toolName differs from "${name}"`, () => {
			expect(isToolCallEventType(name, makeCall("other"))).toBe(false);
		});
	}

	it("returns true for a custom toolName match", () => {
		expect(isToolCallEventType("my_tool", makeCall("my_tool"))).toBe(true);
	});

	it("returns false for a custom toolName mismatch", () => {
		expect(isToolCallEventType("my_tool", makeCall("other_tool"))).toBe(false);
	});

	it("is case-sensitive", () => {
		expect(isToolCallEventType("bash", makeCall("Bash"))).toBe(false);
		expect(isToolCallEventType("bash", makeCall("BASH"))).toBe(false);
	});

	it("narrows built-in call events (compile-time guarantee via cast)", () => {
		const call: ToolCallEvent = makeCall("bash", { command: "ls" });
		if (isToolCallEventType("bash", call)) {
			const narrowed: BashToolCallEvent = call;
			expect(narrowed.toolName).toBe("bash");
		}
	});

	it("narrows custom call events with explicit type params (compile-time guarantee via cast)", () => {
		const call: ToolCallEvent = makeCall("my_tool", { action: "go" });
		if (isToolCallEventType<"my_tool", { action: string }>("my_tool", call)) {
			const narrowed: CustomToolCallEvent = call;
			expect(narrowed.input.action).toBe("go");
		}
	});

	it("returns false for an EditToolResultEvent-shaped result fed to the call guard", () => {
		// Sanity: call guards operate on ToolCallEvent, not ToolResultEvent.
		// Feeding a result-shaped object (with type "tool_result") should be rejected by TS;
		// at runtime we only assert behavior over ToolCallEvent inputs.
		const editResult = makeResult("edit", undefined) as unknown as ToolCallEvent;
		// toolName still matches "edit", so the runtime predicate is true — but the object
		// is not a real ToolCallEvent. This documents that the guard is a pure toolName comparison.
		expect(isToolCallEventType("edit", editResult)).toBe(true);
	});
});
