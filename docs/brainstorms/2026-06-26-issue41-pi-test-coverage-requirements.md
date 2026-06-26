# Requirements: pi/ Test Coverage — Session Persistence + AI Providers

**Date:** 2026-06-26
**Source:** [pi-neolix#41](https://github.com/huangyunhua-neolix/pi-neolix/issues/41)
**Related:** [freecode-web-submodule#320](https://github.com/huangyunhua-neolix/freecode-web-submodule/issues/320), [freecode-web-submodule#358](https://github.com/huangyunhua-neolix/freecode-web-submodule/issues/358)

## Problem

pi/ submodule has 321 test files across 1697 source files (18.9% coverage). Two critical gaps exist:

1. **Session persistence layer** (`packages/agent/src/harness/session/`) — 7 source files, only 2 test files covering `Session` class behavior and `uuidv7` generation. The repo layer (`jsonl-repo.ts`, `memory-repo.ts`, `repo-utils.ts`) has zero direct tests. No round-trip or backward-compatibility tests verify that persisted sessions survive format changes.

2. **AI providers** (`packages/ai/src/providers/`) — 37 provider source files, only 4 test files covering ~4 providers (faux, cross-provider-handoff, providers, openai-responses-copilot). ~33 providers have no tests for API call construction, error paths, or model loading.

## Scope

### P0 — Session persistence tests (铁律 high-risk)

**Must have:**
- Round-trip tests: write session to disk via `JsonlSessionStorage` → read back → verify all messages, metadata, branching structure, and leaf pointers are preserved
- `JsonlSessionRepo` direct tests: CRUD operations on session files (create, read, update, list, fork)
- `InMemorySessionRepo` direct tests: same CRUD surface
- `repo-utils.ts` tests: `createSessionId`, `createTimestamp`, `toSession`, `getFileSystemResultOrThrow`, `getEntriesToFork`
- Backward-compatibility: construct a fixture representing an older format version → verify current code reads it without error, without data loss, and renders the original content faithfully

**Constraint — 铁律 (iron law):**
Tests must NOT modify the persistence format, session directory layout, or startup cleanup logic. Tests only verify that reading existing/old-format files does not error, does not lose data, and renders original content. If a test would require changing the format to test it, it is out of scope — the test instead asserts the current behavior as a regression guard.

### P1 — AI provider mock tests

**Must have for each untested provider:**
- Happy path: mock the provider's HTTP endpoint → verify request construction (URL, headers, body) and response parsing
- Error paths: 401 (auth failure), 429 (rate limit), timeout (network error)
- Model list loading (where `.models.ts` exists)

**Providers to cover (P1, ~33 untested):**
anthropic, openai, google, google-vertex, bedrock, groq, deepseek, xai, mistral, together, cerebras, fireworks, openrouter, cloudflare-workers-ai, vercel-ai-gateway, azure-openai-responses, github-copilot, minimax, minimax-cn, moonshotai, moonshotai-cn, xiaomi, xiaomi-token-plan-cn, xiaomi-token-plan-sgp, xiaomi-token-plan-ams, zai, zai-coding-cn, kimi-coding, ant-ling, opencode, opencode-go, deepseek, openai-codex

**Approach:** Group providers by pattern (OpenAI-compatible vs. Anthropic-native vs. custom). Write a shared test helper that mocks `fetch` and lets each provider test parameterize URL/headers/body expectations. Providers sharing the same adapter pattern can use a shared test suite.

### P2 — CI verification

`.github/workflows/ci.yml` already runs `npm test` (which runs `npm run test --workspaces --if-present`). **P2 is mostly done** — the remaining work is:
- Verify that all workspace packages' tests actually run in CI (no conditional skips)
- Add a comment to ci.yml documenting that pi/ tests are included

## Success Criteria

- [ ] `packages/agent/src/harness/session/` has round-trip persistence tests covering `JsonlSessionStorage` write→read→verify
- [ ] `JsonlSessionRepo` and `InMemorySessionRepo` have direct CRUD tests
- [ ] `repo-utils.ts` has direct tests for all exported functions
- [ ] At least one backward-compatibility fixture test verifies old-format reading
- [ ] Each untested provider has at minimum a happy-path mock test and one error-path test
- [ ] All new tests pass: `npm test` green
- [ ] No modifications to persistence format, session directory layout, or cleanup logic

## Out of Scope

- Modifying any persistence format or session layout (铁律)
- Adding new providers or changing existing provider behavior
- Performance/load testing
- E2E/integration tests that require real API keys
- Tests for `packages/coding-agent/` or `packages/tui/` (already well-covered)

## Key Constraints

1. **铁律**: No changes to persistence format / session directory layout / startup cleanup logic. Tests are regression guards only.
2. **No real API calls**: All provider tests must mock HTTP — no network dependencies in CI.
3. **vitest**: All packages use vitest. Follow existing patterns in `packages/agent/test/` and `packages/ai/test/`.
4. **Node 22**: CI uses Node 22; local dev must match.
