import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { StringEnum } from "../../src/utils/typebox-helpers.ts";

describe("StringEnum", () => {
	it("produces a string schema with the provided enum values", () => {
		const schema = StringEnum(["add", "subtract", "multiply", "divide"]);

		expect(schema.type).toBe("string");
		expect(schema.enum).toEqual(["add", "subtract", "multiply", "divide"]);
		// The schema object is JSON-serializable (no functions / symbols).
		expect(JSON.parse(JSON.stringify(schema)).enum).toEqual([
			"add",
			"subtract",
			"multiply",
			"divide",
		]);
	});

	it("accepts optional description and default fields", () => {
		const schema = StringEnum(["a", "b"], {
			description: "pick one",
			default: "a",
		});

		expect(schema.description).toBe("pick one");
		expect(schema.default).toBe("a");
		expect(schema.enum).toEqual(["a", "b"]);
		expect(schema.type).toBe("string");
	});

	it("omits description / default when not provided", () => {
		const schema = StringEnum(["x", "y"]);

		expect("description" in schema).toBe(false);
		expect("default" in schema).toBe(false);
	});

	it("accepts values provided as a readonly tuple", () => {
		const values = ["red", "green", "blue"] as const;
		const schema = StringEnum(values);

		expect(schema.enum).toEqual(["red", "green", "blue"]);
	});

	it("accepts a single-value enum", () => {
		const schema = StringEnum(["only"]);

		expect(schema.enum).toEqual(["only"]);
		expect(Value.Check(schema, "only")).toBe(true);
		expect(Value.Check(schema, "other")).toBe(false);
	});

	it("validates enum members and rejects non-members (happy path + error path)", () => {
		const schema = StringEnum(["add", "subtract", "multiply", "divide"], {
			description: "The operation to perform",
			default: "add",
		});

		// Happy path: every declared member validates.
		for (const value of ["add", "subtract", "multiply", "divide"]) {
			expect(Value.Check(schema, value)).toBe(true);
		}

		// The configured default must be a valid member.
		expect(Value.Check(schema, schema.default)).toBe(true);

		// Error path: unknown members and non-string values are rejected.
		expect(Value.Check(schema, "modulo")).toBe(false);
		expect(Value.Check(schema, "ADD")).toBe(false);
		expect(Value.Check(schema, "")).toBe(false);
		expect(Value.Check(schema, 42)).toBe(false);
		expect(Value.Check(schema, null)).toBe(false);
		expect(Value.Check(schema, true)).toBe(false);
		expect(Value.Check(schema, { value: "add" })).toBe(false);
		expect(Value.Check(schema, ["add"])).toBe(false);
	});
});
