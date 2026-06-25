import { describe, expect, it } from "vitest";
import {
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	bashExecutionToText,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../../src/harness/messages.ts";

describe("bashExecutionToText", () => {
	it("renders command and output in a fenced block", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "npm run build",
			output: "compiled successfully",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		});
		expect(text).toBe("Ran `npm run build`\n```\ncompiled successfully\n```");
	});

	it("renders (no output) when output is empty", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "true",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		});
		expect(text).toBe("Ran `true`\n(no output)");
	});

	it("appends the non-zero exit code", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "npm test",
			output: "fail",
			exitCode: 2,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		});
		expect(text).toContain("Command exited with code 2");
	});

	it("appends a cancelled marker instead of the exit code when cancelled", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "sleep 10",
			output: "",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			timestamp: 0,
		});
		expect(text).toContain("(command cancelled)");
		expect(text).not.toContain("Command exited with code");
	});

	it("appends a truncation pointer when truncated with a full output path", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "cat big.log",
			output: "head",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: "/tmp/big.log",
			timestamp: 0,
		});
		expect(text).toContain("[Output truncated. Full output: /tmp/big.log]");
	});

	it("omits the truncation pointer when truncated but no path is set", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "cat big.log",
			output: "head",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			timestamp: 0,
		});
		expect(text).not.toContain("[Output truncated");
	});

	it("omits the exit code line when exitCode is 0", () => {
		const text = bashExecutionToText({
			role: "bashExecution",
			command: "ok",
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 0,
		});
		expect(text).not.toContain("Command exited with code");
	});

	it("omits the exit code line when exitCode is null or undefined", () => {
		for (const exitCode of [null, undefined] as const) {
			const text = bashExecutionToText({
				role: "bashExecution",
				command: "ok",
				output: "done",
				exitCode: exitCode as undefined,
				cancelled: false,
				truncated: false,
				timestamp: 0,
			});
			expect(text).not.toContain("Command exited with code");
		}
	});
});

describe("createBranchSummaryMessage", () => {
	it("builds a branchSummary message with a numeric timestamp parsed from ISO", () => {
		const iso = "2026-01-15T10:30:00.000Z";
		const message = createBranchSummaryMessage("summary text", "branch-1", iso);
		expect(message.role).toBe("branchSummary");
		expect(message.summary).toBe("summary text");
		expect(message.fromId).toBe("branch-1");
		expect(message.timestamp).toBe(Date.parse(iso));
	});
});

describe("createCompactionSummaryMessage", () => {
	it("builds a compactionSummary message with tokensBefore and numeric timestamp", () => {
		const iso = "2026-02-20T08:00:00.000Z";
		const message = createCompactionSummaryMessage("compact text", 1234, iso);
		expect(message.role).toBe("compactionSummary");
		expect(message.summary).toBe("compact text");
		expect(message.tokensBefore).toBe(1234);
		expect(message.timestamp).toBe(Date.parse(iso));
	});
});

describe("createCustomMessage", () => {
	it("builds a custom message from a string content with details", () => {
		const iso = "2026-03-10T12:00:00.000Z";
		const message = createCustomMessage("note", "hello", true, { tag: "x" }, iso);
		expect(message.role).toBe("custom");
		expect(message.customType).toBe("note");
		expect(message.content).toBe("hello");
		expect(message.display).toBe(true);
		expect(message.details).toEqual({ tag: "x" });
		expect(message.timestamp).toBe(Date.parse(iso));
	});

	it("builds a custom message from structured content with no details", () => {
		const iso = "2026-03-10T12:00:00.000Z";
		const content = [{ type: "text" as const, text: "hi" }];
		const message = createCustomMessage("info", content, false, undefined, iso);
		expect(message.content).toBe(content);
		expect(message.display).toBe(false);
		expect(message.details).toBeUndefined();
	});
});

describe("summary prefix/suffix constants", () => {
	it("exposes the compaction summary wrapper constants", () => {
		expect(COMPACTION_SUMMARY_PREFIX).toContain("<summary>");
		expect(COMPACTION_SUMMARY_SUFFIX).toContain("</summary>");
	});

	it("exposes the branch summary wrapper constants", () => {
		expect(BRANCH_SUMMARY_PREFIX).toContain("<summary>");
		expect(BRANCH_SUMMARY_SUFFIX).toBe("</summary>");
	});
});
