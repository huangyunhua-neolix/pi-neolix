/**
 * Agent tool — internalized subagent dispatch.
 *
 * Spawns a child `pi` process with an isolated context window, giving it a
 * subset of the parent's tools and a custom system prompt. Replaces the
 * extension-based subagent with a core tool that supports:
 *
 *   - Single: { subagent_type: "name", prompt: "..." }  (or { agent, task })
 *   - Parallel: { tasks: [{ subagent_type, prompt }, ...] }
 *   - Chain: { chain: [{ subagent_type, prompt }, ...] }
 *
 * Key differences from the old extension subagent:
 *   - stdio is `["pipe","pipe","pipe"]` (not "ignore") so the child can relay
 *     `__pi_event` lines back (e.g. AskUserQuestion in JSON mode).
 *   - `processLine` intercepts `__pi_event` lines before normal message
 *     processing and routes them to `handleRelayEvent`.
 *   - `resolveToolsArg` treats `agent.tools === undefined` as a wildcard
 *     (all registered tools), matching freecode's hasWildcard semantics.
 *   - When no subagent_type is provided, falls back to a synthesized
 *     "general-purpose" agent config instead of erroring.
 *
 * Registration into the tool index is handled by t-9, not here.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentConfig } from "./agent-discovery.ts";
import { type AgentScope, discoverAgents, subtractDisallowed } from "./agent-discovery.ts";
import { awaitAskUserQuestionResponse, deliverAskUserQuestionResponse } from "./ask-user-question.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { decodeLine, encodeEvent, type PiEvent } from "./relay-protocol.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const AGENT_TOOL_NAME = "Agent";

/**
 * stdio configuration for spawned agent processes.
 *
 * `["pipe","pipe","pipe"]` is required so the parent can:
 *   - read `__pi_event` NDJSON lines from the child's stdout
 *   - write `ask_user_question_response` events to the child's stdin
 *
 * The old extension subagent used `["ignore","pipe","pipe"]` which made
 * relay impossible — the child's AskUserQuestion tool had no stdin to read
 * responses from.
 */
export const AGENT_SPAWN_STDIO: readonly "pipe"[] = ["pipe", "pipe", "pipe"] as const;

/**
 * Synthesize a "general-purpose" agent config when the caller omits
 * subagent_type. This is the fork-fallback: instead of erroring, we create
 * a minimal config with wildcard tools (undefined → all registered) and a
 * generic system prompt. The child pi process inherits all parent tools
 * and runs with the default system prompt augmented by this append.
 */
export function makeGeneralPurposeAgent(_allToolNames: string[]): AgentConfig {
	return {
		name: "general-purpose",
		description: "A general-purpose assistant for delegated tasks.",
		tools: undefined,
		systemPrompt: "You are a general-purpose assistant. Complete the task to the best of your ability.",
		source: "user",
		filePath: "",
	};
}

/**
 * Resolve the `--tools` argument value for a spawned agent.
 *
 * Wildcard semantics (matching freecode hasWildcard):
 *   - `agent.tools === undefined` → all registered tool names joined by ","
 *     (the child inherits the full tool set, minus any disallowedTools).
 *   - `agent.tools` is an array (including empty `[]`) → the array after
 *     subtracting disallowedTools, joined by ",". An empty array produces
 *     `""` which is fail-safe: the child runs with NO tools rather than
 *     silently inheriting full bash+write (privilege expansion of a
 *     restricted agent).
 *
 * Returns the string to pass to `--tools`, or `undefined` if no tools should
 * be passed (currently never returns undefined — always returns a string).
 */
export function resolveToolsArg(agent: AgentConfig, allRegisteredToolNames: string[]): string | undefined {
	const disallowed = agent.disallowedTools ?? [];

	if (agent.tools === undefined) {
		// Wildcard: all registered tools, minus disallowed
		const resolved = subtractDisallowed(allRegisteredToolNames, disallowed);
		return (resolved ?? []).join(",");
	}

	// Explicit allowlist (including empty []): subtract disallowed, then join.
	// Empty array → "" (fail-safe, child gets no tools).
	const resolved = subtractDisallowed(agent.tools, disallowed);
	return (resolved ?? []).join(",");
}

