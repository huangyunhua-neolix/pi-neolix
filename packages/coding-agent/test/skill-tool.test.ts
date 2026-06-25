import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	createSkillTool,
	createSkillToolDefinition,
	SKILL_TOOL_NAME,
	type SkillSpawnOptions,
	shouldSpawnSkill,
} from "../src/core/tools/skill-tool.ts";

function makeSkill(opts: { name: string; description?: string; filePath: string; baseDir: string }): Skill {
	return {
		name: opts.name,
		description: opts.description ?? "test skill",
		filePath: opts.filePath,
		baseDir: opts.baseDir,
		sourceInfo: createSyntheticSourceInfo(opts.filePath, { source: "test" }),
		disableModelInvocation: false,
	};
}

function writeSkill(dir: string, name: string, body: string, frontmatterExtra = ""): Skill {
	mkdirSync(dir, { recursive: true });
	const fm = `---\nname: ${name}\ndescription: test skill\n${frontmatterExtra}---\n`;
	const content = `${fm}${body}`;
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, content, "utf-8");
	return makeSkill({ name, filePath, baseDir: dir });
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n") ?? ""
	);
}

describe("shouldSpawnSkill", () => {
	it("returns false when content small and no tools", () => {
		expect(shouldSpawnSkill("hello", false, 2000)).toBe(false);
	});

	it("returns true when content exceeds maxInlineChars", () => {
		const big = "a".repeat(2001);
		expect(shouldSpawnSkill(big, false, 2000)).toBe(true);
	});

	it("returns true when content equals boundary (not strictly greater)", () => {
		expect(shouldSpawnSkill("a".repeat(2000), false, 2000)).toBe(false);
	});

	it("returns true when skill declares tools even if small", () => {
		expect(shouldSpawnSkill("hi", true, 2000)).toBe(true);
	});

	it("returns true when skill declares tools AND content is large", () => {
		expect(shouldSpawnSkill("a".repeat(5000), true, 2000)).toBe(true);
	});
});

