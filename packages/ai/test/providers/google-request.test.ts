import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../../src/api/google-generative-ai.ts";
import { GOOGLE_MODELS } from "../../src/providers/google.models.ts";
import { getHeader, mockFetch } from "../helpers/mock-fetch.ts";

const testModel = Object.values(GOOGLE_MODELS)[0]!;

const context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
};

describe("google provider request construction", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends request to google URL with x-goog-api-key header", async () => {
		const { captured, restore } = mockFetch();
		const s = streamGoogle(testModel, context, { apiKey: "test-key-789" });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		const url = captured.url?.toString() ?? "";
		expect(url).toContain("googleapis.com");
		expect(getHeader(captured.headers, "x-goog-api-key")).toBe("test-key-789");
		restore();
	});

	it("includes model id in request body or URL", async () => {
		const { captured, restore } = mockFetch();
		const s = streamGoogle(testModel, context, { apiKey: "test-key-789" });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		const url = captured.url?.toString() ?? "";
		const body = captured.body ?? "";
		expect(url.includes(testModel.id) || body.includes(testModel.id)).toBe(true);
		restore();
	});

	it("surfaces 401 auth error", async () => {
		const { restore } = mockFetch({ status: 401, body: '{"error":{"message":"invalid key"}}' });
		const s = streamGoogle(testModel, context, { apiKey: "bad-key" });
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

	it("loads model list from google.models.ts", () => {
		const models = Object.values(GOOGLE_MODELS);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.provider).toBe("google");
			expect(m.api).toBe("google-generative-ai");
		}
	});
});
