/**
 * Request-level source preference for `fetch`.
 *
 * Only a strictly recognised target earns a preference; everything else keeps the configured order,
 * so an ordinary page is never diverted to a specialised provider.
 */
import { parseBaikeUrl } from '../providers/baidu/target.js';
import { parseZhihuUrl } from '../providers/zhihu/target.js';
export function preferredFetchProvider(rawUrl) {
    if (parseBaikeUrl(rawUrl) !== null)
        return 'baidu';
    if (parseZhihuUrl(rawUrl) !== null)
        return 'zhihu';
    return null;
}
//# sourceMappingURL=targets.js.map