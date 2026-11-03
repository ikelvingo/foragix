function key(providerId, endpoint) {
    return `observed:${providerId}:${endpoint}`;
}
/** Add one observed call. Never writes a quota key, a flag or a provider row. */
export function recordObserved(db, providerId, endpoint, now) {
    const current = readObserved(db, providerId, endpoint);
    const next = {
        count: (current?.count ?? 0) + 1,
        first_at: current?.first_at ?? now,
        last_at: now,
    };
    db.writeMeta(key(providerId, endpoint), JSON.stringify(next));
}
/** Read the observed counters; null means this endpoint has never been called. */
export function readObserved(db, providerId, endpoint) {
    const raw = db.readMeta(key(providerId, endpoint));
    if (raw === null)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.count !== 'number' || typeof parsed.first_at !== 'number' || typeof parsed.last_at !== 'number')
            return null;
        return { count: parsed.count, first_at: parsed.first_at, last_at: parsed.last_at };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=usage.js.map