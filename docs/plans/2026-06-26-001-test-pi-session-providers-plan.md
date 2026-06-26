---
title: "test: pi/ Test Coverage — Session Persistence + AI Providers"
date: 2026-06-26
type: test
origin: docs/brainstorms/2026-06-26-issue41-pi-test-coverage-requirements.md
reviewed: 2026-06-26
---

# Plan: pi/ Test Coverage — Session Persistence + AI Providers

## Summary

Add targeted unit tests to fill genuine gaps in two areas of the pi/ submodule: (1) backward-compatibility fixtures and missing error paths in the session persistence layer, and (2) fetch-level mock tests for AI provider request construction and error paths. All tests are regression guards — they verify existing behavior without modifying persistence format, session layout, or cleanup logic (铁律).

## Problem Frame

pi/ has 321 test files across 1697 source files (18.9% coverage). The issue (#41) identified two gaps. After doc-review verification, the gaps are narrower than originally stated:

1. **Session persistence** (`packages/agent/src/harness/session/`): 7 source files with **5 existing test files** (`session.test.ts`, `session-uuid.test.ts`, `repo.test.ts`, `repo-utils.test.ts`, `storage.test.ts`). The repo layer, repo-utils, and storage round-trip are already tested. The genuine gaps are: (a) backward-compatibility fixtures verifying old-format JSONL readability, (b) a few missing error paths in `repo.test.ts` (createDir failure, list sorting, invalid JSONL skipping).

2. **AI providers** (`packages/ai/src/providers/`): 37 provider source files with **85 existing test files** in `packages/ai/test/`. Every provider has at least 1 test file. However, existing tests are predominantly behavioral/compat/model-loading tests. The genuine gap is **fetch-level mock tests for HTTP request construction** (URL, headers, body shape) and **error-path coverage** (401, 429, timeout) — most existing tests do not verify the request shape sent to `fetch`.

## Requirements

Carried from origin document, revised per doc-review:

- **R1**: Session round-trip persistence tests (partially covered by `storage.test.ts` — add branching round-trip only)
- **R2**: `JsonlSessionRepo` and `InMemorySessionRepo` CRUD tests (partially covered by `repo.test.ts` — add missing error paths)
- **R3**: `repo-utils.ts` tests (fully covered by `repo-utils.test.ts` — 15 tests, all 5 functions — no new work needed)
- **R4**: At least one backward-compatibility fixture test verifies old-format reading (genuine gap — no existing coverage)
- **R5**: Providers lacking fetch-level mock tests get happy-path + error-path coverage (gap is narrower than originally stated — most providers have behavioral tests, just not request-construction mock tests)
- **R6**: All new tests pass: `npm test` green
- **R7**: No modifications to persistence format, session directory layout, or cleanup logic (铁律)
- **R8**: CI runs pi/ tests (already configured in `.github/workflows/ci.yml` — verify and document)

## Key Technical Decisions

### KTD1: Mock FileSystem for backward-compat fixture tests

`JsonlSessionRepo` and `loadJsonlSessionMetadata` depend on a `FileSystem` interface. Backward-compat fixture tests will use an in-memory `FileSystem` mock (not a real temp dir) to inject old-format JSONL strings and verify they're read without error. The existing `storage.test.ts` already uses real temp dirs for round-trip — that approach is fine for storage-level tests but不适合 backward-compat fixture injection.

**Alternative considered:** Use `memfs` npm package. Rejected — adds a dependency when a ~50-line in-memory mock suffices.

### KTD2: Group providers by API pattern for fetch-level mock tests

Providers share API adapters (anthropic-messages, openai-responses, openai-chat-completions, google-gemini, custom). Tests will group by API pattern and share a `mockFetch` helper that intercepts `globalThis.fetch`, records request properties (URL, headers, body), and returns configurable responses. Each provider test parameterizes the helper with its expected URL/headers/body.

**Why:** Even though providers have existing behavioral tests, those tests don't verify the HTTP request shape. A shared `mockFetch` helper with per-provider config keeps request-construction tests compact.

### KTD3: Backward-compat fixtures as inline synthetic strings

Old-format session fixtures will be inline JSONL strings in the test file, not external fixture files. All fixture content must be **fully synthetic** — no real usernames, file paths, or credential-shaped values. Each fixture represents a plausible older format (e.g., missing optional fields like `parentSessionPath`, or entries with only `type` + `message` and no `timestamp`).

**Constraint (铁律):** Fixtures only test that current code reads old data without error. They do NOT test that current code writes old-format data — current code always writes current format.

### KTD4: Provider tests mock fetch, not the provider's API module

Each provider calls an API module (e.g., `anthropicMessagesApi()`) that internally calls `fetch`. Tests mock `globalThis.fetch` via `vi.spyOn(globalThis, "fetch")` — the same pattern used in `openai-responses-copilot-provider.test.ts`. This tests the full request-construction path (provider → API module → fetch) without mocking internal modules.

### KTD5: Env var isolation for auth tests

Provider auth-resolution tests must stub/clear all auth-related env vars before each test to prevent real-credential leakage. The `mockFetch` helper contract includes a `beforeEach`/`afterEach` that saves, clears, and restores all auth env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `AZURE_OPENAI_API_KEY`, `GITHUB_TOKEN`, etc.). This prevents tests from silently succeeding against real credentials on dev machines or CI runners.

