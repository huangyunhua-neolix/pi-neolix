/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * pi's built-in tool names (lowercase): bash, edit, find, grep, ls, read, write.
 * Agent files shared with Claude Code / freecode use PascalCase names
 * (Read, Grep, Glob, Bash, Edit, Write, AskUserQuestion, Skill, Task, ...).
 * pi's `--tools` filter silently drops unknown names (see setActiveToolsByName
 * in agent-session.ts), so without normalization every declared tool would be
 * discarded and the subagent would fall back to the default tool set — ignoring
 * the frontmatter's intent entirely.
 *
 * This maps the Claude Code aliases onto pi's names and drops the ones that have
 * no pi equivalent (AskUserQuestion, Skill, Task, WebFetch, WebSearch, ...).
 * The list is intentionally exhaustive on the read/write/search/exec axis so a
 * shared agent file works on both CLIs.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
	read: "read",
	grep: "grep",
	glob: "find", // Claude Code's file-pattern search ↔ pi's find
	find: "find",
	ls: "ls",
	bash: "bash",
	edit: "edit",
	write: "write",
};

/**
 * Normalize a list of tool names from agent frontmatter to pi's registered names.
 * Case-insensitive; names with no pi equivalent (AskUserQuestion, Skill, Task,
 * WebFetch, ...) are dropped.
 *
 * Return contract (intentional, security-relevant):
 *   - `undefined` → the frontmatter declared no usable tools, OR no `tools:`
 *     key at all. The caller passes no `--tools` flag and the subagent inherits
 *     pi's default tool set. This is the "agent trusts the platform defaults"
 *     case.
 *   - `[]` (empty array) → the frontmatter DID declare tools, but every one of
 *     them was unmappable (e.g. `tools: AskUserQuestion, Skill` — a restricted,
 *     ask-only agent authored for Claude Code). Returning an empty allowlist
 *     makes the spawned pi run with NO tools (fail-safe) instead of silently
 *     inheriting full bash+write, which would invert the agent author's intent
 *     ("restricted agent" → "unrestricted agent"). The caller passes
 *     `--tools ""`, which `setActiveToolsByName` turns into an empty tool set.
 *
 * Without this distinction, a cross-CLI shared agent file that intentionally
 * restricted tools to Claude-Code-only ones would gain unrestricted bash/write
 * access under pi — a privilege expansion.
 *
 * Dropped names are warned to stderr so authors notice the gap.
 */
export function normalizeToolNames(names: string[]): string[] | undefined {
	const normalized = new Set<string>();
	const dropped: string[] = [];
	let declaredCount = 0;
	for (const raw of names) {
		const key = raw.trim().toLowerCase();
		if (!key) continue;
		declaredCount++;
		const mapped = TOOL_NAME_ALIASES[key];
		if (mapped) {
			normalized.add(mapped);
		} else {
			// Preserve original casing in the warning so authors see what they wrote.
			dropped.push(raw.trim());
		}
	}
	if (dropped.length > 0) {
		// eslint-disable-next-line no-console
		console.warn(
			`[subagent] dropped ${dropped.length} tool(s) with no pi equivalent: ${dropped.join(", ")}. ` +
				"Agent will not have access to these capabilities.",
		);
	}
	// No `tools:` declared at all → inherit defaults. Tools declared but all
	// unmappable → empty allowlist (fail-safe), NOT default inheritance.
	if (declaredCount === 0) return undefined;
	return Array.from(normalized);
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const rawTools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		const tools = rawTools && rawTools.length > 0 ? normalizeToolNames(rawTools) : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			// Preserve the fail-safe contract from normalizeToolNames: `[]` (all
			// tools unmappable) must stay `[]` so the child runs with no tools,
			// not be collapsed to undefined (which would inherit full defaults).
			tools,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Root of the freecode / Claude Code user config tree, normally `~/.claude`.
 * freecode / Claude Code install their agents here (`~/.claude/agents`).
 */
function getClaudeConfigHome(): string {
	return path.join(os.homedir(), ".claude");
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const claudeUserDir = path.join(getClaudeConfigHome(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// User agents come from TWO roots so freecode / Claude Code agents
	// (`~/.claude/agents`) are available too. `~/.pi/agent/agents` takes
	// precedence on name collisions (loaded last → overrides earlier entry).
	const userAgents =
		scope === "project" ? [] : [...loadAgentsFromDir(claudeUserDir, "user"), ...loadAgentsFromDir(userDir, "user")];
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
