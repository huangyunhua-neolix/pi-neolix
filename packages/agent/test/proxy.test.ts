import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const PROXY_URL = "https://proxy.example.invalid";
const AUTH_TOKEN = "test-token";

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

function createContext(): Context {
	return {
		systemPrompt: "system",
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
		tools: [],
	};
}

function createUsage(): AssistantMessage["usage"] {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function encodeChunks(events: ProxyAssistantMessageEvent[]): Uint8Array {
	const sse = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n")}\n`;
	return new TextEncoder().encode(sse);
}

function createMockResponse(body: Uint8Array, init?: { ok?: boolean; status?: number; statusText?: string }): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(body);
			controller.close();
		},
	});
	return {
		ok: init?.ok ?? true,
		status: init?.status ?? 200,
		statusText: init?.statusText ?? "",
		body: stream,
	} as Response;
}

function createMockJsonResponse(payload: unknown, init: { status: number; statusText: string }): Response {
	return {
		ok: false,
		status: init.status,
		statusText: init.statusText,
		body: null,
		json: async () => payload,
	} as unknown as Response;
}

interface FetchCall {
	url: string;
	init: RequestInit;
}

function installFetch(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): { calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return Promise.resolve(fetchImpl(url, init));
	});
	return { calls };
}

async function collectStreamEvents(stream: ReturnType<typeof streamProxy>): Promise<{
	events: AssistantMessageEvent[];
	result: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	const result = await stream.result();
	return { events, result };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it("forwards proxy SSE events as AssistantMessageEvents and resolves the final message", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hello " },
			{ type: "text_delta", contentIndex: 0, delta: "world" },
			{ type: "text_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage: createUsage() },
		];
		const { calls } = installFetch(() => Promise.resolve(createMockResponse(encodeChunks(proxyEvents))));

		const stream = streamProxy(createModel(), createContext(), {
			proxyUrl: PROXY_URL,
			authToken: AUTH_TOKEN,
		});
		const { events, result } = await collectStreamEvents(stream);

		expect(calls[0]?.url).toBe(`${PROXY_URL}/api/stream`);
		expect(calls[0]?.init.method).toBe("POST");
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
		expect(headers["Content-Type"]).toBe("application/json");

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);

		expect(result.role).toBe("assistant");
		expect(result.stopReason).toBe("stop");
		expect(result.usage.totalTokens).toBe(15);
		const textBlock = result.content[0];
		expect(textBlock?.type).toBe("text");
		if (textBlock?.type === "text") {
			expect(textBlock.text).toBe("Hello world");
		}
	});

	it("reconstructs tool-call content from streamed JSON deltas", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts"' },
			{ type: "toolcall_delta", contentIndex: 0, delta: "}" },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse", usage: createUsage() },
		];
		installFetch(() => Promise.resolve(createMockResponse(encodeChunks(proxyEvents))));

		const stream = streamProxy(createModel(), createContext(), {
			proxyUrl: PROXY_URL,
			authToken: AUTH_TOKEN,
		});
		const { result } = await collectStreamEvents(stream);

		expect(result.stopReason).toBe("toolUse");
		const toolCall = result.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.id).toBe("call-1");
			expect(toolCall.name).toBe("read");
			expect(toolCall.arguments).toEqual({ path: "a.ts" });
		}
	});

	it("forwards thinking deltas into thinking content", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "reasoning" },
			{ type: "thinking_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage: createUsage() },
		];
		installFetch(() => Promise.resolve(createMockResponse(encodeChunks(proxyEvents))));

		const stream = streamProxy(createModel(), createContext(), {
			proxyUrl: PROXY_URL,
			authToken: AUTH_TOKEN,
		});
		const { result } = await collectStreamEvents(stream);

		const thinking = result.content[0];
		expect(thinking?.type).toBe("thinking");
		if (thinking?.type === "thinking") {
			expect(thinking.thinking).toBe("reasoning");
		}
	});

	it("emits an error event when the proxy responds with a non-ok status", async () => {
		installFetch(() =>
			Promise.resolve(
				createMockJsonResponse({ error: "upstream down" }, { status: 502, statusText: "Bad Gateway" }),
			),
		);

		const stream = streamProxy(createModel(), createContext(), {
			proxyUrl: PROXY_URL,
			authToken: AUTH_TOKEN,
		});
		const { events, result } = await collectStreamEvents(stream);

		expect(events.map((e) => e.type)).toEqual(["error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Proxy error: upstream down");
	});

	it("emits an error event with the status line when the error body is not JSON", async () => {
		const response: Response = {
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			body: null,
			json: async () => {
				throw new Error("not JSON");
			},
		} as unknown as Response;
		installFetch(() => Promise.resolve(response));

		const stream = streamProxy(createModel(), createContext(), {
			proxyUrl: PROXY_URL,
			authToken: AUTH_TOKEN,
		});
		const { result } = await collectStreamEvents(stream);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("500");
		expect(result.errorMessage).toContain("Internal Server Error");
	});

	it("emits an aborted error event when the signal is already aborted", async () => {
		installFetch(() =>
			Promise.resolve(createMockResponse(encodeChunks([{ type: "done", reason: "stop", usage: createUsage() }]))),
		);

		const controller = new AbortController();
		controller.abort();
		const stream = streamProxy(createModel(), createContext(), {
			proxyUrl: PROXY_URL,
			authToken: AUTH_TOKEN,
			signal: controller.signal,
		});
		const { result } = await collectStreamEvents(stream);

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toContain("aborted");
	});

	it("serializes model, context, and resolved options in the request body", async () => {
		const model = createModel();
		const context = createContext();
		const { calls } = installFetch(() =>
			Promise.resolve(createMockResponse(encodeChunks([{ type: "done", reason: "stop", usage: createUsage() }]))),
		);
		const stream = streamProxy(model, context, {
			proxyUrl: PROXY_URL,
			authToken: AUTH_TOKEN,
			temperature: 0.5,
			maxTokens: 1024,
			reasoning: "medium",
		});
		await collectStreamEvents(stream);

		const body = JSON.parse(calls[0]?.init.body as string) as {
			model: unknown;
			context: unknown;
			options: Record<string, unknown>;
		};
		expect(body.model).toMatchObject({ id: "mock", provider: "openai" });
		expect(body.context).toMatchObject({ systemPrompt: "system" });
		expect(body.options).toMatchObject({ temperature: 0.5, maxTokens: 1024, reasoning: "medium" });
		// signal and auth stay out of the serialized options
		expect(body.options).not.toHaveProperty("signal");
		expect(body.options).not.toHaveProperty("authToken");
		expect(body.options).not.toHaveProperty("proxyUrl");
	});

	it("processes events delivered across multiple streamed chunks", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "part1" },
			{ type: "text_delta", contentIndex: 0, delta: "part2" },
			{ type: "text_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage: createUsage() },
		];
		const encoder = new TextEncoder();
		const chunk1 = encoder.encode(
			`${proxyEvents
				.slice(0, 3)
				.map((e) => `data: ${JSON.stringify(e)}`)
				.join("\n")}\n`,
		);
		const chunk2 = encoder.encode(
			`${proxyEvents
				.slice(3)
				.map((e) => `data: ${JSON.stringify(e)}`)
				.join("\n")}\n`,
		);
		const response: Response = {
			ok: true,
			status: 200,
			statusText: "",
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(chunk1);
					controller.enqueue(chunk2);
					controller.close();
				},
			}),
		} as Response;
		installFetch(() => Promise.resolve(response));

		const stream = streamProxy(createModel(), createContext(), {
			proxyUrl: PROXY_URL,
			authToken: AUTH_TOKEN,
		});
		const { result } = await collectStreamEvents(stream);

		const textBlock = result.content[0];
		if (textBlock?.type === "text") {
			expect(textBlock.text).toBe("part1part2");
		}
	});
});
