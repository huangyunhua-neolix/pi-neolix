import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("includes /clear as an alias of /new", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
		expect(names).toContain("clear");
		expect(names).toContain("new");
	});

	it("describes /clear as starting a fresh session", () => {
		const clear = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "clear");
		expect(clear).toBeDefined();
		expect(clear?.description).toMatch(/new session|clear/i);
	});
});
