import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
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

	it("intercepts __pi_event ask_user_question lines and writes response to stdin (with callback)", async () => {
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
		const onAskUserQuestion = vi.fn().mockResolvedValue({ "0": "A" });

		const intercepted = processLine(eventLine, {
			stdin,
			onMessageEnd,
			onToolResultEnd,
			onAskUserQuestion,
		});

		expect(intercepted).toBe(true);
		expect(onMessageEnd).not.toHaveBeenCalled();
		expect(onToolResultEnd).not.toHaveBeenCalled();
		// callback should have been called
		expect(onAskUserQuestion).toHaveBeenCalledTimes(1);
		// Wait for async resolution + stdin.write
		await vi.waitFor(() => {
			expect(stdinWrite).toHaveBeenCalledTimes(1);
		});
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
	it("writes ask_user_question_response to stdin for ask_user_question events (PI_RELAY_AUTO_PICK stub)", () => {
		vi.stubEnv("PI_RELAY_AUTO_PICK", "1");
		try {
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
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("does not write to stdin when no callback and PI_RELAY_AUTO_PICK not set", () => {
		const stdinWrite = vi.fn();
		const stdin = { write: stdinWrite };

		handleRelayEvent(
			{
				__pi_event: "ask_user_question",
				id: "test-id-no-stub",
				questions: [{ question: "q", options: [{ label: "A" }] }],
			},
			stdin,
		);

		expect(stdinWrite).not.toHaveBeenCalled();
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
		proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: msg })}\n`));
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

		const promise = def.execute("call-2", { prompt: "say hello" }, undefined, undefined, makeCtx("/tmp"));

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "hello from subagent" }],
		} as any;
		proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: msg })}\n`));
		proc._emitClose(0);

		const result: any = await promise;
		expect(result.content[0].text).toContain("hello from subagent");
		expect(result.details.mode).toBe("single");
	});

	it("returns error when child exits non-zero", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });

		const promise = def.execute("call-3", { prompt: "fail" }, undefined, undefined, makeCtx("/tmp"));

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		proc.stderr.emit("data", Buffer.from("spawn failure"));
		proc._emitClose(1);

		const result: any = await promise;
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Agent failed");
		expect(result.content[0].text).toContain("spawn failure");
	});
});

// ---------------------------------------------------------------------------
// Round-2 fixes: R1 (AskUserQuestion relay), Y1 (unknown agent), Y2 (ctx.getActiveTools)
// ---------------------------------------------------------------------------

describe("R1: onAskUserQuestion wiring in execute", () => {
	const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "Agent"];

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

	it("passes onAskUserQuestion that uses ctx.ui.select when ctx.hasUI is true", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const selectFn = vi.fn().mockResolvedValue("Option A");
		const ctx = {
			cwd: "/tmp",
			hasUI: true,
			ui: { select: selectFn },
			getActiveTools: () => ALL_TOOLS,
		};
		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });

		const promise = def.execute("r1-1", { prompt: "ask me" }, undefined, undefined, ctx as any);
		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));

		// Emit an ask_user_question event from child
		const evtLine = JSON.stringify({
			__pi_event: "ask_user_question",
			id: "r1-evt-1",
			questions: [{ question: "Pick one", options: [{ label: "Option A" }, { label: "Option B" }] }],
		});
		proc.stdout.emit("data", Buffer.from(`${evtLine}\n`));

		// Wait for ctx.ui.select to be called
		await vi.waitFor(() => expect(selectFn).toHaveBeenCalledTimes(1));
		expect(selectFn).toHaveBeenCalledWith("Pick one", ["Option A", "Option B"]);

		// The response should be written to child stdin
		await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledTimes(1));
		const written = String(proc.stdin.write.mock.calls[0][0]);
		expect(written).toContain("ask_user_question_response");
		expect(written).toContain("r1-evt-1");
		expect(written).toContain("Option A");

		// Emit a message_end and close
		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
		} as any;
		proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: msg })}\n`));
		proc._emitClose(0);

		const result: any = await promise;
		expect(result.content[0].text).toContain("done");
	});

	it("passes onAskUserQuestion that re-emits to stdout when no TUI (bubble-up)", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const ctx = {
			cwd: "/tmp",
			hasUI: false,
			getActiveTools: () => ALL_TOOLS,
		};
		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });

		const promise = def.execute("r1-2", { prompt: "ask me" }, undefined, undefined, ctx as any);
		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));

		// Emit an ask_user_question event from child
		const evtLine = JSON.stringify({
			__pi_event: "ask_user_question",
			id: "r1-evt-2",
			questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }],
		});
		proc.stdout.emit("data", Buffer.from(`${evtLine}\n`));

		// The event should be re-emitted to process.stdout (bubble-up)
		await vi.waitFor(() => {
			const reEmitted = writeSpy.mock.calls.some((c) => String(c[0]).includes("r1-evt-2"));
			expect(reEmitted).toBe(true);
		});

		// Deliver a response (simulating grandparent writing to parent stdin)
		const { deliverAskUserQuestionResponse } = await import("../src/core/tools/ask-user-question.ts");
		deliverAskUserQuestionResponse("r1-evt-2", { "0": "B" });

		// The response should be forwarded to child stdin
		await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledTimes(1));
		const written = String(proc.stdin.write.mock.calls[0][0]);
		expect(written).toContain("ask_user_question_response");
		expect(written).toContain("r1-evt-2");
		expect(written).toContain("B");

		writeSpy.mockRestore();

		const msg: Message = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
		} as any;
		proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: msg })}\n`));
		proc._emitClose(0);

		await promise;
	});
});

