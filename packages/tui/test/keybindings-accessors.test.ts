import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	getKeybindings,
	type Keybinding,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "../src/keybindings.ts";

/**
 * Round-trip coverage for the module-level getKeybindings / setKeybindings
 * singleton. Asserts against the configured TUI_KEYBINDINGS map (no literal
 * key strings) per AGENTS.md no-hardcoded-key-checks.
 */
describe("getKeybindings / setKeybindings", () => {
	// The global singleton is shared across tests, so save it before each test
	// and restore it after. Centralizing this in beforeEach/afterEach avoids
	// state leaks if a test throws before reaching its manual restore.
	let saved: KeybindingsManager | null = null;

	beforeEach(() => {
		// getKeybindings() lazily constructs the global; capture whatever it is.
		saved = getKeybindings();
	});

	afterEach(() => {
		if (saved !== null) {
			setKeybindings(saved);
		}
	});

	describe("getKeybindings", () => {
		it("returns a KeybindingsManager backed by TUI_KEYBINDINGS by default", () => {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const kb = getKeybindings();
			for (const id of Object.keys(TUI_KEYBINDINGS) as (keyof typeof TUI_KEYBINDINGS)[]) {
				const def = TUI_KEYBINDINGS[id];
				const expected = Array.isArray(def.defaultKeys) ? [...def.defaultKeys] : [def.defaultKeys];
				assert.deepStrictEqual(kb.getKeys(id), expected, `default keys for ${id} should match config`);
			}
		});

		it("returns the same instance on subsequent calls when not reset", () => {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const a = getKeybindings();
			const b = getKeybindings();
			assert.strictEqual(a, b, "getKeybindings should return the cached singleton");
		});
	});

	describe("setKeybindings round-trip", () => {
		it("overrides resolve user bindings while preserving un-evicted defaults", () => {
			const overrides: KeybindingsConfig = {
				"tui.input.submit": "ctrl+x",
			};
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, overrides));
			const kb = getKeybindings();

			// Overridden binding reflects the user value.
			assert.deepStrictEqual(kb.getKeys("tui.input.submit"), ["ctrl+x"]);
			// Unrelated default binding is unchanged from the config map.
			const confirmDefault = TUI_KEYBINDINGS["tui.select.confirm"];
			const expectedConfirm = Array.isArray(confirmDefault.defaultKeys)
				? [...confirmDefault.defaultKeys]
				: [confirmDefault.defaultKeys];
			assert.deepStrictEqual(kb.getKeys("tui.select.confirm"), expectedConfirm);
		});

		it("getResolvedBindings reflects merged result after setKeybindings", () => {
			const overrides: KeybindingsConfig = {
				"tui.editor.cursorUp": "ctrl+p",
				"tui.editor.cursorDown": "ctrl+n",
			};
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, overrides));
			const resolved = getKeybindings().getResolvedBindings();

			assert.strictEqual(resolved["tui.editor.cursorUp"], "ctrl+p");
			assert.strictEqual(resolved["tui.editor.cursorDown"], "ctrl+n");
			// A default multi-key binding stays an array.
			const leftDefault = TUI_KEYBINDINGS["tui.editor.cursorLeft"];
			const expectedLeft = Array.isArray(leftDefault.defaultKeys)
				? [...leftDefault.defaultKeys]
				: [leftDefault.defaultKeys];
			assert.deepStrictEqual(resolved["tui.editor.cursorLeft"], expectedLeft);
		});

		it("setKeybindings swaps the global so getKeybindings sees the new instance", () => {
			const first = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.copy": "ctrl+x" });
			setKeybindings(first);
			assert.strictEqual(getKeybindings(), first);

			const second = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.copy": "ctrl+y" });
			setKeybindings(second);
			assert.strictEqual(getKeybindings(), second);
			assert.deepStrictEqual(getKeybindings().getKeys("tui.input.copy"), ["ctrl+y"]);
		});

		it("user bindings for unknown action ids are ignored", () => {
			const overrides: KeybindingsConfig = {
				"tui.nonexistent.action": "ctrl+x",
			};
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, overrides));
			const kb = getKeybindings();
			// Unknown id yields no keys.
			assert.deepStrictEqual(kb.getKeys("tui.nonexistent.action" as Keybinding), []);
			// No conflicts reported for unknown ids.
			assert.deepStrictEqual(kb.getConflicts(), []);
		});
	});
});
