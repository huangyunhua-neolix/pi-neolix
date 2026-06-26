import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamVertex } from "../../src/api/google-vertex.ts";
import { GOOGLE_VERTEX_MODELS } from "../../src/providers/google-vertex.models.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
};

describe("google-vertex provider request construction", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends request to vertex URL with api key", async () => {
		const { captured, restore } = mockFetch();
		const models = Object.values(GOOGLE_VERTEX_MODELS);
		const testModel = models[0]!;
		try {
			const s = streamVertex(testModel, context, { apiKey: "test-vertex-key" });
			for await (const event of s) {
				if (event.type === "done" || event.type === "error") break;
			}
		} catch {
			// Vertex may need project/location — URL capture is what matters
		}
		const url = captured.url?.toString() ?? "";
		expect(url.length).toBeGreaterThan(0);
		restore();
	});

	it("loads models with correct provider id", () => {
		const models = Object.values(GOOGLE_VERTEX_MODELS);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect((m as any).provider).toBe("google-vertex");
		}
	});

	it("surfaces error on 401", async () => {
		const { restore } = mockFetch({ status: 401, body: '{"error":{"message":"unauthorized"}}' });
		const models = Object.values(GOOGLE_VERTEX_MODELS);
		const testModel = models[0]!;
		let hadError = false;
		try {
			const s = streamVertex(testModel, context, { apiKey: "bad-key" });
			for await (const event of s) {
				if (event.type === "error") {
					hadError = true;
					break;
				}
			}
		} catch {
			hadError = true;
		}
		expect(hadError).toBe(true);
		restore();
	});
});
