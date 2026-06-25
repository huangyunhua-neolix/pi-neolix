import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	serializeConversation,
} from "../../src/harness/compaction/utils.ts";
import type { AgentMessage } from "../../src/types.ts";

function createMockUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantWithToolCalls(
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
): AssistantMessage {
	return {
		role: "assistant",
		content: toolCalls.map((tc, index) => ({
			type: "toolCall" as const,
			id: `call-${index}`,
			name: tc.name,
			arguments: tc.arguments,
		})),
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createMockUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

describe("createFileOps", () => {
	it("returns empty sets for read, written, and edited", () => {
		const ops = createFileOps();
		expect(ops.read).toBeInstanceOf(Set);
		expect(ops.written).toBeInstanceOf(Set);
		expect(ops.edited).toBeInstanceOf(Set);
		expect(ops.read.size).toBe(0);
		expect(ops.written.size).toBe(0);
		expect(ops.edited.size).toBe(0);
	});
});

describe("extractFileOpsFromMessage", () => {
	it("records read tool calls into the read set", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(createAssistantWithToolCalls([{ name: "read", arguments: { path: "a.ts" } }]), ops);
		expect([...ops.read]).toEqual(["a.ts"]);
		expect(ops.written.size).toBe(0);
		expect(ops.edited.size).toBe(0);
	});

	it("records write tool calls into the written set", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(createAssistantWithToolCalls([{ name: "write", arguments: { path: "b.ts" } }]), ops);
		expect([...ops.written]).toEqual(["b.ts"]);
	});

	it("records edit tool calls into the edited set", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(createAssistantWithToolCalls([{ name: "edit", arguments: { path: "c.ts" } }]), ops);
		expect([...ops.edited]).toEqual(["c.ts"]);
	});

	it("accumulates across multiple messages and deduplicates", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			createAssistantWithToolCalls([
				{ name: "read", arguments: { path: "a.ts" } },
				{ name: "write", arguments: { path: "b.ts" } },
			]),
			ops,
		);
		extractFileOpsFromMessage(
			createAssistantWithToolCalls([
				{ name: "read", arguments: { path: "a.ts" } },
				{ name: "edit", arguments: { path: "b.ts" } },
			]),
			ops,
		);
		expect([...ops.read]).toEqual(["a.ts"]);
		expect([...ops.written]).toEqual(["b.ts"]);
		expect([...ops.edited]).toEqual(["b.ts"]);
	});

	it("ignores tool calls without a path argument", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(createAssistantWithToolCalls([{ name: "read", arguments: {} }]), ops);
		expect(ops.read.size).toBe(0);
	});

	it("ignores tool calls for tools other than read/write/edit", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			createAssistantWithToolCalls([{ name: "bash", arguments: { path: "ignored.ts" } }]),
			ops,
		);
		expect(ops.read.size).toBe(0);
		expect(ops.written.size).toBe(0);
		expect(ops.edited.size).toBe(0);
	});

	it("ignores non-assistant messages", () => {
		const ops = createFileOps();
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "toolCall", id: "x", name: "read", arguments: { path: "ignored.ts" } }],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		extractFileOpsFromMessage(userMessage, ops);
		expect(ops.read.size).toBe(0);
	});

	it("ignores assistant messages without array content", () => {
		const ops = createFileOps();
		const malformed = { role: "assistant", content: "not-an-array", timestamp: 0 } as unknown as AgentMessage;
		extractFileOpsFromMessage(malformed, ops);
		expect(ops.read.size).toBe(0);
	});

	it("ignores content blocks that are not tool calls", () => {
		const ops = createFileOps();
		const message: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "thought" },
			],
			api: "openai-responses",
			provider: "openai",
			model: "mock",
			usage: createMockUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		extractFileOpsFromMessage(message, ops);
		expect(ops.read.size).toBe(0);
	});
});