/**
 * Resolve the full argument list for spawning a child pi process.
 *
 * Includes:
 *   - `--mode json --no-session` for structured I/O
 *   - `--tools <resolved>` with wildcard/disallowed semantics
 *   - `--model <modelToUse>` when provided
 *   - `--provider <defaultProvider>` when provided
 *   - `--append-system-prompt <tmpPromptPath>` when provided
 *
 * The caller appends the task prompt as a positional argument.
 */
export function resolveSpawnArgs(opts: {
	agent: AgentConfig;
	modelToUse?: string;
	defaultProvider?: string;
	allRegisteredToolNames: string[];
	tmpPromptPath?: string;
}): string[] {
	const { agent, modelToUse, defaultProvider, allRegisteredToolNames, tmpPromptPath } = opts;
	const args: string[] = ["--mode", "json", "--no-session"];

	if (modelToUse) {
		args.push("--model", modelToUse);
	}
	if (defaultProvider) {
		args.push("--provider", defaultProvider);
	}

	const toolsArg = resolveToolsArg(agent, allRegisteredToolNames);
	if (toolsArg !== undefined) {
		args.push("--tools", toolsArg);
	}

	if (tmpPromptPath && agent.systemPrompt.trim()) {
		args.push("--append-system-prompt", tmpPromptPath);
	}

	return args;
}

/**
 * Handle a decoded relay event from the child's stdout.
 *
 * - `ask_user_question`: The child is requesting user input. If
 *   `onAskUserQuestion` is provided, it is called (async) and the response
 *   is written back to stdin. If not provided and `PI_RELAY_AUTO_PICK=1` is
 *   set (headless tests only), a stub response (first option for each
 *   question) is written. Otherwise, no response is written — the child will
 *   time out. In production, `execute()` always provides `onAskUserQuestion`.
 * - `ask_user_question_response`: Delivered to the parent's own pending
 *   question (when the parent is itself a child of another process).
 */
/**
 * Minimal writable-stream interface for relay responses. Real `proc.stdin`
 * (a `net.Socket`) satisfies this; test mocks provide just `{ write }`.
 */
export interface RelayStdin {
	write: (data: string) => boolean;
	once?: (event: string, cb: () => void) => void;
	on?: (event: string, cb: (err: Error) => void) => void;
	removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
}

/**
 * FIX-10: write to a child stdin with backpressure handling.
 *
 * - Checks the return value of `write()`. When `false` (buffer full or child
 *   closed stdin), waits for `'drain'` before resolving (if the stream
 *   supports `once`). Otherwise resolves immediately.
 * - Attaches a one-shot `'error'` listener so a closed/broken pipe doesn't
 *   crash the parent process as an unhandled error.
 *
 * Returns a promise that resolves once the data is either written or the
 * stream has drained.
 */
function writeWithBackpressure(stdin: RelayStdin, data: string): Promise<void> {
	return new Promise<void>((resolve) => {
		const onError = (_err: Error) => {
			stdin.removeListener?.("error", onError as unknown as (...args: unknown[]) => void);
			// Swallow — the child will time out on its own. Logging would be
			// noisy for an expected "child closed stdin" scenario.
			resolve();
		};
		stdin.on?.("error", onError);
		const ok = stdin.write(data);
		if (ok) {
			stdin.removeListener?.("error", onError as unknown as (...args: unknown[]) => void);
			resolve();
		} else if (stdin.once) {
			stdin.once("drain", () => {
				stdin.removeListener?.("error", onError as unknown as (...args: unknown[]) => void);
				resolve();
			});
		} else {
			// No drain event available (test mock) — resolve immediately.
			stdin.removeListener?.("error", onError as unknown as (...args: unknown[]) => void);
			resolve();
		}
	});
}

