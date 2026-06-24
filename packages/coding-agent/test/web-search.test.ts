import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createWebSearchTool,
	createWebSearchToolDefinition,
	executeSearch,
	WEB_SEARCH_TOOL_NAME,
} from "../src/core/tools/web-search.ts";

function getText(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") ?? ""
	);
}

const originalFetch = globalThis.fetch;

describe("web-search tool", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		delete process.env.WEB_SEARCH_API_KEY;
		delete process.env.WEB_SEARCH_PROVIDER;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = originalFetch;
	});

	describe("gate (not configured)", () => {
		it("returns not-configured message when WEB_SEARCH_API_KEY is unset", async () => {
			const tool = createWebSearchTool(process.cwd());
			const result = await tool.execute("call-1", { query: "hello" });
			expect(getText(result)).toContain("not configured");
			expect(getText(result)).toContain("WEB_SEARCH_API_KEY");
		});

		it("does not issue a network request when unconfigured", async () => {
			const fetchMock = vi.fn();
			globalThis.fetch = fetchMock as any;
			const def = createWebSearchToolDefinition(process.cwd());
			await def.execute("call-2", { query: "hello" }, undefined, undefined, {} as any);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe("executeSearch (tavily)", () => {
		beforeEach(() => {
			process.env.WEB_SEARCH_API_KEY = "test-key";
			process.env.WEB_SEARCH_PROVIDER = "tavily";
		});

		it("formats tavily results into text", async () => {
			globalThis.fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							results: [
								{ title: "Result One", url: "https://example.com/one", content: "snippet one" },
								{ title: "Result Two", url: "https://example.com/two", content: "snippet two" },
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			) as any;

			const text = await executeSearch("hello", { provider: "tavily", apiKey: "test-key" });
			expect(text).toContain("Result One");
			expect(text).toContain("https://example.com/one");
			expect(text).toContain("snippet one");
			expect(text).toContain("Result Two");
			expect(text).toContain("https://example.com/two");
		});

		it("returns 'No results found.' when tavily returns empty results", async () => {
			globalThis.fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ results: [] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			) as any;

			const text = await executeSearch("hello", { provider: "tavily", apiKey: "test-key" });
			expect(text).toContain("No results found");
		});

		it("throws on non-ok tavily response", async () => {
			globalThis.fetch = vi.fn(async () => new Response("bad request", { status: 400 })) as any;

			await expect(executeSearch("hello", { provider: "tavily", apiKey: "test-key" })).rejects.toThrow(
				/Tavily search failed/,
			);
		});

		it("returns error text from tool when provider fetch throws", async () => {
			globalThis.fetch = vi.fn(async () => {
				throw new Error("network down");
			}) as any;

			const tool = createWebSearchTool(process.cwd());
			const result = await tool.execute("call-3", { query: "hello" });
			expect(getText(result)).toMatch(/WebSearch error/i);
			expect(getText(result)).toContain("network down");
		});

		it("returns error text from tool on non-ok response", async () => {
			globalThis.fetch = vi.fn(async () => new Response("bad request", { status: 400 })) as any;

			const tool = createWebSearchTool(process.cwd());
			const result = await tool.execute("call-4", { query: "hello" });
			expect(getText(result)).toMatch(/WebSearch error/i);
		});
	});

	describe("provider stubs", () => {
		it("serper provider is not implemented", async () => {
			await expect(executeSearch("q", { provider: "serper", apiKey: "k" })).rejects.toThrow(/not implemented/i);
		});

		it("brave provider is not implemented", async () => {
			await expect(executeSearch("q", { provider: "brave", apiKey: "k" })).rejects.toThrow(/not implemented/i);
		});

		it("unknown provider throws", async () => {
			await expect(executeSearch("q", { provider: "nope", apiKey: "k" })).rejects.toThrow(
				/Unsupported web search provider/,
			);
		});
	});

	describe("tool definition metadata", () => {
		it("exposes the WebSearch tool name", () => {
			expect(WEB_SEARCH_TOOL_NAME).toBe("WebSearch");
			const def = createWebSearchToolDefinition(process.cwd());
			expect(def.name).toBe("WebSearch");
			expect(def.label).toBe("WebSearch");
			expect(def.parameters).toBeDefined();
			expect(def.description).toContain("WEB_SEARCH_API_KEY");
		});
	});
});
