import { type Static, Type } from "typebox";
import { describe, expect, it } from "vitest";
import { defineTool, type ToolDefinition } from "../src/core/extensions/types.ts";

/** A minimal valid ToolDefinition for a toy echo tool. */
function makeValidTool(): ToolDefinition<typeof EchoParams, { echoed: string }> {
	const EchoParams = Type.Object({ message: Type.String() });
	return {
		name: "echo",
		label: "Echo",
		description: "echoes the message back",
		parameters: EchoParams,
		async execute(_toolCallId, params: Static<typeof EchoParams>) {
			return {
				content: [{ type: "text" as const, text: params.message }],
				details: { echoed: params.message },
			};
		},
	};
}

describe("defineTool", () => {
	it("returns a tool whose name/label/description/parameters are preserved", () => {
		const tool = makeValidTool();
		const defined = defineTool(tool);

		expect(defined.name).toBe("echo");
		expect(defined.label).toBe("Echo");
		expect(defined.description).toBe("echoes the message back");
		expect(defined.parameters).toBe(tool.parameters);
	});

	it("returns the same object reference (identity cast)", () => {
		const tool = makeValidTool();
		const defined = defineTool(tool);
		// defineTool is a pure type-level cast; the runtime object is unchanged.
		expect(defined).toBe(tool);
	});

	it("preserves the execute function (delegates to the original)", async () => {
		const tool = makeValidTool();
		const defined = defineTool(tool);

		const result = await defined.execute("call-1", { message: "hi" }, undefined, undefined, {} as never);

		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
		expect(result.details).toEqual({ echoed: "hi" });
	});

	it("preserves optional fields (promptSnippet, promptGuidelines, renderShell, executionMode)", () => {
		const EchoParams = Type.Object({ message: Type.String() });
		const tool: ToolDefinition<typeof EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "d",
			parameters: EchoParams,
			promptSnippet: "Echo: send a message back",
			promptGuidelines: ["Use echo for diagnostics"],
			renderShell: "self",
			executionMode: "parallel",
			async execute() {
				return { content: [], details: undefined };
			},
		};

		const defined = defineTool(tool);
		expect(defined.promptSnippet).toBe("Echo: send a message back");
		expect(defined.promptGuidelines).toEqual(["Use echo for diagnostics"]);
		expect(defined.renderShell).toBe("self");
		expect(defined.executionMode).toBe("parallel");
	});

	it("accepts a tool with no optional fields (minimal shape)", () => {
		const EchoParams = Type.Object({ message: Type.String() });
		const tool: ToolDefinition<typeof EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "d",
			parameters: EchoParams,
			async execute() {
				return { content: [], details: undefined };
			},
		};

		const defined = defineTool(tool);
		expect(defined.promptSnippet).toBeUndefined();
		expect(defined.promptGuidelines).toBeUndefined();
		expect(defined.renderShell).toBeUndefined();
		expect(defined.executionMode).toBeUndefined();
	});

	it("does not perform runtime schema validation — returns the object as-is even if malformed", () => {
		// defineTool is a compile-time helper only; there is no runtime validation path.
		// A structurally incomplete object is still returned unchanged (TS would flag it,
		// but at runtime nothing throws).
		const malformed = {
			name: "bad",
			label: "Bad",
			description: "missing execute",
			parameters: Type.Object({ x: Type.String() }),
			// execute intentionally omitted
		} as unknown as ToolDefinition;

		const defined = defineTool(malformed);
		expect(defined).toBe(malformed as unknown as object);
		expect(defined.name).toBe("bad");
		// No execute was added and no error was thrown.
		expect((defined as { execute?: unknown }).execute).toBeUndefined();
	});
});
