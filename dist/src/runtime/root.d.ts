/**
 * Walk up from `startDir` looking for the skill root.
 * Falls back to two levels up, which is where the root sits relative to `dist/src`.
 */
export declare function findSkillRoot(startDir: string): string;
