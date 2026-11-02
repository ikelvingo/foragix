/**
 * The adapter registry.
 *
 * Only providers with a **verified API shape** are registered. An unverified vendor id in the config
 * is a hard "no corresponding adapter" error: endpoints are never guessed.
 */
import type { ProviderAdapter } from './types.js';
import type { ProviderSchema, SchemaLookup } from '../config/types.js';
import { tavilyAdapter } from './tavily/index.js';
import { exaAdapter } from './exa/index.js';
import { braveAdapter } from './brave/index.js';
import { minimaxAdapter } from './minimax/index.js';
import { firecrawlAdapter } from './firecrawl/index.js';
import { deepseekAdapter } from './deepseek/index.js';

export const ADAPTERS: readonly ProviderAdapter[] = [
  tavilyAdapter,
  exaAdapter,
  braveAdapter,
  minimaxAdapter,
  firecrawlAdapter,
  deepseekAdapter,
];

/**
 * Providers that are verified but not yet implemented, or whose shape is not yet verified.
 * Each reason is the only record of why that provider is absent.
 *
 * Assessed against vendor documentation on 2026-10-28. Entries saying "unconfirmed" or
 * "must be decided" are open questions, not verified facts; re-check before implementing.
 */
export const NOT_IMPLEMENTED: ReadonlyArray<{ id: string; reason: string }> = [
  { id: 'anysearch', reason: 'in fact-checking both the endpoint and the credential description are "unconfirmed"; must not be implemented on a guess' },
  { id: 'searxng', reason: 'self-hosted software with no platform-wide quota; the source of the instance address must be decided first' },
  { id: 'you', reason: 'the free path is MCP rather than a standalone REST, which conflicts with "MCP-only does not count as supported"' },
  { id: 'tinyfish', reason: 'Search and Fetch have different limits, and the short period is not modeled; quota attribution must be decided first' },
  { id: 'baidu', reason: 'metered billing after the free quota, so the default stance of the paid gate must be decided first' },
  { id: 'doubao', reason: 'standalone REST identity unconfirmed' },
  { id: 'zhipu', reason: 'standalone REST endpoint unconfirmed, and it uses a dual 5-hour + weekly period' },
];

const BY_ID = new Map<string, ProviderAdapter>(ADAPTERS.map((a) => [a.id, a]));

export function getAdapter(providerId: string): ProviderAdapter | undefined {
  return BY_ID.get(providerId);
}

export function adapterIds(): readonly string[] {
  return ADAPTERS.map((a) => a.id);
}

/** Builds the schema lookup needed for config validation. */
export function createSchemaLookup(adapters: readonly ProviderAdapter[] = ADAPTERS): SchemaLookup {
  const map = new Map<string, ProviderSchema>(adapters.map((a) => [a.id, a.schema]));
  return {
    get(id) {
      return map.get(id);
    },
    knownIds() {
      return [...map.keys()].sort();
    },
  };
}
