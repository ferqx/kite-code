import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_GIT_IDENTITY_FILE_BYTES = 4 * 1024;

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function readGitIdentityFile(path: string): string {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_GIT_IDENTITY_FILE_BYTES
  ) {
    throw new Error('metadata_identity_invalid');
  }
  const value = readFileSync(path, 'utf8');
  if (Buffer.byteLength(value, 'utf8') > MAX_GIT_IDENTITY_FILE_BYTES) {
    throw new Error('metadata_identity_invalid');
  }
  return value;
}

export function resolveWorkspaceGitMetadataReadOnlyRoots(
  workspaceInput: string,
): readonly string[] {
  try {
    const workspace = realpathSync.native(resolve(workspaceInput));
    const marker = join(workspace, '.git');
    const markerStat = lstatSync(marker);
    if (markerStat.isDirectory() && !markerStat.isSymbolicLink()) return Object.freeze([]);
    if (markerStat.isSymbolicLink()) {
      const target = realpathSync.native(marker);
      return Object.freeze(pathInside(workspace, target) ? [] : [target]);
    }
    if (!markerStat.isFile()) return Object.freeze([]);

    const match = /^gitdir:\s*(.+)\s*$/i.exec(readGitIdentityFile(marker));
    if (!match?.[1]) return Object.freeze([]);
    const gitDir = realpathSync.native(resolve(workspace, match[1]));
    const roots = [gitDir];
    const commonDirFile = join(gitDir, 'commondir');
    if (existsSync(commonDirFile)) {
      const commonDirText = readGitIdentityFile(commonDirFile).trim();
      if (commonDirText) roots.push(realpathSync.native(resolve(gitDir, commonDirText)));
    }
    const externalRoots = [...new Set(roots.filter((root) => !pathInside(workspace, root)))];
    return Object.freeze(
      externalRoots
        .filter(
          (root) =>
            !externalRoots.some((candidate) => candidate !== root && pathInside(candidate, root)),
        )
        .sort((left, right) => left.localeCompare(right)),
    );
  } catch {
    return Object.freeze([]);
  }
}
