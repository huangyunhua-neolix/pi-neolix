// Web adapter bridge — emits OSC escape sequences consumed by the
// freecode-web PTY parser (web/server/pty-parser.mjs).
//
// These sequences are invisible to normal terminals (they swallow unknown
// OSC codes) and never move the cursor or print glyphs, so they are safe to
// emit unconditionally from the interactive TUI. They mirror the signals
// freecode CLI already emits so the web UI shows accurate status, cost and
// context state for pi sessions too. Without them, the web server treats pi
// sessions as passthrough and the UI renders status/cost/context as "—".
//
// Two sequences:
//
//   OSC 9998 — session status (web "LED" bridge + autoupdate subagent gate).
//     ESC ] 9998 ; status=<idle|running|error> ; bg=<N> ; agents=<N> BEL
//     - status: idle | running | error
//     - bg:      foreground/background activity count for the LED indicator
//     - agents:  same value; web server's autoupdate gate reads params.agents
//                so it won't proceed while a turn is in flight.
//
//   OSC 9999 — context window usage + cumulative cost.
//     ESC ] 9999 ; used=<tokens> ; limit=<tokens> ; cost=<usd> BEL
//     - used:  current context tokens (may be omitted right after compaction,
//              when the count is unknown until the next response)
//     - limit: model context window (max tokens)
//     - cost:  cumulative session cost in USD
//
// All writes are best-effort: EPIPE/EBADF during shutdown are swallowed.
//
// Gating: emission only runs when running under the freecode-web adapter
// (FREECODE_WEB=1, injected by web/server BuildChildEnv_). This keeps pi
// completely silent in a bare terminal and makes the behavior explicit.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";

/** Whether we are running under the freecode-web PTY adapter. */
function isWebAdapter(): boolean {
	return process.env.FREECODE_WEB === "1";
}

/** Write raw bytes to stdout, swallowing errors during shutdown. */
function writeRaw(data: string): void {
	try {
		process.stdout.write(data);
	} catch {
		// EPIPE / EBADF — stdout may be closed during shutdown. Swallow.
	}
}

/** Emit an OSC 9998 status frame. */
export function emitWebStatus(status: "idle" | "running" | "error", bg: number, agents: number): void {
	writeRaw(`\x1b]9998;status=${status};bg=${bg};agents=${agents}\x07`);
}

/** Emit an OSC 9999 context/cost frame. `used` may be omitted (post-compaction). */
export function emitWebContextWindow(used: number | undefined, limit: number, cost: number): void {
	// Guard all numeric fields: model.contextWindow or summed cost can be NaN/Infinity
	// for a malformed model entry or a degenerate usage payload. JS renders those as the
	// literal strings "NaN"/"Infinity", which corrupt the OSC frame the web PTY parser
	// consumes. Clamp non-finite values to 0 so the frame stays well-formed.
	const safeLimit = Number.isFinite(limit) ? limit : 0;
	const safeCost = Number.isFinite(cost) ? cost : 0;
	const parts = [`limit=${safeLimit}`, `cost=${safeCost}`];
	if (used !== undefined && Number.isFinite(used) && used >= 0) {
		parts.unshift(`used=${used}`);
	}
	writeRaw(`\x1b]9999;${parts.join(";")}\x07`);
}

/**
 * Extract the freshest context-token count from the last non-aborted /
 * non-error assistant message's usage. Mirrors calculateContextTokens.
 */
function usageContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * WebBridge subscribes to AgentSession events and translates them into the
 * OSC 9998/9999 frames the web PTY parser consumes. Attach once per session;
 * detach before re-subscribing (session switch / reload).
 */
export class WebBridge {
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;

	/** Attach to a session. No-op when not running under the web adapter. */
	attach(session: AgentSession): void {
		this.detach();
		if (!isWebAdapter()) return;
		this.session = session;
		this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
	}

	/** Detach from the current session. Safe to call when not attached. */
	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session = undefined;
	}

	private handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				// Turn begins: mark the session busy so the web LED + autoupdate
				// gate reflect that a turn is in flight.
				emitWebStatus("running", 1, 1);
				break;

			case "message_end":
				if (event.message.role === "assistant") {
					this.emitContextAndCost();
				}
				break;

			case "compaction_end":
				// After compaction the live token count is unknown until the next
				// response, but cost + limit should still refresh so the UI doesn't
				// show stale figures.
				this.emitContextAndCost();
				break;

			case "agent_end": {
				// If another retry turn follows immediately, keep the busy status so
				// we don't flash idle for one frame.
				if (event.willRetry) {
					this.emitContextAndCost();
					emitWebStatus("running", 1, 1);
					break;
				}
				const errored = this.lastAssistantErrored(event.messages);
				this.emitContextAndCost();
				emitWebStatus(errored ? "error" : "idle", 0, 0);
				break;
			}
			default:
				break;
		}
	}

	private lastAssistantErrored(messages: AgentMessage[]): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return (message as AssistantMessage).stopReason === "error";
			}
		}
		return false;
	}

	/**
	 * Emit a single OSC 9999 frame with the current context tokens, context
	 * window limit, and cumulative session cost. Called after assistant
	 * responses and after compaction.
	 */
	private emitContextAndCost(): void {
		const session = this.session;
		if (!session) return;

		// Cumulative cost from ALL persisted entries so it survives compaction
		// (the same source the footer uses).
		const entries = session.sessionManager.getEntries();
		let cost = 0;
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				cost += (entry.message as AssistantMessage).usage.cost.total;
			}
		}

		const model = session.model;
		const limit = model?.contextWindow ?? 0;

		// Prefer the exact token count from the last valid assistant usage; fall
		// back to the session's context estimate. Both may be unavailable right
		// after compaction, in which case we omit `used` (honest "unknown").
		let used: number | undefined = this.lastUsageTokens(entries);
		if (used === undefined) {
			const estimate = session.getContextUsage();
			if (estimate?.tokens !== null && estimate?.tokens !== undefined && estimate.tokens >= 0) {
				used = estimate.tokens;
			}
		}

		if (limit > 0 || cost > 0 || used !== undefined) {
			emitWebContextWindow(used, limit, cost);
		}
	}

	/** Tokens reported by the most recent non-aborted/error assistant message. */
	private lastUsageTokens(entries: { type: string; message?: AgentMessage }[]): number | undefined {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (!message || message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && assistant.usage) {
				const tokens = usageContextTokens(assistant.usage);
				if (tokens > 0) return tokens;
			}
		}
		return undefined;
	}
}
