import type { WorktreeController, WriterWorkspaceLease } from './worktree-controller';
import { WorktreeControllerError } from './worktree-controller';

export interface ChangedFile {
  readonly path: string;
  readonly tracked: boolean;
}

export interface ChangeHandoff {
  readonly version: 1;
  readonly worktreeIdentity: string;
  readonly baselineCommit: string;
  readonly currentCommit: string;
  readonly branchName: string;
  readonly taskIdentity: string;
  readonly runIdentity: string;
  readonly writerIdentity: string;
  readonly createdAt: string;
  readonly status: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly diff: string;
  readonly hasUncommittedChanges: boolean;
}

function nulSeparated(value: string): string[] {
  if (value === '') return [];
  return value.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Produce a read-only review handoff from an identity-validated worktree. Git
 * hooks, external diff drivers, pushes and merges are never invoked here.
 */
export function createChangeHandoff(input: {
  controller: WorktreeController;
  lease: WriterWorkspaceLease;
}): ChangeHandoff {
  const evidence = input.controller.collectHandoffEvidence(input.lease);
  const conflicts = nulSeparated(evidence.conflicts);
  if (conflicts.length > 0) {
    throw new WorktreeControllerError(
      'worktree_conflict',
      'Cannot produce a review handoff with unresolved conflicts.',
    );
  }

  const trackedPaths = nulSeparated(evidence.trackedPaths);
  const untrackedPaths = nulSeparated(evidence.untrackedPaths);
  const untracked = new Set(untrackedPaths);
  const changedFiles = [...new Set([...trackedPaths, ...untrackedPaths])]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((path) => Object.freeze({ path, tracked: !untracked.has(path) }));
  return Object.freeze({
    version: 1 as const,
    worktreeIdentity: evidence.worktreeIdentity,
    baselineCommit: evidence.baselineCommit,
    currentCommit: evidence.currentCommit,
    branchName: evidence.branchName,
    taskIdentity: evidence.taskIdentity,
    runIdentity: evidence.runIdentity,
    writerIdentity: evidence.writerIdentity,
    createdAt: evidence.createdAt,
    status: evidence.status,
    changedFiles: Object.freeze(changedFiles),
    diff: evidence.diff,
    hasUncommittedChanges: evidence.uncommitted.length > 0,
  });
}
