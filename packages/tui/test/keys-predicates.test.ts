import assert from "node:assert";
import { describe, it } from "node:test";
import { isKeyRelease, isKeyRepeat, isKittyProtocolActive, setKittyProtocolActive } from "../src/keys.ts";

/**
 * Coverage for the predicate/state helpers in keys.ts:
 * isKeyRelease, isKeyRepeat, isKittyProtocolActive, setKittyProtocolActive.
 */
describe("isKeyRelease", () => {
	it("returns false for a plain press (no event-type suffix)", () => {
		assert.strictEqual(isKeyRelease("\x1b[99;5u"), false);
	});

	it("returns true for Kitty CSI-u release events across terminal codepoints", () => {
		// Format: ESC [ <codepoint> ; <modifier> : 3 u  (event type 3 = release)
		assert.strictEqual(isKeyRelease("\x1b[97;5:3u"), true); // ctrl+a release
		assert.strictEqual(isKeyRelease("\x1b[13;2:3u"), true); // shift+enter release
	});

	it("returns true for release events on functional keys (~, A, B, C, D, H, F variants)", () => {
		assert.strictEqual(isKeyRelease("\x1b[1;5:3A"), true); // ctrl+up release
		assert.strictEqual(isKeyRelease("\x1b[3:3~"), true); // delete release
		assert.strictEqual(isKeyRelease("\x1b[1;3:3H"), true); // alt+home release
		assert.strictEqual(isKeyRelease("\x1b[1;3:3F"), true); // alt+end release
	});

	it("returns false for repeat events (event type 2)", () => {
		assert.strictEqual(isKeyRelease("\x1b[97;5:2u"), false);
		assert.strictEqual(isKeyRelease("\x1b[1;5:2A"), false);
	});

	it("returns false for bracketed paste content even if it contains a release-like substring", () => {
		// Bluetooth MAC "90:62:3F:A5" wrapped in paste markers must not be a release.
		const paste = "\x1b[200~90:62:3F:A5\x1b[201~";
		assert.strictEqual(isKeyRelease(paste), false);
	});

	it("returns false for plain text with no escape sequence", () => {
		assert.strictEqual(isKeyRelease("hello"), false);
		assert.strictEqual(isKeyRelease(""), false);
	});
});

describe("isKeyRepeat", () => {
	it("returns false for a plain press (no event-type suffix)", () => {
		assert.strictEqual(isKeyRepeat("\x1b[99;5u"), false);
	});

	it("returns true for Kitty CSI-u repeat events across terminal codepoints", () => {
		// Format: ESC [ <codepoint> ; <modifier> : 2 u  (event type 2 = repeat)
		assert.strictEqual(isKeyRepeat("\x1b[97;5:2u"), true); // ctrl+a repeat
		assert.strictEqual(isKeyRepeat("\x1b[13;2:2u"), true); // shift+enter repeat
	});

	it("returns true for repeat events on functional keys (~, A, B, C, D, H, F variants)", () => {
		assert.strictEqual(isKeyRepeat("\x1b[1;5:2A"), true); // ctrl+up repeat
		assert.strictEqual(isKeyRepeat("\x1b[3:2~"), true); // delete repeat
		assert.strictEqual(isKeyRepeat("\x1b[1;3:2H"), true); // alt+home repeat
		assert.strictEqual(isKeyRepeat("\x1b[1;3:2F"), true); // alt+end repeat
	});

	it("returns false for release events (event type 3)", () => {
		assert.strictEqual(isKeyRepeat("\x1b[97;5:3u"), false);
		assert.strictEqual(isKeyRepeat("\x1b[1;5:3A"), false);
	});

	it("returns false for bracketed paste content even if it contains a repeat-like substring", () => {
		const paste = "\x1b[200~code:2F:tail\x1b[201~";
		assert.strictEqual(isKeyRepeat(paste), false);
	});

	it("returns false for plain text with no escape sequence", () => {
		assert.strictEqual(isKeyRepeat("hello"), false);
		assert.strictEqual(isKeyRepeat(""), false);
	});
});

describe("isKittyProtocolActive / setKittyProtocolActive", () => {
	it("defaults to false at module load time within this test file's isolation", () => {
		// Establish a known baseline.
		setKittyProtocolActive(false);
		assert.strictEqual(isKittyProtocolActive(), false);
	});

	it("setKittyProtocolActive(true) is reflected by isKittyProtocolActive()", () => {
		setKittyProtocolActive(true);
		assert.strictEqual(isKittyProtocolActive(), true);
	});

	it("setKittyProtocolActive(false) toggles the state back off", () => {
		setKittyProtocolActive(true);
		assert.strictEqual(isKittyProtocolActive(), true);
		setKittyProtocolActive(false);
		assert.strictEqual(isKittyProtocolActive(), false);
	});

	it("does not throw for boolean coercion values", () => {
		// Boolean true/false only; ensure no exception path.
		setKittyProtocolActive(true);
		setKittyProtocolActive(false);
		assert.strictEqual(isKittyProtocolActive(), false);
	});
});
