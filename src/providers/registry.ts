/**
 * The adapter registry.
 *
 * Only providers with a **verified API shape** are registered. An unverified vendor id in the config
 * is a hard "no corresponding adapter" error: endpoints are never guessed.
 */
import type { ProviderAdapter } from './types.js';
import type { ProviderSchema, SchemaLookup } from '../config/types.js';
import { minimaxCnAdapter } from './minimax/index.js';
import { keenableAdapter } from './keenable/index.js';

import { searxngAdapter } from './searxng/index.js';
import { minimaxAdapter } from './minimax/index.js';

import { tinyfishAdapter } from './tinyfish/index.js';

import { youAdapter } from './you/index.js';

import { zhihuAdapter } from './zhihu/index.js';

import { anysearchAdapter } from './anysearch/index.js';

import { ollamaAdapter } from './ollama/index.js';

import { linkupAdapter } from './linkup/index.js';

import { exaAdapter } from './exa/index.js';

import { metasoAdapter } from './metaso/index.js';

import { firecrawlAdapter } from './firecrawl/index.js';

import { tavilyAdapter } from './tavily/index.js';

import { braveAdapter } from './brave/index.js';

import { doubaoAdapter } from './doubao/index.js';

import { baiduAdapter } from './baidu/index.js';

import { deepseekAdapter } from './deepseek/index.js';

import { zhipuAdapter } from './zhipu/index.js';
import { zhipuCnAdapter } from './zhipu/index.js';

export const ADAPTERS: readonly ProviderAdapter[] = [
  minimaxCnAdapter,
  keenableAdapter,
  searxngAdapter,
  minimaxAdapter,
  tinyfishAdapter,
  youAdapter,
  zhihuAdapter,
  anysearchAdapter,
  ollamaAdapter,
  linkupAdapter,
  exaAdapter,
  metasoAdapter,
  firecrawlAdapter,
  tavilyAdapter,
  braveAdapter,
  doubaoAdapter,
  baiduAdapter,
  deepseekAdapter,
  zhipuCnAdapter,
  zhipuAdapter,
];

/**
 * The rosters that were assessed but carry no adapter today. Currently empty: every vendor
 * in the PRD/service lists either has an adapter or was withdrawn from scope for a fact
 * recorded in documents/providers/ (see the 2026-11-02 douvao withdrawal note there).
 */
export const NOT_IMPLEMENTED: ReadonlyArray<{ id: string; reason: string }> = [];

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
