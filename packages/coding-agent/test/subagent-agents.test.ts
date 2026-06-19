import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgents } from "../examples/extensions/subagent/agents.ts";

/**
 * discoverAgents reads from two user roots:
 *   - ~/.pi/agent/agents  (via getAgentDir(), overridable with PI_CODING_AGENT_DIR)
 *   - ~/.claude/agents    (via getClaudeConfigHome(), driven by $HOME)
 *
 * ~/.pi/agent/agents takes precedence on name collisions.
 */
const REAL_HOME = process.env.HOME;
const REAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function withHome(home: string) {
	process.env.HOME = home;
}

function writeAgent(dir: string, name: string, description = `${name} agent`): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nYou are ${name}.\n`);
}

describe("discoverAgents — ~/.claude/agents user root", () => {
	beforeEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		process.env.HOME = REAL_HOME;
		if (REAL_AGENT_DIR === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = REAL_AGENT_DIR;
		}
	});

	it("discovers agents from ~/.claude/agents", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agents-claude-"));
		const claudeAgents = join(dir, ".claude", "agents");
		// Empty PI agent dir so only ~/.claude/agents contributes.
		process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		writeAgent(claudeAgents, "claude-only");

		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "user");
			expect(agents.map((a) => a.name)).toEqual(["claude-only"]);
			expect(agents[0].source).toBe("user");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("merges ~/.claude/agents and ~/.pi/agent/agents", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agents-merge-"));
		const claudeAgents = join(dir, ".claude", "agents");
		const piAgents = join(dir, "pi-agent", "agents");
		process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
		writeAgent(claudeAgents, "from-claude");
		writeAgent(piAgents, "from-pi");

		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "user");
			expect(agents.map((a) => a.name).sort()).toEqual(["from-claude", "from-pi"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("~/.pi/agent/agents overrides ~/.claude/agents on name collision", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agents-collision-"));
		const claudeAgents = join(dir, ".claude", "agents");
		const piAgents = join(dir, "pi-agent", "agents");
		process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
		// Same name in both roots; the pi-agent one wins.
		writeAgent(claudeAgents, "shared", "claude description");
		writeAgent(piAgents, "shared", "pi description");

		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "user");
			expect(agents).toHaveLength(1);
			expect(agents[0].name).toBe("shared");
			expect(agents[0].description).toBe("pi description");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores ~/.claude/agents when scope is project (user roots excluded)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agents-project-"));
		const claudeAgents = join(dir, ".claude", "agents");
		process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		writeAgent(claudeAgents, "should-be-absent");

		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "project");
			expect(agents.map((a) => a.name)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips agents missing required frontmatter", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agents-validation-"));
		const claudeAgents = join(dir, ".claude", "agents");
		process.env.PI_CODING_AGENT_DIR = join(dir, "pi-agent");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		mkdirSync(claudeAgents, { recursive: true });
		// missing description → skipped
		writeFileSync(join(claudeAgents, "no-desc.md"), "---\nname: no-desc\n---\nbody\n");
		writeAgent(claudeAgents, "valid");

		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "user");
			expect(agents.map((a) => a.name)).toEqual(["valid"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
