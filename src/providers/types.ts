/**
 * The provider adapter contract.
 *
 * The adapter declares billing semantics and tier presets (`init`), issues requests, and normalizes
 * responses into a verdict. State flags, period rollover and routing belong to the core.
 *
 * `init` must be: pure (no network), deterministic, and it must never touch accumulated usage counters.
 */
import type { CredentialView } from '../credentials/load.js';
import type { ProviderConfig, ProviderSchema } from '../config/types.js';
import type { Classification, ProviderErrorHints } from '../errors/classify.js';

export type Capability = 'search' | 'fetch';

/** The product of `init`: this provider's billing semantics and the seeded preset values of each tier. */
export interface ProviderInit {
  /**
   * Seeded-rule version. **Bump only when billing semantics or tier mappings change.**
   * Together with the account tier digest it forms the dual trigger condition for re-seeding.
   */
  readonly version: number;
  /** Whether this provider can incur actual charges; determines whether the paid gate applies. */
  readonly canCharge: boolean;
  /**
   * **Billing shape of this provider's calls** — declared only when `canCharge` is true;
   * defaults to `'payg'`.
   *
   * - `'payg'` — calls beyond the declared free allowance (dayLimit/monthLimit) turn into
   *   real charges. The gate intercepts exactly those calls; usage inside the allowance
   *   passes through like any free resource.
   * - `'included'` — every call consumes a **pre-purchased** pool (subscription points,
   *   prepaid credits): spending the pool creates no new cash-flow event, so the gate must
   *   not apply. When the pool runs dry the regular quota-exhaustion path returns `quota`.
   */
  readonly billingKind?: 'included' | 'payg';
  /**
   * **By what period** this provider's quota resets — independent of `dayLimit` / `monthLimit`.
   * The limits answer "can it be counted locally"; `quotaPeriod` answers "when does the quota recover".
   *
   * `'none'` means the vendor has no determinable reset period: the quota flag can then only be
   * cleared by external events (credential change, config change), never by the passage of time.
   */
  readonly quotaPeriod: 'day' | 'month' | 'both' | 'none';
  /** Daily-period quota ceiling; null means it cannot be counted locally. Independent of quotaPeriod. */
  readonly dayLimit: number | null;
  /** Monthly-period quota ceiling; null means it cannot be counted locally. Independent of quotaPeriod. */
  readonly monthLimit: number | null;
  /** Unit of measurement. Fixed by the adapter, not exposed to configuration. */
  readonly unit: string;
  /** Timezone used for period boundaries; never taken implicitly from the host machine's timezone. */
  readonly resetTimezone: string;
}

export interface SearchRequest {
  readonly query: string;
  readonly maxResults?: number;
}

export interface FetchRequest {
  readonly url: string;
}

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
}

export interface FetchDocument {
  readonly url: string;
  readonly title?: string;
  readonly content: string;
}

export interface AdapterContext {
  /** Credential view. The values may only be used to issue requests — never write them to logs, SQLite, or error messages. */
  readonly credentials: CredentialView;
  /** This provider's configuration (including the validated account tier). */
  readonly config: ProviderConfig;
  /** Injected fetch, to make substitution easy in tests. */
  readonly fetchImpl: typeof globalThis.fetch;
  readonly now: () => number;
  /** All credential names this provider needs (both required and optional). */
  readonly credentialNames: readonly string[];
}

/**
 * Call outcome.
 * The adapter normalizes HTTP responses into a {@link Classification} — provider-specific knowledge
 * appears only here.
 */
export type AdapterOutcome<T> =
  | { readonly ok: true; readonly data: T; readonly usage: number }
  | { readonly ok: false; readonly classification: Classification };

export interface ProviderAdapter {
  readonly id: string;
  /** Used for config validation: account tier options, and whether credentials are required. */
  readonly schema: ProviderSchema;
  /** The capabilities this provider implements. Undeclared capabilities do not enter the candidate set. */
  readonly capabilities: readonly Capability[];
  /** Verified error mapping. When present it takes precedence over the generic heuristics. */
  readonly errorHints?: ProviderErrorHints;

  /**
   * Declares billing semantics and the seeded preset values of each tier. **Pure function, no network.**
   * @param account account tier options that have already passed config validation
   */
  init(account: Readonly<Record<string, unknown>>): ProviderInit;

  search?(ctx: AdapterContext, req: SearchRequest): Promise<AdapterOutcome<SearchHit[]>>;
  fetch?(ctx: AdapterContext, req: FetchRequest): Promise<AdapterOutcome<FetchDocument>>;

  /**
   * Number of billing units consumed by one successful call.
   * Defaults to 1, but not every vendor bills per request (e.g. per result or per page);
   * the core counting logic does not assume +1.
   */
  usageOf?(capability: Capability, account: Readonly<Record<string, unknown>>): number;
}

/** Account tier digest, used for the re-seed decision: a changed tier requires re-seeding even when the version number did not change. */
export function accountDigest(account: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(account).sort();
  return keys.map((k) => `${k}=${JSON.stringify(account[k])}`).join('&');
}
