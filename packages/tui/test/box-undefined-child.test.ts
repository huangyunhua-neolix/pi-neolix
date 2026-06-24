import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import type { Component } from "../src/tui.ts";
import { Container } from "../src/tui.ts";

/**
 * Regression test for the session-crashing bug:
 *   TypeError: undefined is not an object (evaluating 'child.render')
 *   at Box.render / Container.render
 *
 * Root cause: a tool renderer (e.g. the `todo` extension's renderResult, when
 * called with a malformed-args error result whose `details` was `{}`) returned
 * `undefined`. ToolExecutionComponent pushed that `undefined` into a Box's
 * `children` array via `addChild(component)` without null-checking, so the next
 * render frame called `child.render(...)` on `undefined` and killed the process.
 *
 * The fix skips null/undefined children in Box.render / Container.render (and
 * invalidate) so one bad component can never crash the whole TUI. These tests
 * reproduce the ingress (an undefined entry in `children`) and assert no throw.
 */
class LineComponent implements Component {
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(_width: number): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

function pushUndefined(container: { children: Component[] }): void {
	(container.children as unknown[]).push(undefined);
}

describe("Box/Container undefined-child safety", () => {
	it("Box.render skips undefined children without throwing", () => {
		const box = new Box(1, 1);
		pushUndefined(box);
		box.addChild(new LineComponent("real"));
		pushUndefined(box);

		const lines = box.render(40);
		assert.ok(lines.length > 0, "expected some rendered lines");
		assert.ok(
			lines.some((l) => l.includes("real")),
			"real child line should survive",
		);
	});

	it("Container.render skips undefined children without throwing", () => {
		const container = new Container();
		pushUndefined(container);
		container.addChild(new LineComponent("x"));
		pushUndefined(container);

		const lines = container.render(40);
		assert.deepEqual(lines, ["x"]);
	});

	it("Box.invalidate skips undefined children without throwing", () => {
		const box = new Box(1, 1);
		pushUndefined(box);
		box.addChild(new LineComponent("y"));
		assert.doesNotThrow(() => box.invalidate());
	});

	it("Container.invalidate skips undefined children without throwing", () => {
		const container = new Container();
		pushUndefined(container);
		container.addChild(new LineComponent("z"));
		assert.doesNotThrow(() => container.invalidate());
	});

	it("nested Container→Box with an undefined leaf does not crash on render", () => {
		// Mimics the real render path: TUI(Container) → chatContainer(Container)
		// → ToolExecutionComponent(Container) → contentBox(Box) → undefined child.
		const root = new Container();
		const middle = new Container();
		const box = new Box(1, 1);
		pushUndefined(box);
		box.addChild(new LineComponent("leaf"));
		middle.addChild(box);
		root.addChild(middle);

		const lines = root.render(40);
		assert.ok(lines.some((l) => l.includes("leaf")));
	});
});
