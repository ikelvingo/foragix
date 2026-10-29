/**
 * Configuration loading and validation: errors always fail explicitly — unknown keys are reported
 * and never ignored.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { spellHint } from './spell.js';
import { redact } from '../errors/redact.js';
import {
  ConfigError,
  SUPPORTED_CONFIG_VERSIONS,
  type AccountOptionSpec,
  type Config,
  type IsolatedProvider,
  type ProviderConfig,
  type SchemaLookup,
  type ValidationIssue,
} from './types.js';

const ROOT_KEYS = ['version', 'allow_paid', 'providers'] as const;
const PROVIDER_KEYS = ['id', 'enabled', 'priority', 'credentials', 'account', 'allow_paid'] as const;
const CREDENTIAL_KEYS = ['name', 'required'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'object':
      return 'object';
    default:
      return typeof value;
  }
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

export interface ParseOptions {
  /** Adapter schemas by provider id, used to validate account options and credential names. */
  lookup: SchemaLookup;
}

/**
 * Parse and validate configuration text.
 * @throws ConfigError Carries all issues; any issue with `level === 'startup'` refuses startup.
 */
export function parseConfig(text: string, options: ParseOptions): Config {
  const issues: ValidationIssue[] = [];

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    // Safety: never echo the YAML parser's raw message — the file may hold a credential the user
    // mistyped. Keep only the position information.
    const linePos = (err as { linePos?: ReadonlyArray<{ line?: number; col?: number }> }).linePos;
    const at =
      Array.isArray(linePos) && linePos.length > 0 && typeof linePos[0]?.line === 'number'
        ? ` (line ${linePos[0].line}, column ${linePos[0].col ?? 0})`
        : '';
    throw new ConfigError([
      { path: '<root>', level: 'startup', message: `YAML parsing failed${at}. Please check the indentation and quotes` },
    ]);
  }

  if (raw === null || raw === undefined) {
    throw new ConfigError([{ path: '<root>', level: 'startup', message: 'The configuration file is empty' }]);
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError([
      { path: '<root>', level: 'startup', message: `The top level should be an object, but is ${describeType(raw)}` },
    ]);
  }

  for (const key of unknownKeys(raw, ROOT_KEYS)) {
    issues.push({
      path: key,
      level: 'startup',
      message: `Unknown top-level key${spellHint(key, ROOT_KEYS)}`,
    });
  }

  const versionRaw = raw['version'];
  if (typeof versionRaw !== 'number' || !Number.isInteger(versionRaw)) {
    issues.push({ path: 'version', level: 'startup', message: `Required, and should be an integer, but is ${describeType(versionRaw)}` });
  } else if (!SUPPORTED_CONFIG_VERSIONS.includes(versionRaw)) {
    issues.push({
      path: 'version',
      level: 'startup',
      message: `Unsupported configuration format version ${versionRaw}; this version supports ${SUPPORTED_CONFIG_VERSIONS.join(', ')}. Please upgrade the configuration according to the migration instructions`,
    });
  }

  let allowPaid = false;
  if (raw['allow_paid'] !== undefined) {
    if (typeof raw['allow_paid'] !== 'boolean') {
      issues.push({
        path: 'allow_paid',
        level: 'startup',
        message: `Should be a boolean, but is ${describeType(raw['allow_paid'])}`,
      });
    } else {
      allowPaid = raw['allow_paid'];
    }
  }

  const providersRaw = raw['providers'];
  if (!Array.isArray(providersRaw)) {
    issues.push({
      path: 'providers',
      level: 'startup',
      message: `Required, and should be an array, but is ${describeType(providersRaw)}`,
    });
    throw new ConfigError(issues);
  }
  if (providersRaw.length === 0) {
    issues.push({ path: 'providers', level: 'startup', message: 'At least one provider must be configured' });
    throw new ConfigError(issues);
  }

  const built: Array<{ index: number; config: ProviderConfig }> = [];
  const seenIds = new Map<string, number>();

  providersRaw.forEach((entry: unknown, index: number) => {
    const base = `providers[${index}]`;

    if (!isPlainObject(entry)) {
      issues.push({ path: base, level: 'provider', message: `Should be an object, but is ${describeType(entry)}` });
      return;
    }

    for (const key of unknownKeys(entry, PROVIDER_KEYS)) {
      issues.push({
        path: `${base}.${key}`,
        level: 'provider',
        message: `Unknown field${spellHint(key, PROVIDER_KEYS)}`,
      });
    }

    const idRaw = entry['id'];
    let providerId = '';
    if (typeof idRaw !== 'string' || idRaw.trim() === '') {
      issues.push({ path: `${base}.id`, level: 'provider', message: `Required, and should be a non-empty string` });
      return;
    }
    providerId = idRaw.trim();

    const previous = seenIds.get(providerId);
    if (previous !== undefined) {
      issues.push({
        path: `${base}.id`,
        level: 'startup',
        message: `Duplicate provider id: \`${providerId}\` already appears at providers[${previous}]`,
      });
      return;
    }
    seenIds.set(providerId, index);

    const schema = options.lookup.get(providerId);
    if (schema === undefined) {
      const hint = spellHint(providerId, options.lookup.knownIds());
      // Do not return early: keep validating enabled / priority / credentials so the user sees all
      // problems at once instead of fixing one and uncovering the next.
      issues.push({
        path: `${base}.id`,
        level: 'provider',
        message: `No matching adapter: \`${providerId}\`${hint}`,
        providerId,
      });
    }

    // Omitted fields take the obvious default, so a config only has to state differences.
    const enabledRaw = entry['enabled'];
    let enabled = true;
    if (enabledRaw !== undefined) {
      if (typeof enabledRaw !== 'boolean') {
        issues.push({
          path: `${base}.enabled`,
          level: 'provider',
          message: `Should be a boolean, but is ${describeType(enabledRaw)}`,
          providerId,
        });
      } else {
        enabled = enabledRaw;
      }
    }

    const priorityRaw = entry['priority'];
    // Position in the list is the natural default order.
    let priority = (index + 1) * 10;
    if (priorityRaw !== undefined) {
      if (typeof priorityRaw !== 'number' || !Number.isInteger(priorityRaw)) {
        issues.push({
          path: `${base}.priority`,
          level: 'provider',
          message: `Should be an integer (smaller comes first), but is ${describeType(priorityRaw)}`,
          providerId,
        });
      } else {
        priority = priorityRaw;
      }
    }

    const credentialsRaw = entry['credentials'];
    const credentials: Array<{ name: string; required: boolean }> = [];
    if (credentialsRaw === undefined) {
      // Default to exactly what the provider says it needs; the config stays silent about it.
      for (const name of schema?.credentialNames ?? []) credentials.push({ name, required: true });
    } else if (!Array.isArray(credentialsRaw)) {
      issues.push({
        path: `${base}.credentials`,
        level: 'provider',
        message: `Should be an array (write [] when there is no credential requirement), but is ${describeType(credentialsRaw)}`,
        providerId,
      });
    } else {
      credentialsRaw.forEach((cred: unknown, ci: number) => {
        const credPath = `${base}.credentials[${ci}]`;
        if (!isPlainObject(cred)) {
          issues.push({ path: credPath, level: 'provider', message: `Should be an object`, providerId });
          return;
        }
        for (const key of unknownKeys(cred, CREDENTIAL_KEYS)) {
          issues.push({
            path: `${credPath}.${key}`,
            level: 'provider',
            message: `Unknown field${spellHint(key, CREDENTIAL_KEYS)}`,
            providerId,
          });
        }
        const nameRaw = cred['name'];
        const requiredRaw = cred['required'];
        if (typeof nameRaw !== 'string' || nameRaw.trim() === '') {
          issues.push({
            path: `${credPath}.name`,
            level: 'provider',
            message: 'Required, and should be an environment variable name (declare only the name, not the value)',
            providerId,
          });
          return;
        }
        if (typeof requiredRaw !== 'boolean') {
          issues.push({
            path: `${credPath}.required`,
            level: 'provider',
            message: `Required, and should be a boolean, but is ${describeType(requiredRaw)}`,
            providerId,
          });
          return;
        }
        credentials.push({ name: nameRaw.trim(), required: requiredRaw });
      });

      if (credentials.length === 0 && schema?.requiresCredentials === true) {
        issues.push({
          path: `${base}.credentials`,
          level: 'provider',
          message: `\`${providerId}\` requires credentials, but credentials is an empty array. Please declare the required environment variable names`,
          providerId,
        });
      }

      // Credential names must match the adapter's canonical names exactly; a mismatch is a provider-level error.
      if (schema !== undefined && credentials.length > 0) {
        const declared = new Set(schema.credentialNames);
        const given = new Set(credentials.map((c) => c.name));
        const unknown = [...given].filter((n) => !declared.has(n));
        const missing = schema.credentialNames.filter((n) => !given.has(n));

        for (const name of unknown) {
          issues.push({
            path: `${base}.credentials`,
            level: 'provider',
            // The name field may hold a credential value by mistake — redact it before echoing it back.
            message: `\`${providerId}\` does not use the credential name \`${redact(name, 60)}\`${spellHint(name, schema.credentialNames)}; the names this adapter recognizes are: ${schema.credentialNames.map((n) => `\`${n}\``).join(', ')}`,
            providerId,
          });
        }
        for (const name of missing) {
          issues.push({
            path: `${base}.credentials`,
            level: 'provider',
            message: `\`${providerId}\` is missing the credential declaration \`${name}\``,
            providerId,
          });
        }
      }
    }

    // account — the option keys are declared by this provider's adapter
    const accountRaw = entry['account'];
    const account: Record<string, unknown> = {};
    if (accountRaw !== undefined) {
      if (!isPlainObject(accountRaw)) {
        issues.push({
          path: `${base}.account`,
          level: 'provider',
          message: `Should be an object, but is ${describeType(accountRaw)}`,
          providerId,
        });
      } else if (schema === undefined) {
        // Without an adapter the options cannot be validated; the id error is already reported, so do not report it again.
      } else {
        const declared = Object.keys(schema.accountOptions);
        for (const [key, value] of Object.entries(accountRaw)) {
          const accountPath = `${base}.account.${key}`;
          const spec: AccountOptionSpec | undefined = schema.accountOptions[key];
          if (spec === undefined) {
            const hint = spellHint(key, declared);
            issues.push({
              path: accountPath,
              level: 'provider',
              message:
                declared.length === 0
                  ? `\`${providerId}\` declares no account options at all and does not accept \`${key}\``
                  : `\`${providerId}\` does not declare this option${hint}`,
              providerId,
            });
            continue;
          }
          const problem = validateAccountValue(value, spec, accountPath);
          if (problem !== null) {
            issues.push({ ...problem, level: 'provider', providerId });
            continue;
          }
          account[key] = value;
        }
      }
    }

    const providerAllowPaidRaw = entry['allow_paid'];
    let providerAllowPaid: boolean | null = null;
    if (providerAllowPaidRaw !== undefined) {
      if (typeof providerAllowPaidRaw !== 'boolean') {
        issues.push({
          path: `${base}.allow_paid`,
          level: 'provider',
          message: `Should be a boolean, but is ${describeType(providerAllowPaidRaw)}`,
          providerId,
        });
      } else {
        providerAllowPaid = providerAllowPaidRaw;
      }
    }

    built.push({
      index,
      config: {
        id: providerId,
        enabled,
        priority,
        credentials,
        account,
        allowPaid: providerAllowPaid,
      },
    });
  });

  // Two-level errors: a startup-level issue rejects the whole config; a provider-level issue isolates
  // only that provider and the rest keep working.
  const startupIssues = issues.filter((i) => i.level === 'startup');
  if (startupIssues.length > 0) throw new ConfigError(issues);

  const issuesByIndex = new Map<number, ValidationIssue[]>();
  for (const issue of issues) {
    const match = /^providers\[(\d+)\]/.exec(issue.path);
    if (match === null) continue;
    const idx = Number.parseInt(match[1] as string, 10);
    const list = issuesByIndex.get(idx) ?? [];
    list.push(issue);
    issuesByIndex.set(idx, list);
  }

  const providers: ProviderConfig[] = [];
  const isolated: IsolatedProvider[] = [];

  for (const entry of built) {
    const list = issuesByIndex.get(entry.index);
    if (list === undefined) {
      providers.push(entry.config);
    } else {
      isolated.push({ id: entry.config.id, issues: list });
    }
  }

  // Entries whose id was never valid never enter built; collect them into the isolated list separately.
  for (const [idx, list] of issuesByIndex) {
    if (built.some((b) => b.index === idx)) continue;
    const raw = providersRaw[idx];
    const id =
      isPlainObject(raw) && typeof raw['id'] === 'string' && raw['id'].trim() !== ''
        ? raw['id'].trim()
        : `providers[${idx}]`;
    isolated.push({ id, issues: list });
  }

  if (providers.length === 0 && isolated.length > 0) {
    // No usable provider is left: equivalent to an unusable configuration — reject the whole config.
    throw new ConfigError(issues);
  }

  return {
    version: versionRaw as number,
    allowPaid,
    providers,
    isolated,
  };
}

