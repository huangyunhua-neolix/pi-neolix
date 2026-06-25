import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const WEB_FETCH_TOOL_NAME = "WebFetch";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch" }),
	prompt: Type.Optional(
		Type.String({
			description: "Optional instruction for the LLM on what to extract from the page content.",
		}),
	),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	status?: number;
	url?: string;
}

const DISABLED_MESSAGE = "WebFetch is disabled. Set WEB_FETCH_ENABLED=1 in settings.json.";

// --- SSRF hardening (BLOCKER-1) ---

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_CONTENT_CHARS = 50_000; // ~50 KB after htmlToText (FIX-3)

/**
 * True when `ip` is a private / loopback / reserved address that must not be
 * fetched by an LLM-driven tool. Covers:
 *   - IPv4: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local + IMDS),
 *     0.0.0.0, any address ending in 0 (network) or 255 (broadcast) is NOT
 *     treated as special here (only well-known private ranges).
 *   - IPv6: ::1, fc00::/7 (unique-local), fe80::/10 (link-local), ::/128
 *     (unspecified), and anything with an embedded IPv4 private address.
 *
 * `ip` must be a validated IP literal (caller already did `isIP(ip) > 0`).
 */
export function isPrivateIP(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) {
		const parts = ip.split(".").map(Number);
		// parts are validated by isIP already
		const [a, b] = parts;
		if (a === 127) return true; // loopback
		if (a === 10) return true; // private 10/8
		if (a === 0) return true; // 0.0.0.0/8 (this network)
		if (a === 169 && b === 254) return true; // link-local + cloud IMDS
		if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
		if (a === 192 && b === 168) return true; // private 192.168/16
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
		if (a >= 224) return true; // multicast (224/4) + reserved (240/4)
		return false;
	}
	if (family === 6) {
		const lower = ip.toLowerCase();
		if (lower === "::1") return true; // loopback
		if (lower === "::") return true; // unspecified
		if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
		if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb"))
			return true; // link-local fe80::/10
		// IPv4-mapped: ::ffff:a.b.c.d
		const v4Match = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (v4Match) return isPrivateIP(v4Match[1]);
		return false;
	}
	// Not an IP literal at all — treat as private (fail-closed) so hostnames
	// that haven't been resolved yet are rejected by the caller.
	return true;
}

/**
 * Validate a URL for SSRF safety before fetching.
 *
 * 1. Scheme must be http or https.
 * 2. Hostname is resolved (DNS lookup for non-IP hostnames) and every resolved
 *    address must pass `isPrivateIP`. Hostnames that resolve to ANY private IP
 *    are rejected.
 * 3. Port (if present) is left unrestricted — non-privileged ports are the
 *    normative case; blocking ports would break legitimate http(s).
 *
 * Returns `null` when safe, or a human-readable error string when rejected.
 */
export async function validateFetchUrl(url: string): Promise<{ error: string } | { error: null; resolvedUrl: URL }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { error: `invalid URL: ${url}` };
	}

	if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
		return { error: `scheme not allowed: ${parsed.protocol} (only http/https)` };
	}

	const hostname = parsed.hostname;
	if (!hostname) {
		return { error: "URL has no hostname" };
	}

	// Strip IPv6 brackets: new URL("http://[::1]/").hostname returns "[::1]"
	// in some engines; isIP needs the bare address.
	const bareHost = hostname.replace(/^\[|\]$/g, "");

	// If hostname is an IP literal, check directly. Otherwise resolve via DNS.
	if (isIP(bareHost) > 0) {
		if (isPrivateIP(bareHost)) {
			return { error: `refused: hostname ${bareHost} is a private/loopback address` };
		}
	} else {
		let addrs: { address: string; family: number }[];
		try {
			addrs = await dnsLookup(bareHost, { all: true });
		} catch {
			return { error: `DNS lookup failed for ${bareHost}` };
		}
		// Reject if ANY resolved address is private (fail-closed).
		for (const a of addrs) {
			if (isPrivateIP(a.address)) {
				return { error: `refused: ${bareHost} resolves to private address ${a.address}` };
			}
		}
		// Reject if the resolved set is empty.
		if (addrs.length === 0) {
			return { error: `DNS lookup returned no addresses for ${bareHost}` };
		}
	}

	return { error: null, resolvedUrl: parsed };
}

/**
 * Read up to `maxBytes` from a Response body. Aborts (throws) if the body
 * exceeds `maxBytes`, preventing memory exhaustion from oversized responses.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) {
		// No streamable body — fall back to .text() but we can't cap mid-stream.
		// This path is rare (e.g. null body). Trust .text() to terminate.
		return response.text();
	}
	let total = 0;
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			try {
				await reader.cancel();
			} catch {
				// ignore cancel errors
			}
			throw new Error(`response body exceeded ${maxBytes} byte cap`);
		}
		chunks.push(value);
	}
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let joined: Uint8Array;
	if (chunks.length === 1) {
		joined = chunks[0];
	} else {
		joined = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			joined.set(c, offset);
			offset += c.byteLength;
		}
	}
	return decoder.decode(joined);
}

/** Decode a minimal set of HTML entities. */
function decodeEntities(text: string): string {
	const entityMap: Record<string, string> = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": '"',
		"&#39;": "'",
		"&apos;": "'",
		"&nbsp;": " ",
	};
	return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => entityMap[m] ?? m);
}

