import { dirname } from 'node:path';
import type { Json } from '../../extensions';
import { canonicalJson } from '../../json';
import type { PathIdentity } from './paths';
import type { WorktreePlan } from './protocol';

/** Directory ctime changes when a child is created; generation remains a per-attempt fact. */
export function stableWorktreeIdentity(value: PathIdentity) {
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs };
}
const object = (value: unknown): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown) =>
  canonicalJson(left as Json) === canonicalJson(right as Json);
/** Pure comparison of already captured owner facts; SQLite never performs Git or filesystem I/O. */
export function matchesWorktreeApprovalScope(scope: Json, plan: WorktreePlan): boolean {
  try {
    if (
      !object(scope) ||
      !object(scope.repository) ||
      !object(scope.parent) ||
      !object(plan.evidence)
    )
      return false;
    const repository = plan.evidence.repository;
    const parent = plan.evidence.parent;
    if (
      !object(repository) ||
      !object(parent) ||
      !object(repository.rootIdentity) ||
      !object(repository.commonIdentity) ||
      !object(parent.identity)
    )
      return false;
    if (
      scope.action !== plan.action ||
      scope.repository.root !== plan.sourceRoot ||
      scope.repository.commonDir !== plan.commonDir ||
      !same(
        scope.repository.rootIdentity,
        stableWorktreeIdentity(repository.rootIdentity as unknown as PathIdentity),
      ) ||
      !same(
        scope.repository.commonIdentity,
        stableWorktreeIdentity(repository.commonIdentity as unknown as PathIdentity),
      ) ||
      scope.parent.path !== dirname(plan.targetPath) ||
      parent.path !== scope.parent.path ||
      !same(
        scope.parent.identity,
        stableWorktreeIdentity(parent.identity as unknown as PathIdentity),
      )
    )
      return false;
    if (plan.action === 'create')
      return (
        scope.baseOid === plan.baseOid &&
        scope.branchMode === (plan.newBranch ? 'newBranch' : 'detached') &&
        (parent.missingParents === undefined ||
          (Array.isArray(parent.missingParents) && parent.missingParents.length === 0))
      );
    const target = plan.evidence.target;
    return (
      object(scope.target) &&
      object(target) &&
      object(target.identity) &&
      scope.target.path === plan.targetPath &&
      same(
        scope.target.identity,
        stableWorktreeIdentity(target.identity as unknown as PathIdentity),
      )
    );
  } catch {
    return false;
  }
}
