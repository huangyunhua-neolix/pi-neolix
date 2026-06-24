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

export function _setStdinStreamForTesting(stream: NodeJS.ReadableStream | null): void {
	_stdinStream = stream;
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
 */
export function awaitAskUserQuestionResponse(id: string): Promise<Record<string, unknown>> {
	const stdinStream = _stdinStream;
	const onStdinEnd = () => {
		const pending = pendingQuestions.get(id);
		if (pending) {
			pendingQuestions.delete(id);
			pending.reject(new Error("stdin EOF: parent process closed"));
		}
	};
	if (stdinStream) {
		stdinStream.once("end", onStdinEnd);
	}

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		pendingQuestions.set(id, { resolve, reject });
	}).finally(() => {
		if (stdinStream) {
			stdinStream.removeListener("end", onStdinEnd);
		}
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
