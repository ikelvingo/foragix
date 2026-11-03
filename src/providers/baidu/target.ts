/**
 * Target parsing for source-preferred fetch.
 *
 * The official Baike APIs take a name or an id — never a page URL — so a URL is translated here and
 * the answer is only used when the returned lemma still matches it. Anything unrecognised returns
 * null and the caller falls back to the ordinary fetch chain.
 */
export interface LemmaTarget {
  readonly searchType: 'lemmaId' | 'lemmaTitle';
  readonly searchKey: string;
}

/** `https://baike.baidu.com/item/<name>[/<numeric id>]`; https only, no credentials, no lookalike host. */
export function parseBaikeUrl(raw: string): LemmaTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname !== 'baike.baidu.com') return null;

  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (parts[0] !== 'item' || parts.length < 2 || parts.length > 3) return null;

  const id = parts.length === 3 ? parts[2] : undefined;
  if (id !== undefined) {
    if (!/^[0-9]+$/.test(id)) return null;
    return { searchType: 'lemmaId', searchKey: id };
  }

  let name: string;
  try {
    name = decodeURIComponent(parts[1] as string);
  } catch {
    return null;
  }
  if (name.trim() === '') return null;
  return { searchType: 'lemmaTitle', searchKey: name };
}

/** The numeric id inside a lemma response's own `url`, used to prove the answer is the requested sense. */
export function lemmaIdFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parts = new URL(value).pathname.split('/').filter((part) => part !== '');
    const last = parts[parts.length - 1];
    return last !== undefined && /^[0-9]+$/.test(last) ? last : null;
  } catch {
    return null;
  }
}
