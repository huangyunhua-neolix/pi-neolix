/**
 * Claude Code plugin discovery (FEAT-003).
 *
 * pi reuses Claude Code / freecode's installed plugins to provide their skills
 * and slash commands. This module reads `~/.claude/plugins/installed_plugins.json`
 * (the canonical record of which plugins are installed/enabled, as written by
 * freecode CLI's plugin manager) and exposes the per-plugin `skills/` and
 * `commands/` directories so pi's own skill/prompt loaders can pick them up.
 *
 * Scope (plan A): discovery only — pi does NOT install/update plugins itself.
 * Install plugins through freecode CLI (`/plugin ...`) and pi will pick them up
 * on the next reload. Only skills (SKILL.md) and prompt-style commands
 * (`.md` with frontmatter) are consumed; plugin hooks, MCP servers, and other
 * plugin machinery are ignored.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePath } from "../utils/paths.ts";

/** Root of the freecode/Claude Code plugin store, normally `~/.claude`. */
function getClaudeConfigHome(): string {
	return resolvePath(join(homedir(), ".claude"));
}

/** Shape of `~/.claude/plugins/installed_plugins.json` (only the fields we use). */
interface InstalledPluginsFile {
	version?: number;
	plugins?: Record<string, Array<{
		scope?: string;
		installPath?: string;
		version?: string;
	}>>;
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
	if (!existsSync(manifestPath)) {
		return result;
	}

	let parsed: InstalledPluginsFile;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as InstalledPluginsFile;
	} catch {
		// Corrupt manifest — leave pi untouched.
		return result;
	}

	const plugins = parsed.plugins;
	if (!plugins || typeof plugins !== "object") {
		return result;
	}

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

	return result;
}
