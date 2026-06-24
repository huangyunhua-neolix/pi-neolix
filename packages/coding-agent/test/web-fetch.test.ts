import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createWebFetchToolDefinition,
	htmlToText,
	isPrivateIP,
	validateFetchUrl,
	WEB_FETCH_TOOL_NAME,
} from "../src/core/tools/web-fetch.ts";

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

		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.com/",
			expect.objectContaining({ method: "GET", redirect: "manual" }),
		);
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

// ---------------------------------------------------------------------------
// BLOCKER-1: SSRF hardening
// ---------------------------------------------------------------------------

describe("isPrivateIP", () => {
	it("rejects 127.0.0.1 (loopback)", () => {
		expect(isPrivateIP("127.0.0.1")).toBe(true);
	});
	it("rejects 169.254.169.254 (cloud IMDS)", () => {
		expect(isPrivateIP("169.254.169.254")).toBe(true);
	});
	it("rejects 10.0.0.1 (private 10/8)", () => {
		expect(isPrivateIP("10.0.0.1")).toBe(true);
	});
	it("rejects 172.16.0.1 (private 172.16/12)", () => {
		expect(isPrivateIP("172.16.0.1")).toBe(true);
	});
	it("rejects 192.168.1.1 (private 192.168/16)", () => {
		expect(isPrivateIP("192.168.1.1")).toBe(true);
	});
	it("rejects 0.0.0.0", () => {
		expect(isPrivateIP("0.0.0.0")).toBe(true);
	});
	it("rejects ::1 (IPv6 loopback)", () => {
		expect(isPrivateIP("::1")).toBe(true);
	});
	it("rejects fc00::1 (IPv6 unique-local)", () => {
		expect(isPrivateIP("fc00::1")).toBe(true);
	});
	it("rejects fe80::1 (IPv6 link-local)", () => {
		expect(isPrivateIP("fe80::1")).toBe(true);
	});
	it("rejects ::ffff:127.0.0.1 (IPv4-mapped)", () => {
		expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
	});
	it("allows 8.8.8.8 (public)", () => {
		expect(isPrivateIP("8.8.8.8")).toBe(false);
	});
	it("allows 1.1.1.1 (public)", () => {
		expect(isPrivateIP("1.1.1.1")).toBe(false);
	});
	it("treats non-IP strings as private (fail-closed)", () => {
		expect(isPrivateIP("not-an-ip")).toBe(true);
	});
});

describe("validateFetchUrl (BLOCKER-1 SSRF guard)", () => {
	it("rejects file:// scheme", async () => {
		const result = await validateFetchUrl("file:///etc/passwd");
		expect(result.error).toMatch(/scheme not allowed/i);
	});
	it("rejects gopher:// scheme", async () => {
		const result = await validateFetchUrl("gopher://example.com/");
		expect(result.error).toMatch(/scheme not allowed/i);
	});
	it("rejects http://127.0.0.1 (loopback IP literal)", async () => {
		const result = await validateFetchUrl("http://127.0.0.1/");
		expect(result.error).toMatch(/private\/loopback/i);
	});
	it("rejects http://169.254.169.254 (IMDS)", async () => {
		const result = await validateFetchUrl("http://169.254.169.254/latest/meta-data/");
		expect(result.error).toMatch(/private\/loopback/i);
	});
	it("rejects http://10.0.0.1", async () => {
		const result = await validateFetchUrl("http://10.0.0.1/");
		expect(result.error).toMatch(/private\/loopback/i);
	});
	it("rejects http://[::1]/ (IPv6 loopback)", async () => {
		const result = await validateFetchUrl("http://[::1]/");
		expect(result.error).toMatch(/private\/loopback/i);
	});
	it("allows http://example.com (public hostname)", async () => {
		const result = await validateFetchUrl("http://example.com/");
		expect(result.error).toBeNull();
	});
	it("allows http://8.8.8.8 (public IP literal)", async () => {
		const result = await validateFetchUrl("http://8.8.8.8/");
		expect(result.error).toBeNull();
	});
});

describe("WebFetch SSRF + redirect + prompt-injection (BLOCKER-1, FIX-3)", () => {
	beforeEach(() => {
		process.env.WEB_FETCH_ENABLED = "1";
	});

	it("rejects file:// URLs without calling fetch", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute("ssrf-1", { url: "file:///etc/passwd" }, undefined, undefined, makeCtx());
		expect(fetchSpy).not.toHaveBeenCalled();
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/refused/i);
		expect(text).toMatch(/scheme not allowed/i);
	});

	it("rejects http://127.0.0.1 without calling fetch", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"ssrf-2",
			{ url: "http://127.0.0.1:8080/admin" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/refused/i);
	});

	it("rejects redirect to 169.254.169.254 (IMDS via 302)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "http://169.254.169.254/latest/meta-data/" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"ssrf-3",
			{ url: "http://example.com/redirect" },
			undefined,
			undefined,
			makeCtx(),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/refused/i);
		expect(text).toContain("169.254.169.254");
	});

	it("wraps fetched content in <fetched-content> tag (FIX-3)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("<p>hello world</p>", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"inj-1",
			{ url: "https://example.com/" },
			undefined,
			undefined,
			makeCtx(),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("<fetched-content");
		expect(text).toContain("hello world");
		expect(text).toContain("</fetched-content>");
	});

	it("includes prompt hint before the wrapped content when prompt is provided", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("<p>data</p>", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const definition = createWebFetchToolDefinition(process.cwd());
		const result = await definition.execute(
			"inj-2",
			{ url: "https://example.com/", prompt: "summarize" },
			undefined,
			undefined,
			makeCtx(),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.startsWith("Prompt: summarize")).toBe(true);
		expect(text).toContain("<fetched-content");
	});
});
