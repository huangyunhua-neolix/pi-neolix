export {
	AGENT_TOOL_NAME,
	createAgentTool,
	createAgentToolDefinition,
} from "./agent-tool.ts";
export {
	ASK_USER_QUESTION_TOOL_NAME,
	createAskUserQuestionTool,
	createAskUserQuestionToolDefinition,
} from "./ask-user-question.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createSkillTool,
	createSkillToolDefinition,
	SKILL_TOOL_NAME,
	type SkillToolOptions,
} from "./skill-tool.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWebFetchTool,
	createWebFetchToolDefinition,
	WEB_FETCH_TOOL_NAME,
} from "./web-fetch.ts";
export {
	createWebSearchTool,
	createWebSearchToolDefinition,
	WEB_SEARCH_TOOL_NAME,
} from "./web-search.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import type { Skill } from "../skills.ts";
import { createAgentTool, createAgentToolDefinition } from "./agent-tool.ts";
import { createAskUserQuestionTool, createAskUserQuestionToolDefinition } from "./ask-user-question.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createSkillTool, createSkillToolDefinition, type SkillToolOptions } from "./skill-tool.ts";
import { createWebFetchTool, createWebFetchToolDefinition } from "./web-fetch.ts";
import { createWebSearchTool, createWebSearchToolDefinition } from "./web-search.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

const V2 = process.env.PI_AGENT_RUNTIME_V2 === "1";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "Agent"
	| "Skill"
	| "AskUserQuestion"
	| "WebFetch"
	| "WebSearch";

const V2_TOOL_NAMES: ToolName[] = ["Agent", "Skill", "AskUserQuestion", "WebFetch", "WebSearch"];

export const allToolNames: Set<ToolName> = new Set<ToolName>([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	...(V2 ? V2_TOOL_NAMES : []),
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	skill?: SkillToolOptions & { skills?: Skill[] };
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "Agent":
			return createAgentToolDefinition(cwd);
		case "Skill":
			return createSkillToolDefinition(cwd, options?.skill?.skills ?? [], options?.skill);
		case "AskUserQuestion":
			return createAskUserQuestionToolDefinition(cwd);
		case "WebFetch":
			return createWebFetchToolDefinition(cwd);
		case "WebSearch":
			return createWebSearchToolDefinition(cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "Agent":
			return createAgentTool(cwd);
		case "Skill":
			return createSkillTool(cwd, options?.skill?.skills ?? [], options?.skill);
		case "AskUserQuestion":
			return createAskUserQuestionTool(cwd);
		case "WebFetch":
			return createWebFetchTool(cwd);
		case "WebSearch":
			return createWebSearchTool(cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const base: Record<string, ToolDef> = {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
	};
	if (V2) {
		base.Agent = createAgentToolDefinition(cwd);
		base.Skill = createSkillToolDefinition(cwd, options?.skill?.skills ?? [], options?.skill);
		base.AskUserQuestion = createAskUserQuestionToolDefinition(cwd);
		base.WebFetch = createWebFetchToolDefinition(cwd);
		base.WebSearch = createWebSearchToolDefinition(cwd);
	}
	return base as Record<ToolName, ToolDef>;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const base: Record<string, Tool> = {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
	};
	if (V2) {
		base.Agent = createAgentTool(cwd);
		base.Skill = createSkillTool(cwd, options?.skill?.skills ?? [], options?.skill);
		base.AskUserQuestion = createAskUserQuestionTool(cwd);
		base.WebFetch = createWebFetchTool(cwd);
		base.WebSearch = createWebSearchTool(cwd);
	}
	return base as Record<ToolName, Tool>;
}
