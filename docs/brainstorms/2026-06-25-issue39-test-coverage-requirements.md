# Requirements: pi-neolix test coverage gap (issue #39)

- **Source issue:** huangyunhua-neolix/pi-neolix#39
- **Upstream tracker:** freecode-web-submodule#320
- **Date:** 2026-06-25
- **Scope decision:** all 4 packages in one PR (agent + tui + coding-agent + ai)

## Problem

pi-neolix has 291 tests / 936 src files, but coverage is uneven. `packages/agent` (16 tests) and `packages/tui` (28 tests) are thin relative to their src; many exported functions are untested. `packages/coding-agent` (169 tests) and `packages/ai` (85 tests) are healthy but have scattered untested exports and edge paths.

## Users & value

- **Maintainers** of pi-neolix (the coding-agent CLI monorepo): regression safety net before refactors; documented behavior via test names.
- **Upstream freecode-web-submodule**: this issue is a downstream of #320; closing it unblocks the upstream tracker.

## Success criteria

- [ ] `packages/agent/` exported-function coverage > 60%
- [ ] `packages/tui/` key interaction paths have tests (ink render, keybinding conflicts, state-update throttle, terminal resize)
- [ ] `packages/coding-agent/` and `packages/ai/` scattered untested exports covered: edge error paths, schema-validation-failure cases
- [ ] All new tests pass in CI (non-e2e; run via `./test.sh` from repo root)
- [ ] `npm run check` (biome + tsgo + pinned-deps + ts-imports + shrinkwrap + browser-smoke) passes with no errors/warnings/infos
- [ ] No production persistence format / session-dir layout / startup-cleanup logic touched (铁律)

## Scope boundaries

### In scope

- **`packages/agent/`** (highest priority):
  - Agent loop interrupt/resume
  - Tool-call failure retry
  - Context-window exhaustion handling
  - Subagent switching
  - Other untested exports surfaced by coverage report
- **`packages/tui/`**:
  - Ink rendering
  - Keybinding conflicts
  - State-update throttling
  - Terminal resize
- **`packages/coding-agent/` + `packages/ai/`**:
  - Scattered untested exports
  - Edge error paths
  - Schema-validation-failure cases

### Deferred for later

- Follow-up sweep for deeper coverage in coding-agent/ai if this cycle's scatter pass leaves sub-50% pockets (track in a separate issue).
- Coverage-threshold enforcement in CI (gating) — separate concern.

### Outside this product's identity (non-goals)

- **No production persistence format changes.** `packages/agent/src/harness/session/` (jsonl-repo, jsonl-storage, memory-repo) is persistence code. Tests may exercise it read-only against the existing format and must use temp dirs. Never mutate the on-disk format, session-directory layout, or startup cleanup logic (the freecode-web-submodule 铁律, inherited because pi is the CLI whose sessions the web wrapper hosts).
- **No new features or behavior changes.** Tests only. If a test surfaces a genuine production bug, flag it in the PR description — do not fix it in this cycle (out of scope for a coverage PR).
- **No e2e tests hitting real provider endpoints or paid tokens.** Use faux provider / mocks per existing patterns.
- **No cross-package integration tests** beyond existing patterns.

## Key decisions

1. **One PR, all 4 packages.** Mechanical test additions; review burden is moderate and a single review pass closes the issue. Chosen over agent-only because the user explicitly wants the full gap closed in this cycle.
2. **Respect per-package test frameworks.** agent / coding-agent / ai use `vitest --run`; tui uses `node --test test/*.test.ts`. Do not unify frameworks in this cycle.
3. **Coverage discovery drives targets.** The ">60% agent export coverage" target is measured against the per-package `vitest.config.ts` coverage provider. The plan phase enumerates untested exports from a coverage run; tui coverage (node --test) has no built-in threshold, so "key interaction paths have tests" is the qualitative bar there.
4. **coding-agent regressions placement.** New coding-agent tests for issue-specific behavior go under `packages/coding-agent/test/suite/regressions/39-<slug>.test.ts` using `test/suite/harness.ts` + faux provider (per AGENTS.md). Other coding-agent tests go alongside existing test files.
5. **Pre-commit gate.** `npm run check` must pass before commit. Never run full `npm test` or `vitest` directly (e2e activates with endpoint/auth env vars); run `./test.sh` for the non-e2e suite, or target specific files via the package-root vitest invocation.

## Constraints (from AGENTS.md, inherited)

- Erasable TypeScript syntax only in `packages/*/src` and `packages/*/test`: no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`.
- Top-level imports only — no inline `await import()` / dynamic type imports.
- No `any` unless absolutely necessary.
- No emojis in commits/issues/PR comments/code.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` and regenerate if a models change is needed (unlikely in a test-only PR).
- Hydrate deps with `npm install --ignore-scripts`; never run lifecycle scripts unless asked.
- Never commit unless asked — the dev-cycle tick handles commits.

## Dependencies / assumptions

- **Assumption:** the per-package `vitest.config.ts` files have a coverage provider configured (vitest config exists in all 4 packages). Plan phase verifies the coverage command and provider (v8/istanbul) before relying on it.
- **Assumption:** `./test.sh` from repo root runs the non-e2e suite across all packages without activating e2e (env vars absent). Plan phase verifies.
- **Assumption:** agent `harness/session/` persistence format is stable enough to test read-only without format changes. If a test would require a format change to be exercisable, that path is out of scope (flagged, not done).
- **Dependency:** `npm install --ignore-scripts` must have been run in the worktree for tests to execute. Plan/implementation phase hydrates if needed.

## Risks

- **e2e activation.** Running `vitest` directly with endpoint/auth env vars present activates e2e tests that hit real providers. Mitigation: always run via `./test.sh` or targeted file invocation; never `npm test`.
- **Coverage threshold measurement ambiguity for tui.** `node --test` has no native coverage threshold. The qualitative bar ("key interaction paths have tests") is the success measure; a numeric threshold for tui is out of scope.
- **Persistence test safety.** Session-persistence tests could accidentally write to the real session dir or mutate format. Mitigation: use `os.tmpdir()`-based paths and assert against fixtures built from the existing format; never persist to `~/.claude` or equivalent.
- **PR size.** All 4 packages in one PR could be large. Mitigation: organize commits per-package so review can slice; if the diff exceeds ~600 test lines, consider splitting per-package commits within the single PR.

## Handoff

Next: `ce-plan` on this requirements doc → enumerate untested exports per package via a coverage run → produce per-package test-file plan → implement via dev-cycle tick (Step 6) → PR on pi-neolix `main`.
