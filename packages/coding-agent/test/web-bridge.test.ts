// Unit tests for the web-bridge OSC emitter.
//
// Verifies that AgentSession events translate into the exact OSC 9998/9999
// frames the web PTY parser (web/server/pty-parser.mjs) consumes, and that
// the bridge is a no-op unless FREECODE_WEB=1 (bare terminals stay silent).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emitWebContextWindow, emitWebStatus, WebBridge } from "../src/core/web-bridge.ts";

function captureStdout() {
	const writes: string[] = [];
	const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
		writes.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});
	return { writes, spy };
}

describe("emitWebStatus / emitWebContextWindow — OSC frame format", () => {
	let cap: ReturnType<typeof captureStdout>;

	beforeEach(() => {
		cap = captureStdout();
	});
	afterEach(() => cap.spy.mockRestore());

	test("emitWebStatus emits an OSC 9998 BEL-terminated frame", () => {
		emitWebStatus("running", 1, 1);
		expect(cap.writes).toEqual(["\x1b]9998;status=running;bg=1;agents=1\x07"]);
	});

	test("emitWebStatus idle frame", () => {
		emitWebStatus("idle", 0, 0);
		expect(cap.writes).toEqual(["\x1b]9998;status=idle;bg=0;agents=0\x07"]);
	});

	test("emitWebContextWindow emits used+limit+cost", () => {
		emitWebContextWindow(1234, 200000, 0.5);
		expect(cap.writes).toEqual(["\x1b]9999;used=1234;limit=200000;cost=0.5\x07"]);
	});

	test("emitWebContextWindow omits used when undefined (post-compaction)", () => {
		emitWebContextWindow(undefined, 200000, 0.5);
		expect(cap.writes).toEqual(["\x1b]9999;limit=200000;cost=0.5\x07"]);
	});

	test("emitWebContextWindow clamps non-finite limit/cost to 0", () => {
		// A malformed model.contextWindow (NaN) or degenerate summed cost (Infinity)
		// would otherwise render as the literal strings "NaN"/"Infinity" and corrupt
		// the OSC frame the web PTY parser consumes.
		emitWebContextWindow(undefined, Number.NaN, Number.POSITIVE_INFINITY);
		expect(cap.writes).toEqual(["\x1b]9999;limit=0;cost=0\x07"]);
	});
});

describe("WebBridge — env gating", () => {
	let cap: ReturnType<typeof captureStdout>;
	const orig = process.env.FREECODE_WEB;

	beforeEach(() => {
		cap = captureStdout();
	});
	afterEach(() => {
		cap.spy.mockRestore();
		process.env.FREECODE_WEB = orig;
	});

	test("attach is a no-op when FREECODE_WEB is unset", () => {
		delete process.env.FREECODE_WEB;
		const session = { subscribe: vi.fn(() => () => {}) };
		const bridge = new WebBridge();
		bridge.attach(session as any);
		expect(session.subscribe).not.toHaveBeenCalled();
	});

	test("attach subscribes when FREECODE_WEB=1", () => {
		process.env.FREECODE_WEB = "1";
		const session = { subscribe: vi.fn(() => () => {}) } as any;
		const bridge = new WebBridge();
		bridge.attach(session);
		expect(session.subscribe).toHaveBeenCalledTimes(1);
	});
});

describe("WebBridge — event → OSC translation", () => {
	let cap: ReturnType<typeof captureStdout>;
	const orig = process.env.FREECODE_WEB;

	function makeSession(messages: any[] = []) {
		const listeners: Array<(e: any) => void> = [];
		const session = {
			subscribe: (fn: (e: any) => void) => {
				listeners.push(fn);
				return () => {
					const i = listeners.indexOf(fn);
					if (i >= 0) listeners.splice(i, 1);
				};
			},
			sessionManager: {
				getEntries: () => messages,
			},
			model: { contextWindow: 200000 },
			getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }),
		};
		return {
			session,
			emit: (e: any) => {
				for (const l of listeners) l(e);
			},
		};
	}

	beforeEach(() => {
		process.env.FREECODE_WEB = "1";
		cap = captureStdout();
	});
	afterEach(() => {
		cap.spy.mockRestore();
		process.env.FREECODE_WEB = orig;
	});

	test("agent_start → OSC 9998 running", () => {
		const { session, emit } = makeSession();
		const bridge = new WebBridge();
		bridge.attach(session as any);
		emit({ type: "agent_start" });
		expect(cap.writes).toContain("\x1b]9998;status=running;bg=1;agents=1\x07");
	});

	test("assistant message_end → OSC 9999 with used+limit+cost", () => {
		const messages = [
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					usage: {
						input: 1000,
						output: 234,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1234,
						cost: { total: 0.5 },
					},
				},
			},
		];
		const { session, emit } = makeSession(messages);
		const bridge = new WebBridge();
		bridge.attach(session as any);
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 1000, output: 234, cacheRead: 0, cacheWrite: 0, totalTokens: 1234, cost: { total: 0.5 } },
			},
		});
		expect(cap.writes).toContain("\x1b]9999;used=1234;limit=200000;cost=0.5\x07");
	});

	test("agent_end (no retry) → OSC 9998 idle", () => {
		const { session, emit } = makeSession();
		const bridge = new WebBridge();
		bridge.attach(session as any);
		emit({ type: "agent_start" });
		cap.writes.length = 0;
		emit({ type: "agent_end", messages: [], willRetry: false });
		expect(cap.writes).toContain("\x1b]9998;status=idle;bg=0;agents=0\x07");
	});

	test("agent_end with error assistant → OSC 9998 error", () => {
		const { session, emit } = makeSession();
		const bridge = new WebBridge();
		bridge.attach(session as any);
		emit({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error", usage: { cost: { total: 0 } } }],
			willRetry: false,
		});
		expect(cap.writes).toContain("\x1b]9998;status=error;bg=0;agents=0\x07");
	});

	test("agent_end willRetry → stays running (no idle flash)", () => {
		const { session, emit } = makeSession();
		const bridge = new WebBridge();
		bridge.attach(session as any);
		emit({ type: "agent_end", messages: [], willRetry: true });
		expect(cap.writes).toContain("\x1b]9998;status=running;bg=1;agents=1\x07");
		expect(cap.writes).not.toContain("\x1b]9998;status=idle;bg=0;agents=0\x07");
	});

	test("detach stops further emission", () => {
		const { session, emit } = makeSession();
		const bridge = new WebBridge();
		bridge.attach(session as any);
		bridge.detach();
		cap.writes.length = 0;
		emit({ type: "agent_start" });
		expect(cap.writes).toEqual([]);
	});

	test("compaction_end → OSC 9999 refresh (cost + limit, used omitted until next response)", () => {
		// After compaction the live token count is unknown, but cost + limit should
		// still refresh so the web UI does not show stale figures.
		const messages = [
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					usage: {
						input: 500,
						output: 100,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 600,
						cost: { total: 0.2 },
					},
				},
			},
		];
		const { session, emit } = makeSession(messages);
		const bridge = new WebBridge();
		bridge.attach(session as any);
		cap.writes.length = 0;
		emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
		// A 9999 frame must be emitted; `used` is undefined post-compaction so the
		// frame carries limit + cost only.
		expect(cap.writes.some((w) => w.startsWith("\x1b]9999;") && w.includes("limit=200000") && w.includes("cost=0.2"))).toBe(true);
	});
});
