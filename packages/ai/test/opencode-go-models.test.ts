import { describe, expect, it } from "vitest";
import { OPENCODE_GO_MODELS } from "../src/providers/opencode-go.models.ts";

const OPENCODE_GO_MODEL_IDS = Object.keys(OPENCODE_GO_MODELS);

describe("OpenCode Go model endpoints", () => {
	it.each(OPENCODE_GO_MODEL_IDS)("routes %s through the Neolix Anthropic messages endpoint", (model_id) => {
		const model = OPENCODE_GO_MODELS[model_id as keyof typeof OPENCODE_GO_MODELS];

		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://claude.neolix.ai");
	});
});
