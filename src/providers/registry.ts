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
import { anysearchAdapter } from './anysearch/index.js';
import { searxngAdapter } from './searxng/index.js';
import { youAdapter } from './you/index.js';
import { tinyfishAdapter } from './tinyfish/index.js';
import { baiduAdapter } from './baidu/index.js';
import { zhipuAdapter } from './zhipu/index.js';

export const ADAPTERS: readonly ProviderAdapter[] = [
  tavilyAdapter,
  exaAdapter,
  braveAdapter,
  minimaxAdapter,
  firecrawlAdapter,
  deepseekAdapter,
  anysearchAdapter,
  searxngAdapter,
  youAdapter,
  tinyfishAdapter,
  baiduAdapter,
  zhipuAdapter,
];

/**
 * Providers that are verified but not yet implemented, or whose shape is not yet verified.
 * Each reason is the only record of why that provider is absent.
 *
 * Assessed against vendor documentation on 2026-11-02 (see documents/providers/).
 * Entries saying "unconfirmed" are open questions, not verified facts.
 */
export const NOT_IMPLEMENTED: ReadonlyArray<{ id: string; reason: string }> = [
  { id: 'doubao', reason: 'not implementable as standalone search REST: only Ark chat-completions tool-call, AgentKit skills and MCP surfaces exist for web search; a standalone key-auth search REST is not publicly documented (volume/AgentKit surfaces are usable but outside this REST contract)' },
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
