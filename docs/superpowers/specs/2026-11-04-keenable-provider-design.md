# Keenable Provider Design

## Intent

Add Keenable as a high-priority provider for the project's existing web search and page-fetch capabilities, and document its credential and monthly allowance in both READMEs.

## Selected approach

Use one `keenable` provider adapter for both documented REST operations:

- `POST https://api.keenable.ai/v1/search`, authenticated with `X-API-Key`; map query and result count to Keenable's request and normalize ranked title, URL, and snippet results.
- Keenable accepts `max_results` from 1 to 50 while the shared CLI accepts 1 to 100; clamp the provider-specific request value to 50, leaving the shared CLI contract unchanged. Omit it when unspecified so Keenable applies its documented default of up to 10.
- `GET https://api.keenable.ai/v1/fetch?url=...`, authenticated with `X-API-Key`; map returned title and Markdown content to the project's fetch result.
- Read the credential from `KEENABLE_API_KEY`. Keep the supplied value in the user's `~/.bashrc`; never store it in source, README files, configuration, SQLite, or Git.
- Record one request per successful search or fetch against the documented monthly allowance of 100,000 requests. Use the existing monthly state and UTC boundary as a local approximation (the API documents monthly reset but no timezone); HTTP 402 is mapped to monthly exhaustion and the normal routing loop falls back to the next provider. HTTP 429 is a short-window rate limit; 401 is a credential rejection and Keenable's documented 403 disabled/revoked-key response gets a provider-specific credential classification.
- Declare the provider chargeable in billing metadata because Keenable can consume purchased credits when the account has them; the user's account-level credit binding remains the consent boundary.
- Keep `minimax_cn` ahead of Keenable, with Keenable ahead of the other providers in both the built-in order and the current local config. The project sorts ascending: a smaller priority number runs first. The generated default order will start `minimax_cn`, Keenable, then the existing roster. In the current `~/.foragix/config.yaml`, set `minimax_cn` to priority 5 and Keenable to priority 9; existing providers begin at 10, so their relative ordering stays unchanged. The existing config has explicit priorities, so registry order alone would not change its routing.

## Approaches considered

1. **One search-and-fetch adapter (selected):** follows both official endpoints and the existing `ProviderAdapter` capabilities while sharing one credential and monthly account allowance.
2. **Search-only adapter:** rejected because it would leave Keenable's documented Fetch endpoint unavailable despite the project's existing fetch capability.
3. **Separate local credit-consent or free-only stop setting:** rejected because the user specifies that credit binding at the Keenable account is the consent boundary; the application should not duplicate it.

## Constraints and non-goals

- Use only the documented API base URL, authentication header, paths, and response fields; do not guess endpoints or send live billable requests during implementation.
- Add no account options or provider-specific payment configuration.
- Preserve the README content currently on `main`; update both language versions only for the new provider, its `KEENABLE_API_KEY`, the 100,000-per-month allowance, and the provider count.
- Preserve the relative ordering of other providers; only the requested `minimax_cn` / Keenable precedence is introduced.

## Review focus

- Missing or rejected `KEENABLE_API_KEY` must use the existing credential and auth-failure handling without exposing the value.
- Search and fetch responses with missing optional fields must normalize safely; malformed responses must not become fabricated empty success.
- Quota exhaustion, rate limiting, and credential rejection must follow Keenable's documented 402, 429, and 401/403 semantics, with ordinary provider fallback intact.
- The generic CLI accepts up to 100 results; Keenable must never receive `max_results` above its documented 50-result ceiling.
- Monthly local usage is bookkeeping; the Keenable account remains authoritative for shared usage and paid credits.
