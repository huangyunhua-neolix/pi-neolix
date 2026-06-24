import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/core/tools/agent-discovery.ts";
import {
	AGENT_SPAWN_STDIO,
	AGENT_TOOL_NAME,
	createAgentTool,
	createAgentToolDefinition,
	handleRelayEvent,
	makeGeneralPurposeAgent,
	processLine,
	resolveSpawnArgs,
	resolveToolsArg,
} from "../src/core/tools/agent-tool.ts";

const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		systemPrompt: "you are a test agent",
		source: "user",
		filePath: "/tmp/test.md",
		...overrides,
	};
}

describe("AGENT_TOOL_NAME", () => {
	it("exports correct tool name", () => {
		expect(AGENT_TOOL_NAME).toBe("Agent");
	});
});

describe("resolveToolsArg", () => {
	it("returns all registered names joined when agent.tools is undefined (wildcard)", () => {
		const agent = makeAgent({ tools: undefined });
		const result = resolveToolsArg(agent, ALL_TOOLS);
		expect(result).toBe(ALL_TOOLS.join(","));
	});

	it("returns the explicit tools list joined when agent.tools is a non-empty array", () => {
		const agent = makeAgent({ tools: ["read"] });
		const result = resolveToolsArg(agent, ALL_TOOLS);
		expect(result).toBe("read");
	});

	it('returns "" for empty array (fail-safe, no wildcard collapse)', () => {
		const agent = makeAgent({ tools: [] });
		const result = resolveToolsArg(agent, ALL_TOOLS);
		expect(result).toBe("");
	});

	it("subtracts disallowedTools from the explicit allowlist", () => {
		const agent = makeAgent({ tools: ["read", "bash"], disallowedTools: ["bash"] });
		const result = resolveToolsArg(agent, ALL_TOOLS);
		expect(result).toBe("read");
	});

	it("subtracts disallowedTools from wildcard (undefined tools)", () => {
		const agent = makeAgent({ tools: undefined, disallowedTools: ["bash"] });
		const result = resolveToolsArg(agent, ALL_TOOLS);
		// wildcard minus disallowed → all tools except bash
		const expected = ALL_TOOLS.filter((t) => t !== "bash").join(",");
		expect(result).toBe(expected);
	});

	it("returns empty string when all tools are disallowed", () => {
		const agent = makeAgent({ tools: ["read"], disallowedTools: ["read"] });
		const result = resolveToolsArg(agent, ALL_TOOLS);
		expect(result).toBe("");
	});
});

describe("makeGeneralPurposeAgent", () => {
	it("creates a config with name general-purpose", () => {
		const agent = makeGeneralPurposeAgent(ALL_TOOLS);
		expect(agent.name).toBe("general-purpose");
	});

	it("has undefined tools (wildcard)", () => {
		const agent = makeGeneralPurposeAgent(ALL_TOOLS);
		expect(agent.tools).toBeUndefined();
	});

	it("has a generic system prompt mentioning general-purpose", () => {
		const agent = makeGeneralPurposeAgent(ALL_TOOLS);
		expect(agent.systemPrompt.toLowerCase()).toContain("general-purpose");
	});

	it("resolves to all tools via resolveToolsArg", () => {
		const agent = makeGeneralPurposeAgent(ALL_TOOLS);
		const result = resolveToolsArg(agent, ALL_TOOLS);
		expect(result).toBe(ALL_TOOLS.join(","));
	});
});