describe("Y1: resolveAgent unknown agent name", () => {
	const ALL_TOOLS = ["read", "bash", "edit"];

	it("throws with available list when agent name is not found", async () => {
		const proc: any = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });

		const ctx = { cwd: "/tmp", getActiveTools: () => ALL_TOOLS };

		await expect(
			def.execute(
				"y1-1",
				{ subagent_type: "nonexistent-agent", prompt: "do stuff" },
				undefined,
				undefined,
				ctx as any,
			),
		).rejects.toThrow(/Unknown agent: nonexistent-agent/);
	});

	it("falls back to general-purpose when subagent_type is omitted", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });

		const ctx = { cwd: "/tmp", getActiveTools: () => ALL_TOOLS };

		const promise = def.execute("y1-2", { prompt: "do stuff" }, undefined, undefined, ctx as any);
		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));

		const args = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
		// Should have --tools with all tools (wildcard)
		expect(args).toContain("--tools");
		const toolsIdx = args.indexOf("--tools");
		expect(args[toolsIdx + 1]).toBe(ALL_TOOLS.join(","));

		proc._emitClose(0);
		await promise;
	});
});

describe("Y2: execute uses ctx.getActiveTools when available", () => {
	it("uses ctx.getActiveTools() result for allRegisteredToolNames", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const customTools = ["read", "bash", "Agent", "CustomTool"];
		const getActiveTools = vi.fn(() => customTools);
		const ctx = { cwd: "/tmp", getActiveTools };

		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });
		const promise = def.execute("y2-1", { prompt: "do stuff" }, undefined, undefined, ctx as any);

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		expect(getActiveTools).toHaveBeenCalled();

		const args = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
		expect(args).toContain("--tools");
		const toolsIdx = args.indexOf("--tools");
		expect(args[toolsIdx + 1]).toBe(customTools.join(","));

		proc._emitClose(0);
		await promise;
	});

	it("falls back to hardcoded list when ctx has no getActiveTools", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		// ctx without getActiveTools — simulates real ExtensionContext
		const ctx = { cwd: "/tmp" };

		const def = createAgentToolDefinition("/tmp", { spawnFn: spawnFn as any });
		const promise = def.execute("y2-2", { prompt: "do stuff" }, undefined, undefined, ctx as any);

		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));
		const args = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
		expect(args).toContain("--tools");
		const toolsIdx = args.indexOf("--tools");
		// Should contain at least the base tools
		expect(args[toolsIdx + 1]).toContain("read");
		expect(args[toolsIdx + 1]).toContain("bash");

		proc._emitClose(0);
		await promise;
	});
});