export function handleRelayEvent(
	evt: PiEvent,
	stdin: RelayStdin | null,
	onAskUserQuestion?: (evt: { id: string; questions: unknown[] }) => Promise<Record<string, unknown>>,
): void {
	if (evt.__pi_event === "ask_user_question") {
		if (onAskUserQuestion) {
			onAskUserQuestion({ id: evt.id, questions: evt.questions })
				.then(async (answers) => {
					if (stdin) {
						await writeWithBackpressure(
							stdin,
							encodeEvent({
								__pi_event: "ask_user_question_response",
								id: evt.id,
								answers,
							}),
						);
					}
				})
				.catch(() => {
					// Silently swallow — child will time out or error on its own.
				});
			return;
		}

		// Stub: only for headless tests (PI_RELAY_AUTO_PICK=1). Picks the first
		// option for each question. Production code must always provide
		// onAskUserQuestion via execute().
		if (process.env.PI_RELAY_AUTO_PICK === "1") {
			const stubAnswers: Record<string, unknown> = {};
			const questions = Array.isArray(evt.questions) ? evt.questions : [];
			for (let i = 0; i < questions.length; i++) {
				const q = questions[i] as Record<string, unknown> | undefined;
				if (!q || typeof q !== "object") continue;
				const options = Array.isArray(q.options) ? q.options : [];
				if (options.length > 0) {
					const first = options[0] as Record<string, unknown> | undefined;
					if (first && typeof first.label === "string") {
						stubAnswers[String(i)] = first.label;
					}
				}
			}
			if (stdin) {
				void writeWithBackpressure(
					stdin,
					encodeEvent({
						__pi_event: "ask_user_question_response",
						id: evt.id,
						answers: stubAnswers,
					}),
				);
			}
			return;
		}

		// No handler and no auto-pick: child will time out. This is a
		// configuration error — execute() should always provide onAskUserQuestion.
		return;
	}

	if (evt.__pi_event === "ask_user_question_response") {
		deliverAskUserQuestionResponse(evt.id, evt.answers);
		return;
	}
}

export interface ProcessLineContext {
	stdin: RelayStdin | null;
	onMessageEnd?: (msg: Message) => void;
	onToolResultEnd?: (msg: Message) => void;
	onAskUserQuestion?: (evt: { id: string; questions: unknown[] }) => Promise<Record<string, unknown>>;
	/**
	 * FIX-9: when true, `ask_user_question_response` events decoded from the
	 * stream are silently dropped instead of being forwarded to
	 * `deliverAskUserQuestionResponse`. This is set to `true` when processing
	 * CHILD stdout (in `runOneAgentSpawn`) so a malicious or buggy child in
	 * parallel mode cannot short-circuit a sibling's pending question by
	 * emitting a response event with a foreign id. The parent's own responses
	 * arrive via stdin (written by the grandparent), not via child stdout.
	 */
	dropResponses?: boolean;
}

/**
 * Process a single line of child stdout.
 *
 * Returns `true` if the line was a relay event (`__pi_event`) and was
 * intercepted — the caller should NOT process it as a normal message.
 * Returns `false` for all other lines (normal JSON, empty, non-JSON).
 *
 * For non-intercepted lines, this function parses the JSON and dispatches
 * to `onMessageEnd` / `onToolResultEnd` callbacks.
 */
export function processLine(line: string, ctx: ProcessLineContext): boolean {
	if (!line || !line.trim()) {
		return false;
	}

	// Relay event interception: check before normal JSON message processing.
	const evt = decodeLine(line);
	if (evt) {
		// FIX-9: a child emitting `ask_user_question_response` on its stdout
		// can never legitimately resolve the parent's pending question.
		// Responses are written to stdin by the grandparent, not emitted on
		// stdout. Drop these events to prevent parallel-mode forgery.
		if (evt.__pi_event === "ask_user_question_response" && ctx.dropResponses) {
			return true;
		}
		handleRelayEvent(evt, ctx.stdin, ctx.onAskUserQuestion);
		return true;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return false;
	}

	if (typeof parsed !== "object" || parsed === null) {
		return false;
	}

	const obj = parsed as Record<string, unknown>;

	if (obj.type === "message_end" && obj.message && ctx.onMessageEnd) {
		ctx.onMessageEnd(obj.message as Message);
		return false;
	}

	if (obj.type === "tool_result_end" && obj.message && ctx.onToolResultEnd) {
		ctx.onToolResultEnd(obj.message as Message);
		return false;
	}

	return false;
}

