import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { Skill } from "../skills.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const SKILL_TOOL_NAME = "Skill";

const DEFAULT_INLINE_MAX_CHARS = 2000;

const skillSchema = Type.Object({
	skill_name: Type.String({ description: "Name of the skill to invoke" }),
	args: Type.Optional(Type.String({ description: "Optional arguments to pass to the skill" })),
});

export type SkillToolInput = Static<typeof skillSchema>;

export interface SkillSpawnOptions {
	skillName: string;
	skillContent: string;
	skillFilePath: string;
	skillBaseDir: string;
	args?: string;
	cwd: string;
}

export type SpawnSkillFn = (opts: SkillSpawnOptions) => Promise<{ content: TextContent[]; details?: unknown }>;

export interface SkillToolOptions {
	maxInlineChars?: number;
	spawnSkill?: SpawnSkillFn;
}

export function shouldSpawnSkill(skillContent: string, skillDeclaresTools: boolean, maxInlineChars: number): boolean {
	if (skillDeclaresTools) return true;
	return skillContent.length > maxInlineChars;
}

export function resolveMaxInlineChars(override?: number): number {
	if (override !== undefined) return override;
	const env = process.env.PI_SKILL_INLINE_MAX_CHARS;
	if (env !== undefined && env !== "") {
		const parsed = Number.parseInt(env, 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return DEFAULT_INLINE_MAX_CHARS;
}

function skillDeclaresTools(frontmatter: Record<string, unknown>): boolean {
	const tools = frontmatter.tools;
	if (tools === undefined || tools === null) return false;
	if (typeof tools === "string") return tools.trim() !== "";
	if (Array.isArray(tools)) return tools.length > 0;
	if (typeof tools === "boolean") return tools;
	return Boolean(tools);
}

export function createSkillToolDefinition(
	cwd: string,
	skills: Skill[],
	options?: SkillToolOptions,
): ToolDefinition<typeof skillSchema, unknown> {
	const maxInlineChars = resolveMaxInlineChars(options?.maxInlineChars);
	const spawnSkill = options?.spawnSkill;

	return {
		name: SKILL_TOOL_NAME,
		label: "skill",
		description:
			"Invoke a skill by name. Small skills without declared tools are inlined into the conversation; large skills or skills that declare tools are spawned as a subprocess.",
		promptSnippet: "Invoke a skill",
		parameters: skillSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { skill_name, args } = params;
			const skill = skills.find((s) => s.name === skill_name);
			if (!skill) {
				const available = skills.map((s) => s.name).join(", ");
				throw new Error(`Unknown skill: ${skill_name}. Available skills: ${available || "(none)"}`);
			}

			const rawContent = readFileSync(skill.filePath, "utf-8");
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(rawContent);
			const skillContent = body;
			const declaresTools = skillDeclaresTools(frontmatter);

			if (shouldSpawnSkill(skillContent, declaresTools, maxInlineChars)) {
				if (!spawnSkill) {
					throw new Error(`Skill ${skill.name} requires spawn but no spawnSkill function was provided`);
				}
				const spawnResult = await spawnSkill({
					skillName: skill.name,
					skillContent,
					skillFilePath: skill.filePath,
					skillBaseDir: skill.baseDir,
					args,
					cwd,
				});
				return {
					content: spawnResult.content,
					details: spawnResult.details ?? { mode: "spawn", skillName: skill.name },
				};
			}

			const content: TextContent[] = [{ type: "text", text: skillContent }];
			return { content, details: { mode: "inline", skillName: skill.name } };
		},
	};
}

export function createSkillTool(
	cwd: string,
	skills: Skill[],
	options?: SkillToolOptions,
): AgentTool<typeof skillSchema> {
	return wrapToolDefinition(createSkillToolDefinition(cwd, skills, options));
}
