import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const WEB_SEARCH_TOOL_NAME = "WebSearch";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query string." }),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

const NOT_CONFIGURED_MESSAGE =
	"WebSearch is not configured. Set WEB_SEARCH_API_KEY (and optionally WEB_SEARCH_PROVIDER) in settings.json.";

const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

interface TavilyResult {
	title?: string;
	url?: string;
	content?: string;
}

interface TavilyResponse {
	results?: TavilyResult[];
	answer?: string;
}

function formatResults(results: TavilyResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => {
			const title = r.title ?? "(untitled)";
			const url = r.url ?? "";
			const snippet = r.content ?? "";
			return `${i + 1}. ${title}\n${url}\n${snippet}`.trimEnd();
		})
		.join("\n\n");
}

async function executeTavilySearch(query: string, apiKey: string): Promise<string> {
	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ query }),
		signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		// FIX-4: never surface raw response body (may echo Authorization or
		// provider-internal key material on auth errors). Return a sanitized
		// status-coded message.
		if (response.status === 401 || response.status === 403) {
			throw new Error(`Tavily search failed (${response.status}): provider auth failed`);
		}
		throw new Error(`Tavily search failed (${response.status}): ${response.statusText}`);
	}
	// FIX-2: cap response body to prevent memory exhaustion.
	const text = await readBodyCapped(response, SEARCH_MAX_BODY_BYTES);
	let data: TavilyResponse;
	try {
		data = JSON.parse(text) as TavilyResponse;
	} catch {
		throw new Error(`Tavily search failed: malformed JSON response`);
	}
	return formatResults(data.results ?? []);
}

/**
 * Read up to `maxBytes` from a Response body. Throws if the body exceeds
 * `maxBytes`, preventing memory exhaustion from oversized responses.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) {
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

async function executeSerperSearch(_query: string, _apiKey: string): Promise<string> {
	throw new Error("serper web search provider is not implemented");
}

async function executeBraveSearch(_query: string, _apiKey: string): Promise<string> {
	throw new Error("brave web search provider is not implemented");
}

/**
 * Execute a web search against the configured provider.
 *
 * Throws on provider failure; callers are expected to catch and surface the error text.
 */
export async function executeSearch(query: string, opts: { provider: string; apiKey: string }): Promise<string> {
	const { provider, apiKey } = opts;
	switch (provider) {
		case "tavily":
			return executeTavilySearch(query, apiKey);
		case "serper":
			return executeSerperSearch(query, apiKey);
		case "brave":
			return executeBraveSearch(query, apiKey);
		default:
			throw new Error(`Unsupported web search provider: ${provider}`);
	}
}

export function createWebSearchToolDefinition(
	_cwd: string,
): ToolDefinition<typeof webSearchSchema, { provider: string; query: string } | undefined> {
	return {
		name: WEB_SEARCH_TOOL_NAME,
		label: "WebSearch",
		description:
			"Search the web for current information. Returns formatted text results (title, url, snippet). Configure via WEB_SEARCH_API_KEY and WEB_SEARCH_PROVIDER (default: tavily) in settings.json.",
		promptSnippet: "Search the web",
		parameters: webSearchSchema,
		async execute(_toolCallId, { query }, _signal, _onUpdate, _ctx) {
			const provider = process.env.WEB_SEARCH_PROVIDER ?? "tavily";
			const apiKey = process.env.WEB_SEARCH_API_KEY;
			if (!apiKey) {
				return {
					content: [{ type: "text", text: NOT_CONFIGURED_MESSAGE }] as TextContent[],
					details: undefined,
				};
			}
			try {
				const text = await executeSearch(query, { provider, apiKey });
				return {
					content: [{ type: "text", text }] as TextContent[],
					details: { provider, query },
				};
			} catch (error) {
				return {
					content: [
						{ type: "text", text: `WebSearch error: ${error instanceof Error ? error.message : String(error)}` },
					] as TextContent[],
					details: undefined,
				};
			}
		},
	};
}

export function createWebSearchTool(cwd: string): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd));
}
