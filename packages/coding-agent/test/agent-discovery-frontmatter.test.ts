import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentConfig,
	discoverAgents,
	normalizeToolNames,
	subtractDisallowed,
} from "../src/core/tools/agent-discovery.ts";

const describeV2 = process.env.PI_AGENT_RUNTIME_V2 === "1" ? describe : describe.skip;

describeV2("agent-discovery frontmatter fields (V2-only)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeAgent(name: string, frontmatterLines: string[], body = "System prompt body"): string {
		const agentsDir = path.join(tempDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		const filePath = path.join(agentsDir, `${name}.md`);
		fs.writeFileSync(filePath, `---\n${frontmatterLines.join("\n")}\n---\n${body}`);
		return filePath;
	}

	function getAgent(name: string): AgentConfig {
		const result = discoverAgents(tempDir, "project");
		const agent = result.agents.find((a) => a.name === name);
		if (!agent) throw new Error(`Agent ${name} not found in ${JSON.stringify(result.agents.map((a) => a.name))}`);
		return agent;
	}

	it("parses color and skills as comma-separated arrays", () => {
		writeAgent("color-skills", [
			"name: color-skills",
			'description: "Agent with color and skills"',
			"color: blue, green",
			"skills: skill1, skill2, skill3",
		]);
		const agent = getAgent("color-skills");
		expect(agent.color).toEqual(["blue", "green"]);
		expect(agent.skills).toEqual(["skill1", "skill2", "skill3"]);
	});

	it("parses effort as-is", () => {
		writeAgent("effort-agent", ["name: effort-agent", 'description: "Agent with effort"', "effort: high"]);
		const agent = getAgent("effort-agent");
		expect(agent.effort).toBe("high");
	});

	it("parses isolation and permissionMode as-is", () => {
		writeAgent("isolation-agent", [
			"name: isolation-agent",
			'description: "Agent with isolation"',
			"isolation: strict",
			"permissionMode: plan",
		]);
		const agent = getAgent("isolation-agent");
		expect(agent.isolation).toBe("strict");
		expect(agent.permissionMode).toBe("plan");
	});

	it("parses maxTurns as number", () => {
		writeAgent("maxturns-agent", ["name: maxturns-agent", 'description: "Agent with maxTurns"', "maxTurns: 50"]);
		const agent = getAgent("maxturns-agent");
		expect(agent.maxTurns).toBe(50);
	});

	it("parses maxTurns when given as quoted string", () => {
		writeAgent("maxturns-str", ["name: maxturns-str", 'description: "Agent with maxTurns string"', 'maxTurns: "25"']);
		const agent = getAgent("maxturns-str");
		expect(agent.maxTurns).toBe(25);
	});

	it("parses disallowedTools as comma-separated array", () => {
		writeAgent("disallowed-agent", [
			"name: disallowed-agent",
			'description: "Agent with disallowedTools"',
			"disallowedTools: Read, Write, Bash",
		]);
		const agent = getAgent("disallowed-agent");
		expect(agent.disallowedTools).toEqual(["Read", "Write", "Bash"]);
	});

	it("parses initialPrompt as-is", () => {
		writeAgent("prompt-agent", [
			"name: prompt-agent",
			'description: "Agent with initialPrompt"',
			"initialPrompt: Do the thing",
		]);
		const agent = getAgent("prompt-agent");
		expect(agent.initialPrompt).toBe("Do the thing");
	});

	it("parses background, memory, hooks, mcpServers as-is", () => {
		writeAgent("complex-agent", [
			"name: complex-agent",
			'description: "Agent with complex fields"',
			"background: true",
			"memory: false",
			'hooks: "hook-config"',
			"mcpServers: server1",
		]);
		const agent = getAgent("complex-agent");
		expect(agent.background).toBe(true);
		expect(agent.memory).toBe(false);
		expect(agent.hooks).toBe("hook-config");
		expect(agent.mcpServers).toBe("server1");
	});

	it("preserves existing tools and model fields", () => {
		writeAgent("legacy-agent", [
			"name: legacy-agent",
			'description: "Legacy agent"',
			"tools: Read, Write",
			"model: claude-3-5-sonnet",
		]);
		const agent = getAgent("legacy-agent");
		expect(agent.tools).toEqual(["read", "write"]);
		expect(agent.model).toBe("claude-3-5-sonnet");
	});
});