---

## Implementation Units

### U1. Extend repo.test.ts with missing error paths

**Goal:** Add the missing error-path and edge-case tests to the existing `repo.test.ts` (68 lines, 3 test cases). The existing tests cover happy-path CRUD for both `InMemorySessionRepo` and `JsonlSessionRepo` but lack error paths.

**Requirements:** R2, R7

**Dependencies:** none

**Files:**
- `packages/agent/test/harness/repo.test.ts` (modify — extend existing)
- `packages/agent/test/harness/mock-fs.ts` (new — shared in-memory FileSystem mock for error injection)

**Approach:**
- Add a `mock-fs.ts` helper with an `InMemoryFileSystem` implementing the `Pick<FileSystem, ...>` interface. Store files/dirs in a `Map`. All methods return `Result<TValue, FileError>`. Support configurable failure injection (e.g., `createDir` always fails).
- Add tests to the existing `describe("JsonlSessionRepo")` block:
  - `list()` on non-existent sessionsRoot → returns empty array
  - `list()` with `.jsonl` file that has invalid JSON → catches `invalid_session`, skips; other errors propagate
  - `list()` sorting — create two sessions, verify sorted by `createdAt` descending
  - `open()` with non-existent path → throws `SessionError("not_found")`
  - `create()` when `createDir` fails (mock returns `FileError`) → throws `SessionError` with code `"storage"`
- Add tests to the existing `describe("InMemorySessionRepo")` block:
  - `open()` with unknown id → `SessionError("not_found")`
  - `delete()` non-existent session → no-op (Map.delete on missing key)

**Patterns to follow:** Existing `repo.test.ts` structure. New `mock-fs.ts` follows the pattern of `session-test-utils.ts` (shared helper in `test/harness/`).

**Test scenarios:**
- **Edge case:** list on non-existent sessionsRoot → returns empty array (not error)
- **Edge case:** list with invalid JSON `.jsonl` file → catches `invalid_session`, skips
- **Edge case:** list sorting — two sessions → sorted by createdAt desc
- **Error path:** open with non-existent path → `SessionError("not_found")`
- **Error path:** create when createDir fails → `SessionError("storage")`
- **Error path:** open InMemorySessionRepo with unknown id → `SessionError("not_found")`
- **Error path:** delete non-existent InMemorySessionRepo session → no-op

**Verification:** `npx vitest run packages/agent/test/harness/repo.test.ts` passes with all new + existing tests.

---

### U2. Session backward-compat fixture tests

**Goal:** Verify that old-format JSONL files are readable without error, without data loss, and render original content (铁律). This is the one genuine gap in the session layer — no existing test covers backward compatibility.

**Requirements:** R4, R7

**Dependencies:** U1 (mock-fs helper)

**Files:**
- `packages/agent/test/harness/session-backward-compat.test.ts` (new)

**Approach:**
- Use the `mock-fs.ts` helper from U1 to inject old-format JSONL strings into the in-memory filesystem.
- Construct inline synthetic JSONL fixtures representing plausible older formats:
  - Missing optional fields like `parentSessionPath`
  - Entries with only `type` + `message` and no `timestamp`
  - Minimal header with just `cwd` + `sessionId` (no `parentSessionPath`, no `createdAt`)
