import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkspaceGitMetadataReadOnlyRoots } from '@kite-ai/builtin-runtime/git';

export interface WorkspaceExternalReadScope {
  readonly roots: readonly string[];
  readonly digest: `sha256:${string}`;
}

/** The ordinary trust protocol grants only the selected workspace. */
export const EMPTY_WORKSPACE_EXTERNAL_READ_SCOPE: WorkspaceExternalReadScope = Object.freeze({
  roots: Object.freeze([]),
  digest: `sha256:${createHash('sha256')
    .update('kite.workspace-external-read-scope.v1\0[]')
    .digest('hex')}`,
});

/**
 * Resolve Workspace-associated read identities that live outside the canonical
 * Workspace. Discovery is mechanism-specific; authorization is not. The
 * resulting sorted roots and digest are checked at sandbox preparation against
 * an existing exact external-read grant. Ordinary Workspace Trust never calls it.
 */
export function resolveWorkspaceExternalReadScope(
  workspaceInput: string,
): WorkspaceExternalReadScope {
  const workspace = realpathSync.native(resolve(workspaceInput));
  const roots = Object.freeze(
    [...new Set(resolveWorkspaceGitMetadataReadOnlyRoots(workspace))].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  const digest = `sha256:${createHash('sha256')
    .update(`kite.workspace-external-read-scope.v1\0${JSON.stringify(roots)}`)
    .digest('hex')}` as const;
  return Object.freeze({ roots, digest });
}
