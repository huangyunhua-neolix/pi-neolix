import { afterEach, beforeEach, vi } from "vitest";

export interface CapturedRequest {
	url: string | URL | undefined;
	method: string | undefined;
	headers: Headers | string[][] | Record<string, string | readonly string[]> | undefined;
	body: string | undefined;
}

export interface MockFetchOptions {
	status?: number;
	headers?: Record<string, string>;
	body?: string;
}

const AUTH_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GEMINI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_ENDPOINT",
	"GITHUB_TOKEN",
	"COPILOT_TOKEN",
	"DEEPSEEK_API_KEY",
	"GROQ_API_KEY",
	"XAI_API_KEY",
	"MISTRAL_API_KEY",
	"TOGETHER_API_KEY",
	"CEREBRAS_API_KEY",
	"FIREWORKS_API_KEY",
	"OPENROUTER_API_KEY",
	"CLOUDFLARE_API_KEY",
	"VERCEL_AI_GATEWAY_API_KEY",
	"MOONSHOT_API_KEY",
	"MINIMAX_API_KEY",
	"XIAOMI_API_KEY",
	"ZAI_API_KEY",
	"HUGGINGFACE_API_KEY",
	"NVIDIA_API_KEY",
];

export interface MockFetchResult {
	captured: CapturedRequest;
	restore: () => void;
}

export function mockFetch(options: MockFetchOptions = {}): MockFetchResult {
	const captured: CapturedRequest = {
		url: undefined,
		method: undefined,
		headers: undefined,
		body: undefined,
	};

	const status = options.status ?? 200;
	const responseHeaders = options.headers ?? { "content-type": "text/event-stream" };
	const responseBody = options.body ?? "data: [DONE]\n\n";

	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		captured.url = typeof input === "string" ? input : input instanceof URL ? input : input.url;
		captured.method = init?.method;
		captured.headers = init?.headers;
		captured.body = typeof init?.body === "string" ? init.body : undefined;
		return new Response(responseBody, { status, headers: responseHeaders });
	});

	return {
		captured,
		restore: () => spy.mockRestore(),
	};
}

export function getHeader(headers: CapturedRequest["headers"], name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of AUTH_ENV_VARS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
		delete savedEnv[key];
	}
	vi.restoreAllMocks();
});
