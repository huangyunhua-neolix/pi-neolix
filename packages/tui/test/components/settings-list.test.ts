import assert from "node:assert";
import { describe, it } from "node:test";
import { type SettingItem, SettingsList, type SettingsListTheme } from "../../src/components/settings-list.ts";
import { TUI } from "../../src/tui.ts";
import { VirtualTerminal } from "../virtual-terminal.ts";

const theme: SettingsListTheme = {
	label: (text, _selected) => text,
	value: (text, _selected) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

function makeItems(): SettingItem[] {
	return [
		{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
		{ id: "font", label: "Font Size", currentValue: "14", values: ["12", "14", "16"] },
		{
			id: "lang",
			label: "Language",
			currentValue: "en",
			description: "UI display language",
		},
	];
}

describe("SettingsList", () => {
	describe("construction and render", () => {
		it("renders the cursor on the first item by default", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				const lines = list.render(60);
				const joined = lines.join("\n");
				assert.ok(joined.includes("> "), "cursor prefix should mark the selected item");
				assert.ok(joined.includes("Theme"), "first item label should render");
				assert.ok(joined.includes("dark"), "first item value should render");
			} finally {
				tui.stop();
			}
		});

		it("renders the empty-state hint when there are no items", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					[],
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				const lines = list.render(60);
				const joined = lines.join("\n");
				assert.ok(joined.includes("No settings"), "empty state hint should render");
			} finally {
				tui.stop();
			}
		});

		it("renders the description of the selected item", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const items = makeItems();
				// Select the item with a description (index 2).
				const list = new SettingsList(
					items,
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				// Move selection down twice.
				list.handleInput("\x1b[B"); // down
				list.handleInput("\x1b[B"); // down
				const lines = list.render(60);
				const joined = lines.join("\n");
				assert.ok(joined.includes("UI display language"), "description should render for selected item");
			} finally {
				tui.stop();
			}
		});
	});

	describe("navigation", () => {
		it("moves the selection down on the down keybinding", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				list.handleInput("\x1b[B"); // down
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("> "), "cursor should still be present");
				assert.ok(joined.includes("Font Size"), "second item should be selected");
			} finally {
				tui.stop();
			}
		});

		it("wraps selection from last back to first on down", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const items = makeItems();
				const list = new SettingsList(
					items,
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				// Move to the last item (index 2).
				list.handleInput("\x1b[B");
				list.handleInput("\x1b[B");
				// One more down wraps to first.
				list.handleInput("\x1b[B");
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("Theme"), "selection should wrap to first item");
			} finally {
				tui.stop();
			}
		});

		it("wraps selection from first to last on up", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const items = makeItems();
				const list = new SettingsList(
					items,
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				// At index 0; up wraps to last item.
				list.handleInput("\x1b[A"); // up
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("Language"), "selection should wrap to last item");
			} finally {
				tui.stop();
			}
		});

		it("does not move selection when there are no items", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					[],
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				// Must not throw.
				list.handleInput("\x1b[B");
				list.handleInput("\x1b[A");
				assert.ok(list.render(60).join("\n").includes("No settings"));
			} finally {
				tui.stop();
			}
		});
	});

	describe("value cycling via confirm", () => {
		it("cycles to the next value on Enter and reports the change", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const changes: Array<{ id: string; value: string }> = [];
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					(id, value) => changes.push({ id, value }),
					() => {},
					{},
				);
				list.handleInput("\r"); // enter → tui.select.confirm
				assert.deepStrictEqual(changes, [{ id: "theme", value: "light" }]);
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("light"), "cycled value should render");
			} finally {
				tui.stop();
			}
		});

		it("cycles values on Space as well", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const changes: Array<{ id: string; value: string }> = [];
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					(id, value) => changes.push({ id, value }),
					() => {},
					{},
				);
				list.handleInput(" ");
				assert.deepStrictEqual(changes, [{ id: "theme", value: "light" }]);
			} finally {
				tui.stop();
			}
		});

		it("wraps value cycling back to the first value after the last", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const changes: Array<{ id: string; value: string }> = [];
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					(id, value) => changes.push({ id, value }),
					() => {},
					{},
				);
				// theme: dark → light → dark
				list.handleInput("\r");
				list.handleInput("\r");
				assert.deepStrictEqual(changes, [
					{ id: "theme", value: "light" },
					{ id: "theme", value: "dark" },
				]);
			} finally {
				tui.stop();
			}
		});
	});

	describe("cancel", () => {
		it("invokes onCancel on the cancel keybinding (Escape)", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				let cancelled = 0;
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => cancelled++,
					{},
				);
				list.handleInput("\x1b"); // escape
				assert.strictEqual(cancelled, 1);
			} finally {
				tui.stop();
			}
		});
	});

	describe("updateValue", () => {
		it("updates an item's currentValue by id", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				list.updateValue("font", "20");
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("20"), "updated value should render");
			} finally {
				tui.stop();
			}
		});

		it("is a no-op for an unknown id", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				// Must not throw.
				list.updateValue("nonexistent", "x");
				assert.ok(list.render(60).join("\n").includes("Theme"));
			} finally {
				tui.stop();
			}
		});
	});

	describe("submenu", () => {
		it("opens the submenu component on confirm and renders it instead of the list", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				let submenuRendered = false;
				const submenuComponent = {
					render: () => {
						submenuRendered = true;
						return ["submenu-line"];
					},
					invalidate: () => {},
				};
				const items: SettingItem[] = [
					{
						id: "picker",
						label: "Picker",
						currentValue: "a",
						submenu: (_value, done) => {
							// Keep a reference so done() can be called later by the test.
							(doneRef as (v?: string) => void) = done;
							return submenuComponent;
						},
					},
				];
				let doneRef: ((v?: string) => void) | null = null;
				const list = new SettingsList(
					items,
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				list.handleInput("\r"); // confirm opens submenu
				const lines = list.render(60);
				assert.strictEqual(submenuRendered, true, "submenu component should render");
				assert.deepStrictEqual(lines, ["submenu-line"]);
				// Clean up the submenu by calling done() with no value.
				(doneRef as (v?: string) => void)?.();
			} finally {
				tui.stop();
			}
		});

		it("commits the submenu selection via done(value) and closes it", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const changes: Array<{ id: string; value: string }> = [];
				let doneRef: ((v?: string) => void) | null = null;
				const items: SettingItem[] = [
					{
						id: "picker",
						label: "Picker",
						currentValue: "a",
						submenu: (_value, done) => {
							(doneRef as (v?: string) => void) = done;
							return {
								render: () => ["submenu"],
								invalidate: () => {},
							};
						},
					},
				];
				const list = new SettingsList(
					items,
					5,
					theme,
					(id, value) => changes.push({ id, value }),
					() => {},
					{},
				);
				list.handleInput("\r");
				(doneRef as (v?: string) => void)?.("b");
				// After done, the list should render again (not the submenu).
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("Picker"), "list should render after submenu closes");
				assert.ok(joined.includes("b"), "new value should render");
				assert.deepStrictEqual(changes, [{ id: "picker", value: "b" }]);
			} finally {
				tui.stop();
			}
		});

		it("delegates input to the active submenu", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const delegated: string[] = [];
				const items: SettingItem[] = [
					{
						id: "picker",
						label: "Picker",
						currentValue: "a",
						submenu: (_value, _done) => {
							return {
								render: () => ["submenu"],
								invalidate: () => {},
								handleInput: (data: string) => delegated.push(data),
							};
						},
					},
				];
				const list = new SettingsList(
					items,
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				list.handleInput("\r"); // open submenu
				list.handleInput("x"); // should go to submenu
				list.handleInput("\x1b[A"); // up arrow should go to submenu too
				assert.deepStrictEqual(delegated, ["x", "\x1b[A"]);
			} finally {
				tui.stop();
			}
		});
	});

	describe("search", () => {
		it("filters items by typed query when enableSearch is on", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => {},
					{ enableSearch: true },
				);
				// Type "font" (spaces are stripped by the input handler).
				for (const ch of "font") {
					list.handleInput(ch);
				}
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("Font Size"), "matching item should remain after filter");
				assert.ok(!joined.includes("> Theme"), "non-matching Theme item should be filtered out");
			} finally {
				tui.stop();
			}
		});

		it("shows the no-matching hint when the query matches nothing", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => {},
					{ enableSearch: true },
				);
				for (const ch of "zzz") {
					list.handleInput(ch);
				}
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("No matching"), "no-match hint should render");
			} finally {
				tui.stop();
			}
		});

		it("ignores bare space input in search mode", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => {},
					{ enableSearch: true },
				);
				// A lone space must not be added to the search query.
				list.handleInput(" ");
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("Theme"), "all items should remain when query is empty");
			} finally {
				tui.stop();
			}
		});
	});

	describe("invalidate", () => {
		it("does not throw when there is no submenu component", () => {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			try {
				const list = new SettingsList(
					makeItems(),
					5,
					theme,
					() => {},
					() => {},
					{},
				);
				list.invalidate();
				assert.ok(true, "invalidate should not throw without a submenu");
			} finally {
				tui.stop();
			}
		});
	});
});
