import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createWebFetchToolDefinition, htmlToText, WEB_FETCH_TOOL_NAME } from "../src/core/tools/web-fetch.ts";

const ORIGINAL_ENV = { ...process.env };

function makeCtx(): ExtensionContext {
	return {} as ExtensionContext;
}

beforeEach(() => {
	process.env = { ...ORIGINAL_ENV };
	delete process.env.WEB_FETCH_ENABLED;
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("htmlToText", () => {
	it("strips script and style tags entirely", () => {
		const html = '<style>body{color:red}</style><script>alert("x")</script><p>hi</p>';
		expect(htmlToText(html)).toBe("hi");
	});

	it("removes all HTML tags", () => {
		const html = '<div><h1>Title</h1><p>Paragraph <a href="#">link</a></p></div>';
		expect(htmlToText(html)).toBe("Title Paragraph link");
	});

	it("decodes common HTML entities", () => {
		expect(htmlToText("&amp;&lt;&gt;&quot;&#39;&nbsp;")).toBe("&<>\"'");
	});

	it("collapses whitespace", () => {
		const html = "<p>a\n\n  b\t\tc</p>";
		expect(htmlToText(html)).toBe("a b c");
	});

	it("returns empty string for empty input", () => {
		expect(htmlToText("")).toBe("");
	});
});

describe("WebFetch tool (disabled)", () => {
	it("returns disabled message when WEB_FETCH_ENABLED is not set", async () => {
		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"call-1",
			{ url: "https://example.com" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(result.content).toEqual([
			{ type: "text", text: "WebFetch is disabled. Set WEB_FETCH_ENABLED=1 in settings.json." },
		]);
	});

	it("returns disabled message when WEB_FETCH_ENABLED is not '1'", async () => {
		process.env.WEB_FETCH_ENABLED = "0";
		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"call-2",
			{ url: "https://example.com" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("disabled"),
		});
	});

	it("does not call fetch when disabled", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const definition = createWebFetchToolDefinition(process.cwd());
		await definition.execute("call-3", { url: "https://example.com" }, undefined, undefined, makeCtx());
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("WebFetch tool (enabled)", () => {
	beforeEach(() => {
		process.env.WEB_FETCH_ENABLED = "1";
	});

	it("fetches URL and returns extracted text", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Map([["content-type", "text/html"]]),
			text: () => Promise.resolve("<html><body><h1>Hello</h1><p>World</p></body></html>"),
		});
		vi.stubGlobal("fetch", fetchMock);

		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"call-4",
			{ url: "https://example.com" },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(fetchMock).toHaveBeenCalledWith("https://example.com", expect.objectContaining({ method: "GET" }));
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Hello");
		expect(text).toContain("World");
		expect(text).not.toContain("<h1>");
	});

	it("includes prompt hint when prompt is provided", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Map(),
			text: () => Promise.resolve("<p>some content</p>"),
		});
		vi.stubGlobal("fetch", fetchMock);

		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"call-5",
			{ url: "https://example.com", prompt: "summarize" },
			undefined,
			undefined,
			makeCtx(),
		);

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("some content");
	});

	it("returns error text result on network failure", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("ENOTFOUND example.com"));
		vi.stubGlobal("fetch", fetchMock);

		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"call-6",
			{ url: "https://example.com" },
			undefined,
			undefined,
			makeCtx(),
		);

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("ENOTFOUND");
	});

	it("returns error text result on non-ok HTTP status", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			headers: new Map(),
			text: () => Promise.resolve(""),
		});
		vi.stubGlobal("fetch", fetchMock);

		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"call-7",
			{ url: "https://example.com" },
			undefined,
			undefined,
			makeCtx(),
		);

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("404");
	});
});

describe("WebFetch tool definition metadata", () => {
	it("exposes the expected tool name", () => {
		expect(WEB_FETCH_TOOL_NAME).toBe("WebFetch");
		const definition = createWebFetchToolDefinition(process.cwd());
		expect(definition.name).toBe("WebFetch");
	});

	it("has url and prompt parameters in schema", () => {
		const definition = createWebFetchToolDefinition(process.cwd());
		const props = (definition.parameters as unknown as { properties: Record<string, unknown> }).properties;
		expect(props).toHaveProperty("url");
		expect(props).toHaveProperty("prompt");
	});
});
