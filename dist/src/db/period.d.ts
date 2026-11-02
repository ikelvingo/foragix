/**
 * Period keys in the adapter-declared timezone, never the host's: `YYYY-MM-DD` for day, `YYYY-MM` for month.
 * A changed key means a period boundary was crossed and that period resets.
 */
/** Default timezone. Used only when the adapter does not declare one. */
export declare const DEFAULT_TIMEZONE = "UTC";
/**
 * Validate whether a timezone identifier is accepted by the runtime: an invalid timezone makes
 * Intl throw, so it must be blocked at the config validation stage, not here.
 */
export declare function isValidTimezone(tz: string): boolean;
/**
 * The day key of a moment in the given timezone, of the form `2026-10-29`.
 * `en-CA` yields an ISO-style `YYYY-MM-DD`, comparable directly in lexicographic order.
 */
export declare function dayKey(timezone: string, at: number): string;
export declare function monthKey(timezone: string, at: number): string;
export interface PeriodKeys {
    day: string;
    month: string;
}
export declare function periodKeys(timezone: string, at: number): PeriodKeys;
