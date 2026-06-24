import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { encodeEvent, newEventId } from "./relay-protocol.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

const optionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const questionSchema = Type.Object({
	question: Type.String({ description: "The question to ask" }),
	header: Type.Optional(Type.String({ description: "Optional header for the question" })),
	options: Type.Array(optionSchema, { description: "Options to choose from" }),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selections" })),
});

const askUserQuestionSchema = Type.Object({
	questions: Type.Array(questionSchema, { description: "Questions to ask the user" }),
});

export type AskUserQuestionInput = Static<typeof askUserQuestionSchema>;

interface PendingQuestion {
	resolve: (answers: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

const pendingQuestions = new Map<string, PendingQuestion>();

let _stdinStream: NodeJS.ReadableStream | null = process.stdin;

// FIX-8: per-call `once("end")` accumulates to MaxListeners=10 and leaks.
// Use a single shared "end" listener that fan-outs to all pending questions.
let _stdinEndListenerAttached = false;
const _stdinEndHandlers = new Set<(id: string) => void>();

function _ensureStdinEndListener(): void {
	const stream = _stdinStream;
	if (!stream || _stdinEndListenerAttached) return;
	_stdinEndListenerAttached = true;
	// Raise the ceiling so multiple concurrent AUQ calls don't trip the
	// default 10-listener warning even on other event types.
	if (typeof stream.setMaxListeners === "function") {
		stream.setMaxListeners(Math.max(stream.getMaxListeners?.() ?? 10, 50));
	}
	stream.on("end", () => {
		for (const h of _stdinEndHandlers) {
			for (const id of pendingQuestions.keys()) {
				h(id);
			}
		}
	});
}

export function _setStdinStreamForTesting(stream: NodeJS.ReadableStream | null): void {
	_stdinStream = stream;
	// Reset the shared-listener flag so the new stream gets a fresh listener.
	_stdinEndListenerAttached = false;
	_stdinEndHandlers.clear();
}

export function _clearPendingForTesting(): void {
	for (const [id, pending] of pendingQuestions) {
		pendingQuestions.delete(id);
		pending.reject(new Error("cleared for testing"));
	}
}

/**
 * Deliver a response to a pending AskUserQuestion.
 *
 * Called by the relay handler (agent-tool.ts) when the parent process
 * sends back an `ask_user_question_response` event. Responses with an
 * unknown id are silently ignored.
 */
export function deliverAskUserQuestionResponse(id: string, answers: Record<string, unknown>): void {
	const pending = pendingQuestions.get(id);
	if (pending) {
		pendingQuestions.delete(id);
		pending.resolve(answers);
	}
}

/**
 * Register a pending AskUserQuestion and return a promise that resolves
 * when `deliverAskUserQuestionResponse(id, answers)` is called.
 *
 * Used by:
 *   - The AskUserQuestion tool's own JSON-mode execute (re-emits event to
 *     stdout, then awaits the grandparent's response).
 *   - The Agent tool's bubble-up path (child emits ask_user_question, parent
 *     re-emits to its own stdout, awaits response, forwards to child stdin).
 *
 * Rejects with "stdin EOF" if the parent's stdin closes before a response
 * arrives.
 *
 * R2-13: rejects with "timeout" if no response arrives within
 * `PI_ASK_USER_QUESTION_TIMEOUT_MS` (default 10 minutes). Without this,
 * a parent that neither responds nor closes stdin leaves the child
 * hanging indefinitely.
 */
export function awaitAskUserQuestionResponse(id: string): Promise<Record<string, unknown>> {
	const stdinStream = _stdinStream;

	// R2-13: optional timeout to prevent indefinite hang.
	const timeoutMs = (() => {
		const env = process.env.PI_ASK_USER_QUESTION_TIMEOUT_MS;
		if (env !== undefined && env !== "") {
			const parsed = Number.parseInt(env, 10);
			if (Number.isFinite(parsed) && parsed > 0) return parsed;
		}
		return 10 * 60 * 1000; // 10 minutes default
	})();

	// FIX-8: register on the shared fan-out set instead of per-call once().
	const onStdinEnd = (endId: string) => {
		if (endId !== id) return;
		const pending = pendingQuestions.get(id);
		if (pending) {
			pendingQuestions.delete(id);
			pending.reject(new Error("stdin EOF: parent process closed"));
		}
	};
	if (stdinStream) {
		_stdinEndHandlers.add(onStdinEnd);
		_ensureStdinEndListener();
	}

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => {
			const pending = pendingQuestions.get(id);
			if (pending) {
				pendingQuestions.delete(id);
				pending.reject(new Error(`AskUserQuestion timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);
		// Don't keep the event loop alive solely for this timer.
		timer.unref();
		pendingQuestions.set(id, {
			resolve: (val) => {
				clearTimeout(timer);
				resolve(val);
			},
			reject: (err) => {
				clearTimeout(timer);
				reject(err);
			},
		});
	}).finally(() => {
		_stdinEndHandlers.delete(onStdinEnd);
	});
}

export function createAskUserQuestionToolDefinition(_cwd: string): ToolDefinition<typeof askUserQuestionSchema> {
	return {
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "AskUserQuestion",
		description: "Ask the user a question with selectable options. Use when you need user input to proceed.",
		promptSnippet: "Ask the user questions with selectable options",
		parameters: askUserQuestionSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { questions } = params;

			if (ctx.hasUI && ctx.ui) {
				const answers: Record<string, unknown> = {};
				for (let i = 0; i < questions.length; i++) {
					const q = questions[i];
					const title = q.header ?? q.question;
					const labels = q.options.map((o) => o.label);
					const selected = await ctx.ui.select(title, labels);
					if (selected === undefined) {
						return {
							content: [{ type: "text", text: "User cancelled the question" }],
							details: undefined,
						};
					}
					answers[String(i)] = selected;
				}
				return {
					content: [{ type: "text", text: JSON.stringify(answers) }],
					details: undefined,
				};
			}

			const id = newEventId();
			const event = encodeEvent({
				__pi_event: "ask_user_question",
				id,
				questions: questions as unknown[],
			});
			process.stdout.write(event);

			try {
				const answers = await awaitAskUserQuestionResponse(id);
				return {
					content: [{ type: "text", text: JSON.stringify(answers) }],
					details: undefined,
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${errorMsg}` }],
					details: undefined,
				};
			}
		},

		renderCall(args, _themeArg, _context) {
			const firstQ = Array.isArray(args.questions) && args.questions.length > 0 ? args.questions[0] : undefined;
			const questionText = firstQ?.question ?? "...";
			return new Text(theme.fg("toolTitle", theme.bold("AskUserQuestion ")) + theme.fg("muted", questionText), 0, 0);
		},
	};
}

export function createAskUserQuestionTool(cwd: string): AgentTool<typeof askUserQuestionSchema> {
	return wrapToolDefinition(createAskUserQuestionToolDefinition(cwd));
}
