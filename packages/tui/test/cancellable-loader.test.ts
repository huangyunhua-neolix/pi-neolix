import assert from "node:assert";
import { describe, it } from "node:test";
import { CancellableLoader } from "../src/components/cancellable-loader.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function identity(text: string): string {
	return text;
}

/**
 * Construct a CancellableLoader wired to a VirtualTerminal + TUI, run `fn`,
 * and guarantee loader.dispose() + tui.stop() are called. Centralizes the
 * terminal/TUI setup and teardown so individual tests stay focused on
 * behavior. dispose() is idempotent, so tests that dispose explicitly are
 * safe with the cleanup in the finally block.
 */
function withLoader(fn: (loader: CancellableLoader) => void): void {
	const terminal = new VirtualTerminal(40, 5);
	const tui = new TUI(terminal);
	let loader: CancellableLoader | null = null;
	try {
		loader = new CancellableLoader(tui, identity, identity, "Working...");
		fn(loader);
	} finally {
		loader?.dispose();
		tui.stop();
	}
}

describe("CancellableLoader", () => {
	describe("construction and signal state", () => {
		it("starts non-aborted with a live signal", () => {
			withLoader((loader) => {
				assert.strictEqual(loader.aborted, false);
				assert.strictEqual(loader.signal.aborted, false);
			});
		});
	});

	describe("handleInput", () => {
		it("does not abort on a non-cancel key", () => {
			withLoader((loader) => {
				loader.handleInput("x");
				assert.strictEqual(loader.aborted, false);
			});
		});

		it("aborts and fires onAbort when the cancel keybinding matches (Escape)", () => {
			withLoader((loader) => {
				let abortedCount = 0;
				loader.onAbort = () => {
					abortedCount++;
				};

				// Escape is part of the tui.select.cancel default key set.
				loader.handleInput("\x1b");

				assert.strictEqual(loader.aborted, true);
				assert.strictEqual(loader.signal.aborted, true);
				assert.strictEqual(abortedCount, 1, "onAbort should fire exactly once");
			});
		});

		it("aborts on the ctrl+c cancel keybinding variant as well", () => {
			withLoader((loader) => {
				loader.handleInput("\x03"); // ctrl+c
				assert.strictEqual(loader.aborted, true);
			});
		});

		it("invokes onAbort on each cancel input, even after the first abort", () => {
			withLoader((loader) => {
				let abortedCount = 0;
				loader.onAbort = () => {
					abortedCount++;
				};

				loader.handleInput("\x1b");
				loader.handleInput("\x1b");

				// onAbort fires once per cancel input; the AbortController is
				// idempotent but the callback is still invoked each time.
				assert.strictEqual(abortedCount, 2, "onAbort fires once per cancel input");
				assert.strictEqual(loader.aborted, true);
			});
		});

		it("ignores cancel input after abort when onAbort is unset", () => {
			withLoader((loader) => {
				// No onAbort configured — must not throw.
				loader.handleInput("\x1b");
				assert.strictEqual(loader.aborted, true);
				// Second cancel must not throw even with no callback.
				loader.handleInput("\x1b");
			});
		});
	});

	describe("render", () => {
		it("renders the message text with a leading empty line", () => {
			withLoader((loader) => {
				loader.setMessage("Loading data");
				const lines = loader.render(40);
				assert.ok(lines.length >= 1, "render should produce at least one line");
				assert.strictEqual(lines[0], "", "first line should be the loader's top padding");
				const joined = lines.join("\n");
				assert.ok(joined.includes("Loading data"), `rendered output should include message, got: ${joined}`);
			});
		});

		it("updates the rendered message after setMessage", () => {
			withLoader((loader) => {
				loader.setMessage("First");
				loader.setMessage("Second");
				const joined = loader.render(40).join("\n");
				assert.ok(joined.includes("Second"), `updated message should render, got: ${joined}`);
				assert.ok(!joined.includes("First"), `old message should be gone, got: ${joined}`);
			});
		});
	});

	describe("dispose", () => {
		it("stops the spinner animation without aborting the signal", () => {
			withLoader((loader) => {
				loader.dispose();
				// dispose stops the animation but does not abort.
				assert.strictEqual(loader.aborted, false);
				// Signal is still usable.
				assert.strictEqual(loader.signal.aborted, false);
			});
		});
	});
});
