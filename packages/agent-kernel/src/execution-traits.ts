/**
 * Deterministic scheduling facts. Providers may describe concrete resources,
 * but the Kernel never receives a Capability or Tool name.
 */
export interface ResourceScopeV1 {
  readonly kind:
    | 'runtime'
    | 'workspace'
    | 'process'
    | 'network'
    | 'external_state'
    | 'subagent'
    | 'skill';
  readonly key: string;
}

export interface ExecutionTraitsV1 {
  readonly resourceScopes: readonly ResourceScopeV1[];
  readonly access: 'read' | 'write' | 'unknown';
  readonly conflictKeys: readonly string[];
  readonly isolation: 'shared' | 'exclusive_workspace' | 'worktree';
  readonly causalGroup: string;
  readonly interactionBarrier: boolean;
  readonly concurrencyGroup?: string;
  readonly leaseFenceRequired: boolean;
}

export interface SchedulableEffectV1 {
  readonly effectId: string;
  readonly traits: ExecutionTraitsV1;
}

/**
 * Select the longest consecutive prefix that may execute with the first
 * effect. Queue order remains authoritative and the caller supplies the
 * bounded ceiling for the first effect's concurrency group.
 */
export function selectSchedulableEffectBatchV1(
  candidates: readonly SchedulableEffectV1[],
  ceiling: number,
): readonly string[] {
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
    throw new Error('scheduler concurrency ceiling must be a positive integer');
  }
  const first = candidates[0];
  if (!first) return Object.freeze([]);
  const selected: SchedulableEffectV1[] = [first];
  for (const candidate of candidates.slice(1)) {
    if (selected.length >= ceiling) break;
    if (
      !selected.every((accepted) => executionTraitsMayOverlapV1(accepted.traits, candidate.traits))
    ) {
      break;
    }
    selected.push(candidate);
  }
  return Object.freeze(selected.map((candidate) => candidate.effectId));
}

/** Pure symmetric overlap rule. Unknown or conflicting work fails closed. */
export function executionTraitsMayOverlapV1(
  left: Readonly<ExecutionTraitsV1>,
  right: Readonly<ExecutionTraitsV1>,
): boolean {
  if (left.interactionBarrier || right.interactionBarrier) return false;
  if (!left.concurrencyGroup || left.concurrencyGroup !== right.concurrencyGroup) return false;

  if (left.access === 'unknown' || right.access === 'unknown') return false;

  if (left.access === 'read' && right.access === 'read') return true;

  if (
    left.isolation !== 'worktree' ||
    right.isolation !== 'worktree' ||
    left.causalGroup !== right.causalGroup ||
    !resourceScopesAreProvablyDisjointV1(left.resourceScopes, right.resourceScopes)
  ) {
    return false;
  }
  const conflicts = new Set(left.conflictKeys);
  return !right.conflictKeys.some((key) => conflicts.has(key));
}

function resourceScopesAreProvablyDisjointV1(
  left: readonly ResourceScopeV1[],
  right: readonly ResourceScopeV1[],
): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const occupied = new Set(left.map((scope) => `${scope.kind}\0${scope.key}`));
  return !right.some((scope) => occupied.has(`${scope.kind}\0${scope.key}`));
}
