import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** A path recorded as canonical while a Session existed may later be deleted.
 * Retargeted symlinks and inaccessible paths do not retain that identity.
 */
export function persistedWorkspaceIdentity(path: string):
  | {
      readonly projectId: `project_${string}`;
      readonly workspaceDigest: `sha256:${string}`;
      readonly revision: 1;
    }
  | undefined {
  if (!isAbsolute(path) || resolve(path) !== path) return undefined;
  try {
    if (realpathSync.native(path) !== path) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    // A dangling symlink is not a deleted directory. An ancestor symlink
    // must not silently redirect a historical Session when it reappears.
    let ancestor = path;
    while (true) {
      try {
        const entry = lstatSync(ancestor);
        if (!entry.isDirectory() || realpathSync.native(ancestor) !== ancestor) return undefined;
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
        const parent = dirname(ancestor);
        if (parent === ancestor) return undefined;
        ancestor = parent;
      }
    }
  }
  const workspaceDigest = `sha256:${createHash('sha256').update(path).digest('hex')}` as const;
  return {
    projectId: `project_${workspaceDigest.slice('sha256:'.length)}`,
    workspaceDigest,
    revision: 1,
  };
}
