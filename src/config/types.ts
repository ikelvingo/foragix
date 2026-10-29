/**
 * Two-level errors: `startup` issues reject the whole configuration; `provider` issues isolate only
 * that provider, and the rest keep working. The only number in the configuration is `priority` — an
 * ordering, not a quota.
 */

export const SUPPORTED_CONFIG_VERSIONS: readonly number[] = [1];

export interface AccountOptionSpec {
  readonly type: 'boolean' | 'string' | 'number';
  /** String options only: the set of allowed values. */
  readonly allowedValues?: readonly string[];
  /** Description shown in error messages. */
  readonly description: string;
  readonly default: unknown;
}

export interface ProviderSchema {
  readonly id: string;
  /** The account options this provider supports; any undeclared key is an error. */
  readonly accountOptions: Readonly<Record<string, AccountOptionSpec>>;
  /**
   * The **canonical** credential names for this provider: the names declared in the configuration must
   * match these exactly, and a mismatch is a provider-level error.
   */
  readonly credentialNames: readonly string[];
  /**
   * Whether this provider requires credentials; when true, an empty `credentials` array in the
   * configuration is a provider-level error (an omitted declaration).
   */
  readonly requiresCredentials?: boolean;
}

export interface SchemaLookup {
  get(providerId: string): ProviderSchema | undefined;
  /** All registered provider ids. */
  knownIds(): readonly string[];
}

export interface ProviderConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly credentials: ReadonlyArray<{ readonly name: string; readonly required: boolean }>;
  readonly account: Readonly<Record<string, unknown>>;
  /** Provider-level override; null means inherit the top-level default. */
  readonly allowPaid: boolean | null;
}

export interface Config {
  readonly version: number;
  /** Top-level default for cost-incurring calls; defaults to false. */
  readonly allowPaid: boolean;
  /** Providers that passed validation. */
  readonly providers: readonly ProviderConfig[];
  /** Providers isolated because of **provider-level** errors; only that provider is isolated. */
  readonly isolated: readonly IsolatedProvider[];
}

export interface IsolatedProvider {
  readonly id: string;
  readonly issues: readonly ValidationIssue[];
}

export type IssueLevel = 'startup' | 'provider';

export interface ValidationIssue {
  /** The location of the error, e.g. `providers[2].account.isDevelop`. */
  readonly path: string;
  readonly message: string;
  readonly level: IssueLevel;
  /** The provider id the provider-level issue belongs to (if any). */
  readonly providerId?: string;
}

/** Configuration validation failed; carries all issues, not just the first. */
export class ConfigError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const startup = issues.filter((i) => i.level === 'startup');
    const summary =
      startup.length > 0
        ? `${startup.length} configuration errors, cannot start`
        : `${issues.length} provider configuration errors`;
    super(summary);
    this.name = 'ConfigError';
    this.issues = issues;
  }

  format(): string {
    return this.issues.map((i) => `  [${i.level}] ${i.path}: ${i.message}`).join('\n');
  }
}
