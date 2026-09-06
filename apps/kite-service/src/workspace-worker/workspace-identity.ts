import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';

/** Canonical Workspace identity shared by the control plane and the Worker child. */
export function canonicalWorkspaceIdentity(workspace: {
  readonly canonicalPath: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
}): KiteWorkspaceIdentity {
  if (!workspace.canonicalPath || !isAbsolute(workspace.canonicalPath)) {
    throw new TypeError('Workspace canonical path must be absolute.');
  }
  const canonicalPath = realpathSync.native(resolve(workspace.canonicalPath));
  const digest = createHash('sha256').update(canonicalPath).digest('hex');
  if (
    canonicalPath !== workspace.canonicalPath ||
    workspace.workspaceDigest !== `sha256:${digest}` ||
    workspace.projectId !== `project_${digest}`
  ) {
    throw new TypeError('Workspace identity is not the exact canonical project identity.');
  }
  return Object.freeze({
    canonicalPath,
    projectId: workspace.projectId,
    workspaceDigest: workspace.workspaceDigest as `sha256:${string}`,
  });
}

export function workspaceIdentityDigest(workspace: KiteWorkspaceIdentity): string {
  const material = JSON.stringify({
    canonicalPath: workspace.canonicalPath,
    projectId: workspace.projectId,
    workspaceDigest: workspace.workspaceDigest,
  });
  return `sha256:${createHash('sha256')
    .update(`kite.workspace-identity.v1\0${material}`)
    .digest('hex')}`;
}