- Call `loadJsonlSessionMetadata()` and `JsonlSessionStorage.open()` on each fixture — verify no error, no data loss, content renders.
- **铁律 guard:** Tests only READ old-format data. They never write old-format data. Current code always writes current format.
- **All fixtures must be fully synthetic** — no real usernames, file paths, or credential-shaped values.

**Patterns to follow:** `packages/agent/test/harness/storage.test.ts` — uses `JsonlSessionStorage` and `loadJsonlSessionMetadata` directly. Use `mock-fs.ts` instead of real temp dirs for fixture injection.

**Test scenarios:**
- **Happy path:** old-format fixture with missing `parentSessionPath` → `loadJsonlSessionMetadata()` succeeds, returns metadata with `parentSessionPath: undefined`
- **Happy path:** old-format fixture with entries missing `timestamp` → `JsonlSessionStorage.open()` succeeds, entries readable
- **Edge case:** empty session file (only metadata line, no entries) → open succeeds, `getEntries()` returns `[]`
- **Edge case:** fixture with minimal header (only `cwd` + `sessionId`) → open succeeds, missing fields default to `undefined`
- **Error path:** corrupt JSONL (invalid JSON on first line) → `loadJsonlSessionMetadata()` throws `SessionError("invalid_session")`

**Verification:** `npx vitest run packages/agent/test/harness/session-backward-compat.test.ts` passes.

---

### U3. Provider shared mock helper + reference provider tests

**Goal:** Build the shared `mockFetch` test helper (with env var isolation) and write fetch-level request-construction tests for the three "reference" providers (anthropic, openai, google) that establish the pattern for all subsequent provider tests.

**Requirements:** R5

**Dependencies:** none

**Files:**
- `packages/ai/test/helpers/mock-fetch.ts` (new — shared helper with env var isolation)
- `packages/ai/test/providers/anthropic-request.test.ts` (new)
- `packages/ai/test/providers/openai-request.test.ts` (new)
- `packages/ai/test/providers/google-request.test.ts` (new)

**Approach:**
- **`mockFetch` helper:** Wraps `vi.spyOn(globalThis, "fetch")`. Takes a config: `{ status, headers, body }` for the mock response, and returns a `captured` object with `{ url, method, headers, body }` for request assertions. `afterEach` restores `fetch`.
- **Env var isolation (KTD5):** The helper's `beforeEach` saves and clears all auth-related env vars. `afterEach` restores them. This prevents real-credential leakage.
- **Anthropic provider test:** Mock `fetch` to return a streaming response. Verify: request URL is `https://api.anthropic.com/v1/messages`, headers include `x-api-key` and `anthropic-version`, body contains model + messages. Test 401 error path. Test 429 rate limit path. Test model list loading from `anthropic.models.ts`.
- **OpenAI provider test:** Same pattern for `openai-responses` API. Verify URL, `Authorization` header, body. Error paths: 401, 429, timeout (`AbortError`). Test model list loading.
- **Google provider test:** Same for `google-gemini` API. Verify URL pattern, `x-goog-api-key` header. Error paths: 401, 429. Test model list loading.

**Patterns to follow:** `packages/ai/test/openai-responses-copilot-provider.test.ts` — uses `vi.spyOn(globalThis, "fetch")`, captures headers, iterates stream events.

**Test scenarios:**
- **Happy path (anthropic):** stream with mock 200 → events collected, request URL/headers/body verified
- **Happy path (openai):** stream with mock 200 SSE → events collected, `Authorization` header verified
- **Happy path (google):** stream with mock 200 → events collected, `x-goog-api-key` header verified
- **Model loading (each):** provider's `.models.ts` exports load correctly, model ids match expected format
- **Error path (each provider):** 401 response → auth error surfaced
- **Error path (each provider):** 429 response → rate limit error surfaced
- **Error path (openai):** fetch rejects with `AbortError` → timeout/network error surfaced
- **Edge case (each provider):** missing API key env var → auth resolution returns undefined

