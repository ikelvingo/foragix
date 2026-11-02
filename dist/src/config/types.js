/**
 * Two-level errors: `startup` issues reject the whole configuration; `provider` issues isolate only
 * that provider, and the rest keep working. The only number in the configuration is `priority` — an
 * ordering, not a quota.
 */
export const SUPPORTED_CONFIG_VERSIONS = [1];
/** Configuration validation failed; carries all issues, not just the first. */
export class ConfigError extends Error {
    issues;
    constructor(issues) {
        const startup = issues.filter((i) => i.level === 'startup');
        const summary = startup.length > 0
            ? `${startup.length} configuration errors, cannot start`
            : `${issues.length} provider configuration errors`;
        super(summary);
        this.name = 'ConfigError';
        this.issues = issues;
    }
    format() {
        return this.issues.map((i) => `  [${i.level}] ${i.path}: ${i.message}`).join('\n');
    }
}
//# sourceMappingURL=types.js.map