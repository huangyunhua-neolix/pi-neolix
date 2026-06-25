import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, isFocusable } from "../src/tui.ts";

/** Minimal component with no `focused` field. */
class NonFocusableComponent implements Component {
	render(_width: number): string[] {
		return ["plain"];
	}
	invalidate(): void {}
}

/** Component that opts into focus via the Focusable interface. */
class FocusableComponent implements Component {
	focused = false;
	render(_width: number): string[] {
		return [this.focused ? "focused" : "unfocused"];
	}
	invalidate(): void {}
}

/** Component that carries an unrelated `focused`-shaped boolean is still Focusable. */
class ToggleComponent implements Component {
	// `focused` here is a generic toggle, not necessarily a hardware cursor —
	// the type guard only checks structural presence of the field.
	focused: boolean;
	constructor(focused: boolean) {
		this.focused = focused;
	}
	render(_width: number): string[] {
		return ["toggle"];
	}
	invalidate(): void {}
}

describe("isFocusable", () => {
	describe("non-focusable inputs", () => {
		it("returns false for null", () => {
			assert.strictEqual(isFocusable(null), false);
		});

		it("returns false for a component without a focused field", () => {
			const component = new NonFocusableComponent();
			assert.strictEqual(isFocusable(component), false);
		});

		it("returns false for a plain object that does not implement Component", () => {
			assert.strictEqual(isFocusable({} as Component | null), false);
		});
	});

	describe("focusable inputs", () => {
		it("returns true for a component that has a focused boolean field", () => {
			const component = new FocusableComponent();
			assert.strictEqual(isFocusable(component), true);
		});

		it("narrows the type so focused is readable after the guard", () => {
			const component: Component | null = new FocusableComponent();
			assert.ok(isFocusable(component), "guard should narrow");
			// After the guard, `component.focused` must be accessible.
			component.focused = true;
			assert.strictEqual(component.focused, true);
			component.focused = false;
			assert.strictEqual(component.focused, false);
		});

		it("returns true regardless of the focused boolean value", () => {
			assert.strictEqual(isFocusable(new ToggleComponent(true)), true);
			assert.strictEqual(isFocusable(new ToggleComponent(false)), true);
		});
	});
});
