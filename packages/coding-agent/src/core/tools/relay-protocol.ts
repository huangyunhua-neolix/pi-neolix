/**
 * Relay protocol for AskUserQuestion when a child agent runs without TUI.
 *
 * Child process emits `__pi_event` NDJSON lines on stdout; parent decodes,
 * renders the question, and writes the response back on stdin.
 *
 * `__pi_event` is a reserved discriminator that does not collide with pi's
 * json-mode envelope (e.g. `{"type":"message_end",...}`).
 *
 * This module is the pure data layer: encode/decode/id generation only.
 * No IPC piping here.
 */

/**
 * Discriminated union of all relay events.
 *
 * Extend this union when adding new event types; `decodeLine` only accepts
 * events whose `__pi_event` tag is listed here.
 */
export type PiEvent =
	| { __pi_event: "ask_user_question"; id: string; questions: unknown[] }
	| {
			__pi_event: "ask_user_question_response";
			id: string;
			answers: Record<string, unknown>;
	  };

/** Tag set used by `decodeLine` to validate incoming lines. */
const KNOWN_EVENT_TAGS = new Set<string>(["ask_user_question", "ask_user_question_response"]);

/**
 * Encode a `PiEvent` as a single NDJSON line (JSON + "\n").
 *
 * The trailing newline is the line delimiter expected by the parent's
 * line-reader. Callers must not pre-append newlines.
 */
export function encodeEvent(evt: PiEvent): string {
	return JSON.stringify(evt) + "\n";
}

/**
 * Decode a single NDJSON line into a `PiEvent`.
 *
 * Returns `null` when:
 *   - the line is empty or not valid JSON
 *   - the parsed object is not a `__pi_event` line
 *   - the `__pi_event` tag is unknown to this build
 *   - required fields (`id`, plus payload per type) are missing
 *
 * Tolerant by design: callers pipe arbitrary stdout through this and rely
 * on null to mean "not a relay event, pass through".
 */
export function decodeLine(line: string): PiEvent | null {
	if (!line) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}

	const obj = parsed as Record<string, unknown>;
	const tag = obj["__pi_event"];

	if (typeof tag !== "string" || !KNOWN_EVENT_TAGS.has(tag)) {
		return null;
	}

	if (typeof obj["id"] !== "string" || obj["id"].length === 0) {
		return null;
	}

	if (tag === "ask_user_question") {
		if (!Array.isArray(obj["questions"])) {
			return null;
		}
		return {
			__pi_event: "ask_user_question",
			id: obj["id"] as string,
			questions: obj["questions"] as unknown[],
		};
	}

	if (tag === "ask_user_question_response") {
		const answers = obj["answers"];
		if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
			return null;
		}
		return {
			__pi_event: "ask_user_question_response",
			id: obj["id"] as string,
			answers: answers as Record<string, unknown>,
		};
	}

	return null;
}

/**
 * Generate a fresh event id (UUID v4 via `crypto.randomUUID`).
 *
 * Used to correlate an `ask_user_question` with its corresponding
 * `ask_user_question_response`.
 */
export function newEventId(): string {
	return crypto.randomUUID();
}
