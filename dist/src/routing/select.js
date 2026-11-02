/** Call condition: `is_enable = 1`, no live bit, no running cooldown, no in-window exhaustion. */
export function isUsable(candidate) {
    return (candidate.isEnable &&
        candidate.isAvailable === 0 &&
        !candidate.cooldownUntil &&
        !candidate.dayExhausted &&
        !candidate.monthExhausted);
}
/**
 * Candidate ordering: `priority` ascending, then provider id ascending.
 */
export function compareCandidates(a, b) {
    if (a.priority !== b.priority)
        return a.priority - b.priority;
    return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
}
/**
 * Resolve the candidate order for this call: pure filtering and ordering, no requests issued.
 */
export function planSelection(candidates, capability) {
    const withCapability = candidates.filter((c) => c.capabilities.includes(capability));
    const excluded = [];
    const usable = [];
    for (const candidate of withCapability) {
        if (!candidate.isEnable) {
            excluded.push({ candidate, reason: 'disabled' });
        }
        else if (!isUsable(candidate)) {
            excluded.push({ candidate, reason: 'unavailable' });
        }
        else {
            usable.push(candidate);
        }
    }
    usable.sort(compareCandidates);
    return {
        ordered: usable,
        excluded,
        noneWithCapability: withCapability.length === 0,
    };
}
export function selectFirst(plan) {
    return plan.ordered[0] ?? null;
}
//# sourceMappingURL=select.js.map