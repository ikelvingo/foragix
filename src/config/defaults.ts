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
import type { Config, ProviderConfig } from './types.js';

/** Used when no config file exists. Kept small so the whole default policy stays readable. */
export const CONFIG_VERSION = 1;

/** Priority spacing between default entries, leaving room to slot a provider in between. */
const PRIORITY_STEP = 10;

/**
 * Every registered adapter, enabled, ordered by registry position.
 *
 * `allowPaid` is left null so each provider inherits the top-level `allowPaid: false`: providers
 * that can incur charges stay behind the paid gate until the user says otherwise.
 */
export function buildDefaultConfig(adapters: readonly ProviderAdapter[]): Config {
  const providers: ProviderConfig[] = adapters.map((adapter, index) => ({
    id: adapter.id,
    enabled: true,
    priority: (index + 1) * PRIORITY_STEP,
    // The adapter's own canonical names; the config may only ever name variables, never values.
    credentials: adapter.schema.credentialNames.map((name) => ({ name, required: true })),
    account: {},
    allowPaid: null,
  }));

  return { version: CONFIG_VERSION, allowPaid: false, providers, isolated: [] };
}

/**
 * Render the default configuration as commented YAML.
 *
 * Written to disk on first run so the user has a real, readable file to open and edit instead of
 * settings hidden in code. Every line here is a default: deleting the file restores the same
 * behaviour, so nothing can be lost by tidying it up.
 */
export function renderDefaultConfigYaml(adapters: readonly ProviderAdapter[]): string {
  const out: string[] = [
    '# foragix configuration.',
    '#',
    '# This file ships with the skill and is read from the skill directory. Edit it in place.',
    '# Every field except `id` has a default, so it only needs to state what you want different;',
    '# deleting it falls back to the same values built into the code.',
    '#',
    '#   enabled      default: true',
    '#   priority     default: position in this list (10, 20, ...); lower runs first',
    '#   credentials  default: exactly what the provider declares',
    '#',
    '# Credentials are never written here, only the NAME of the environment variable to read.',
    '',
    'version: 1',
    '',
    '# Top-level default. A provider that may bill you stays unused until it opts in below.',
    'allow_paid: false',
    '',
    'providers:',
  ];

  for (const [index, adapter] of adapters.entries()) {
    out.push(`  - id: ${adapter.id}`);
    out.push('    enabled: true');
    out.push(`    priority: ${(index + 1) * PRIORITY_STEP}`);

    const names = adapter.schema.credentialNames;
    if (names.length === 0) {
      out.push('    credentials: []');
    } else {
      out.push('    credentials:');
      for (const name of names) {
        out.push(`      - name: ${name}`);
        out.push('        required: true');
      }
    }
    out.push('');
  }

  out.push('# Providers that may incur charges also need `allow_paid: true`, here or globally:');
  out.push('#');
  out.push('#   - id: exa');
  out.push('#     allow_paid: true');
  out.push('#');
  out.push('# Further providers are known but have no adapter yet, so they are deliberately absent.');
  out.push('# Adding one does not break this file: that entry alone is set aside and listed under');
  out.push('# `isolated` by `status` with "No matching adapter", and the rest keep working.');
  out.push('');

  return out.join('\n');
}
