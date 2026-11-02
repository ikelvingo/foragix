/**
 * The adapter registry.
 *
 * Only providers with a **verified API shape** are registered. An unverified vendor id in the config
 * is a hard "no corresponding adapter" error: endpoints are never guessed.
 */
import type { ProviderAdapter } from './types.js';
import type { SchemaLookup } from '../config/types.js';
export declare const ADAPTERS: readonly ProviderAdapter[];
/**
 * The rosters that were assessed but carry no adapter today. Currently empty: every vendor
 * in the PRD/service lists either has an adapter or was withdrawn from scope for a fact
 * recorded in documents/providers/ (see the 2026-11-02 douvao withdrawal note there).
 */
export declare const NOT_IMPLEMENTED: ReadonlyArray<{
    id: string;
    reason: string;
}>;
export declare function getAdapter(providerId: string): ProviderAdapter | undefined;
export declare function adapterIds(): readonly string[];
/** Builds the schema lookup needed for config validation. */
export declare function createSchemaLookup(adapters?: readonly ProviderAdapter[]): SchemaLookup;