/**
 * Convert an HTML string to plain text.
 *
 * Removes `<script>`/`<style>` blocks entirely, strips all remaining tags,
 * decodes common entities, and collapses whitespace.
 */
export function htmlToText(html: string): string {
	if (!html) return "";
	let text = html;
	// Remove script and style blocks including their contents.
	text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
	// Remove all remaining HTML tags, replacing each with a space to preserve word boundaries.
	text = text.replace(/<[^>]+>/g, " ");
	// Decode HTML entities.
	text = decodeEntities(text);
	// Collapse all whitespace runs to a single space and trim.
	text = text.replace(/\s+/g, " ").trim();
	return text;
}

/** Build a text-only tool result. */
function textResult(
	text: string,
	details: WebFetchToolDetails = {},
): { content: TextContent[]; details: WebFetchToolDetails } {
	return { content: [{ type: "text", text }], details };
}

/** Build an error text tool result (does not throw). */
function errorResult(
	message: string,
	details: WebFetchToolDetails = {},
): { content: TextContent[]; details: WebFetchToolDetails } {
	return { content: [{ type: "text", text: message }], details };
}

export function createWebFetchToolDefinition(_cwd: string): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	return {
		name: WEB_FETCH_TOOL_NAME,
		label: "WebFetch",
		description:
			"Fetch a URL and return its content as plain text. Requires WEB_FETCH_ENABLED=1 in the environment. HTML is converted to text (tags removed, whitespace collapsed). If `prompt` is provided, it is forwarded as guidance for the model but the tool still returns the full extracted text.",
		promptSnippet: "Fetch a web page as text",
		parameters: webFetchSchema,
		async execute(
			_toolCallId,
			{ url, prompt }: { url: string; prompt?: string },
			_signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			if (process.env.WEB_FETCH_ENABLED !== "1") {
				return textResult(DISABLED_MESSAGE);
			}

			// SSRF guard: validate scheme + resolved IP before any fetch.
			const check = await validateFetchUrl(url);
			if (check.error !== null) {
				return errorResult(`WebFetch refused for ${url}: ${check.error}`, { url });
			}
			const initialUrl = check.resolvedUrl.href;

			// Manual redirect handling: each 3xx hop is re-validated.
			let currentUrl = initialUrl;
			let response: Response | null = null;
			try {
				for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
					response = await fetch(currentUrl, {
						method: "GET",
						redirect: "manual",
						signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
					});
					// fetch with redirect:"manual" returns the 3xx response object.
					const status = response.status;
					if (status >= 300 && status < 400) {
						const loc = response.headers.get("location");
						if (!loc) {
							// 3xx without Location — treat as terminal (non-ok).
							break;
						}
						const nextUrl = new URL(loc, currentUrl).href;
						const nextCheck = await validateFetchUrl(nextUrl);
						if (nextCheck.error !== null) {
							return errorResult(`WebFetch refused redirect ${currentUrl} → ${nextUrl}: ${nextCheck.error}`, {
								url: nextUrl,
							});
						}
						currentUrl = nextUrl;
						continue;
					}
					// Non-3xx — terminal response.
					break;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`WebFetch failed for ${url}: ${message}`, { url: currentUrl });
			}

			if (!response) {
				return errorResult(`WebFetch failed for ${url}: no response`, { url: currentUrl });
			}

			if (!response.ok) {
				return errorResult(`WebFetch failed for ${url}: HTTP ${response.status}`, {
					status: response.status,
					url: currentUrl,
				});
			}

			let raw: string;
			try {
				raw = await readBodyCapped(response, MAX_BODY_BYTES);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`WebFetch failed for ${url}: ${message}`, { url: currentUrl });
			}

			const text = htmlToText(raw);
			// FIX-3: cap content length and wrap as untrusted to prevent
			// prompt-injection from hostile page content.
			const truncated = text.length > MAX_CONTENT_CHARS ? text.slice(0, MAX_CONTENT_CHARS) : text;
			const wrapped = `<fetched-content url="${currentUrl}">\n${truncated}\n</fetched-content>`;
			let output = wrapped;
			if (prompt) {
				output = `Prompt: ${prompt}\n\n${wrapped}`;
			}

			return textResult(output, { status: response.status, url: currentUrl });
		},
	};
}

export function createWebFetchTool(cwd: string): AgentTool<typeof webFetchSchema, WebFetchToolDetails> {
	return wrapToolDefinition(createWebFetchToolDefinition(cwd));
}