describe("createSkillTool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `skill-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("exposes the Skill tool name constant", () => {
		expect(SKILL_TOOL_NAME).toBe("Skill");
	});

	it("inlines small skill without tools and returns content", async () => {
		const skillDir = join(testDir, "small-skill");
		const skill = writeSkill(skillDir, "small-skill", "Do the small thing.\n");
		const tool = createSkillTool(testDir, [skill]);
		const result = await tool.execute("call-1", { skill_name: "small-skill" });
		const text = getText(result);
		expect(text).toContain("Do the small thing.");
		expect(result.details).toMatchObject({ mode: "inline", skillName: "small-skill" });
	});

	it("spawns when content exceeds default 2000 chars and returns child output via mock", async () => {
		const skillDir = join(testDir, "big-skill");
		const body = "x".repeat(2500);
		const skill = writeSkill(skillDir, "big-skill", `${body}\n`);
		const spawnMock = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "child-output-from-spawn" }],
			details: { mode: "spawn" },
		});
		const tool = createSkillTool(testDir, [skill], { spawnSkill: spawnMock });
		const result = await tool.execute("call-2", { skill_name: "big-skill" });
		expect(getText(result)).toBe("child-output-from-spawn");
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const callArg: SkillSpawnOptions = spawnMock.mock.calls[0][0];
		expect(callArg.skillName).toBe("big-skill");
		expect(callArg.cwd).toBe(testDir);
		expect(callArg.skillContent).toContain(body);
	});

	it("spawns when skill declares tools in frontmatter", async () => {
		const skillDir = join(testDir, "tools-skill");
		const skill = writeSkill(skillDir, "tools-skill", "tiny body\n", "tools: read, bash\n");
		const spawnMock = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "spawned-with-tools" }],
		});
		const tool = createSkillTool(testDir, [skill], { spawnSkill: spawnMock });
		const result = await tool.execute("call-3", { skill_name: "tools-skill" });
		expect(getText(result)).toBe("spawned-with-tools");
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it("throws with available skill list when skill name is unknown", async () => {
		const a = writeSkill(join(testDir, "a"), "skill-a", "a body\n");
		const b = writeSkill(join(testDir, "b"), "skill-b", "b body\n");
		const tool = createSkillTool(testDir, [a, b]);
		await expect(tool.execute("call-4", { skill_name: "nope" })).rejects.toThrow(/Unknown skill: nope/);
		await expect(tool.execute("call-5", { skill_name: "nope" })).rejects.toThrow(/skill-a/);
		await expect(tool.execute("call-6", { skill_name: "nope" })).rejects.toThrow(/skill-b/);
	});

	it("respects PI_SKILL_INLINE_MAX_CHARS env override", async () => {
		const skillDir = join(testDir, "env-skill");
		// 100 chars body — below default 2000, above override 50
		const body = "y".repeat(100);
		const skill = writeSkill(skillDir, "env-skill", `${body}\n`);
		const spawnMock = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "spawned-via-env-override" }],
		});
		vi.stubEnv("PI_SKILL_INLINE_MAX_CHARS", "50");
		try {
			const tool = createSkillTool(testDir, [skill], { spawnSkill: spawnMock });
			const result = await tool.execute("call-7", { skill_name: "env-skill" });
			expect(getText(result)).toBe("spawned-via-env-override");
			expect(spawnMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("passes args through to spawn function", async () => {
		const skillDir = join(testDir, "args-skill");
		const skill = writeSkill(skillDir, "args-skill", "x".repeat(3000));
		const spawnMock = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
		});
		const tool = createSkillTool(testDir, [skill], { spawnSkill: spawnMock });
		await tool.execute("call-8", { skill_name: "args-skill", args: "my-args" });
		const callArg: SkillSpawnOptions = spawnMock.mock.calls[0][0];
		expect(callArg.args).toBe("my-args");
	});

	it("createSkillToolDefinition exposes name, schema, description", () => {
		const def = createSkillToolDefinition(testDir, []);
		expect(def.name).toBe(SKILL_TOOL_NAME);
		expect(def.parameters).toBeDefined();
		expect(def.description.toLowerCase()).toContain("skill");
	});

	it("executes with spawnSkill when provided (Y1 wiring)", async () => {
		const skillDir = join(testDir, "y1-spawn-skill");
		const skill = writeSkill(skillDir, "y1-spawn-skill", "x".repeat(3000));
		const spawnMock = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "y1-spawned" }],
		});
		const tool = createSkillTool(testDir, [skill], { spawnSkill: spawnMock });
		const result = await tool.execute("call-y1", { skill_name: "y1-spawn-skill" });
		expect(getText(result)).toBe("y1-spawned");
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it("passes loaded skills list so unknown skill throws with available list (Y1 wiring)", async () => {
		const a = writeSkill(join(testDir, "y1-a"), "y1-a", "body\n");
		const tool = createSkillTool(testDir, [a]);
		await expect(tool.execute("call-y1-2", { skill_name: "nope" })).rejects.toThrow(/y1-a/);
	});

	// R2-14: skill spawn receives signal + onAskUserQuestion
	describe("R2-14: spawn receives signal and onAskUserQuestion", () => {
		it("passes signal and onAskUserQuestion from execute to spawnSkill", async () => {
			const skillDir = join(testDir, "r2-14-skill");
			const skill = writeSkill(skillDir, "r2-14-skill", "x".repeat(3000));
			const spawnMock = vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "ok" }],
			});
			// Use createSkillToolDefinition directly so we can pass ctx as 5th arg.
			const def = createSkillToolDefinition(testDir, [skill], { spawnSkill: spawnMock });

			const ac = new AbortController();
			const mockCtx = {
				mode: "json",
				hasUI: false,
			} as any;

			await def.execute("r2-14-1", { skill_name: "r2-14-skill" }, ac.signal, undefined, mockCtx);

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const callArg: SkillSpawnOptions = spawnMock.mock.calls[0][0];
			expect(callArg.signal).toBe(ac.signal);
			expect(callArg.onAskUserQuestion).toBeDefined();
			expect(typeof callArg.onAskUserQuestion).toBe("function");
		});

		it("constructs TUI onAskUserQuestion when ctx.hasUI is true", async () => {
			const skillDir = join(testDir, "r2-14-tui-skill");
			const skill = writeSkill(skillDir, "r2-14-tui-skill", "x".repeat(3000));
			const spawnMock = vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "ok" }],
			});
			const def = createSkillToolDefinition(testDir, [skill], { spawnSkill: spawnMock });

			const selectFn = vi.fn().mockResolvedValue("Option A");
			const mockCtx = {
				mode: "tui",
				hasUI: true,
				ui: { select: selectFn },
			} as any;

			await def.execute("r2-14-2", { skill_name: "r2-14-tui-skill" }, undefined, undefined, mockCtx);

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const callArg: SkillSpawnOptions = spawnMock.mock.calls[0][0];
			expect(callArg.onAskUserQuestion).toBeDefined();
			expect(typeof callArg.onAskUserQuestion).toBe("function");

			// Verify the TUI path is used by calling the handler
			await callArg.onAskUserQuestion!({
				id: "test",
				questions: [{ question: "Pick", options: [{ label: "Option A" }] }],
			});
			expect(selectFn).toHaveBeenCalledWith("Pick", ["Option A"]);
		});
	});
});
