/**
 * The configuration used when the user has no config file.
 *
 * A skill has to work the moment it is installed. Requiring a config file to be copied first is
 * friction with no safety benefit, so every provider that actually has an adapter is enabled by
 * default and the user only writes a config when they want to change something.
 *
 * Built from the adapter registry, so it can never drift from what is implemented: a provider
 * gains a default entry the moment its adapter is registered, and loses it the moment it is not.
 */
import type { ProviderAdapter } from '../providers/types.js';
import type { Config } from './types.js';
/** Used when no config file exists. Kept small so the whole default policy stays readable. */
export declare const CONFIG_VERSION = 1;
/**
 * Every registered adapter, enabled, ordered by registry position.
 *
 * `allowPaid` is left null so each provider inherits the top-level `allowPaid: false`: providers
 * that depend on account-side setup (defaultEnabled false) stay off until the owner enables them.
 */
export declare function buildDefaultConfig(adapters: readonly ProviderAdapter[]): Config;
/**
 * Render the default configuration as commented YAML.
 *
 * Written to disk on first run so the user has a real, readable file to open and edit instead of
 * settings hidden in code. Every line here is a default: deleting the file restores the same
 * behaviour, so nothing can be lost by tidying it up.
 */
export declare function renderDefaultConfigYaml(adapters: readonly ProviderAdapter[]): string;
/**
 * Config for merged default entries: every registered adapter the user's config does not
 * mention gets its own default entry — exactly what a generated config would have contained.
 * A config therefore stays authoritative even when written against a smaller roster: newly
 * implemented providers join the pool automatically, sensitive ones (defaultEnabled false)
 * stay off until the owner turns them on.
 */
export declare function mergeDefaultProviders(config: Config, adapters: readonly ProviderAdapter[]): Config;