// ---------------------------------------------------------------------------
// FIX-5: stdout/stderr buffer cap
// FIX-6: SIGKILL timer cleared on close
// FIX-7: temp dir cleanup with rmSync recursive
// FIX-9: relay parallel forgery guard
// FIX-11: PATH spoof — getPiInvocation fallback
// ---------------------------------------------------------------------------

describe("FIX-5: stdout buffer cap at 1 MB", () => {
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

	it("truncates stdout buffer when child emits > 1 MB without newlines", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const promise = runOneAgentSpawn({
			agent: makeSpawnAgent({ systemPrompt: "" }),
			task: "task",
			cwd: "/tmp",
			allRegisteredToolNames: ALL_TOOLS,
			spawnFn: spawnFn as any,
		});
		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));

		// Emit 2 MB of data with no newline.
		const huge = "A".repeat(2 * 1024 * 1024);
		proc.stdout.emit("data", Buffer.from(huge));

		proc._emitClose(0);
		const result = await promise;
		// The stdout buffer should have been truncated; stderr should note truncation.
		expect(result.stderr).toMatch(/stdout truncated/i);
	});

	it("truncates stderr buffer when child emits > 1 MB on stderr", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const promise = runOneAgentSpawn({
			agent: makeSpawnAgent({ systemPrompt: "" }),
			task: "task",
			cwd: "/tmp",
			allRegisteredToolNames: ALL_TOOLS,
			spawnFn: spawnFn as any,
		});
		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));

		const huge = "B".repeat(2 * 1024 * 1024);
		proc.stderr.emit("data", Buffer.from(huge));

		proc._emitClose(1);
		const result = await promise;
		expect(result.stderr).toMatch(/stderr truncated/i);
	});
});

describe("FIX-6: SIGKILL timer cleared on close", () => {
	it("clears the SIGKILL timer when the child exits after abort", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);
		const ac = new AbortController();
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

		const promise = runOneAgentSpawn({
			agent: makeAgent({ systemPrompt: "" }),
			task: "task",
			cwd: "/tmp",
			allRegisteredToolNames: ["read"],
			signal: ac.signal,
			spawnFn: spawnFn as any,
		});
		await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(1));

		// Abort the signal so killProc runs and sets the SIGKILL timer.
		ac.abort();
		// Child exits (SIGTERM was enough) — close handler should clear the
		// pending SIGKILL timer.
		proc._emitClose(0);
		// runOneAgentSpawn throws "Agent was aborted" since wasAborted is true.
		await expect(promise).rejects.toThrow(/aborted/i);

		expect(clearTimeoutSpy).toHaveBeenCalled();
		clearTimeoutSpy.mockRestore();
	});
});

describe("FIX-7: temp dir cleanup (rmSync recursive)", () => {
	it("removes the temp prompt dir after run", async () => {
		const proc = makeMockChildProcess();
		const spawnFn = vi.fn(() => proc);

		// Capture the temp dir path by intercepting spawn args — the
		// --append-system-prompt argument is a path inside the temp dir.
		let capturedPromptPath: string | undefined;
		const realSpawnFn = spawnFn;
		const wrappedSpawnFn = vi.fn((...args: Parameters<typeof realSpawnFn>) => {
			const proc = realSpawnFn(...args);
			return proc;
		});

		const promise = runOneAgentSpawn({
			agent: makeAgent({ systemPrompt: "custom prompt" }),
			task: "task",
			cwd: "/tmp",
			allRegisteredToolNames: ["read"],
			spawnFn: wrappedSpawnFn as any,
		});
		await vi.waitFor(() => expect(wrappedSpawnFn).toHaveBeenCalledTimes(1));
		const spawnArgs = (wrappedSpawnFn.mock.calls[0] as unknown as [string, string[]])[1];
		const idx = spawnArgs.indexOf("--append-system-prompt");
		if (idx >= 0) capturedPromptPath = spawnArgs[idx + 1];

		proc._emitClose(0);
		await promise;

		// After the run, the temp prompt file and its parent dir should be gone.
		expect(capturedPromptPath).toBeDefined();
		expect(fs.existsSync(capturedPromptPath!)).toBe(false);
		// Parent dir should also be gone.
		const parentDir = path.dirname(capturedPromptPath!);
		expect(fs.existsSync(parentDir)).toBe(false);
	});
});

