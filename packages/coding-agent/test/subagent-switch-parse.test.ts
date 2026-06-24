import { describe, expect, it } from "vitest";
import { parseAgentSwitchInput } from "../examples/extensions/subagent/index.ts";

/**
 * parseAgentSwitchInput is the pure parser behind the `/agent:` input handler.
 * It owns the #4 edge cases: reserved "off", trailing-task carry-through, empty
 * name, and pass-through for non-`/agent:` input.
 */
describe("parseAgentSwitchInput", () => {
	it("passes through non-/agent: input unchanged", () => {
		expect(parseAgentSwitchInput("hello world")).toEqual({ kind: "passthrough", name: "", task: "" });
		expect(parseAgentSwitchInput("/skill:foo bar")).toEqual({ kind: "passthrough", name: "", task: "" });
		expect(parseAgentSwitchInput("/agent")).toEqual({ kind: "passthrough", name: "", task: "" });
	});

	it("parses /agent:<name> <task>", () => {
		expect(parseAgentSwitchInput("/agent:code-reviewer review this diff")).toEqual({
			kind: "switch",
			name: "code-reviewer",
			task: "review this diff",
		});
	});

	it("parses /agent:<name> with no task", () => {
		expect(parseAgentSwitchInput("/agent:planner")).toEqual({ kind: "switch", name: "planner", task: "" });
	});

	it("parses /agent:off (no task) as kind 'off' — 'off' is reserved", () => {
		expect(parseAgentSwitchInput("/agent:off")).toEqual({ kind: "off", name: "off", task: "" });
	});

	it("parses /agent:off <task> as 'off' with the trailing task (run as base after exit)", () => {
		expect(parseAgentSwitchInput("/agent:off now do something else")).toEqual({
			kind: "off",
			name: "off",
			task: "now do something else",
		});
	});

	it("an agent literally named 'off' is shadowed — parses as 'off', not 'switch'", () => {
		// This is the documented reserved-name behavior: such an agent must be
		// dispatched one-shot via the `subagent` tool or renamed.
		expect(parseAgentSwitchInput("/agent:off anything")).toEqual({
			kind: "off",
			name: "off",
			task: "anything",
		});
	});

	it("parses /agent: with nothing after as switch with empty name", () => {
		expect(parseAgentSwitchInput("/agent:")).toEqual({ kind: "switch", name: "", task: "" });
	});

	it("trims leading/trailing whitespace of name and task", () => {
		expect(parseAgentSwitchInput("/agent:foo    do   X  ")).toEqual({
			kind: "switch",
			name: "foo",
			task: "do   X",
		});
	});
});