**Verification:** `npx vitest run packages/ai/test/providers/anthropic-request.test.ts packages/ai/test/providers/openai-request.test.ts packages/ai/test/providers/google-request.test.ts` passes.

---

### U4. OpenAI-compatible provider batch request-construction tests

**Goal:** Fetch-level request-construction tests for providers that use the `openai-chat-completions` or similar API pattern. These share a common request structure (URL differs, headers differ slightly, body shape is similar). Also covers special providers that share the same API pattern.

**Requirements:** R5

**Dependencies:** U3 (mock-fetch helper)

**Files:**
- `packages/ai/test/providers/openai-compatible-request.test.ts` (new — parametrized test suite)

**Approach:**
- Build a parametrized test suite: `describe.each(providers)` where each provider config specifies `{ id, providerFn, expectedBaseUrl, expectedAuthHeaderName, expectedAuthEnvVar, modelsFile }`.
- For each provider: mock fetch, call `stream()` or `complete()`, verify URL contains `expectedBaseUrl`, auth header name matches, body contains the model id and messages.
- Error paths: 401, 429 (parametrized — same assertions, different provider).
- Model list loading: for providers with `.models.ts`, verify model ids load correctly.
- Providers covered (grouped by API pattern):
  - **OpenAI-chat-completions:** groq, deepseek, xai, mistral, together, cerebras, fireworks, openrouter, vercel-ai-gateway, cloudflare-workers-ai, opencode, opencode-go
  - **Special (same parametrized pattern):** minimax, minimax-cn, moonshotai, moonshotai-cn, xiaomi, xiaomi-token-plan-cn, xiaomi-token-plan-sgp, xiaomi-token-plan-ams, zai, zai-coding-cn, kimi-coding, ant-ling, huggingface, nvidia, openai-codex, azure-openai-responses

**Patterns to follow:** U3's `mockFetch` helper + `describe.each` pattern from vitest.

**Test scenarios:**
- **Happy path (each provider):** mock 200 → request URL contains provider's baseUrl, auth header correct, body has model + messages
- **Model loading (each provider with .models.ts):** model ids load correctly
- **Error path (each provider):** 401 → auth error
- **Error path (each provider):** 429 → rate limit error
- **Edge case (each provider):** missing API key env var → auth resolution returns undefined

**Verification:** `npx vitest run packages/ai/test/providers/openai-compatible-request.test.ts` passes.

---

### U5. Special-auth provider request-construction tests

**Goal:** Fetch-level request-construction tests for providers with distinct auth patterns that cannot be parametrized with the OpenAI-compatible suite: bedrock (AWS SigV4), google-vertex (ADC), github-copilot (OAuth).

**Requirements:** R5

**Dependencies:** U3 (mock-fetch helper)

**Files:**
- `packages/ai/test/providers/bedrock-request.test.ts` (new)
- `packages/ai/test/providers/vertex-request.test.ts` (new)
- `packages/ai/test/providers/github-copilot-request.test.ts` (new)

**Approach:**
- **Bedrock:** Test AWS auth resolution (ambient credentials, no API key needed), verify request uses AWS SigV4 signing (mock fetch, verify `Authorization` header contains `AWS4-HMAC-SHA256`). Test model list loading from `amazon-bedrock.models.ts`.
- **Vertex:** Test ADC (Application Default Credentials) file-based auth + project/location env vars. Verify URL pattern includes project and location. Test model list loading.
- **GitHub Copilot:** Test OAuth token resolution, verify request to copilot proxy URL. Extend the existing `openai-responses-copilot-provider.test.ts` pattern. Test model list loading.

**Patterns to follow:** U3's `mockFetch` helper. Existing `bedrock-endpoint-resolution.test.ts`, `google-vertex-api-key-resolution.test.ts`, `github-copilot-oauth.test.ts` provide auth-resolution patterns.

**Test scenarios:**
- **Happy path (bedrock):** mock fetch → request signed with AWS SigV4, URL is bedrock runtime endpoint
- **Happy path (vertex):** mock fetch → URL contains project + location, auth from ADC
- **Happy path (copilot):** mock fetch → request to copilot proxy, OAuth token in header
- **Model loading (each):** `.models.ts` exports load correctly
- **Error path (each):** 401 → auth error
- **Error path (bedrock):** no AWS credentials → unconfigured
- **Error path (vertex):** no ADC file + no project → unconfigured
- **Error path (copilot):** no OAuth token → unconfigured