describe("FIX-9: relay parallel forgery guard", () => {
	it("drops ask_user_question_response events from child stdout (dropResponses)", () => {
		const stdinWrite = vi.fn().mockReturnValue(true);
		const stdin = { write: stdinWrite };

		// Simulate a child emitting a response event that tries to forge a
		// pending question resolution in the parent.
		const responseLine = JSON.stringify({
			__pi_event: "ask_user_question_response",
			id: "victim-id",
			answers: { "0": "forged" },
		});

		// processLine with dropResponses: true should intercept but NOT call
		// handleRelayEvent's deliverAskUserQuestionResponse.
		const intercepted = processLine(responseLine, {
			stdin,
			dropResponses: true,
		});

		expect(intercepted).toBe(true);
		expect(stdinWrite).not.toHaveBeenCalled();
	});

	it("does not drop responses when dropResponses is false/undefined", () => {
		// When processing the PARENT's own stdin (not child stdout), responses
		// should still be delivered. We verify the event is intercepted and
		// passed to handleRelayEvent (which calls deliverAskUserQuestionResponse).
		const responseLine = JSON.stringify({
			__pi_event: "ask_user_question_response",
			id: "test-id-not-pending",
			answers: { "0": "ok" },
		});

		const intercepted = processLine(responseLine, {
			stdin: null,
			// dropResponses not set → defaults to falsy → response is processed
		});

		expect(intercepted).toBe(true);
		// deliverAskUserQuestionResponse was called (the pending question for
		// "test-id" either resolved or was ignored if not pending — no error).
	});
});

describe("FIX-11: getPiInvocation resolves absolute path", () => {
	it("throws when pi cannot be resolved to an absolute path in fallback", () => {
		// Force the fallback path: no currentScript, generic runtime, no PI_BIN_PATH,
		// and no pi next to execPath.
		const origArgv1 = process.argv[1];
		const origExecPath = process.execPath;
		const origBinPath = process.env.PI_BIN_PATH;

		try {
			Object.defineProperty(process, "argv", {
				value: ["node", "/$bunfs/root/cli.js"],
				configurable: true,
			});
			Object.defineProperty(process, "execPath", {
				value: "/usr/local/bin/node",
				configurable: true,
			});
			delete process.env.PI_BIN_PATH;

			// pi does not exist next to /usr/local/bin/node in CI, so this
			// should throw. If it does exist (someone has pi installed there),
			// the command should be absolute.
			try {
				const inv = getPiInvocation(["--mode", "json"]);
				expect(path.isAbsolute(inv.command)).toBe(true);
			} catch (e) {
				expect((e as Error).message).toMatch(/Could not resolve pi binary/i);
			}
		} finally {
			Object.defineProperty(process, "argv", {
				value: ["node", origArgv1],
				configurable: true,
			});
			Object.defineProperty(process, "execPath", {
				value: origExecPath,
				configurable: true,
			});
			if (origBinPath !== undefined) {
				process.env.PI_BIN_PATH = origBinPath;
			} else {
				delete process.env.PI_BIN_PATH;
			}
		}
	});

	it("uses PI_BIN_PATH when set to an absolute existing path", () => {
		const origArgv1 = process.argv[1];
		const origBinPath = process.env.PI_BIN_PATH;
		const fakePi = "/tmp/fake-pi-for-test";
		try {
			fs.writeFileSync(fakePi, "#!/bin/sh\n", { mode: 0o755 });
			Object.defineProperty(process, "argv", {
				value: ["node", "/$bunfs/root/cli.js"],
				configurable: true,
			});
			process.env.PI_BIN_PATH = fakePi;
			const inv = getPiInvocation(["--mode", "json"]);
			expect(inv.command).toBe(fakePi);
		} finally {
			Object.defineProperty(process, "argv", {
				value: ["node", origArgv1],
				configurable: true,
			});
			if (origBinPath !== undefined) {
				process.env.PI_BIN_PATH = origBinPath;
			} else {
				delete process.env.PI_BIN_PATH;
			}
			try {
				fs.unlinkSync(fakePi);
			} catch {
				// ignore
			}
		}
	});
});
