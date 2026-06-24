import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	_clearPendingForTesting,
	_setStdinStreamForTesting,
	ASK_USER_QUESTION_TOOL_NAME,
	createAskUserQuestionToolDefinition,
	deliverAskUserQuestionResponse,
} from "../src/core/tools/ask-user-question.ts";
import { decodeLine } from "../src/core/tools/relay-protocol.ts";

describe("AskUserQuestion tool", () => {
	let capturedOutput: string;
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		capturedOutput = "";
		writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((data: unknown) => {
			capturedOutput += String(data);
			return true;
		}) as any);
		_setStdinStreamForTesting(new PassThrough());
	});

	afterEach(() => {
		writeSpy.mockRestore();
		_setStdinStreamForTesting(null);
		_clearPendingForTesting();
	});

	it("exports correct tool name", () => {
		expect(ASK_USER_QUESTION_TOOL_NAME).toBe("AskUserQuestion");
	});

	describe("TUI mode", () => {
		it("returns rendered answer from ctx.ui.select", async () => {
			const selectFn = vi.fn().mockResolvedValue("Option A");
			const mockCtx = {
				mode: "tui",
				hasUI: true,
				ui: { select: selectFn },
			} as unknown as ExtensionContext;

			const definition = createAskUserQuestionToolDefinition(process.cwd());
			const result = await definition.execute(
				"tool-1",
				{
					questions: [
						{
							question: "Pick one",
							options: [{ label: "Option A" }, { label: "Option B" }],
						},
					],
				},
				undefined,
				undefined,
				mockCtx,
			);

			expect(selectFn).toHaveBeenCalledWith("Pick one", ["Option A", "Option B"]);
			expect(result.content[0]).toEqual({
				type: "text",
				text: JSON.stringify({ "0": "Option A" }),
			});
		});

		it("returns cancelled message when user dismisses", async () => {
			const selectFn = vi.fn().mockResolvedValue(undefined);
			const mockCtx = {
				mode: "tui",
				hasUI: true,
				ui: { select: selectFn },
			} as unknown as ExtensionContext;

			const definition = createAskUserQuestionToolDefinition(process.cwd());
			const result = await definition.execute(
				"tool-1",
				{
					questions: [
						{
							question: "Pick one",
							options: [{ label: "A" }, { label: "B" }],
						},
					],
				},
				undefined,
				undefined,
				mockCtx,
			);

			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text.toLowerCase()).toContain("cancel");
		});
	});

	describe("JSON relay mode", () => {
		it("writes encodeEvent to stdout and resolves with matching response", async () => {
			const mockCtx = {
				mode: "json",
				hasUI: false,
			} as unknown as ExtensionContext;

			const definition = createAskUserQuestionToolDefinition(process.cwd());
			const execPromise = definition.execute(
				"tool-1",
				{
					questions: [
						{
							question: "Pick one",
							options: [{ label: "A" }, { label: "B" }],
						},
					],
				},
				undefined,
				undefined,
				mockCtx,
			);

			// Parse the event written to stdout
			const event = decodeLine(capturedOutput.trim());
			expect(event).not.toBeNull();
			if (event?.__pi_event !== "ask_user_question") {
				throw new Error("expected ask_user_question event");
			}
			expect(event.questions).toHaveLength(1);
			const id = event.id;

			// Deliver the response with matching id
			const answers = { "0": "A" };
			deliverAskUserQuestionResponse(id, answers);

			const result = await execPromise;
			expect(result.content[0]).toEqual({
				type: "text",
				text: JSON.stringify(answers),
			});
		});

		it("ignores response with wrong id", async () => {
			const mockCtx = {
				mode: "json",
				hasUI: false,
			} as unknown as ExtensionContext;

			const definition = createAskUserQuestionToolDefinition(process.cwd());
			const execPromise = definition.execute(
				"tool-1",
				{
					questions: [
						{
							question: "Pick one",
							options: [{ label: "A" }, { label: "B" }],
						},
					],
				},
				undefined,
				undefined,
				mockCtx,
			);

			const event = decodeLine(capturedOutput.trim());
			const id = event!.id;

			// Deliver with wrong id — should be ignored
			deliverAskUserQuestionResponse("wrong-id", { "0": "wrong" });

			// Deliver with correct id — should resolve
			const answers = { "0": "B" };
			deliverAskUserQuestionResponse(id, answers);

			const result = await execPromise;
			expect(result.content[0]).toEqual({
				type: "text",
				text: JSON.stringify(answers),
			});
		});

		it("returns error text on stdin EOF", async () => {
			const stdinStream = new PassThrough();
			_setStdinStreamForTesting(stdinStream);

			const mockCtx = {
				mode: "json",
				hasUI: false,
			} as unknown as ExtensionContext;

			const definition = createAskUserQuestionToolDefinition(process.cwd());
			const execPromise = definition.execute(
				"tool-1",
				{
					questions: [
						{
							question: "Pick one",
							options: [{ label: "A" }],
						},
					],
				},
				undefined,
				undefined,
				mockCtx,
			);

			// Simulate parent process death
			stdinStream.emit("end");

			const result = await execPromise;
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("Error");
			expect(text).toContain("stdin");
		});
	});
});
