import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAI } from "../../src/api/openai-responses.ts";
import { OPENAI_MODELS } from "../../src/providers/openai.models.ts";
import { getHeader, mockFetch } from "../helpers/mock-fetch.ts";

const testModel = Object.values(OPENAI_MODELS)[0]!;

const context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
};

describe("openai provider request construction", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends request to openai URL with Authorization header", async () => {
		const { captured, restore } = mockFetch();
		const s = streamOpenAI(testModel, context, { apiKey: "test-key-456" });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		const url = captured.url?.toString() ?? "";
		expect(url).toContain("openai.com");
		expect(getHeader(captured.headers, "authorization")).toBe("Bearer test-key-456");
		restore();
	});

	it("includes model id and messages in request body", async () => {
		const { captured, restore } = mockFetch();
		const s = streamOpenAI(testModel, context, { apiKey: "test-key-456" });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(captured.body).toContain(testModel.id);
		expect(captured.body).toContain("hi");
		restore();
	});

	it("surfaces 401 auth error", async () => {
		const { restore } = mockFetch({ status: 401, body: '{"error":{"message":"invalid api key"}}' });
		const s = streamOpenAI(testModel, context, { apiKey: "bad-key" });
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

	it("loads model list from openai.models.ts", () => {
		const models = Object.values(OPENAI_MODELS);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.provider).toBe("openai");
			expect(m.api).toBe("openai-responses");
		}
	});
});
