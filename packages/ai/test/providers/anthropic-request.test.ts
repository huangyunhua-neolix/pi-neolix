import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../../src/api/anthropic-messages.ts";
import { ANTHROPIC_MODELS } from "../../src/providers/anthropic.models.ts";
import { getHeader, mockFetch } from "../helpers/mock-fetch.ts";

const testModel = Object.values(ANTHROPIC_MODELS)[0]!;

const context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
};

describe("anthropic provider request construction", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends request to correct URL with x-api-key header", async () => {
		const { captured, restore } = mockFetch();
		const s = streamAnthropic(testModel, context, { apiKey: "test-key-123" });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		const url = captured.url?.toString() ?? "";
		expect(url).toContain("api.anthropic.com");
		expect(getHeader(captured.headers, "x-api-key")).toBe("test-key-123");
		expect(getHeader(captured.headers, "anthropic-version")).toBeTruthy();
		restore();
	});

	it("includes model id and messages in request body", async () => {
		const { captured, restore } = mockFetch();
		const s = streamAnthropic(testModel, context, { apiKey: "test-key-123" });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(captured.body).toContain(testModel.id);
		expect(captured.body).toContain("hi");
		restore();
	});

	it("surfaces 401 auth error", async () => {
		const { restore } = mockFetch({ status: 401, body: '{"error":{"message":"invalid api key"}}' });
		const s = streamAnthropic(testModel, context, { apiKey: "bad-key" });
		let hadError = false;
		for await (const event of s) {
			if (event.type === "error") {
				hadError = true;
				break;
			}
		}
		expect(hadError).toBe(true);
		restore();
	});

	it("loads model list from anthropic.models.ts", () => {
		const models = Object.values(ANTHROPIC_MODELS);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.provider).toBe("anthropic");
			expect(m.api).toBe("anthropic-messages");
			expect(m.id).toBeTruthy();
		}
	});
});
