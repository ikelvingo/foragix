/**
 * Spelling suggestions are best-effort: when no candidate fits, no suggestion is invented.
 */
/** Levenshtein distance, capped: returns `limit + 1` when the distance exceeds `limit`. */
export function levenshtein(a, b, limit = 3) {
    if (a === b)
        return 0;
    if (Math.abs(a.length - b.length) > limit)
        return limit + 1;
    const prev = new Array(b.length + 1);
    const curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1)
        prev[j] = j;
    for (let i = 1; i <= a.length; i += 1) {
        curr[0] = i;
        let rowMin = curr[0];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            curr[j] = value;
            if (value < rowMin)
                rowMin = value;
        }
        if (rowMin > limit)
            return limit + 1;
        for (let j = 0; j <= b.length; j += 1)
            prev[j] = curr[j];
    }
    return prev[b.length];
}
/**
 * Best-effort suggestion among the candidates: match rule is edit distance ≤ 2 or a prefix
 * relation; returns null when nothing fits — no suggestion is invented.
 */
export function suggestKey(input, candidates) {
    const needle = input.toLowerCase();
    let best = null;
    for (const key of candidates) {
        const lowered = key.toLowerCase();
        let score;
        if (lowered === needle) {
            score = 0;
        }
        else if (lowered.startsWith(needle) || needle.startsWith(lowered)) {
            score = 1 + Math.abs(lowered.length - needle.length) / 100;
        }
        else {
            const distance = levenshtein(needle, lowered);
            if (distance > 2)
                continue;
            score = distance;
        }
        if (best === null || score < best.score)
            best = { key, score };
    }
    return best?.key ?? null;
}
/** The "did you mean `x`?" suffix; empty string when there is no suggestion. */
export function spellHint(input, candidates) {
    const suggestion = suggestKey(input, candidates);
    return suggestion === null ? '' : `; did you mean \`${suggestion}\`?`;
}
//# sourceMappingURL=spell.js.map