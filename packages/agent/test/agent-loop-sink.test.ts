import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runAgentLoop, runAgentLoopContinue } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

interface SinkRecorder {
	events: AgentEvent[];
	sink: (event: AgentEvent) => Promise<void>;
}

function createRecordingSink(): SinkRecorder {
	const events: AgentEvent[] = [];
	const sink = async (event: AgentEvent): Promise<void> => {
		events.push(event);
	};
	return { events, sink };
}

describe("runAgentLoop with AgentEventSink", () => {
	it("emits the full event sequence and returns only the new messages", async () => {
		const context: AgentContext = { systemPrompt: "You are helpful.", messages: [], tools: [] };
		const userPrompt: AgentMessage = createUserMessage("Hello");
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "Hi!" }]),
				});
			});
			return stream;
		};

		const recorder = createRecordingSink();
		const newMessages = await runAgentLoop([userPrompt], context, config, recorder.sink, undefined, streamFn);

		expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(newMessages[1]).toMatchObject({ role: "assistant" });

		const eventTypes = recorder.events.map((e) => e.type);
		expect(eventTypes).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const agentEnd = recorder.events[recorder.events.length - 1];
		if (agentEnd?.type === "agent_end") {
			expect(agentEnd.messages).toBe(newMessages);
		}
	});

	it("routes multiple prompts through the sink before the assistant turn", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const first: AgentMessage = createUserMessage("one");
		const second: AgentMessage = createUserMessage("two");
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "ok" }]),
				});
			});
			return stream;
		};

		const recorder = createRecordingSink();
		const newMessages = await runAgentLoop([first, second], context, config, recorder.sink, undefined, streamFn);

		expect(newMessages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
		const messageStarts = recorder.events.filter((e) => e.type === "message_start");
		expect(messageStarts.length).toBe(3);
	});

	it("propagates an aborted assistant response through the sink without throwing", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const userPrompt: AgentMessage = createUserMessage("Hello");
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "aborted" }], "aborted"),
				});
			});
			return stream;
		};

		const recorder = createRecordingSink();
		const newMessages = await runAgentLoop([userPrompt], context, config, recorder.sink, undefined, streamFn);

		expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect((newMessages[1] as AssistantMessage).stopReason).toBe("aborted");
		const eventTypes = recorder.events.map((e) => e.type);
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes[eventTypes.length - 1]).toBe("agent_end");
	});

	it("awaits an async sink that defers via a microtask", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const userPrompt: AgentMessage = createUserMessage("Hello");
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const observed: AgentEvent[] = [];
		let order = 0;
		const sink = async (event: AgentEvent): Promise<void> => {
			const current = ++order;
			await Promise.resolve();
			observed.push(event);
			expect(current).toBe(order); // ordering preserved across awaits
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "x" }]),
				});
			});
			return stream;
		};

		await runAgentLoop([userPrompt], context, config, sink, undefined, streamFn);
		expect(observed.length).toBeGreaterThan(0);
		expect(observed[observed.length - 1]?.type).toBe("agent_end");
	});
});

describe("runAgentLoopContinue with AgentEventSink", () => {
	it("throws when the context has no messages", () => {
		const context: AgentContext = { systemPrompt: "x", messages: [], tools: [] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const recorder = createRecordingSink();
		return expect(runAgentLoopContinue(context, config, recorder.sink)).rejects.toThrow(
			"Cannot continue: no messages in context",
		);
	});

	it("throws when the last context message is an assistant message", () => {
		const context: AgentContext = {
			systemPrompt: "x",
			messages: [createUserMessage("hi"), createAssistantMessage([{ type: "text", text: "hey" }])],
			tools: [],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const recorder = createRecordingSink();
		return expect(runAgentLoopContinue(context, config, recorder.sink)).rejects.toThrow(
			"Cannot continue from message role: assistant",
		);
	});

	it("emits only the new assistant message and skips user message events", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");
		const context: AgentContext = { systemPrompt: "You are helpful.", messages: [userMessage], tools: [] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "Response" }]),
				});
			});
			return stream;
		};

		const recorder = createRecordingSink();
		const newMessages = await runAgentLoopContinue(context, config, recorder.sink, undefined, streamFn);

		expect(newMessages.map((m) => m.role)).toEqual(["assistant"]);
		const messageEnds = recorder.events.filter((e) => e.type === "message_end");
		expect(messageEnds.length).toBe(1);
		if (messageEnds[0]?.type === "message_end") {
			expect(messageEnds[0].message.role).toBe("assistant");
		}
		const eventTypes = recorder.events.map((e) => e.type);
		expect(eventTypes[0]).toBe("agent_start");
		expect(eventTypes[1]).toBe("turn_start");
		expect(eventTypes[eventTypes.length - 1]).toBe("agent_end");
		// No user message events are emitted — only the new assistant message
		const messageStarts = recorder.events.filter((e) => e.type === "message_start");
		expect(messageStarts.length).toBe(1);
		if (messageStarts[0]?.type === "message_start") {
			expect(messageStarts[0].message.role).toBe("assistant");
		}
	});

	it("returns the error assistant message in new-messages and emits agent_end when the model aborts immediately", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");
		const context: AgentContext = { systemPrompt: "", messages: [userMessage], tools: [] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "err" }], "error"),
				});
			});
			return stream;
		};

		const recorder = createRecordingSink();
		const newMessages = await runAgentLoopContinue(context, config, recorder.sink, undefined, streamFn);

		// The aborted/error assistant message is still part of newMessages
		expect(newMessages.map((m) => m.role)).toEqual(["assistant"]);
		expect((newMessages[0] as AssistantMessage).stopReason).toBe("error");
		const eventTypes = recorder.events.map((e) => e.type);
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes[eventTypes.length - 1]).toBe("agent_end");
	});
});
