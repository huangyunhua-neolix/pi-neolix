import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { PREFERRED_MODEL_ID, resolvePreferredModel } from "../examples/extensions/subagent/index.ts";

/**
 * resolvePreferredModel decides whether to override an agent's `model`
 * frontmatter with glm-5.2. It must return "glm-5.2" only when glm-5.2 is
 * available (auth configured) under the SAME provider that will be injected
 * into the child via `--provider` (defaultProvider). Otherwise it returns
 * undefined so the caller falls back to the agent's own model.
 *
 * The provider coupling is load-bearing: the child pi is pinned to
 * defaultProvider via `--provider`, so preferring a glm-5.2 that lives under a
 * different provider would make the child send a model that provider cannot
 * serve (buildFallbackModel fabricates a fake entry with the wrong baseUrl).
 */

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions" as Api,
		provider,
		baseUrl: `https://${provider}.example.com`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
		compat: undefined,
	} as Model<Api>;
}

function registryWith(models: Model<Api>[]) {
	return {
		getAvailable: vi.fn(() => models),
	} as unknown as Parameters<typeof resolvePreferredModel>[0];
}

describe("resolvePreferredModel", () => {
	it("returns glm-5.2 when available under the default provider", () => {
		const reg = registryWith([
			fakeModel("neolix", "claude-opus-4.8-vertex"),
			fakeModel("neolix", PREFERRED_MODEL_ID),
		]);
		expect(resolvePreferredModel(reg, "neolix")).toBe("glm-5.2");
	});

	it("returns undefined when glm-5.2 is available under a DIFFERENT provider", () => {
		// glm-5.2 authed under opencode-go, but child is pinned to neolix.
		const reg = registryWith([
			fakeModel("neolix", "claude-opus-4.8-vertex"),
			fakeModel("opencode-go", PREFERRED_MODEL_ID),
		]);
		expect(resolvePreferredModel(reg, "neolix")).toBeUndefined();
	});

	it("returns undefined when glm-5.2 is not available at all", () => {
		const reg = registryWith([fakeModel("neolix", "claude-opus-4.8-vertex")]);
		expect(resolvePreferredModel(reg, "neolix")).toBeUndefined();
	});

	it("returns undefined when defaultProvider is unknown (no provider to pin)", () => {
		// Without a pinned provider the child could resolve glm-5.2 ambiguously
		// across providers, so we do not override.
		const reg = registryWith([fakeModel("neolix", PREFERRED_MODEL_ID)]);
		expect(resolvePreferredModel(reg, undefined)).toBeUndefined();
	});

	it("returns undefined when modelRegistry is undefined", () => {
		expect(resolvePreferredModel(undefined, "neolix")).toBeUndefined();
	});

	it("does not match glm-5.2 by name alone across providers", () => {
		// Two providers each have a model named glm-5.2; only the one under the
		// default provider counts.
		const reg = registryWith([fakeModel("opencode-go", PREFERRED_MODEL_ID), fakeModel("neolix", PREFERRED_MODEL_ID)]);
		expect(resolvePreferredModel(reg, "neolix")).toBe("glm-5.2");
		expect(resolvePreferredModel(reg, "opencode-go")).toBe("glm-5.2");
		expect(resolvePreferredModel(reg, "zai")).toBeUndefined();
	});
});
