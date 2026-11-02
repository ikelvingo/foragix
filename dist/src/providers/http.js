import { classifyNetworkError, classifyResponse } from '../errors/classify.js';
export const DEFAULT_TIMEOUT_MS = 15_000;
function headersToRecord(headers) {
    const out = {};
    headers.forEach((value, key) => {
        out[key.toLowerCase()] = value;
    });
    return out;
}
/**
 * Issues a single request.
 * Network-layer failures (connection / DNS / TLS / timeout) are all normalized to transient failure —
 * they **have no determinable recovery condition**, so they set no persistent flag and only enter cooldown.
 */
export async function request(fetchImpl, url, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
    const init = {
        method: options.method ?? 'GET',
        signal,
        redirect: 'follow',
    };
    const headers = { accept: 'application/json', ...(options.headers ?? {}) };
    if (options.json !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.json);
    }
    else if (options.body !== undefined) {
        init.body = options.body;
    }
    init.headers = headers;
    try {
        const response = await fetchImpl(url, init);
        const body = await response.text();
        return {
            ok: true,
            usage: 0,
            data: { status: response.status, headers: headersToRecord(response.headers), body },
        };
    }
    catch (err) {
        return { ok: false, classification: classifyNetworkError(err) };
    }
}
/** Applies the generic classification rules to a response already obtained. */
export function interpret(result, hints, now) {
    return classifyResponse({ status: result.status, headers: result.headers, body: result.body, hints }, now);
}
/** Safely parses JSON. Returns null on failure; the caller decides whether that counts as a parse failure. */
export function parseJson(body) {
    try {
        return JSON.parse(body);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=http.js.map