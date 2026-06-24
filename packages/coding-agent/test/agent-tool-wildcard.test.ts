import { EventEmitter } from "node:events";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/core/tools/agent-discovery.ts";
import {
	AGENT_SPAWN_STDIO,
	AGENT_TOOL_NAME,
	createAgentTool,
	createAgentToolDefinition,
	getPiInvocation,
	handleRelayEvent,
	makeGeneralPurposeAgent,
	processLine,
	resolveSpawnArgs,
	resolveToolsArg,
	runOneAgentSpawn,
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

// ---------------------------------------------------------------------------
// Spawn loop integration (R1)
// ---------------------------------------------------------------------------

/**
 * Mock ChildProcess for spawn-loop tests. Emits 'data' on stdout/stderr,
 * 'close' with an exit code, and exposes a writable stdin.
 */
function makeMockChildProcess(): any {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const stdin = { write: vi.fn().mockReturnValue(true), end: vi.fn() };
	const proc: any = {
		stdout,
		stderr,
		stdin,
		kill: vi.fn(),
		killed: false,
		on: vi.fn((event: string, cb: (...args: any[]) => void) => {
			proc._handlers = proc._handlers || {};
			const list = proc._handlers[event] || [];
			list.push(cb);
			proc._handlers[event] = list;
			return proc;
		}),
		_emitClose: (code: number) => {
			const handlers = proc._handlers?.close ?? [];
			for (const cb of handlers) cb(code);
		},
	};
	return proc;
}

describe("getPiInvocation", () => {
	it("returns command and args", () => {
		const inv = getPiInvocation(["--mode", "json"]);
		expect(inv.command).toBeDefined();
		expect(Array.isArray(inv.args)).toBe(true);
	});
});

describe("runOneAgentSpawn (spawn loop)", () => {
	const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "Agent"];

	function makeSpawnAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
		return {
			name: "test-agent",
			description: "test",
			systemPrompt: "you are a test agent",
			source: "user",
			filePath: "/tmp/test.md",
			tools: undefined,
			...overrides,
		};
	}

	it("spawns child pi with resolved argv including --tools wildcard and pipe/pipe/pipe stdio", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);

		const promise = runOneAgentSpawn({
			agent: makeSpawnAgent(),
			task: "do something",
			cwd: "/tmp",
			allRegisteredToolNames: ALL_TOOLS,
			spawnFn: spawnFn as any,
		});

		// Wait for spawn to be called
		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));

		const spawnCall = spawnFn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
		const [command, args, options] = spawnCall;
		expect(command).toBeDefined();
		// --mode json --no-session
		expect(args).toContain("--mode");
		expect(args).toContain("--no-session");
		// --tools wildcard = all tools joined
		expect(args).toContain("--tools");
		const toolsIdx = args.indexOf("--tools");
		expect(args[toolsIdx + 1]).toBe(ALL_TOOLS.join(","));
		// stdio is pipe/pipe/pipe
		expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
		expect(options.cwd).toBe("/tmp");
		expect(options.shell).toBe(false);
		// task passed as positional
		expect(args[args.length - 1]).toContain("Task: do something");

		// Emit a message_end line
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "hello from child" }],
		} as any;
		proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message: msg }) + "\n"));
		proc._emitClose(0);

		const result = await promise;
		expect(result.exitCode).toBe(0);
		expect(result.messages.length).toBe(1);
		expect(result.agent).toBe("test-agent");
	});

	it("returns exit code on child failure and includes stderr", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);

		const promise = runOneAgentSpawn({
			agent: makeSpawnAgent(),
			task: "fail task",
			cwd: "/tmp",
			allRegisteredToolNames: ALL_TOOLS,
			spawnFn: spawnFn as any,
		});

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		proc.stderr.emit("data", Buffer.from("child error output"));
		proc._emitClose(1);

		const result = await promise;
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("child error output");
	});

	it("writes system prompt to temp file and passes via --append-system-prompt", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);

		const promise = runOneAgentSpawn({
			agent: makeSpawnAgent({ systemPrompt: "custom system prompt" }),
			task: "task",
			cwd: "/tmp",
			allRegisteredToolNames: ALL_TOOLS,
			spawnFn: spawnFn as any,
		});

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		const args = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
		expect(args).toContain("--append-system-prompt");
		const idx = args.indexOf("--append-system-prompt");
		expect(args[idx + 1]).toMatch(/prompt-test-agent\.md$/);

		proc._emitClose(0);
		await promise;
	});

	it("does not pass --append-system-prompt when systemPrompt is empty", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);

		const promise = runOneAgentSpawn({
			agent: makeSpawnAgent({ systemPrompt: "   " }),
			task: "task",
			cwd: "/tmp",
			allRegisteredToolNames: ALL_TOOLS,
			spawnFn: spawnFn as any,
		});

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		const args = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
		expect(args).not.toContain("--append-system-prompt");

		proc._emitClose(0);
		await promise;
	});
});

describe("createAgentToolDefinition execute (single mode via mock spawn)", () => {
	const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "Agent"];

	function makeCtx(cwd: string): any {
		return { cwd, getActiveTools: () => ALL_TOOLS };
	}

	it("returns error result for invalid parameters", async () => {
		const def = createAgentToolDefinition("/tmp");
		const result: any = await def.execute("call-1", {}, undefined, undefined, makeCtx("/tmp"));
		expect(result.content[0].text).toContain("Invalid parameters");
	});

	it("spawns child for single agent mode and returns assistant output", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });

		const promise = def.execute(
			"call-2",
			{ subagent_type: "general-purpose", prompt: "say hello" },
			undefined,
			undefined,
			makeCtx("/tmp"),
		);

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "hello from subagent" }],
		} as any;
		proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message: msg }) + "\n"));
		proc._emitClose(0);

		const result: any = await promise;
		expect(result.content[0].text).toContain("hello from subagent");
		expect(result.details.mode).toBe("single");
	});

	it("returns error when child exits non-zero", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });

		const promise = def.execute(
			"call-3",
			{ subagent_type: "general-purpose", prompt: "fail" },
			undefined,
			undefined,
			makeCtx("/tmp"),
		);

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		proc.stderr.emit("data", Buffer.from("spawn failure"));
		proc._emitClose(1);

		const result: any = await promise;
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Agent failed");
		expect(result.content[0].text).toContain("spawn failure");
	});
});
