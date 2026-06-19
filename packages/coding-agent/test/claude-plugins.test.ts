import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverClaudePluginPaths } from "../src/core/claude-plugins.ts";

// The module reads from homedir()/.claude/plugins/installed_plugins.json.
// We drive behavior with the PI_DISABLE_CLAUDE_PLUGINS env flag for the
// "disabled" case and use temp dirs + HOME override for structural/edge cases.

const REAL_HOME = process.env.HOME;

function withHome(home: string) {
	process.env.HOME = home;
}

describe("claude-plugins discovery (FEAT-003)", () => {
	beforeEach(() => {
		process.env.HOME = REAL_HOME;
	});
	afterEach(() => {
		process.env.HOME = REAL_HOME;
		process.env.PI_DISABLE_CLAUDE_PLUGINS = "";
	});

	it("returns empty arrays when disabled via PI_DISABLE_CLAUDE_PLUGINS", () => {
		process.env.PI_DISABLE_CLAUDE_PLUGINS = "1";
		const result = discoverClaudePluginPaths();
		expect(result.skillPaths).toEqual([]);
		expect(result.promptPaths).toEqual([]);
		expect(result.loadedPlugins).toEqual([]);
	});

	it("returns empty arrays when installed_plugins.json does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
		withHome(dir);
		try {
			const result = discoverClaudePluginPaths();
			expect(result.skillPaths).toEqual([]);
			expect(result.promptPaths).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tolerates corrupt installed_plugins.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
		const pluginsDir = join(dir, ".claude", "plugins");
		mkdirSync(pluginsDir, { recursive: true });
		writeFileSync(join(pluginsDir, "installed_plugins.json"), "{ not valid json");
		withHome(dir);
		try {
			const result = discoverClaudePluginPaths();
			expect(result.skillPaths).toEqual([]);
			expect(result.promptPaths).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("collects skills/ and commands/ dirs from enabled plugins, skips missing/empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
		const pluginsDir = join(dir, ".claude", "plugins");
		mkdirSync(pluginsDir, { recursive: true });

		// plugin A: has skills + commands
		const pluginA = join(dir, "pluginA", "1.0.0");
		mkdirSync(join(pluginA, "skills", "brainstorming"), { recursive: true });
		writeFileSync(join(pluginA, "skills", "brainstorming", "SKILL.md"), "---\nname: brainstorming\n---\n");
		mkdirSync(join(pluginA, "commands"), { recursive: true });
		writeFileSync(join(pluginA, "commands", "go.md"), "---\ndescription: go\n---\n");

		// plugin B: skills only
		const pluginB = join(dir, "pluginB", "2.0.0");
		mkdirSync(join(pluginB, "skills", "tdd"), { recursive: true });
		writeFileSync(join(pluginB, "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n");

		// plugin C: installPath does not exist on disk
		const pluginC = join(dir, "pluginC-does-not-exist");

		// plugin D: no skills, no commands (e.g. hooks-only)
		const pluginD = join(dir, "pluginD", "1.0.0");
		mkdirSync(pluginD, { recursive: true });

		writeFileSync(
			join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"a@market": [{ scope: "user", installPath: pluginA, version: "1.0.0" }],
					"b@market": [{ scope: "user", installPath: pluginB, version: "2.0.0" }],
					"c@market": [{ scope: "user", installPath: pluginC, version: "1.0.0" }],
					"d@market": [{ scope: "user", installPath: pluginD, version: "1.0.0" }],
				},
			}),
		);
		withHome(dir);
		try {
			const result = discoverClaudePluginPaths();
			expect(result.skillPaths.sort()).toEqual([join(pluginA, "skills"), join(pluginB, "skills")].sort());
			expect(result.promptPaths).toEqual([join(pluginA, "commands")]);
			expect(result.loadedPlugins.sort()).toEqual(["a@market", "b@market"].sort());
			expect(result.loadedPlugins).not.toContain("c@market");
			expect(result.loadedPlugins).not.toContain("d@market");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses the last (latest) install entry when multiple are present", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
		const pluginsDir = join(dir, ".claude", "plugins");
		mkdirSync(pluginsDir, { recursive: true });

		const oldVer = join(dir, "pluginA", "0.9.0");
		mkdirSync(join(oldVer, "skills"), { recursive: true });
		const newVer = join(dir, "pluginA", "1.0.0");
		mkdirSync(join(newVer, "skills", "fresh"), { recursive: true });
		writeFileSync(join(newVer, "skills", "fresh", "SKILL.md"), "---\nname: fresh\n---\n");

		writeFileSync(
			join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				plugins: {
					"a@market": [
						{ installPath: oldVer, version: "0.9.0" },
						{ installPath: newVer, version: "1.0.0" },
					],
				},
			}),
		);
		withHome(dir);
		try {
			const result = discoverClaudePluginPaths();
			expect(result.skillPaths).toEqual([join(newVer, "skills")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("also exposes user-level ~/.claude/skills and ~/.claude/commands", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
		// user-level skills (e.g. compound-engineering ce-* family)
		mkdirSync(join(dir, ".claude", "skills", "ce-compound"), { recursive: true });
		writeFileSync(
			join(dir, ".claude", "skills", "ce-compound", "SKILL.md"),
			"---\nname: ce-compound\ndescription: doc a solved problem\n---\n",
		);
		// user-level command
		mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
		writeFileSync(join(dir, ".claude", "commands", "dual-review.md"), "---\ndescription: dual review\n---\n");
		// no installed_plugins.json -> plugin section contributes nothing,
		// but user-level dirs must still be discovered.
		withHome(dir);
		try {
			const result = discoverClaudePluginPaths();
			expect(result.skillPaths).toEqual([join(dir, ".claude", "skills")]);
			expect(result.promptPaths).toEqual([join(dir, ".claude", "commands")]);
			expect(result.loadedPlugins).toEqual([]); // no plugins in manifest
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("merges plugin paths with user-level paths together", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-claude-plugins-"));
		const pluginsDir = join(dir, ".claude", "plugins");
		mkdirSync(pluginsDir, { recursive: true });

		// a plugin with skills
		const pluginA = join(dir, "pluginA", "1.0.0");
		mkdirSync(join(pluginA, "skills", "tdd"), { recursive: true });
		writeFileSync(join(pluginA, "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n");
		writeFileSync(
			join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({ plugins: { "a@market": [{ installPath: pluginA, version: "1.0.0" }] } }),
		);
		// user-level skills alongside
		mkdirSync(join(dir, ".claude", "skills", "ce-compound"), { recursive: true });
		writeFileSync(join(dir, ".claude", "skills", "ce-compound", "SKILL.md"), "---\nname: ce-compound\n---\n");

		withHome(dir);
		try {
			const result = discoverClaudePluginPaths();
			expect(result.skillPaths).toEqual([
				join(pluginA, "skills"),
				join(dir, ".claude", "skills"),
			]);
			expect(result.loadedPlugins).toEqual(["a@market"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
