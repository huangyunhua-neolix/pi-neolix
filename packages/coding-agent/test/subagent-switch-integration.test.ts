import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";
import subagentExtension from "../examples/extensions/subagent/index.ts";

/**
 * Integration tests for session-level agent switching: `/agent:<name>` injects
 * the agent's systemPrompt into the switched turn via before_agent_start, and
 * `/agent:off` resets the next turn to the base prompt. Agent discovery is
 * hermetic via $HOME + PI_CODING_AGENT_DIR redirect (same technique as
 * subagent-agents.test.ts). The trust prompt is skipped because the harness
 * session has no dialog UI (hasUI === false).
 */
const REAL_HOME = process.env.HOME;
const REAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

describe("session-level agent switch (/agent:<name>)", () => {
	let harness: Harness;
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-switch-"));
		process.env.HOME = dir;
		process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		const claudeAgents = join(dir, ".claude", "agents");
		mkdirSync(claudeAgents, { recursive: true });
		writeFileSync(
			join(claudeAgents, "swtest.md"),
			"---\nname: swtest\ndescription: switch test agent\n---\nYOU ARE THE SWTEST AGENT PERSONA. Reply ok.\n",
		);
	});

	afterEach(async () => {
		if (harness) harness.cleanup();
		process.env.HOME = REAL_HOME;
		if (REAL_AGENT_DIR === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = REAL_AGENT_DIR;
		}
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("injects the agent persona into the switched turn's system prompt", async () => {
		harness = await createHarnessWithExtensions({
			responses: ["ok"],
			extensionFactories: [{ path: "<subagent>", factory: subagentExtension }],
		});

		await harness.session.prompt("/agent:swtest do the thing");

		expect(harness.faux.callCount).toBe(1);
		const sp = harness.faux.contexts[0].systemPrompt;
		expect(sp).toContain("YOU ARE THE SWTEST AGENT PERSONA");
		expect(sp).toContain("PI INTERACTIVE-SESSION ADAPTATION");
	});

	it("resets to the base system prompt after /agent:off", async () => {
		harness = await createHarnessWithExtensions({
			responses: ["ok", "ok"],
			extensionFactories: [{ path: "<subagent>", factory: subagentExtension }],
		});

		await harness.session.prompt("/agent:swtest do the thing"); // persona on  -> 1 call
		await harness.session.prompt("/agent:off"); // exit (handled, no turn)  -> 0 calls
		await harness.session.prompt("plain question"); // base prompt            -> 1 call

		expect(harness.faux.callCount).toBe(2);
		expect(harness.faux.contexts[0].systemPrompt).toContain("YOU ARE THE SWTEST AGENT PERSONA");
		expect(harness.faux.contexts[1].systemPrompt).not.toContain("YOU ARE THE SWTEST AGENT PERSONA");
	});
});
