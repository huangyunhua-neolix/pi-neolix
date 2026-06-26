import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../../src/api/openai-completions.ts";
import { CEREBRAS_MODELS } from "../../src/providers/cerebras.models.ts";
import { DEEPSEEK_MODELS } from "../../src/providers/deepseek.models.ts";
import { FIREWORKS_MODELS } from "../../src/providers/fireworks.models.ts";
import { GROQ_MODELS } from "../../src/providers/groq.models.ts";
import { OPENROUTER_MODELS } from "../../src/providers/openrouter.models.ts";
import { TOGETHER_MODELS } from "../../src/providers/together.models.ts";
import { XAI_MODELS } from "../../src/providers/xai.models.ts";
import { getHeader, mockFetch } from "../helpers/mock-fetch.ts";

const context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
};

interface ProviderConfig {
	id: string;
	models: Record<string, unknown>;
	expectedUrlPart: string;
	apiKeyEnvVar: string;
}

const providers: ProviderConfig[] = [
	{ id: "groq", models: GROQ_MODELS, expectedUrlPart: "groq.com", apiKeyEnvVar: "GROQ_API_KEY" },
	{ id: "deepseek", models: DEEPSEEK_MODELS, expectedUrlPart: "deepseek.com", apiKeyEnvVar: "DEEPSEEK_API_KEY" },
	{ id: "xai", models: XAI_MODELS, expectedUrlPart: "x.ai", apiKeyEnvVar: "XAI_API_KEY" },
	{ id: "cerebras", models: CEREBRAS_MODELS, expectedUrlPart: "cerebras.ai", apiKeyEnvVar: "CEREBRAS_API_KEY" },
	{ id: "together", models: TOGETHER_MODELS, expectedUrlPart: "together.ai", apiKeyEnvVar: "TOGETHER_API_KEY" },
	{ id: "fireworks", models: FIREWORKS_MODELS, expectedUrlPart: "fireworks.ai", apiKeyEnvVar: "FIREWORKS_API_KEY" },
	{
		id: "openrouter",
		models: OPENROUTER_MODELS,
		expectedUrlPart: "openrouter.ai",
		apiKeyEnvVar: "OPENROUTER_API_KEY",
	},
];

describe.each(providers)("openai-compatible provider: $id", ({ id, models, expectedUrlPart }) => {
	afterEach(() => vi.restoreAllMocks());

	const testModel = Object.values(models)[0] as any;

	it("sends request to correct URL with Bearer auth", async () => {
		const { captured, restore } = mockFetch();
		const s = streamOpenAICompletions(testModel, context, { apiKey: `test-${id}-key` });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		const url = captured.url?.toString() ?? "";
		expect(url).toContain(expectedUrlPart);
		expect(getHeader(captured.headers, "authorization")).toBe(`Bearer test-${id}-key`);
		restore();
	});

	it("includes model id in request body", async () => {
		const { captured, restore } = mockFetch();
		const s = streamOpenAICompletions(testModel, context, { apiKey: `test-${id}-key` });
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(captured.body).toContain(testModel.id);
		restore();
	});

	it("surfaces 401 auth error", async () => {
		const { restore } = mockFetch({ status: 401, body: '{"error":{"message":"unauthorized"}}' });
		const s = streamOpenAICompletions(testModel, context, { apiKey: "bad-key" });
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
		const modelList = Object.values(models);
		expect(modelList.length).toBeGreaterThan(0);
		for (const m of modelList) {
			expect((m as any).provider).toBe(id);
		}
	});
});
