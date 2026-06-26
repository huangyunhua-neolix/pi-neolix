import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../../src/api/openai-completions.ts";
import { GITHUB_COPILOT_MODELS } from "../../src/providers/github-copilot.models.ts";
import { getHeader, mockFetch } from "../helpers/mock-fetch.ts";

const context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
};

describe("github-copilot provider request construction", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends request to copilot proxy URL with auth", async () => {
		const { captured, restore } = mockFetch();
		// Find an openai-completions model from copilot
		const allModels = Object.values(GITHUB_COPILOT_MODELS) as any[];
		const testModel = allModels.find((m) => m.api === "openai-completions") ?? allModels[0]!;
		const s = streamOpenAICompletions(testModel, context, { apiKey: "test-copilot-token" });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		const url = captured.url?.toString() ?? "";
		expect(url).toContain("githubcopilot.com");
		expect(getHeader(captured.headers, "authorization")).toBe("Bearer test-copilot-token");
		restore();
	});

	it("includes model id in request body", async () => {
		const { captured, restore } = mockFetch();
		const allModels = Object.values(GITHUB_COPILOT_MODELS) as any[];
		const testModel = allModels.find((m) => m.api === "openai-completions") ?? allModels[0]!;
		const s = streamOpenAICompletions(testModel, context, { apiKey: "test-copilot-token" });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(captured.body).toContain(testModel.id);
		restore();
	});

	it("surfaces 401 auth error", async () => {
		const { restore } = mockFetch({ status: 401, body: '{"error":{"message":"unauthorized"}}' });
		const allModels = Object.values(GITHUB_COPILOT_MODELS) as any[];
		const testModel = allModels.find((m) => m.api === "openai-completions") ?? allModels[0]!;
		const s = streamOpenAICompletions(testModel, context, { apiKey: "bad-token" });
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

	it("loads models with correct provider id", () => {
		const models = Object.values(GITHUB_COPILOT_MODELS);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect((m as any).provider).toBe("github-copilot");
		}
	});
});
