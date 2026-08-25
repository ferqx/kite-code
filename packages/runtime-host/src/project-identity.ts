import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectIdentity } from '@kite/runtime-spi';

/**
 * Resolve the Workspace identity directly from its canonical path. There is
 * no installation registry, expiring handle, lock file, or second authority.
 */
export function resolveProjectIdentity(workspace: string): ProjectIdentity {
  if (!workspace) throw new Error('Workspace must be non-empty.');
  const canonicalWorkspace = realpathSync.native(resolve(workspace));
  const digest = `sha256:${createHash('sha256').update(canonicalWorkspace).digest('hex')}` as const;
  return Object.freeze({
    projectId: `project_${digest.slice('sha256:'.length)}`,
    revision: 1,
    workspaceDigest: digest,
  });
}
