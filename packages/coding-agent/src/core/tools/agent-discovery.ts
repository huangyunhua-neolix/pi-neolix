/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

const V2 = process.env.PI_AGENT_RUNTIME_V2 === "1";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	color?: string[];
	skills?: string[];
	effort?: string;
	permissionMode?: string;
	isolation?: string;
	maxTurns?: number;
	disallowedTools?: string[];
	initialPrompt?: string;
	background?: unknown;
	memory?: unknown;
	hooks?: unknown;
	mcpServers?: unknown;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Tool-name aliases mapping frontmatter tool names (case-insensitive) to
 * canonical forms. Two tiers:
 *
 *  1. pi-native tools (read, grep, find, ls, bash, edit, write) → lowercased
 *     pi registered names. These are the tools `setActiveToolsByName` actually
 *     activates at spawn time.
 *  2. Cross-CLI tools (Skill, AskUserQuestion, WebFetch, WebSearch, Agent)
 *     → PascalCase canonical names. pi may or may not have implementations for
 *     these (the spawn path decides), but recognizing them here means
 *     `normalizeToolNames` keeps them in the allowlist instead of dropping
 *     them, and `subtractDisallowed` can match disallowedTools entries written
 *     in either naming convention.
 *
 * Names absent from this map are treated as unmappable by `normalizeToolNames`
 * (dropped with a warning) and passed through as-is by `subtractDisallowed`
 * (lowercased, so they only match themselves).
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
	skill: "Skill",
	askuserquestion: "AskUserQuestion",
	webfetch: "WebFetch",
	websearch: "WebSearch",
	agent: "Agent",
	task: "Agent",
	subagent: "Agent",
};

/**
 * Normalize a list of tool names from agent frontmatter to canonical forms
 * (see TOOL_NAME_ALIASES). Case-insensitive; names absent from the alias map
 * are dropped (with a warning) as having no pi or cross-CLI equivalent.
 *
 * Return contract (intentional, security-relevant):
 *   - `undefined` → the frontmatter declared no usable tools, OR no `tools:`
 *     key at all. The caller passes no `--tools` flag and the subagent inherits
 *     pi's default tool set. This is the "agent trusts the platform defaults"
 *     case.
 *   - `[]` (empty array) → the frontmatter DID declare tools, but every one of
 *     them was unmappable (e.g. `tools: SomeUnknownTool` — a name with no entry
 *     in TOOL_NAME_ALIASES). Returning an empty allowlist makes the spawned pi
 *     run with NO tools (fail-safe) instead of silently inheriting full
 *     bash+write, which would invert the agent author's intent ("restricted
 *     agent" → "unrestricted agent"). The caller passes `--tools ""`, which
 *     `setActiveToolsByName` turns into an empty tool set.
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
	// PI_QUIET=1 suppresses informational startup diagnostics. End users running
	// shared Claude Code / freecode agent files don't need the cross-CLI gap
	// report; agent authors can leave PI_QUIET unset (or `export PI_QUIET=`) to
	// see it. Accepts 1 / true / yes (case-insensitive), matching other PI_* flags.
	const quietFlag = process.env.PI_QUIET;
	const quiet = quietFlag === "1" || quietFlag?.toLowerCase() === "true" || quietFlag?.toLowerCase() === "yes";
	if (dropped.length > 0 && !quiet) {
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

/**
 * Subtract disallowed tool names from an allowlist.
 *
 * The allowlist is assumed to already be normalized (output of
 * `normalizeToolNames` — canonical lowercase pi names or PascalCase canonical
 * names for cross-CLI tools). The disallowed list is normalized here using the
 * same alias map so that Claude-Code-style names (Read, Task, subagent, ...)
 * are reduced to the same canonical form before subtraction.
 *
 * Return contract:
 *   - `allowlist === undefined` → return `undefined`. The wildcard allowlist
 *     (agent trusts platform defaults) is NOT narrowed by disallowedTools,
 *     because the author didn't enumerate an explicit allowlist to begin with.
 *   - Otherwise → return a new array with disallowed entries removed.
 */
export function subtractDisallowed(allowlist: string[] | undefined, disallowed: string[]): string[] | undefined {
	if (allowlist === undefined) return undefined;
	if (!disallowed || disallowed.length === 0) return allowlist;

	const disallowedSet = new Set<string>();
	const unmapped: string[] = [];
	for (const raw of disallowed) {
		const key = raw.trim().toLowerCase();
		if (!key) continue;
		const mapped = TOOL_NAME_ALIASES[key];
		if (mapped) {
			disallowedSet.add(mapped);
		} else {
			// FIX-12: previously unmapped names were silently passed through
			// (lowercased), so a typo like `bashx` would never match anything
			// and the disallowed entry would be a no-op. Warn so authors notice.
			disallowedSet.add(key);
			unmapped.push(raw.trim());
		}
	}
	if (unmapped.length > 0) {
		const quietFlag = process.env.PI_QUIET;
		const quiet = quietFlag === "1" || quietFlag?.toLowerCase() === "true" || quietFlag?.toLowerCase() === "yes";
		if (!quiet) {
			// eslint-disable-next-line no-console
			console.warn(
				`[subagent] ${unmapped.length} disallowedTools entr${unmapped.length === 1 ? "y" : "ies"} had no alias mapping: ` +
					`${unmapped.join(", ")}. These will only match tools with the exact same (lowercased) name.`,
			);
		}
	}
	return allowlist.filter((tool) => !disallowedSet.has(tool));
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

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

		const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
		if (!name || !description) {
			continue;
		}

		const rawTools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools
						.split(",")
						.map((t: string) => t.trim())
						.filter(Boolean)
				: [];
		const tools = rawTools.length > 0 ? normalizeToolNames(rawTools) : undefined;

		const splitList = (value: unknown): string[] | undefined => {
			if (typeof value !== "string") return undefined;
			const parts = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			return parts.length > 0 ? parts : undefined;
		};

		const maxTurns =
			typeof frontmatter.maxTurns === "number"
				? frontmatter.maxTurns
				: typeof frontmatter.maxTurns === "string" && frontmatter.maxTurns.trim()
					? Number.parseInt(frontmatter.maxTurns, 10)
					: undefined;

		agents.push({
			name,
			description,
			// Preserve the fail-safe contract from normalizeToolNames: `[]` (all
			// tools unmappable) must stay `[]` so the child runs with no tools,
			// not be collapsed to undefined (which would inherit full defaults).
			tools,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
			// V2-gated extended frontmatter fields. When PI_AGENT_RUNTIME_V2 is
			// off, only the base four (name/description/tools/model) are parsed
			// so flag-off runs match the pre-V2 agent shape exactly.
			...(V2
				? {
						color: splitList(frontmatter.color),
						skills: splitList(frontmatter.skills),
						effort: typeof frontmatter.effort === "string" ? frontmatter.effort : undefined,
						permissionMode:
							typeof frontmatter.permissionMode === "string" ? frontmatter.permissionMode : undefined,
						isolation: typeof frontmatter.isolation === "string" ? frontmatter.isolation : undefined,
						maxTurns,
						disallowedTools: splitList(frontmatter.disallowedTools),
						initialPrompt: typeof frontmatter.initialPrompt === "string" ? frontmatter.initialPrompt : undefined,
						background: frontmatter.background,
						memory: frontmatter.memory,
						hooks: frontmatter.hooks,
						mcpServers: frontmatter.mcpServers,
					}
				: {}),
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
