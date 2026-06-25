import {
	type AssistantMessage,
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type BranchPreparation,
	type BranchSummaryDetails,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
} from "../../src/harness/compaction/branch-summarization.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { toSession } from "../../src/harness/session/repo-utils.ts";
import type { BranchSummaryEntry, CompactionEntry, MessageEntry, SessionTreeEntry } from "../../src/harness/types.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

let nextId = 0;
function createId(): string {
	return `entry-${nextId++}`;
}

function createMockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string, usage = createMockUsage(100, 50)): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createAssistantWithToolCall(name: string, path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${nextId++}`, name, arguments: { path } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createMockUsage(100, 50),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createMessageEntry(message: AgentMessage, parentId: string | null = null): MessageEntry {
	return {
		type: "message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function createBranchSummaryEntry(
	summary: string,
	fromId: string,
	parentId: string | null = null,
	details?: BranchSummaryDetails,
	fromHook = false,
): BranchSummaryEntry {
	return {
		type: "branch_summary",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		fromId,
		summary,
		details,
		fromHook,
	};
}

function createCompactionEntry(
	summary: string,
	firstKeptEntryId: string,
	parentId: string | null = null,
): CompactionEntry {
	return {
		type: "compaction",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 1234,
	};
}

const models = createModels();
let fauxCount = 0;

function createFauxModel(reasoning: boolean, maxTokens = 8192): { faux: FauxProviderHandle; model: Model<string> } {
	const faux = fauxProvider({
		provider: `faux-branch-${++fauxCount}`,
		models: [
			{
				id: reasoning ? "reasoning-model" : "non-reasoning-model",
				reasoning,
				contextWindow: 200000,
				maxTokens,
			},
		],
	});
	models.setProvider(faux.provider);
	return { faux, model: faux.getModel() };
}

function buildSessionWithEntries(entries: SessionTreeEntry[]): ReturnType<typeof toSession> {
	const storage = new InMemorySessionStorage({
		entries,
		metadata: { id: "branch-session", createdAt: "2026-01-01T00:00:00.000Z" },
	});
	return toSession(storage);
}

describe("collectEntriesForBranchSummary", () => {
	beforeEach(() => {
		nextId = 0;
	});

	it("returns empty entries and null ancestor when oldLeafId is null", async () => {
		const session = buildSessionWithEntries([]);
		const result: CollectEntriesResult = await collectEntriesForBranchSummary(session, null, "any");
		expect(result.entries).toEqual([]);
		expect(result.commonAncestorId).toBeNull();
	});

	it("collects the divergent branch entries up to the common ancestor", async () => {
		// Tree:
		//   user1 -> assistant1 -> user2  -> assistant2  (old leaf)
		//                    \-> user2b -> assistant2b (target)
		const user1 = createMessageEntry(createUserMessage("u1"), null);
		const assistant1 = createMessageEntry(createAssistantMessage("a1"), user1.id);
		const user2 = createMessageEntry(createUserMessage("u2"), assistant1.id);
		const assistant2 = createMessageEntry(createAssistantMessage("a2"), user2.id);
		const user2b = createMessageEntry(createUserMessage("u2b"), assistant1.id);
		const assistant2b = createMessageEntry(createAssistantMessage("a2b"), user2b.id);
		const session = buildSessionWithEntries([user1, assistant1, user2, assistant2, user2b, assistant2b]);

		const result = await collectEntriesForBranchSummary(session, assistant2.id, assistant2b.id);
		expect(result.commonAncestorId).toBe(assistant1.id);
		expect(result.entries.map((e) => e.id)).toEqual([user2.id, assistant2.id]);
	});

	it("returns empty entries when old leaf is on the target path (ancestor case)", async () => {
		const user1 = createMessageEntry(createUserMessage("u1"), null);
		const assistant1 = createMessageEntry(createAssistantMessage("a1"), user1.id);
		const user2 = createMessageEntry(createUserMessage("u2"), assistant1.id);
		const session = buildSessionWithEntries([user1, assistant1, user2]);
		// oldLeafId is on the path to targetId === oldLeafId
		const result = await collectEntriesForBranchSummary(session, user2.id, user2.id);
		expect(result.commonAncestorId).toBe(user2.id);
		expect(result.entries).toEqual([]);
	});
});

describe("prepareBranchEntries", () => {
	beforeEach(() => {
		nextId = 0;
	});

	it("returns empty messages and file ops for no entries", () => {
		const preparation: BranchPreparation = prepareBranchEntries([]);
		expect(preparation.messages).toEqual([]);
		expect([...preparation.fileOps.read]).toEqual([]);
		expect([...preparation.fileOps.written]).toEqual([]);
		expect([...preparation.fileOps.edited]).toEqual([]);
		expect(preparation.totalTokens).toBe(0);
	});

	it("extracts messages in chronological order from message entries", () => {
		const user1 = createMessageEntry(createUserMessage("u1"), null);
		const assistant1 = createMessageEntry(createAssistantMessage("a1"), user1.id);
		const user2 = createMessageEntry(createUserMessage("u2"), assistant1.id);
		const preparation = prepareBranchEntries([user1, assistant1, user2]);
		expect(preparation.messages.map((m) => (m as { content: Array<{ text: string }> }).content[0]?.text)).toEqual([
			"u1",
			"a1",
			"u2",
		]);
		expect(preparation.totalTokens).toBeGreaterThan(0);
	});

	it("skips toolResult messages but keeps file ops from assistant tool calls", () => {
		const user1 = createMessageEntry(createUserMessage("u1"), null);
		const assistant1 = createMessageEntry(createAssistantWithToolCall("read", "src/a.ts"), user1.id);
		const toolResult: MessageEntry = {
			type: "message",
			id: createId(),
			parentId: assistant1.id,
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		const preparation = prepareBranchEntries([user1, assistant1, toolResult]);
		expect(preparation.messages).toHaveLength(2);
		expect(preparation.messages[0]?.role).toBe("user");
		expect(preparation.messages[1]?.role).toBe("assistant");
		expect([...preparation.fileOps.read]).toEqual(["src/a.ts"]);
	});

	it("imports file ops from prior branch_summary details when not from a hook", () => {
		const user1 = createMessageEntry(createUserMessage("u1"), null);
		const priorBranch: BranchSummaryEntry = createBranchSummaryEntry("prior", "old", user1.id, {
			readFiles: ["old-read.ts"],
			modifiedFiles: ["old-edit.ts"],
		});
		const assistant1 = createMessageEntry(createAssistantMessage("a1"), priorBranch.id);
		const preparation = prepareBranchEntries([user1, priorBranch, assistant1]);
		expect([...preparation.fileOps.read]).toContain("old-read.ts");
		expect([...preparation.fileOps.edited]).toContain("old-edit.ts");
		expect(preparation.messages.map((m) => m.role)).toContain("branchSummary");
	});

	it("respects a token budget by truncating from the oldest entries", () => {
		const entries: SessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (let i = 0; i < 10; i++) {
			const user = createMessageEntry(createUserMessage(`User message ${i}`), parentId);
			entries.push(user);
			parentId = user.id;
		}
		const preparation = prepareBranchEntries(entries, 10);
		expect(preparation.messages.length).toBeLessThan(10);
		expect(preparation.messages.length).toBeGreaterThan(0);
		expect(preparation.totalTokens).toBeLessThanOrEqual(14); // last message may push slightly past budget
	});

	it("keeps all entries when token budget is zero (default)", () => {
		const entries: SessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (let i = 0; i < 5; i++) {
			const user = createMessageEntry(createUserMessage(`User message ${i}`), parentId);
			entries.push(user);
			parentId = user.id;
		}
		const preparation = prepareBranchEntries(entries, 0);
		expect(preparation.messages.length).toBe(5);
	});

	it("keeps a compaction entry when it fits within 90% of the budget", () => {
		const user1 = createMessageEntry(createUserMessage("u1"), null);
		const compaction = createCompactionEntry("summary", user1.id, user1.id);
		const preparation = prepareBranchEntries([user1, compaction], 1);
		// compaction entries are retained when totalTokens < budget * 0.9 even if budget exceeded
		expect(preparation.messages.some((m) => m.role === "compactionSummary")).toBe(true);
	});
});

describe("generateBranchSummary", () => {
	beforeEach(() => {
		nextId = 0;
	});

	it("returns a no-content result when there are no messages to summarize", async () => {
		const { model } = createFauxModel(false);
		const options: GenerateBranchSummaryOptions = {
			models,
			model,
			signal: new AbortController().signal,
		};
		const result = getOrThrow(await generateBranchSummary([], options));
		expect(result.summary).toBe("No content to summarize");
		expect(result.readFiles).toEqual([]);
		expect(result.modifiedFiles).toEqual([]);
	});

	it("generates a summary with the preamble and file-operation tags", async () => {
		const user1 = createMessageEntry(createUserMessage("build the feature"), null);
		const assistant1 = createMessageEntry(createAssistantWithToolCall("write", "src/feature.ts"), user1.id);
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("## Goal\nShip the feature")]);
		const options: GenerateBranchSummaryOptions = {
			models,
			model,
			signal: new AbortController().signal,
		};
		const result = getOrThrow(await generateBranchSummary([user1, assistant1], options));
		expect(result.summary).toContain("Summary of that exploration:");
		expect(result.summary).toContain("## Goal");
		expect(result.summary).toContain("Ship the feature");
		expect(result.summary).toContain("<modified-files>");
		expect(result.summary).toContain("src/feature.ts");
		expect(result.modifiedFiles).toEqual(["src/feature.ts"]);
	});

	it("returns an aborted error when the summarization is aborted", async () => {
		const user1 = createMessageEntry(createUserMessage("summarize"), null);
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "stopped" })]);
		const options: GenerateBranchSummaryOptions = {
			models,
			model,
			signal: new AbortController().signal,
		};
		const result = await generateBranchSummary([user1], options);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("aborted");
			expect(result.error.message).toBe("stopped");
		}
	});

	it("returns a summarization_failed error when the model errors", async () => {
		const user1 = createMessageEntry(createUserMessage("summarize"), null);
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
		const options: GenerateBranchSummaryOptions = {
			models,
			model,
			signal: new AbortController().signal,
		};
		const result = await generateBranchSummary([user1], options);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("summarization_failed");
			expect(result.error.message).toBe("Branch summary failed: boom");
		}
	});

	it("appends custom instructions to the default prompt when replaceInstructions is not set", async () => {
		const user1 = createMessageEntry(createUserMessage("summarize this"), null);
		let promptText = "";
		const { faux, model } = createFauxModel(false);
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const block = message?.role === "user" ? message.content[0] : undefined;
				promptText = block !== undefined && typeof block === "object" && block.type === "text" ? block.text : "";
				return fauxAssistantMessage("## Goal\nok");
			},
		]);
		const options: GenerateBranchSummaryOptions = {
			models,
			model,
			signal: new AbortController().signal,
			customInstructions: "focus on tests",
		};
		getOrThrow(await generateBranchSummary([user1], options));
		expect(promptText).toContain("Additional focus: focus on tests");
		expect(promptText).toContain("<conversation>");
	});

	it("replaces the default prompt with custom instructions when replaceInstructions is true", async () => {
		const user1 = createMessageEntry(createUserMessage("summarize this"), null);
		let promptText = "";
		const { faux, model } = createFauxModel(false);
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const block = message?.role === "user" ? message.content[0] : undefined;
				promptText = block !== undefined && typeof block === "object" && block.type === "text" ? block.text : "";
				return fauxAssistantMessage("## Goal\nok");
			},
		]);
		const options: GenerateBranchSummaryOptions = {
			models,
			model,
			signal: new AbortController().signal,
			customInstructions: "custom-only prompt",
			replaceInstructions: true,
		};
		getOrThrow(await generateBranchSummary([user1], options));
		expect(promptText).toContain("custom-only prompt");
		expect(promptText).not.toContain("Additional focus:");
	});
});
