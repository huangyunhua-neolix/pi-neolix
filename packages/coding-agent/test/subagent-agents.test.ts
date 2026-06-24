import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, normalizeToolNames } from "../src/core/tools/agent-discovery.ts";

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

describe("normalizeToolNames — Claude Code → pi tool mapping", () => {
	// Silence the dropped-tools warning so test output stays clean; assert on
	// it explicitly in the dedicated test below.
	const realWarn = console.warn;
	beforeEach(() => {
		console.warn = () => {};
	});
	afterEach(() => {
		console.warn = realWarn;
	});

	it("maps PascalCase Claude Code names to pi's lowercase registry", () => {
		expect(normalizeToolNames(["Read", "Grep", "Glob", "Bash", "Edit", "Write"])).toEqual(
			expect.arrayContaining(["read", "grep", "find", "bash", "edit", "write"]),
		);
	});

	it("is case-insensitive", () => {
		expect(normalizeToolNames(["READ", "Grep"])).toEqual(expect.arrayContaining(["read", "grep"]));
	});

	it("drops names that have no pi equivalent (AskUserQuestion, Skill, Task, WebFetch)", () => {
		const result = normalizeToolNames(["Read", "AskUserQuestion", "Skill", "Task", "WebFetch", "Grep"]);
		expect(result).toEqual(expect.arrayContaining(["read", "grep"]));
		expect(result).not.toContain("askuserquestion");
		expect(result).not.toContain("skill");
	});

	it("returns [] (empty allowlist, fail-safe) when declared tools are all unmappable", () => {
		// A restricted agent authored for Claude Code (`tools: AskUserQuestion, Skill`)
		// must NOT silently inherit pi's full default tool set (bash+write) — that
		// would be a privilege expansion. Empty allowlist = child runs with no tools.
		expect(normalizeToolNames(["AskUserQuestion", "Skill", "TodoWrite"])).toEqual([]);
	});

	it("returns undefined only when no tools were declared at all", () => {
		// No `tools:` key in frontmatter, or empty value → inherit pi defaults.
		expect(normalizeToolNames([])).toBeUndefined();
		expect(normalizeToolNames(["", "  "])).toBeUndefined();
	});

	it("warns to stderr listing dropped tool names (original casing preserved)", () => {
		const calls: string[] = [];
		console.warn = (msg: string) => calls.push(msg);
		normalizeToolNames(["Read", "AskUserQuestion", "Skill"]);
		expect(calls).toHaveLength(1);
		// Both dropped names must appear (order-independent), and the mapped
		// name "read" must NOT — if casing broke, "read" would match the
		// dropped-name substring check.
		expect(calls[0]).toMatch(/AskUserQuestion/);
		expect(calls[0]).toMatch(/Skill/);
		expect(calls[0]).not.toMatch(/\bread\b/);
	});

	it("suppresses the dropped-tools warning when PI_QUIET is set", () => {
		const prev = process.env.PI_QUIET;
		process.env.PI_QUIET = "1";
		try {
			const calls: string[] = [];
			console.warn = (msg: string) => calls.push(msg);
			const result = normalizeToolNames(["Read", "AskUserQuestion", "Skill"]);
			// Warning suppressed, but the fail-safe mapping behavior is unchanged.
			expect(calls).toHaveLength(0);
			expect(result).toEqual(expect.arrayContaining(["read"]));
			expect(result).not.toContain("askuserquestion");
		} finally {
			if (prev === undefined) delete process.env.PI_QUIET;
			else process.env.PI_QUIET = prev;
		}
	});

	it("PI_QUIET accepts true / yes / case-insensitive variants", () => {
		for (const value of ["true", "TRUE", "yes", "Yes"]) {
			const prev = process.env.PI_QUIET;
			process.env.PI_QUIET = value;
			try {
				const calls: string[] = [];
				console.warn = (msg: string) => calls.push(msg);
				normalizeToolNames(["Read", "AskUserQuestion"]);
				expect(calls).toHaveLength(0);
			} finally {
				if (prev === undefined) delete process.env.PI_QUIET;
				else process.env.PI_QUIET = prev;
			}
		}
	});

	it("PI_QUIET=1 does NOT expand privileges: all-unmappable tools still → empty allowlist", () => {
		const prev = process.env.PI_QUIET;
		process.env.PI_QUIET = "1";
		try {
			const calls: string[] = [];
			console.warn = (msg: string) => calls.push(msg);
			const result = normalizeToolNames(["AskUserQuestion", "Skill"]);
			// A restricted, ask-only agent authored for Claude Code must NOT inherit
			// pi's full default tool set just because PI_QUIET silences the warning.
			expect(result).toEqual([]);
			expect(calls).toHaveLength(0);
		} finally {
			if (prev === undefined) delete process.env.PI_QUIET;
			else process.env.PI_QUIET = prev;
		}
	});

	it("does not warn when all declared tools map cleanly", () => {
		const calls: string[] = [];
		console.warn = (msg: string) => calls.push(msg);
		normalizeToolNames(["Read", "Grep"]);
		expect(calls).toHaveLength(0);
	});

	it("dedupes when Glob and Find both map to find", () => {
		const result = normalizeToolNames(["Glob", "find"]);
		expect(result).toEqual(["find"]);
	});

	it("end-to-end: an agent file with Claude Code tool names is normalized on discovery", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagent-tools-"));
		const claudeAgents = join(dir, ".claude", "agents");
		mkdirSync(claudeAgents, { recursive: true });
		writeFileSync(
			join(claudeAgents, "reviewer.md"),
			"---\nname: reviewer\ndescription: review\ntools: Read, Grep, Glob, AskUserQuestion, Skill\n---\nbody\n",
		);
		delete process.env.PI_CODING_AGENT_DIR;
		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "user");
			expect(agents).toHaveLength(1);
			expect(agents[0].tools).toEqual(expect.arrayContaining(["read", "grep", "find"]));
			expect(agents[0].tools).not.toContain("AskUserQuestion");
			expect(agents[0].tools).not.toContain("Skill");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("end-to-end: an agent declaring only unmappable tools gets an empty allowlist (fail-safe)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagent-failsafe-"));
		const claudeAgents = join(dir, ".claude", "agents");
		mkdirSync(claudeAgents, { recursive: true });
		writeFileSync(
			join(claudeAgents, "ask-only.md"),
			"---\nname: ask-only\ndescription: ask\ntools: AskUserQuestion, Skill\n---\nbody\n",
		);
		delete process.env.PI_CODING_AGENT_DIR;
		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "user");
			expect(agents).toHaveLength(1);
			// Not undefined (which would inherit defaults) — explicit empty allowlist.
			expect(agents[0].tools).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("end-to-end: an agent with no tools frontmatter inherits defaults (undefined)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagent-notools-"));
		const claudeAgents = join(dir, ".claude", "agents");
		mkdirSync(claudeAgents, { recursive: true });
		writeFileSync(join(claudeAgents, "bare.md"), "---\nname: bare\ndescription: bare\n---\nbody\n");
		delete process.env.PI_CODING_AGENT_DIR;
		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "user");
			expect(agents).toHaveLength(1);
			expect(agents[0].tools).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("end-to-end: whitespace-only tools value is treated as undeclared (inherits defaults)", () => {
		// `tools: "   "` → filter(Boolean) → [] → length 0 guard short-circuits
		// to undefined BEFORE normalizeToolNames runs. This pins the current
		// contract: malformed/empty tools value = "trust platform defaults",
		// NOT "run with no tools" (which would be the fail-safe [] path).
		// If you change loadAgentsFromDir to route whitespace through
		// normalizeToolNames, update this test to expect [].
		const dir = mkdtempSync(join(tmpdir(), "pi-subagent-ws-"));
		const claudeAgents = join(dir, ".claude", "agents");
		mkdirSync(claudeAgents, { recursive: true });
		writeFileSync(join(claudeAgents, "ws.md"), '---\nname: ws\ndescription: ws\ntools: "   "\n---\nbody\n');
		delete process.env.PI_CODING_AGENT_DIR;
		withHome(dir);
		try {
			const { agents } = discoverAgents(join(dir, "cwd"), "user");
			expect(agents).toHaveLength(1);
			expect(agents[0].tools).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
