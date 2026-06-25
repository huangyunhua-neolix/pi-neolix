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

interface SetupOptions {
	onChange?: (id: string, value: string) => void;
	onCancel?: () => void;
	options?: Record<string, unknown>;
}

/**
 * Construct a SettingsList wired to a VirtualTerminal + TUI, run `fn`, and
 * guarantee `tui.stop()` is called. Centralizes the terminal/TUI setup and
 * teardown so individual tests stay focused on behavior.
 */
function withList(items: SettingItem[], fn: (list: SettingsList) => void, opts: SetupOptions = {}): void {
	const terminal = new VirtualTerminal(60, 10);
	const tui = new TUI(terminal);
	try {
		const list = new SettingsList(
			items,
			5,
			theme,
			opts.onChange ?? (() => {}),
			opts.onCancel ?? (() => {}),
			opts.options ?? {},
		);
		fn(list);
	} finally {
		tui.stop();
	}
}

describe("SettingsList", () => {
	describe("construction and render", () => {
		it("renders the cursor on the first item by default", () => {
			withList(makeItems(), (list) => {
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("> "), "cursor prefix should mark the selected item");
				assert.ok(joined.includes("Theme"), "first item label should render");
				assert.ok(joined.includes("dark"), "first item value should render");
			});
		});

		it("renders the empty-state hint when there are no items", () => {
			withList([], (list) => {
				const lines = list.render(60);
				const joined = lines.join("\n");
				assert.ok(lines.length > 0, "empty state should render a hint line");
				assert.ok(joined.includes("No settings"), "empty state hint should render");
			});
		});

		it("renders the description of the selected item", () => {
			withList(makeItems(), (list) => {
				// Move selection down twice to the item with a description (index 2).
				list.handleInput("\x1b[B"); // down
				list.handleInput("\x1b[B"); // down
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("UI display language"), "description should render for selected item");
			});
		});
	});

	describe("navigation", () => {
		it("moves the selection down on the down keybinding", () => {
			withList(makeItems(), (list) => {
				list.handleInput("\x1b[B"); // down
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("> "), "cursor should still be present");
				assert.ok(joined.includes("Font Size"), "second item should be selected");
			});
		});

		it("wraps selection from last back to first on down", () => {
			withList(makeItems(), (list) => {
				// Move to the last item (index 2).
				list.handleInput("\x1b[B");
				list.handleInput("\x1b[B");
				// One more down wraps to first.
				list.handleInput("\x1b[B");
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("Theme"), "selection should wrap to first item");
			});
		});

		it("wraps selection from first to last on up", () => {
			withList(makeItems(), (list) => {
				// At index 0; up wraps to last item.
				list.handleInput("\x1b[A"); // up
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("Language"), "selection should wrap to last item");
			});
		});

		it("does not move selection when there are no items", () => {
			withList([], (list) => {
				// Must not throw.
				list.handleInput("\x1b[B");
				list.handleInput("\x1b[A");
				assert.ok(list.render(60).join("\n").includes("No settings"));
			});
		});
	});

	describe("value cycling via confirm", () => {
		it("cycles to the next value on Enter and reports the change", () => {
			const changes: Array<{ id: string; value: string }> = [];
			withList(
				makeItems(),
				(list) => {
					list.handleInput("\r"); // enter → tui.select.confirm
					assert.deepStrictEqual(changes, [{ id: "theme", value: "light" }]);
					const joined = list.render(60).join("\n");
					assert.ok(joined.includes("light"), "cycled value should render");
				},
				{ onChange: (id, value) => changes.push({ id, value }) },
			);
		});

		it("cycles values on Space as well", () => {
			const changes: Array<{ id: string; value: string }> = [];
			withList(
				makeItems(),
				(list) => {
					list.handleInput(" ");
					assert.deepStrictEqual(changes, [{ id: "theme", value: "light" }]);
				},
				{ onChange: (id, value) => changes.push({ id, value }) },
			);
		});

		it("wraps value cycling back to the first value after the last", () => {
			const changes: Array<{ id: string; value: string }> = [];
			withList(
				makeItems(),
				(list) => {
					// theme: dark → light → dark
					list.handleInput("\r");
					list.handleInput("\r");
					assert.deepStrictEqual(changes, [
						{ id: "theme", value: "light" },
						{ id: "theme", value: "dark" },
					]);
				},
				{ onChange: (id, value) => changes.push({ id, value }) },
			);
		});
	});

	describe("cancel", () => {
		it("invokes onCancel on the cancel keybinding (Escape)", () => {
			let cancelled = 0;
			withList(
				makeItems(),
				(list) => {
					list.handleInput("\x1b"); // escape
					assert.strictEqual(cancelled, 1);
				},
				{ onCancel: () => cancelled++ },
			);
		});
	});

	describe("updateValue", () => {
		it("updates an item's currentValue by id", () => {
			withList(makeItems(), (list) => {
				list.updateValue("font", "20");
				const joined = list.render(60).join("\n");
				assert.ok(joined.includes("20"), "updated value should render");
			});
		});

		it("is a no-op for an unknown id", () => {
			withList(makeItems(), (list) => {
				// Must not throw.
				list.updateValue("nonexistent", "x");
				assert.ok(list.render(60).join("\n").includes("Theme"));
			});
		});
	});

	describe("submenu", () => {
		it("opens the submenu component on confirm and renders it instead of the list", () => {
			const submenuRendered = { value: false };
			const submenuComponent = {
				render: () => {
					submenuRendered.value = true;
					return ["submenu-line"];
				},
				invalidate: () => {},
			};
			const doneRef: { current: ((v?: string) => void) | null } = { current: null };
			const items: SettingItem[] = [
				{
					id: "picker",
					label: "Picker",
					currentValue: "a",
					submenu: (_value, done) => {
						// Keep a reference so done() can be called later by the test.
						doneRef.current = done;
						return submenuComponent;
					},
				},
			];
			withList(items, (list) => {
				list.handleInput("\r"); // confirm opens submenu
				const lines = list.render(60);
				assert.strictEqual(submenuRendered.value, true, "submenu component should render");
				assert.deepStrictEqual(lines, ["submenu-line"]);
				// Clean up the submenu by calling done() with no value.
				doneRef.current?.();
			});
		});

		it("commits the submenu selection via done(value) and closes it", () => {
			const changes: Array<{ id: string; value: string }> = [];
			const doneRef: { current: ((v?: string) => void) | null } = { current: null };
			const items: SettingItem[] = [
				{
					id: "picker",
					label: "Picker",
					currentValue: "a",
					submenu: (_value, done) => {
						doneRef.current = done;
						return {
							render: () => ["submenu"],
							invalidate: () => {},
						};
					},
				},
			];
			withList(
				items,
				(list) => {
					list.handleInput("\r");
					doneRef.current?.("b");
					// After done, the list should render again (not the submenu).
					const joined = list.render(60).join("\n");
					assert.ok(joined.includes("Picker"), "list should render after submenu closes");
					assert.ok(joined.includes("b"), "new value should render");
					assert.deepStrictEqual(changes, [{ id: "picker", value: "b" }]);
				},
				{ onChange: (id, value) => changes.push({ id, value }) },
			);
		});

		it("delegates input to the active submenu", () => {
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
			withList(items, (list) => {
				list.handleInput("\r"); // open submenu
				list.handleInput("x"); // should go to submenu
				list.handleInput("\x1b[A"); // up arrow should go to submenu too
				assert.deepStrictEqual(delegated, ["x", "\x1b[A"]);
			});
		});
	});

	describe("search", () => {
		it("filters items by typed query when enableSearch is on", () => {
			withList(
				makeItems(),
				(list) => {
					// Type "font" (spaces are stripped by the input handler).
					for (const ch of "font") {
						list.handleInput(ch);
					}
					const joined = list.render(60).join("\n");
					assert.ok(joined.includes("Font Size"), "matching item should remain after filter");
					assert.ok(!joined.includes("> Theme"), "non-matching Theme item should be filtered out");
				},
				{ options: { enableSearch: true } },
			);
		});

		it("shows the no-matching hint when the query matches nothing", () => {
			withList(
				makeItems(),
				(list) => {
					for (const ch of "zzz") {
						list.handleInput(ch);
					}
					const joined = list.render(60).join("\n");
					assert.ok(joined.includes("No matching"), "no-match hint should render");
				},
				{ options: { enableSearch: true } },
			);
		});

		it("ignores bare space input in search mode", () => {
			withList(
				makeItems(),
				(list) => {
					// A lone space must not be added to the search query.
					list.handleInput(" ");
					const joined = list.render(60).join("\n");
					assert.ok(joined.includes("Theme"), "all items should remain when query is empty");
				},
				{ options: { enableSearch: true } },
			);
		});
	});

	describe("invalidate", () => {
		it("does not throw when there is no submenu component", () => {
			withList(makeItems(), (list) => {
				list.invalidate();
				assert.ok(true, "invalidate should not throw without a submenu");
			});
		});
	});
});
