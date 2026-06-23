import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

const ANTHROPIC_ENDPOINT_MODELS = ["minimax-m2.7", "qwen3.6-plus"] as const;

describe("OpenCode Go model endpoints", () => {
	it.each(ANTHROPIC_ENDPOINT_MODELS)("routes %s through the Anthropic messages API", (model_id) => {
		const model = getModel("opencode-go", model_id);

		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("https://opencode.ai/zen/go");
	});
});
