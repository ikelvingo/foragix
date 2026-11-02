/**
 * Spelling suggestions are best-effort: when no candidate fits, no suggestion is invented.
 */
/** Levenshtein distance, capped: returns `limit + 1` when the distance exceeds `limit`. */
export declare function levenshtein(a: string, b: string, limit?: number): number;
/**
 * Best-effort suggestion among the candidates: match rule is edit distance ≤ 2 or a prefix
 * relation; returns null when nothing fits — no suggestion is invented.
 */
export declare function suggestKey(input: string, candidates: readonly string[]): string | null;
/** The "did you mean `x`?" suffix; empty string when there is no suggestion. */
export declare function spellHint(input: string, candidates: readonly string[]): string;