/**
 * Spawn function type — injectable for testing.
 *
 * Default implementation is `node:child_process.spawn`. Tests pass a mock
 * to verify argv / stdio / processLine wiring without spawning a real `pi`
 * subprocess.
 */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Resolve the `pi` invocation (command + argv prefix) for spawning a child
 * agent process. Mirrors the old extension's getPiInvocation logic: when pi
 * is running under a generic runtime (node/bun), invoke `pi` directly so the
 * child resolves via PATH; otherwise re-run the current script with the
 * current executable.
 *
 * FIX-11: the previous fallback `{ command: "pi" }` spawned via PATH, which
 * could execute a malicious `pi` binary planted earlier in PATH. Now:
 *   - Try `PI_BIN_PATH` env var (absolute path).
 *   - Try `pi` next to `process.execPath` (e.g. /usr/local/bin/pi next to node).
 *   - If neither resolves to an absolute path that exists, throw rather than
 *     blindly spawning a bare name.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		// Compiled binary (e.g. bun build --compile): process.execPath IS pi.
		return { command: process.execPath, args };
	}

	// Generic runtime fallback: resolve pi to an absolute path.
	const piBinPath = process.env.PI_BIN_PATH;
	if (piBinPath && path.isAbsolute(piBinPath) && fs.existsSync(piBinPath)) {
		return { command: piBinPath, args };
	}
	const piCandidate = path.join(path.dirname(process.execPath), "pi");
	if (fs.existsSync(piCandidate)) {
		return { command: piCandidate, args };
	}
	throw new Error(
		"Could not resolve pi binary to an absolute path. " +
			"Set PI_BIN_PATH or install pi alongside the runtime. " +
			"Refusing to spawn via PATH (security: PATH spoofing risk).",
	);
}

/**
 * Write the agent's system prompt to a temp file and return the path. The
 * child pi receives it via `--append-system-prompt`.
 */
async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{
	dir: string;
	filePath: string;
}> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export interface RunOneAgentSpawnOptions {
	agent: AgentConfig;
	task: string;
	cwd: string;
	allRegisteredToolNames: string[];
	modelToUse?: string;
	defaultProvider?: string;
	signal?: AbortSignal;
	onMessageEnd?: (msg: Message) => void;
	onAskUserQuestion?: (evt: { id: string; questions: unknown[] }) => Promise<Record<string, unknown>>;
	step?: number;
	spawnFn?: SpawnFn;
}

export interface SingleSpawnResult {
	agent: string;
	agentSource: AgentConfig["source"];
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	step?: number;
}

/**
 * Spawn a single child `pi` process for one agent invocation, drain its
 * stdout through `processLine`, and return the collected messages + exit
 * code. Used by single, parallel, and chain modes.
 */
export async function runOneAgentSpawn(opts: RunOneAgentSpawnOptions): Promise<SingleSpawnResult> {
	const {
		agent,
		task,
		cwd,
		allRegisteredToolNames,
		modelToUse,
		defaultProvider,
		signal,
		onMessageEnd,
		onAskUserQuestion,
		step,
		spawnFn: injectSpawnFn,
	} = opts;

	const spawnFn: SpawnFn = injectSpawnFn ?? (spawn as SpawnFn);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | undefined;

	const result: SingleSpawnResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		step,
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}

		const argv = resolveSpawnArgs({
			agent,
			modelToUse,
			defaultProvider,
			allRegisteredToolNames,
			tmpPromptPath,
		});
		argv.push(`Task: ${task}`);

		const invocation = getPiInvocation(argv);
		let buffer = "";
		let stderrBuffer = "";
		let wasAborted = false;

		// FIX-5: cap stdout/stderr buffers at 1 MB to prevent OOM on a child
		// that emits a single very long line with no newline. Once the cap is
		// exceeded we drop further data and mark the result as truncated.
		const MAX_BUFFER_BYTES = 1 * 1024 * 1024;
		let stdoutCapped = false;
		let stderrCapped = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawnFn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: [...AGENT_SPAWN_STDIO] as SpawnOptions["stdio"],
			});

			const stdin = proc.stdin;
			const processCtx: ProcessLineContext = {
				stdin,
				onMessageEnd: (msg) => {
					result.messages.push(msg);
					onMessageEnd?.(msg);
				},
				onToolResultEnd: (msg) => {
					result.messages.push(msg);
				},
				onAskUserQuestion,
				// FIX-9: child stdout response events must not resolve the
				// parent's own pending questions (parallel-forgery guard).
				dropResponses: true,
			};

			proc.stdout?.on("data", (data: Buffer) => {
				if (stdoutCapped) return;
				buffer += data.toString();
				if (buffer.length > MAX_BUFFER_BYTES) {
					buffer = buffer.slice(0, MAX_BUFFER_BYTES);
					stdoutCapped = true;
					result.stderr += `\n[agent-tool] stdout truncated at ${MAX_BUFFER_BYTES} bytes\n`;
				}
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					processLine(line, processCtx);
				}
			});

			proc.stderr?.on("data", (data: Buffer) => {
				if (stderrCapped) return;
				stderrBuffer += data.toString();
				if (stderrBuffer.length > MAX_BUFFER_BYTES) {
					stderrBuffer = stderrBuffer.slice(0, MAX_BUFFER_BYTES);
					stderrCapped = true;
					stderrBuffer += `\n[agent-tool] stderr truncated at ${MAX_BUFFER_BYTES} bytes\n`;
				}
			});

			// FIX-6: capture the SIGKILL timer so it can be cleared on clean
			// exit, preventing a stale timer from firing on a recycled PID.
			let sigkillTimer: NodeJS.Timeout | null = null;

			proc.on("close", (code) => {
				if (sigkillTimer) {
					clearTimeout(sigkillTimer);
					sigkillTimer = null;
				}
				if (buffer.trim()) processLine(buffer, processCtx);
				resolve(code ?? 0);
			});

			proc.on("error", (err: NodeJS.ErrnoException) => {
				if (sigkillTimer) {
					clearTimeout(sigkillTimer);
					sigkillTimer = null;
				}
				// Preserve the spawn error message so callers see WHY it failed.
				result.stderr += `\n[agent-tool] spawn error: ${err.message}\n`;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					sigkillTimer = setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
					// Don't keep the event loop alive solely for this timer.
					sigkillTimer.unref();
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.stderr = stderrBuffer + (result.stderr ? result.stderr : "");

		result.exitCode = exitCode;
		if (wasAborted) throw new Error("Agent was aborted");
		return result;
	} finally {
		// FIX-7: use fs.rmSync recursive+force so partial files or extra
		// entries inside the temp dir don't cause ENOTEMPTY leaks.
		if (tmpPromptDir) {
			fs.rmSync(tmpPromptDir, { recursive: true, force: true });
		}
	}
}

function getFinalAssistantOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedSpawnResult(result: SingleSpawnResult): boolean {
	return result.exitCode !== 0;
}

function getResultOutput(result: SingleSpawnResult): string {
	if (isFailedSpawnResult(result)) {
		return result.stderr || getFinalAssistantOutput(result.messages) || "(no output)";
	}
	return getFinalAssistantOutput(result.messages) || "(no output)";
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Read defaultProvider from settings.json (~/.pi/settings.json). The child
 * pi's model resolver is pinned to this provider via `--provider`.
 */
function readDefaultProvider(): string | undefined {
	try {
		const settingsPath = path.join(getAgentDir(), "settings.json");
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed.defaultProvider && typeof parsed.defaultProvider === "string") {
			return parsed.defaultProvider;
		}
	} catch {
		// ignore — no settings.json or invalid JSON
	}
	return undefined;
}

const V2 = process.env.PI_AGENT_RUNTIME_V2 === "1";

const BASE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const V2_TOOL_NAMES = ["Agent", "Skill", "AskUserQuestion", "WebFetch", "WebSearch"];

/**
 * Return the list of all registered tool names for the current runtime
 * (matches the set produced by createAllToolDefinitions in index.ts).
 *
 * Used by the Agent tool's execute() to resolve `--tools` for the spawned
 * child. We compute this locally rather than importing from index.ts to
 * avoid a circular import (index.ts imports from agent-tool.ts).
 */
