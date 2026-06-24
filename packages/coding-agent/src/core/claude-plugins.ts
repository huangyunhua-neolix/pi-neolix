/**
 * Claude Code / freecode plugin & user-resource discovery (FEAT-003).
 *
 * pi reuses Claude Code / freecode's installed plugins AND user-level
 * resource directories so the same skills and slash commands are available
 * in pi without reimplementing the marketplace/installer. Two sources:
 *
 *   1. Plugins: `~/.claude/plugins/installed_plugins.json` lists each enabled
 *      plugin's installPath; we expose its `skills/` and `commands/` dirs
 *      (e.g. superpowers, ralph-loop).
 *   2. User level: `~/.claude/skills/`, `~/.claude/commands/`, and
 *      `~/.claude/agents/` — the freecode/Claude Code user resource roots.
 *      This is where compound-engineering skills (ce-*), user-defined slash
 *      commands, and user-defined subagent definitions live.
 *
 * Note on agents: pi has no subagent dispatch machinery, so agent files
 * (`~/.claude/agents/*.md`) are surfaced as prompt-style templates — typing
 * `/<agent-name>` injects the agent's system-prompt body into the current
 * session. This is not a true fork; it is a convenience alias that matches
 * the freecode-CLI user experience for the common "load this persona" case.
 *
 * Scope (plan A): discovery only — pi does NOT install/update plugins itself.
 * Install plugins through freecode CLI (`/plugin ...`) and pi will pick them up
 * on the next reload. Only skills (SKILL.md) and prompt-style commands
 * (`.md` with frontmatter) are consumed; plugin hooks, MCP servers, and other
 * plugin machinery are ignored.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { resolvePath } from "../utils/paths.ts";

/** Root of the freecode/Claude Code plugin store, normally `~/.claude`. */
function getClaudeConfigHome(): string {
	return resolvePath(join(homedir(), ".claude"));
}

/** Shape of `~/.claude/plugins/installed_plugins.json` (only the fields we use). */
interface InstalledPluginsFile {
	version?: number;
	plugins?: Record<
		string,
		Array<{
			scope?: string;
			installPath?: string;
			version?: string;
		}>
	>;
}

export interface ClaudePluginPaths {
	/** Directories to scan for SKILL.md, i.e. `<installPath>/skills`. */
	skillPaths: string[];
	/** Directories to scan for prompt-style commands, i.e. `<installPath>/commands`. */
	promptPaths: string[];
	/** `<name>@<marketplace>` for each plugin whose installPath was used. */
	loadedPlugins: string[];
}

/** Sentinel returned when plugins are disabled via env (for tests/offline). */
function isDisabled(): boolean {
	return process.env.PI_DISABLE_CLAUDE_PLUGINS === "1";
}

/**
 * Read `installed_plugins.json` and collect existing `skills/` and `commands/`
 * directories from each enabled plugin's installPath.
 *
 * Defensive by design: any malformed JSON, missing file, or non-existent
 * installPath is silently skipped (this mirrors freecode's tolerant loading
 * and never breaks pi startup).
 */
export function discoverClaudePluginPaths(): ClaudePluginPaths {
	const result: ClaudePluginPaths = { skillPaths: [], promptPaths: [], loadedPlugins: [] };
	if (isDisabled()) {
		return result;
	}

	const manifestPath = join(getClaudeConfigHome(), "plugins", "installed_plugins.json");
	if (existsSync(manifestPath)) {
		let parsed: InstalledPluginsFile;
		try {
			parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as InstalledPluginsFile;
		} catch {
			// Corrupt manifest — skip plugin discovery, but still expose
			// user-level dirs below.
			parsed = {};
		}

		const plugins = parsed.plugins;
		if (plugins && typeof plugins === "object") {
			for (const [key, installs] of Object.entries(plugins)) {
				if (!Array.isArray(installs) || installs.length === 0) {
					continue;
				}
				// Use the most recent install entry (last in array). freecode appends on
				// update, so the tail is the current version.
				const latest = installs[installs.length - 1];
				const installPath = latest?.installPath;
				if (!installPath) {
					continue;
				}
				if (!existsSync(installPath)) {
					continue;
				}
				// Defense in depth: only accept plugin install paths under the user's home
				// directory. A tampered installed_plugins.json could otherwise point
				// installPath at an arbitrary absolute location (e.g. /tmp/evil or /etc/...)
				// whose skills/ would be loaded into every pi session's system prompt.
				// Plugins legitimately live somewhere under $HOME (under ~/.claude, a
				// project dir, etc.), so bounding to $HOME rejects truly external paths
				// while keeping all real install locations.
				const home = homedir();
				const resolvedInstall = resolvePath(installPath);
				if (home && resolvedInstall !== home && !resolvedInstall.startsWith(home + sep)) {
					continue;
				}
				// Skip the plugin cache directory. Claude Code installs plugins into
				// `~/.claude/plugins/cache/<publisher>/<plugin>/<version>/`, and those
				// same skills are mirrored at the user level (`~/.claude/skills/`).
				// Loading both creates 14+ "collision" diagnostics for superpowers
				// skills (brainstorming, test-driven-development, ...). The user-level
				// copies are the trusted source, so we ignore the cache entirely.
				// Case-insensitive: macOS HFS+ is case-insensitive, so /Plugins/CACHE/
				// would evade a case-sensitive check and re-introduce the collisions.
				const normalizedInstall = installPath.replace(/\\/g, "/").toLowerCase();
				if (normalizedInstall.includes("/plugins/cache/")) {
					continue;
				}

				const skillsDir = join(installPath, "skills");
				const commandsDir = join(installPath, "commands");
				if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
					result.skillPaths.push(resolvePath(skillsDir));
					result.loadedPlugins.push(key);
				}
				if (existsSync(commandsDir) && statSync(commandsDir).isDirectory()) {
					result.promptPaths.push(resolvePath(commandsDir));
				}
			}
		}
	}

	// FEAT-003 (user level): also expose freecode's user resource roots,
	// `~/.claude/skills`, `~/.claude/commands`, and `~/.claude/agents`. These
	// hold user-installed skills (e.g. the compound-engineering `ce-*` family),
	// user-defined slash commands, and user-defined subagent definitions,
	// mirrored verbatim from Claude Code / freecode. Agent files are folded
	// into promptPaths so they surface as `/<agent-name>` slash commands
	// (pi has no subagent dispatch — see file header).
	const userSkillsDir = join(getClaudeConfigHome(), "skills");
	const userCommandsDir = join(getClaudeConfigHome(), "commands");
	const userAgentsDir = join(getClaudeConfigHome(), "agents");
	if (existsSync(userSkillsDir) && statSync(userSkillsDir).isDirectory()) {
		result.skillPaths.push(resolvePath(userSkillsDir));
	}
	if (existsSync(userCommandsDir) && statSync(userCommandsDir).isDirectory()) {
		result.promptPaths.push(resolvePath(userCommandsDir));
	}
	if (existsSync(userAgentsDir) && statSync(userAgentsDir).isDirectory()) {
		result.promptPaths.push(resolvePath(userAgentsDir));
	}

	return result;
}
