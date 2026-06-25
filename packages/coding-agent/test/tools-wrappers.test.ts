import { describe, expect, it } from "vitest";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { wrapRegisteredTool, wrapRegisteredTools } from "../src/core/extensions/wrapper.ts";
import type { ExtensionContext, RegisteredTool, ToolDefinition } from "../src/core/extensions/types.ts";

/** Minimal faux ExtensionContext — the wrapper only forwards it to definition.execute. */
function makeFauxContext(): ExtensionContext {
	return {} as ExtensionContext;
}

/** A faux runner that exposes createContext() and tracks calls via the returned counter. */
function makeFauxRunner(): { runner: { createContext(): ExtensionContext }; count(): number } {
	let n = 0;
	return {
		runner: {
			createContext(): ExtensionContext {
				n++;
				return makeFauxContext();
			},
		},
		count: () => n,
	};
}

/** Build a RegisteredTool whose definition.execute records its arguments and returns a known result. */
function makeRecordingTool(options?: { throws?: Error }): {
	registeredTool: RegisteredTool;
	executeCalls: Array<{ toolCallId: unknown; params: unknown; ctx: ExtensionContext | undefined }>;
	sourceInfo: { path: string };
} {
	const executeCalls: Array<{ toolCallId: unknown; params: unknown; ctx: ExtensionContext | undefined }> = [];
	const definition: ToolDefinition = {
		name: "faux_tool",
		label: "Faux Tool",
		description: "a faux tool for testing",
		parameters: Type.Object({ value: Type.String() }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			executeCalls.push({ toolCallId, params, ctx });
			if (options?.throws) {
				throw options.throws;
			}
			return {
				content: [{ type: "text", text: "faux-ok" }],
				details: { done: true },
			} as AgentToolResult<unknown>;
		},
	};
	return {
		registeredTool: {
			definition,
			sourceInfo: { path: "<inline>" },
		},
		executeCalls,
		sourceInfo: { path: "<inline>" },
	};
}

describe("wrapRegisteredTool", () => {
	it("delegates execute to the definition's execute, forwarding ctx from runner.createContext()", async () => {
		const { registeredTool, executeCalls } = makeRecordingTool();
		const { runner, count } = makeFauxRunner();

		const wrapped: AgentTool = wrapRegisteredTool(registeredTool, runner);

		// Surface metadata is preserved from the definition.
		expect(wrapped.name).toBe("faux_tool");
		expect(wrapped.label).toBe("Faux Tool");
		expect(wrapped.description).toBe("a faux tool for testing");

		const result = await wrapped.execute("call-1", { value: "hello" }, undefined, undefined);

		expect(executeCalls).toHaveLength(1);
		expect(executeCalls[0].toolCallId).toBe("call-1");
		expect(executeCalls[0].params).toEqual({ value: "hello" });
		// createContext() was called exactly once and the produced ctx was forwarded.
		expect(count()).toBe(1);
		expect(executeCalls[0].ctx).toBeDefined();

		expect(result.content).toEqual([{ type: "text", text: "faux-ok" }]);
		expect(result.details).toEqual({ done: true });
	});

	it("propagates errors thrown by the underlying definition.execute", async () => {
		const boom = new Error("boom-from-definition");
		const { registeredTool } = makeRecordingTool({ throws: boom });
		const { runner } = makeFauxRunner();

		const wrapped: AgentTool = wrapRegisteredTool(registeredTool, runner);

		await expect(wrapped.execute("call-1", { value: "x" }, undefined, undefined)).rejects.toThrow(
			"boom-from-definition",
		);
	});

	it("forwards prepareArguments and executionMode from the definition", () => {
		const definition: ToolDefinition = {
			name: "with_prepare",
			label: "With Prepare",
			description: "d",
			parameters: Type.Object({ value: Type.String() }),
			prepareArguments: (args) => ({ value: String((args as { value?: unknown }).value ?? "") }),
			executionMode: "sequential",
			async execute() {
				return { content: [], details: undefined } as AgentToolResult<unknown>;
			},
		};
		const registeredTool: RegisteredTool = {
			definition,
			sourceInfo: { path: "<inline>" },
		};
		const { runner } = makeFauxRunner();
		const wrapped = wrapRegisteredTool(registeredTool, runner);

		expect(typeof wrapped.prepareArguments).toBe("function");
		expect(wrapped.prepareArguments?.({ value: 42 })).toEqual({ value: "42" });
		expect(wrapped.executionMode).toBe("sequential");
	});

	it("returns undefined prepareArguments when the definition omits it", () => {
		const { registeredTool } = makeRecordingTool();
		const { runner } = makeFauxRunner();
		const wrapped = wrapRegisteredTool(registeredTool, runner);
		expect(wrapped.prepareArguments).toBeUndefined();
	});
});

describe("wrapRegisteredTools", () => {
	it("wraps an empty list into an empty AgentTool array", () => {
		const { runner } = makeFauxRunner();
		const wrapped = wrapRegisteredTools([], runner);
		expect(wrapped).toEqual([]);
	});

	it("wraps each tool, preserving order and delegating independently", async () => {
		const a = makeRecordingTool();
		a.registeredTool.definition.name = "tool_a";
		const b = makeRecordingTool();
		b.registeredTool.definition.name = "tool_b";
		const { runner } = makeFauxRunner();

		const wrapped = wrapRegisteredTools([a.registeredTool, b.registeredTool], runner);
		expect(wrapped).toHaveLength(2);
		expect(wrapped[0].name).toBe("tool_a");
		expect(wrapped[1].name).toBe("tool_b");

		await wrapped[0].execute("c1", { value: "a" }, undefined, undefined);
		await wrapped[1].execute("c2", { value: "b" }, undefined, undefined);

		expect(a.executeCalls).toHaveLength(1);
		expect(a.executeCalls[0].params).toEqual({ value: "a" });
		expect(b.executeCalls).toHaveLength(1);
		expect(b.executeCalls[0].params).toEqual({ value: "b" });
	});

	it("propagates an error from one tool without affecting another", async () => {
		const boom = new Error("tool-b-failed");
		const a = makeRecordingTool();
		a.registeredTool.definition.name = "ok_tool";
		const b = makeRecordingTool({ throws: boom });
		b.registeredTool.definition.name = "failing_tool";
		const { runner } = makeFauxRunner();

		const wrapped = wrapRegisteredTools([a.registeredTool, b.registeredTool], runner);

		// Tool a succeeds.
		await expect(wrapped[0].execute("c1", { value: "a" }, undefined, undefined)).resolves.toMatchObject({
			details: { done: true },
		});
		// Tool b throws.
		await expect(wrapped[1].execute("c2", { value: "b" }, undefined, undefined)).rejects.toThrow("tool-b-failed");
	});
});