function getAllRegisteredToolNames(): string[] {
	return V2 ? [...BASE_TOOL_NAMES, ...V2_TOOL_NAMES] : BASE_TOOL_NAMES;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	subagent_type: Type.Optional(Type.String({ description: "Name of the agent to invoke" })),
	agent: Type.Optional(Type.String({ description: "Alias for subagent_type (legacy)" })),
	prompt: Type.Optional(Type.String({ description: "Task to delegate to the agent" })),
	task: Type.Optional(Type.String({ description: "Alias for prompt (legacy)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	subagent_type: Type.Optional(Type.String({ description: "Name of the agent to invoke" })),
	agent: Type.Optional(Type.String({ description: "Alias for subagent_type (legacy)" })),
	prompt: Type.Optional(Type.String({ description: "Task with optional {previous} placeholder for prior output" })),
	task: Type.Optional(Type.String({ description: "Alias for prompt (legacy)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user".',
	default: "user",
});

const agentSchema = Type.Object({
	subagent_type: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (single mode). Omit for general-purpose fallback." }),
	),
	agent: Type.Optional(
		Type.String({ description: "Alias for subagent_type (legacy). subagent_type takes priority." }),
	),
	prompt: Type.Optional(
		Type.String({ description: "Task to delegate (single mode). prompt takes priority over task." }),
	),
	task: Type.Optional(Type.String({ description: "Alias for prompt (legacy)." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of task items for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of task items for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export type AgentToolInput = Static<typeof agentSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface AgentToolDefinitionOptions {
	/**
	 * Injectable spawn function for testing. Defaults to
	 * `node:child_process.spawn`.
	 */
	spawnFn?: SpawnFn;
}

export function createAgentToolDefinition(
	_cwd: string,
	options?: AgentToolDefinitionOptions,
): ToolDefinition<typeof agentSchema, unknown> {
	const spawnFn = options?.spawnFn;
	return {
		name: AGENT_TOOL_NAME,
		label: "Agent",
		description: [
			"Delegate tasks to specialized subagents with isolated context windows.",
			"Modes: single (subagent_type + prompt), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Omit subagent_type to use a general-purpose fallback agent.",
		].join(" "),
		promptSnippet: "Delegate tasks to specialized subagents",
		parameters: agentSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";

			// Y2: Prefer ctx.getActiveTools() (real runtime tool list) when
			// available. ExtensionContext does not expose this method, but
			// ExtensionCommandContext and test mocks do — duck-type to detect.
			// Fall back to the hardcoded list otherwise.
			const ctxAny = ctx as unknown as { getActiveTools?: () => string[] };
			const ctxToolNames = typeof ctxAny.getActiveTools === "function" ? (ctxAny.getActiveTools() as string[]) : [];
			const allRegisteredToolNames = ctxToolNames.length > 0 ? ctxToolNames : getAllRegisteredToolNames();

			const defaultProvider = readDefaultProvider();
			const modelToUse: string | undefined = undefined;

			// R1: Construct onAskUserQuestion callback based on available UI.
			// - ctx.hasUI && ctx.ui: render each question via ctx.ui.select (TUI).
			// - No TUI but stdin is a pipe (spawned child): re-emit event to
			//   process.stdout so the grandparent can handle it, then await the
			//   response via deliverAskUserQuestionResponse.
			// - Neither: throw — child will time out. This is the only legitimate
			//   error path; silent degrade is forbidden (fc-spec-writer depends on
			//   asking questions).
			let onAskUserQuestion:
				| ((evt: { id: string; questions: unknown[] }) => Promise<Record<string, unknown>>)
				| undefined;

			if (ctx.hasUI && ctx.ui) {
				onAskUserQuestion = async (evt) => {
					const answers: Record<string, unknown> = {};
					const questions = Array.isArray(evt.questions) ? evt.questions : [];
					for (let i = 0; i < questions.length; i++) {
						const q = questions[i] as
							| { question?: string; header?: string; options: { label: string }[] }
							| undefined;
						if (!q || !Array.isArray(q.options)) continue;
						const title = q.header ?? q.question ?? "Select an option";
						const labels = q.options.map((o) => o.label);
						const selected = await ctx.ui.select(title, labels);
						if (selected === undefined) break;
						answers[String(i)] = selected;
					}
					return answers;
				};
			} else if (!process.stdin.isTTY) {
				// Bubble-up: re-emit to stdout, wait for grandparent's response.
				onAskUserQuestion = async (evt) => {
					process.stdout.write(
						encodeEvent({
							__pi_event: "ask_user_question",
							id: evt.id,
							questions: evt.questions,
						}),
					);
					return awaitAskUserQuestionResponse(evt.id);
				};
			}
			// else: no TUI and stdin is TTY — no handler. Child will time out.
			// This is the "neither TUI nor bubble-up" error path.

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.prompt || params.task);

			if (!hasChain && !hasTasks && !hasSingle) {
				return {
					content: [
						{
							type: "text",
							text: "Invalid parameters. Provide subagent_type + prompt, tasks array, or chain array.",
						},
					],
					details: undefined,
				};
			}

			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			// Y1: Omitted name → general-purpose fork fallback (correct).
			// Name provided but not found → throw with available agent list.
			// Previously this silently fell back to general-purpose, masking
			// typos and misconfiguration.
			const resolveAgent = (name?: string): AgentConfig => {
				if (!name) return makeGeneralPurposeAgent(allRegisteredToolNames);
				const found = agents.find((a) => a.name === name);
				if (found) return found;
				const available = agents.map((a) => a.name).filter(Boolean);
				throw new Error(
					`Unknown agent: ${name}. Available agents: ${available.length > 0 ? available.join(", ") : "(none)"}`,
				);
			};

			const spawnOpts = (
				agentCfg: AgentConfig,
				task: string,
				cwd: string,
				step?: number,
			): RunOneAgentSpawnOptions => ({
				agent: agentCfg,
				task,
				cwd,
				allRegisteredToolNames,
				modelToUse: modelToUse ?? agentCfg.model,
				defaultProvider,
				signal,
				onAskUserQuestion,
				step,
				spawnFn,
			});

			// Chain mode: sequential, {previous} placeholder substituted.
			if (hasChain && params.chain) {
				const results: SingleSpawnResult[] = [];
				let previousOutput = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskText = (step.prompt ?? step.task ?? "").replace(/\{previous\}/g, previousOutput);
					const agentCfg = resolveAgent(step.subagent_type ?? step.agent);
					const result = await runOneAgentSpawn(spawnOpts(agentCfg, taskText, step.cwd ?? ctx.cwd, i + 1));
					results.push(result);
					if (isFailedSpawnResult(result)) {
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${agentCfg.name}): ${getResultOutput(result)}`,
								},
							],
							details: { mode: "chain", results },
							isError: true,
						};
					}
					previousOutput = getFinalAssistantOutput(result.messages);
				}
				return {
					content: [
						{
							type: "text",
							text: getFinalAssistantOutput(results[results.length - 1].messages) || "(no output)",
						},
					],
					details: { mode: "chain", results },
				};
			}

			// Parallel mode: bounded concurrency.
			if (hasTasks && params.tasks) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: { mode: "parallel", results: [] },
					};
				}
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const agentCfg = resolveAgent(t.subagent_type ?? t.agent);
					const taskText = t.prompt ?? t.task ?? "";
					return runOneAgentSpawn(spawnOpts(agentCfg, taskText, t.cwd ?? ctx.cwd, index + 1));
				});
				const successCount = results.filter((r) => !isFailedSpawnResult(r)).length;
				const summaries = results.map((r) => {
					const output = getResultOutput(r);
					const status = isFailedSpawnResult(r) ? "failed" : "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: { mode: "parallel", results },
				};
			}

			// Single mode.
			const agentCfg = resolveAgent(params.subagent_type ?? params.agent);
			const taskText = params.prompt ?? params.task ?? "";
			const result = await runOneAgentSpawn(spawnOpts(agentCfg, taskText, params.cwd ?? ctx.cwd));
			if (isFailedSpawnResult(result)) {
				return {
					content: [{ type: "text", text: `Agent failed: ${getResultOutput(result)}` }],
					details: { mode: "single", results: [result] },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalAssistantOutput(result.messages) || "(no output)" }],
				details: { mode: "single", results: [result] },
			};
		},

		renderCall(args, _themeArg, _context) {
			const scope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("Agent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const name = step.subagent_type ?? step.agent ?? "general-purpose";
					const promptText = step.prompt ?? step.task ?? "";
					const cleanTask = promptText.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", name) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("Agent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const name = t.subagent_type ?? t.agent ?? "general-purpose";
					const promptText = t.prompt ?? t.task ?? "";
					const preview = promptText.length > 40 ? `${promptText.slice(0, 40)}...` : promptText;
					text += `\n  ${theme.fg("accent", name)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const name = args.subagent_type ?? args.agent ?? "general-purpose";
			const promptText = args.prompt ?? args.task ?? "";
			const preview = promptText ? (promptText.length > 60 ? `${promptText.slice(0, 60)}...` : promptText) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("Agent ")) + theme.fg("accent", name) + theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},
	};
}

export function createAgentTool(cwd: string, options?: AgentToolDefinitionOptions): AgentTool<typeof agentSchema> {
	return wrapToolDefinition(createAgentToolDefinition(cwd, options));
}