describe("computeFileLists", () => {
	it("returns empty lists when no operations were recorded", () => {
		const { readFiles, modifiedFiles } = computeFileLists(createFileOps());
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual([]);
	});

	it("treats read-only files as read files", () => {
		const ops = createFileOps();
		ops.read.add("z.ts");
		ops.read.add("a.ts");
		const { readFiles, modifiedFiles } = computeFileLists(ops);
		expect(readFiles).toEqual(["a.ts", "z.ts"]);
		expect(modifiedFiles).toEqual([]);
	});

	it("classifies written and edited files as modified, sorted", () => {
		const ops = createFileOps();
		ops.written.add("b.ts");
		ops.edited.add("a.ts");
		const { readFiles, modifiedFiles } = computeFileLists(ops);
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["a.ts", "b.ts"]);
	});

	it("excludes files that are both read and modified from the read list", () => {
		const ops = createFileOps();
		ops.read.add("shared.ts");
		ops.edited.add("shared.ts");
		ops.read.add("only-read.ts");
		const { readFiles, modifiedFiles } = computeFileLists(ops);
		expect(readFiles).toEqual(["only-read.ts"]);
		expect(modifiedFiles).toEqual(["shared.ts"]);
	});
});

describe("formatFileOperations", () => {
	it("returns an empty string when both lists are empty", () => {
		expect(formatFileOperations([], [])).toBe("");
	});

	it("renders only the read-files block when no modified files exist", () => {
		const result = formatFileOperations(["a.ts", "b.ts"], []);
		expect(result).toBe("\n\n<read-files>\na.ts\nb.ts\n</read-files>");
	});

	it("renders only the modified-files block when no read files exist", () => {
		const result = formatFileOperations([], ["c.ts"]);
		expect(result).toBe("\n\n<modified-files>\nc.ts\n</modified-files>");
	});

	it("renders both blocks separated by a blank line when both lists are non-empty", () => {
		const result = formatFileOperations(["a.ts"], ["b.ts"]);
		expect(result).toContain("<read-files>");
		expect(result).toContain("<modified-files>");
		expect(result).toBe("\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>");
	});
});

describe("serializeConversation", () => {
	it("serializes a user message with string content", () => {
		const result = serializeConversation([createUserMessage("hello")]);
		expect(result).toBe("[User]: hello");
	});

	it("serializes a user message with structured text content", () => {
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: "structured" }],
			timestamp: Date.now(),
		};
		expect(serializeConversation([message])).toBe("[User]: structured");
	});

	it("serializes assistant text and thinking blocks in separate sections", () => {
		const message: Message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "pondering" },
				{ type: "text", text: "answer" },
			],
			timestamp: Date.now(),
		} as unknown as Message;
		const result = serializeConversation([message]);
		expect(result).toContain("[Assistant thinking]: pondering");
		expect(result).toContain("[Assistant]: answer");
	});

	it("serializes assistant tool calls with their arguments", () => {
		const message: Message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }],
			timestamp: Date.now(),
		} as unknown as Message;
		const result = serializeConversation([message]);
		expect(result).toContain('[Assistant tool calls]: read(path="a.ts")');
	});

	it("serializes tool result text content with truncation", () => {
		const longText = "x".repeat(3000);
		const message: Message = {
			role: "toolResult",
			toolCallId: "1",
			toolName: "read",
			content: [{ type: "text", text: longText }],
			isError: false,
			timestamp: Date.now(),
		} as unknown as Message;
		const result = serializeConversation([message]);
		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 1000 more characters truncated]");
		expect(result.length).toBeLessThan(longText.length + 200);
	});

	it("joins multiple messages with a double newline", () => {
		const result = serializeConversation([createUserMessage("a"), createUserMessage("b")]);
		expect(result).toBe("[User]: a\n\n[User]: b");
	});

	it("skips empty user content", () => {
		const empty: Message = {
			role: "user",
			content: [{ type: "text", text: "" }],
			timestamp: Date.now(),
		};
		expect(serializeConversation([empty])).toBe("");
	});

	it("serializes an unserializable argument value safely", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const message: Message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "weird", arguments: circular as Record<string, unknown> }],
			timestamp: Date.now(),
		} as unknown as Message;
		const result = serializeConversation([message]);
		expect(result).toContain("[Assistant tool calls]: weird(self=");
		// A circular reference makes JSON.stringify throw, so safeJsonStringify
		// must fall back to the explicit [unserializable] marker.
		expect(result).toContain("[unserializable]");
	});
});
