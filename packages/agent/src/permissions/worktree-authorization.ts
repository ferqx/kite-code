import { createHash } from 'node:crypto';
import type { PermissionDecision } from '../extensions';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { dispatchScopeLeaves } from './dispatch-scope';

/** Integrity binding of trusted policy composition, not a signature or an execution grant. */
export interface WorktreeDecisionSeal {
  digest: string;
  decision: Json;
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const object = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function worktreeConfigurationIdentity(
  snapshot: PermissionDecision['snapshot'],
): string | null {
  try {
    let identity: string | undefined;
    for (const { namespace, data } of dispatchScopeLeaves(
      snapshot,
      'worktree_authorization_unavailable',
    )) {
      if (namespace !== 'builtin.permissions' || !object(data.capability)) return null;
      const binding = data.capability.worktreeAuthorization;
      if (
        !object(binding) ||
        Object.keys(binding).join() !== 'configurationIdentity' ||
        typeof binding.configurationIdentity !== 'string' ||
        !/^[a-f0-9]{64}$/.test(binding.configurationIdentity) ||
        (identity !== undefined && identity !== binding.configurationIdentity)
      )
        return null;
      identity = binding.configurationIdentity;
    }
    return identity ?? null;
  } catch {
    return null;
  }
}

export function validWorktreeDecision(decision: PermissionDecision): boolean {
  const seal = decision.worktreeDecisionSeal;
  if (!seal || !worktreeConfigurationIdentity(decision.snapshot)) return false;
  const { worktreeDecisionSeal: _seal, ...original } = decision;
  return (
    canonicalJson(json(original)) === canonicalJson(seal.decision) &&
    digest(seal.decision) === seal.digest
  );
}

/** Only default worktree policy and verified existing AND/Planning composition call this. */
export function sealWorktreeDecision(
  decision: PermissionDecision,
  sources?: readonly PermissionDecision[],
): PermissionDecision {
  const { worktreeDecisionSeal: _seal, ...unsealed } = decision;
  if (
    !worktreeConfigurationIdentity(decision.snapshot) ||
    sources?.some((source) => !validWorktreeDecision(source))
  )
    return unsealed;
  const value = json(unsealed);
  return { ...unsealed, worktreeDecisionSeal: { digest: digest(value), decision: value } };
}
