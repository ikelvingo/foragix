# Keenable Provider Implementation Plan

> **For agentic workers:** Use the test-first sequence below; keep each change scoped to the Keenable provider and its documented routing/configuration.

**Goal:** Add Keenable search and fetch with its 100,000-request monthly allowance, high default priority after `minimax_cn`, and bilingual README documentation.

**Architecture:** Implement one adapter using Keenable's documented REST endpoints and the existing provider contract. Preserve the account-side credit policy: count successful calls locally, do not set `localCap`, and let provider quota responses control fallback.

**Tech Stack:** TypeScript, Node.js built-in fetch and test runner, existing YAML config, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-keenable-provider-design.md`

## Global Constraints

- Use `KEENABLE_API_KEY` via `X-API-Key`; the key value belongs only in the user's `~/.bashrc` and must never enter source, README, config, SQLite, logs, or Git.
- Keenable search accepts `max_results` from 1 to 50; clamp the shared 1–100 input at the provider boundary.
- Count one successful search or fetch as one monthly request against 100,000; do not enable a local hard cap or add a credits-consent option.
- Map Keenable HTTP 402 to monthly quota exhaustion, 401/403 to credential rejection, and 429 to short-window rate limiting.
- Default order: `minimax_cn`, Keenable, then the existing provider roster. Smaller priority values run first.
- Preserve the current `README.md` and `README.zh-CN.md` contents; update provider count, service list, credential name, and quota/API description only.
- Keep local config priorities `minimax_cn: 5`, Keenable `9`; preserve all other provider priorities.
- No live requests to Keenable during implementation; use mocked HTTP for focused functional verification.

## Review Focus

- Search requests with no max-results omit the field; values 51–100 are clamped to 50.
- Search and fetch each use the same credential and count one successful request.
- URLs are encoded as a GET query parameter; returned markdown content maps to `FetchDocument.content`.
- Missing optional result fields are safe; malformed success bodies are rejected as parse failures.
- 402 causes monthly fallback; 401/403 isolate credentials; 429 sets a cooldown without treating it as monthly exhaustion.
- If `minimax_cn` is disabled or lacks a key, Keenable is the highest-priority usable API provider; if it is usable, it runs first.

---

### Task 1: Add focused provider contract tests

**Files:**
- Create: `test/providers-keenable.test.ts`

- [ ] Write tests for adapter registration, search request/response mapping, max-results clamping, fetch URL/content mapping, usage metadata, and HTTP status classification using the existing injected `fetchImpl` pattern.
- [ ] Run the focused tests against the current implementation and confirm the missing Keenable adapter is the failing condition.

### Task 2: Implement and register Keenable

**Files:**
- Create: `src/providers/keenable/index.ts`
- Modify: `src/providers/registry.ts`

- [ ] Implement `search` with `POST /v1/search`, `X-API-Key`, query and clamped optional `max_results`; normalize `title`, `url`, and `snippet`.
- [ ] Implement `fetch` with `GET /v1/fetch?url=...`; normalize `url`, optional `title`, and markdown `content`.
- [ ] Declare credential `KEENABLE_API_KEY`, capabilities `search`/`fetch`, one request per successful operation, 100,000 monthly requests, UTC local period, no `localCap`, and chargeable-account metadata.
- [ ] Add provider-specific 403 credential mapping and preserve generic 402/401/429 handling.
- [ ] Register `minimax_cn` first and Keenable second in the default adapter order; leave the remaining relative order unchanged.
- [ ] Build and run the focused tests; confirm they pass.

### Task 3: Document and configure the provider

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify local `~/.bashrc` and `~/.foragix/config.yaml` only

- [ ] Change the provider count from 19 to 20 where stated; add Keenable and `KEENABLE_API_KEY` to each service list and link its API docs.
- [ ] State its 100,000 monthly free requests and that purchased-credit behavior is controlled by the Keenable account.
- [ ] Add the supplied key to `~/.bashrc` without printing it; add the provider name and variable name only to local config, setting `minimax_cn` priority 5 and Keenable priority 9 while retaining other priorities.
- [ ] Confirm local config parses, the key is present without displaying it, README diff is scoped, and `git diff --check` passes.

### Task 4: Reviewer gate and focused functional verification

- [ ] Delegate the targeted review to the user's `Reviewer` assistant; request findings only for the Keenable provider and destructive side effects.
- [ ] If no destructive issue is found, run only the focused Keenable adapter and routing verification; do not run the full suite.
- [ ] Report the reviewer findings, focused verification result, and changed files.
