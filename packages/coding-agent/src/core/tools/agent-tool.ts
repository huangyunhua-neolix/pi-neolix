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

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentConfig } from "./agent-discovery.ts";
import { subtractDisallowed } from "./agent-discovery.ts";
import { deliverAskUserQuestionResponse } from "./ask-user-question.ts";
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
 * - `ask_user_question`: The child is requesting user input. In this skeleton,
 *   if `onAskUserQuestion` is provided, it is called (async) and the response
 *   is written back to stdin. If not provided, a stub response (first option
 *   for each question) is written immediately. Real TUI presentation is t-9.
 * - `ask_user_question_response`: Delivered to the parent's own pending
 *   question (when the parent is itself a child of another process).
 */
export function handleRelayEvent(
	evt: PiEvent,
	stdin: { write: (data: string) => boolean } | null,
	onAskUserQuestion?: (evt: { id: string; questions: unknown[] }) => Promise<Record<string, unknown>>,
): void {
	if (evt.__pi_event === "ask_user_question") {
		if (onAskUserQuestion) {
			onAskUserQuestion({ id: evt.id, questions: evt.questions })
				.then((answers) => {
					if (stdin) {
						stdin.write(
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

		// Stub: pick the first option for each question (index-based answers).
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
			stdin.write(
				encodeEvent({
					__pi_event: "ask_user_question_response",
					id: evt.id,
					answers: stubAnswers,
				}),
			);
		}
		return;
	}

	if (evt.__pi_event === "ask_user_question_response") {
		deliverAskUserQuestionResponse(evt.id, evt.answers);
		return;
	}
}

export interface ProcessLineContext {
	stdin: { write: (data: string) => boolean } | null;
	onMessageEnd?: (msg: Message) => void;
	onToolResultEnd?: (msg: Message) => void;
	onAskUserQuestion?: (evt: { id: string; questions: unknown[] }) => Promise<Record<string, unknown>>;
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

export function createAgentToolDefinition(cwd: string): ToolDefinition<typeof agentSchema, unknown> {
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

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// The full spawn loop (runSingleAgent) is not implemented here — it
			// lives in the execute path that t-9 wires up with model registry,
			// settings.json provider detection, and TUI rendering. This stub
			// returns a placeholder so the tool definition is structurally
			// complete and the pure functions (resolveToolsArg, resolveSpawnArgs,
			// processLine) are independently testable.
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.subagent_type || params.agent) && Boolean(params.prompt || params.task);

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

			return {
				content: [
					{
						type: "text",
						text: `Agent tool dispatched (cwd: ${cwd}). Full spawn loop is implemented in the runtime integration layer.`,
					},
				],
				details: undefined,
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

export function createAgentTool(cwd: string): AgentTool<any> {
	return wrapToolDefinition(createAgentToolDefinition(cwd));
}