**Verification:** All new provider test files pass via `npx vitest run packages/ai/test/providers/bedrock-request.test.ts packages/ai/test/providers/vertex-request.test.ts packages/ai/test/providers/github-copilot-request.test.ts`.

---

### U6. CI verification

**Goal:** Verify that `.github/workflows/ci.yml` runs all pi/ tests, and document it.

**Requirements:** R8

**Dependencies:** U1–U5 (all tests must exist first)

**Files:**
- `.github/workflows/ci.yml` (modify — add comment documenting pi/ test inclusion)
- `packages/agent/package.json` (verify — `"test"` script exists and runs vitest)
- `packages/ai/package.json` (verify — same)

**Approach:**
- Verify `npm test` (root) runs `npm run test --workspaces --if-present`, which runs each workspace's `test` script.
- Verify `packages/agent/package.json` has `"test": "vitest"` or similar.
- Verify `packages/ai/package.json` has `"test": "vitest"` or similar.
- Add a comment to `.github/workflows/ci.yml` in the Test step documenting that pi/ workspace tests are included.
- If any workspace is missing a test script, add `"test": "vitest run"` to its `package.json`.

**Test scenarios:**
- **Test expectation: none** — this unit is CI config verification, not behavioral code. Verification is running `npm test` locally and confirming all workspace tests run.

**Verification:** `npm test` from repo root runs tests for all 4 workspaces (agent, ai, coding-agent, tui) and all pass.

---

## Scope Boundaries

### In scope
- Session backward-compat fixture tests (genuine gap — no existing coverage)
- Missing error paths in `repo.test.ts` (extends existing file)
- Fetch-level request-construction mock tests for AI providers (complements existing behavioral tests)
- CI verification (confirm tests run, add documentation comment)

### Permanently excluded (铁律)
- Modifying any persistence format or session directory layout
- Tests that require network access or real API credentials
- Adding new providers or changing existing provider behavior

### Deferred to follow-up work
- E2E/integration tests that require real API keys
- Performance/load testing for session storage
- Tests for `packages/coding-agent/` or `packages/tui/` (already well-covered)
- Startup cleanup logic tests (cleanup lives in the web server, not pi/)

---

## Risks and Dependencies

| Risk | Mitigation |
|---|---|
| Mock `FileSystem` doesn't match real FS behavior | Cross-check with existing `storage.test.ts` which uses real temp dirs — both approaches cover different failure modes |
| Provider API patterns change between versions | Pin mock responses to current API behavior; tests are regression guards, not forward-compat |
| 铁律 violation: test accidentally modifies persistence code | Tests only import and call existing functions; no source file modifications planned. Code review gate in Step 8 catches any accidental source changes. |
| Real-credential leakage in auth tests | `mockFetch` helper's `beforeEach`/`afterEach` saves, clears, and restores all auth env vars (KTD5) |
| Backward-compat fixtures contain real-looking data | All fixtures must be fully synthetic — no real usernames, file paths, or credential-shaped values (KTD3) |
| Existing provider tests overlap with new request-construction tests | New tests focus on request shape (URL/headers/body), not behavior — complement rather than duplicate existing coverage |

---

## System-Wide Impact

- **CI:** New test files increase CI runtime. Estimate ~30-60s additional (mock-only, no network). Acceptable — CI already takes several minutes for build + check + test.
- **Developers:** New tests provide regression guards for anyone touching session persistence or providers. No workflow changes needed.
- **No production impact:** All changes are test files + one CI comment. No source modifications, no dependency changes.

---

## Assumptions

- Existing behavioral/compat tests for providers do not fully cover HTTP request construction (URL, headers, body shape) — the new fetch-level mock tests complement rather than duplicate them.
- The backward-compat fixtures represent plausible older formats based on current code's optional fields. If actual older format versions exist in git history, they should be used as fixture basis instead.
- `repo-utils.test.ts` (187 lines, 15 tests) fully covers all 5 exported functions — no additional tests needed (R3 satisfied by existing coverage).