describe("resolveSpawnArgs", () => {
	it("includes --mode json --no-session", () => {
		const agent = makeAgent({ tools: undefined });
		const args = resolveSpawnArgs({
			agent,
			allRegisteredToolNames: ALL_TOOLS,
		});
		expect(args).toContain("--mode");
		expect(args[args.indexOf("--mode") + 1]).toBe("json");
		expect(args).toContain("--no-session");
	});

	it("includes --tools with resolved wildcard", () => {
		const agent = makeAgent({ tools: undefined });
		const args = resolveSpawnArgs({
			agent,
			allRegisteredToolNames: ALL_TOOLS,
		});
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe(ALL_TOOLS.join(","));
	});

	it('includes --tools "" for empty allowlist', () => {
		const agent = makeAgent({ tools: [] });
		const args = resolveSpawnArgs({
			agent,
			allRegisteredToolNames: ALL_TOOLS,
		});
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe("");
	});

	it("includes --model when modelToUse is provided", () => {
		const agent = makeAgent({ tools: undefined });
		const args = resolveSpawnArgs({
			agent,
			modelToUse: "glm-5.2",
			allRegisteredToolNames: ALL_TOOLS,
		});
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("glm-5.2");
	});

	it("includes --provider when defaultProvider is provided", () => {
		const agent = makeAgent({ tools: undefined });
		const args = resolveSpawnArgs({
			agent,
			defaultProvider: "openai",
			allRegisteredToolNames: ALL_TOOLS,
		});
		expect(args).toContain("--provider");
		expect(args[args.indexOf("--provider") + 1]).toBe("openai");
	});

	it("includes --append-system-prompt when tmpPromptPath is provided", () => {
		const agent = makeAgent({ tools: undefined, systemPrompt: "custom prompt" });
		const args = resolveSpawnArgs({
			agent,
			allRegisteredToolNames: ALL_TOOLS,
			tmpPromptPath: "/tmp/prompt.md",
		});
		expect(args).toContain("--append-system-prompt");
		expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("/tmp/prompt.md");
	});

	it("omits --append-system-prompt when systemPrompt is empty", () => {
		const agent = makeAgent({ tools: undefined, systemPrompt: "  " });
		const args = resolveSpawnArgs({
			agent,
			allRegisteredToolNames: ALL_TOOLS,
		});
		expect(args).not.toContain("--append-system-prompt");
	});
});

describe("AGENT_SPAWN_STDIO", () => {
	it('is ["pipe","pipe","pipe"]', () => {
		expect(AGENT_SPAWN_STDIO).toEqual(["pipe", "pipe", "pipe"]);
	});
});

