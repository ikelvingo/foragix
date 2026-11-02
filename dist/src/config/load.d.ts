import { type Config, type ProviderConfig, type SchemaLookup } from './types.js';
export interface ParseOptions {
    /** Adapter schemas by provider id, used to validate account options and credential names. */
    lookup: SchemaLookup;
}
/**
 * Parse and validate configuration text.
 * @throws ConfigError Carries all issues; any issue with `level === 'startup'` refuses startup.
 */
export declare function parseConfig(text: string, options: ParseOptions): Config;
export declare function loadConfigFile(path: string, options: ParseOptions): Config;
/** The provider's effective allow_paid: its own override wins, otherwise the top-level default. */
export declare function effectiveAllowPaid(config: Config, provider: ProviderConfig): boolean;
