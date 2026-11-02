/**
 * Selection is a **pure function** — deterministic for the same inputs, with no randomness, no
 * time and no process identity.
 */
import type { Capability } from '../providers/types.js';

export interface Candidate {
  readonly providerId: string;
  readonly priority: number;
  readonly isEnable: boolean;
  readonly isAvailable: number;
  readonly capabilities: readonly Capability[];
  /** Derived cooldown state (audit §2.1): a future `retry_after`, already nulled when expired.
   *  Optional for hand-built literals; absent means not cooling. */
  readonly cooldownUntil?: number | null;
  /** Derived quota state (audit §2.5): the stored exhausted-period key equals the current key.
   *  Optional for hand-built literals; absent means not exhausted. */
  readonly dayExhausted?: boolean;
  readonly monthExhausted?: boolean;
}

/** Call condition: `is_enable = 1`, no live bit, no running cooldown, no in-window exhaustion. */
export function isUsable(candidate: Candidate): boolean {
  return (
    candidate.isEnable &&
    candidate.isAvailable === 0 &&
    !candidate.cooldownUntil &&
    !candidate.dayExhausted &&
    !candidate.monthExhausted
  );
}

/**
 * Candidate ordering: `priority` ascending, then provider id ascending.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
}

export interface SelectionPlan {
  /** Candidates to try, in order. */
  readonly ordered: readonly Candidate[];
  /** Candidates with the capability that were excluded, with the reason, for status output. */
  readonly excluded: ReadonlyArray<{ candidate: Candidate; reason: 'disabled' | 'unavailable' }>;
  /** No candidate declares this capability. */
  readonly noneWithCapability: boolean;
}

/**
 * Resolve the candidate order for this call: pure filtering and ordering, no requests issued.
 */
export function planSelection(candidates: readonly Candidate[], capability: Capability): SelectionPlan {
  const withCapability = candidates.filter((c) => c.capabilities.includes(capability));
  const excluded: Array<{ candidate: Candidate; reason: 'disabled' | 'unavailable' }> = [];
  const usable: Candidate[] = [];

  for (const candidate of withCapability) {
    if (!candidate.isEnable) {
      excluded.push({ candidate, reason: 'disabled' });
    } else if (!isUsable(candidate)) {
      excluded.push({ candidate, reason: 'unavailable' });
    } else {
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

export function selectFirst(plan: SelectionPlan): Candidate | null {
  return plan.ordered[0] ?? null;
}