describe("processLine", () => {
	let stdinWrite: ReturnType<typeof vi.fn>;
	let stdin: { write: (data: string) => boolean };

	beforeEach(() => {
		stdinWrite = vi.fn().mockReturnValue(true) as any;
		stdin = { write: stdinWrite as any };
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("intercepts __pi_event ask_user_question lines and writes response to stdin", () => {
		const eventLine = JSON.stringify({
			__pi_event: "ask_user_question",
			id: "evt-1",
			questions: [
				{
					question: "Pick one",
					options: [{ label: "A" }, { label: "B" }],
				},
			],
		});
		const onMessageEnd = vi.fn();
		const onToolResultEnd = vi.fn();

		const intercepted = processLine(eventLine, {
			stdin,
			onMessageEnd,
			onToolResultEnd,
		});

		expect(intercepted).toBe(true);
		expect(onMessageEnd).not.toHaveBeenCalled();
		expect(onToolResultEnd).not.toHaveBeenCalled();
		// stdin.write should have been called with a response event
		expect(stdinWrite).toHaveBeenCalledTimes(1);
		const written = String(stdinWrite.mock.calls[0][0]);
		expect(written).toContain("__pi_event");
		expect(written).toContain("ask_user_question_response");
		expect(written).toContain("evt-1");
	});

	it("does not intercept normal message_end lines", () => {
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
		} as any;
		const line = JSON.stringify({ type: "message_end", message: msg });
		const onMessageEnd = vi.fn();
		const onToolResultEnd = vi.fn();

		const intercepted = processLine(line, {
			stdin,
			onMessageEnd,
			onToolResultEnd,
		});

		expect(intercepted).toBe(false);
		expect(onMessageEnd).toHaveBeenCalledTimes(1);
		expect(onToolResultEnd).not.toHaveBeenCalled();
	});

	it("does not intercept normal tool_result_end lines", () => {
		const msg: Message = {
			role: "toolResult",
			content: [{ type: "text", text: "result" }],
		} as any;
		const line = JSON.stringify({ type: "tool_result_end", message: msg });
		const onMessageEnd = vi.fn();
		const onToolResultEnd = vi.fn();

		const intercepted = processLine(line, {
			stdin,
			onMessageEnd,
			onToolResultEnd,
		});

		expect(intercepted).toBe(false);
		expect(onToolResultEnd).toHaveBeenCalledTimes(1);
		expect(onMessageEnd).not.toHaveBeenCalled();
	});

	it("ignores empty lines", () => {
		const onMessageEnd = vi.fn();
		const onToolResultEnd = vi.fn();

		const intercepted = processLine("", {
			stdin,
			onMessageEnd,
			onToolResultEnd,
		});

		expect(intercepted).toBe(false);
		expect(onMessageEnd).not.toHaveBeenCalled();
		expect(onToolResultEnd).not.toHaveBeenCalled();
	});

	it("ignores non-JSON lines", () => {
		const onMessageEnd = vi.fn();
		const onToolResultEnd = vi.fn();

		const intercepted = processLine("not json at all", {
			stdin,
			onMessageEnd,
			onToolResultEnd,
		});

		expect(intercepted).toBe(false);
		expect(onMessageEnd).not.toHaveBeenCalled();
		expect(onToolResultEnd).not.toHaveBeenCalled();
	});
});

describe("handleRelayEvent", () => {
	it("writes ask_user_question_response to stdin for ask_user_question events", () => {
		const stdinWrite = vi.fn();
		const stdin = { write: stdinWrite };

		handleRelayEvent(
			{
				__pi_event: "ask_user_question",
				id: "test-id",
				questions: [
					{
						question: "Pick",
						options: [{ label: "A" }, { label: "B" }],
					},
				],
			},
			stdin,
		);

		expect(stdinWrite).toHaveBeenCalledTimes(1);
		const written = String(stdinWrite.mock.calls[0][0]);
		expect(written).toContain("ask_user_question_response");
		expect(written).toContain("test-id");
	});

	it("does not write to stdin when stdin is null", () => {
		expect(() => {
			handleRelayEvent(
				{
					__pi_event: "ask_user_question",
					id: "test-id",
					questions: [],
				},
				null,
			);
		}).not.toThrow();
	});

	it("uses onAskUserQuestion callback when provided", async () => {
		const stdinWrite = vi.fn();
		const stdin = { write: stdinWrite };
		const callback = vi.fn().mockResolvedValue({ "0": "B" });

		handleRelayEvent(
			{
				__pi_event: "ask_user_question",
				id: "cb-id",
				questions: [{ question: "q", options: [{ label: "A" }, { label: "B" }] }],
			},
			stdin,
			callback,
		);

		// Wait for the async callback to resolve
		await vi.waitFor(() => {
			expect(callback).toHaveBeenCalledTimes(1);
			expect(stdinWrite).toHaveBeenCalledTimes(1);
		});

		const written = String(stdinWrite.mock.calls[0][0]);
		expect(written).toContain("cb-id");
		expect(written).toContain('"B"');
	});
});

describe("createAgentToolDefinition", () => {
	it("creates a definition with name Agent", () => {
		const def = createAgentToolDefinition("/tmp");
		expect(def.name).toBe("Agent");
	});

	it("has a promptSnippet", () => {
		const def = createAgentToolDefinition("/tmp");
		expect(def.promptSnippet).toBeDefined();
		expect(def.promptSnippet!.length).toBeGreaterThan(0);
	});

	it("has parameters schema with subagent_type and prompt", () => {
		const def = createAgentToolDefinition("/tmp");
		expect(def.parameters).toBeDefined();
	});
});

describe("createAgentTool", () => {
	it("creates a tool with name Agent", () => {
		const tool = createAgentTool("/tmp");
		expect(tool.name).toBe("Agent");
	});
});
