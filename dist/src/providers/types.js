/** Account tier digest, used for the re-seed decision: a changed tier requires re-seeding even when the version number did not change. */
export function accountDigest(account) {
    const keys = Object.keys(account).sort();
    return keys.map((k) => `${k}=${JSON.stringify(account[k])}`).join('&');
}
//# sourceMappingURL=types.js.map