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

			let response: Response;
			try {
				response = await fetch(url, { method: "GET" });
			} catch (error: any) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(`WebFetch failed for ${url}: ${message}`, { url });
			}

			if (!response.ok) {
				return errorResult(`WebFetch failed for ${url}: HTTP ${response.status}`, {
					status: response.status,
					url,
				});
			}

			const raw = await response.text();
			const text = htmlToText(raw);

			let output = text;
			if (prompt) {
				output = `Prompt: ${prompt}\n\n${text}`;
			}

			return textResult(output, { status: response.status, url });
		},
	};
}

export function createWebFetchTool(cwd: string): AgentTool<typeof webFetchSchema, WebFetchToolDetails> {
	return wrapToolDefinition(createWebFetchToolDefinition(cwd));
}
