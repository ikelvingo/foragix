/**
 * Period keys in the adapter-declared timezone, never the host's: `YYYY-MM-DD` for day, `YYYY-MM` for month.
 * A changed key means a period boundary was crossed and that period resets.
 */
/** Default timezone. Used only when the adapter does not declare one. */
export const DEFAULT_TIMEZONE = 'UTC';
/**
 * Validate whether a timezone identifier is accepted by the runtime: an invalid timezone makes
 * Intl throw, so it must be blocked at the config validation stage, not here.
 */
export function isValidTimezone(tz) {
    try {
        new Intl.DateTimeFormat('en-CA', { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The day key of a moment in the given timezone, of the form `2026-10-29`.
 * `en-CA` yields an ISO-style `YYYY-MM-DD`, comparable directly in lexicographic order.
 */
export function dayKey(timezone, at) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(at));
}
export function monthKey(timezone, at) {
    return dayKey(timezone, at).slice(0, 7);
}
export function periodKeys(timezone, at) {
    const day = dayKey(timezone, at);
    return { day, month: day.slice(0, 7) };
}
//# sourceMappingURL=period.js.map