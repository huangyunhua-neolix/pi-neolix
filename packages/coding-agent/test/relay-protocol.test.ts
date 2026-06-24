import { describe, expect, it } from "vitest";
import { decodeLine, encodeEvent, newEventId, type PiEvent } from "../src/core/tools/relay-protocol.ts";

describe("relay-protocol", () => {
	describe("encodeEvent", () => {
		it("produces NDJSON line terminated with newline", () => {
			const evt: PiEvent = {
				__pi_event: "ask_user_question",
				id: "abc-123",
				questions: [{ prompt: "Continue?" }],
			};
			const out = encodeEvent(evt);
			expect(out.endsWith("\n")).toBe(true);
			const parsed = JSON.parse(out);
			expect(parsed.__pi_event).toBe("ask_user_question");
			expect(parsed.id).toBe("abc-123");
			expect(parsed.questions).toEqual([{ prompt: "Continue?" }]);
		});

		it("encodes ask_user_question_response with answers object", () => {
			const evt: PiEvent = {
				__pi_event: "ask_user_question_response",
				id: "resp-1",
				answers: { q1: "yes" },
			};
			const out = encodeEvent(evt);
			expect(JSON.parse(out).answers).toEqual({ q1: "yes" });
		});
	});

	describe("decodeLine", () => {
		it("round-trips encode then decode", () => {
			const evt: PiEvent = {
				__pi_event: "ask_user_question",
				id: newEventId(),
				questions: [{ prompt: "Pick one", choices: ["a", "b"] }],
			};
			const encoded = encodeEvent(evt);
			const decoded = decodeLine(encoded);
			expect(decoded).toEqual(evt);
		});

		it("decodes a line without trailing newline", () => {
			const line = JSON.stringify({
				__pi_event: "ask_user_question_response",
				id: "r-9",
				answers: { q: "no" },
			});
			const decoded = decodeLine(line);
			expect(decoded?.__pi_event).toBe("ask_user_question_response");
			expect(decoded?.id).toBe("r-9");
		});

		it("returns null for malformed JSON", () => {
			expect(decodeLine("{not valid json")).toBeNull();
			expect(decodeLine("")).toBeNull();
		});

		it("returns null for non-pi-event line", () => {
			const plain = JSON.stringify({ type: "message_end" });
			expect(decodeLine(plain)).toBeNull();
		});

		it("returns null for unknown __pi_event type", () => {
			const unknown = JSON.stringify({
				__pi_event: "totally_unknown_event",
				id: "x",
			});
			expect(decodeLine(unknown)).toBeNull();
		});

		it("returns null when id field is missing", () => {
			const noId = JSON.stringify({
				__pi_event: "ask_user_question",
				questions: [],
			});
			expect(decodeLine(noId)).toBeNull();
		});
	});

	describe("newEventId", () => {
		it("produces unique uuid-like strings", () => {
			const a = newEventId();
			const b = newEventId();
			expect(a).not.toBe(b);
			expect(a.length).toBeGreaterThan(10);
			// UUID v4 shape: 8-4-4-4-12
			expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		});

		it("correlates an encoded event with its decoded form by id", () => {
			const id = newEventId();
			const evt: PiEvent = {
				__pi_event: "ask_user_question",
				id,
				questions: [],
			};
			const decoded = decodeLine(encodeEvent(evt));
			expect(decoded?.id).toBe(id);
		});
	});
});