describe("subtractDisallowed", () => {
	it("removes disallowed tools from allowlist (case-insensitive, alias-normalized)", () => {
		expect(subtractDisallowed(["read", "bash"], ["Read"])).toEqual(["bash"]);
	});

	it("returns undefined when allowlist is undefined (wildcard not narrowed)", () => {
		expect(subtractDisallowed(undefined, ["bash"])).toBeUndefined();
	});

	it("normalizes Task/subagent to Agent via alias map", () => {
		expect(subtractDisallowed(["Agent"], ["Task"])).toEqual([]);
		expect(subtractDisallowed(["Agent"], ["subagent"])).toEqual([]);
	});

	it("normalizes AskUserQuestion via alias map", () => {
		expect(subtractDisallowed(["AskUserQuestion"], ["askuserquestion"])).toEqual([]);
	});

	it("returns the original allowlist when nothing is disallowed", () => {
		expect(subtractDisallowed(["read", "bash"], [])).toEqual(["read", "bash"]);
	});

	it("does not remove tools not in the disallowed list", () => {
		expect(subtractDisallowed(["read", "bash"], ["write"])).toEqual(["read", "bash"]);
	});

	// FIX-12: unmapped disallowed names should warn (previously silently
	// passed through lowercased, so a typo like `bashx` would never match).
	it("warns when a disallowed name has no alias mapping (FIX-12)", () => {
		delete process.env.PI_QUIET;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = subtractDisallowed(["read", "bash"], ["bashx"]);
			// bashx doesn't match any alias, so it's passed through lowercased
			// and the allowlist is unchanged (bashx !== bash/read).
			expect(result).toEqual(["read", "bash"]);
			expect(warnSpy).toHaveBeenCalled();
			const warnMsg = warnSpy.mock.calls[0][0] as string;
			expect(warnMsg).toMatch(/bashx/);
			expect(warnMsg).toMatch(/no alias mapping/i);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not warn for mapped disallowed names (FIX-12)", () => {
		delete process.env.PI_QUIET;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			subtractDisallowed(["read", "bash"], ["Read"]);
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("suppresses unmapped-disallowed warning when PI_QUIET=1 (FIX-12)", () => {
		vi.stubEnv("PI_QUIET", "1");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			subtractDisallowed(["read", "bash"], ["typotool"]);
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
			vi.unstubAllEnvs();
		}
	});
});

describe("TOOL_NAME_ALIASES (via normalizeToolNames)", () => {
	it("maps AskUserQuestion to AskUserQuestion", () => {
		expect(normalizeToolNames(["AskUserQuestion"])).toEqual(["AskUserQuestion"]);
	});

	it("maps Task to Agent", () => {
		expect(normalizeToolNames(["Task"])).toEqual(["Agent"]);
	});

	it("maps subagent to Agent", () => {
		expect(normalizeToolNames(["subagent"])).toEqual(["Agent"]);
	});

	it("maps Skill to Skill", () => {
		expect(normalizeToolNames(["Skill"])).toEqual(["Skill"]);
	});

	it("maps WebFetch to WebFetch", () => {
		expect(normalizeToolNames(["WebFetch"])).toEqual(["WebFetch"]);
	});

	it("maps WebSearch to WebSearch", () => {
		expect(normalizeToolNames(["WebSearch"])).toEqual(["WebSearch"]);
	});

	it("still maps read/bash/edit/write correctly", () => {
		expect(normalizeToolNames(["Read", "Bash", "Edit", "Write"])).toEqual(["read", "bash", "edit", "write"]);
	});
});