function validateAccountValue(
  value: unknown,
  spec: AccountOptionSpec,
  path: string,
): Omit<ValidationIssue, 'level'> | null {
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { path, message: `Should be a boolean (${spec.description}), but is ${describeType(value)}` };
      }
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { path, message: `Should be a number (${spec.description}), but is ${describeType(value)}` };
      }
      return null;
    case 'string': {
      if (typeof value !== 'string') {
        return { path, message: `Should be a string (${spec.description}), but is ${describeType(value)}` };
      }
      const allowed = spec.allowedValues;
      if (allowed !== undefined && !allowed.includes(value)) {
        const hint = spellHint(value, allowed);
        return { path, message: `Invalid value${hint}; allowed values: ${allowed.map((v) => `\`${v}\``).join(', ')}` };
      }
      return null;
    }
  }
}

export function loadConfigFile(path: string, options: ParseOptions): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError([
      { path: '<file>', level: 'startup', message: `Cannot read the configuration file (${code ?? 'unknown'}): ${path}` },
    ]);
  }
  return parseConfig(text, options);
}

/** The provider's effective allow_paid: its own override wins, otherwise the top-level default. */
export function effectiveAllowPaid(config: Config, provider: ProviderConfig): boolean {
  return provider.allowPaid ?? config.allowPaid;
}
