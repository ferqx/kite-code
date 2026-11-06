import { realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

export interface TemporaryWorktreePathOptions {
  readonly platform: NodeJS.Platform;
  readonly temporaryDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

function pathImplementation(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function absolute(path: string, platform: NodeJS.Platform): boolean {
  return (
    !path.includes('\0') &&
    (platform === 'win32'
      ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(path)
      : posix.isAbsolute(path))
  );
}

async function physicalPath(target: string, platform: NodeJS.Platform): Promise<string> {
  const paths = pathImplementation(platform);
  const suffix: string[] = [];
  let current = paths.normalize(target);
  for (;;) {
    try {
      return paths.join(await realpath(current), ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)))
        throw error;
      const parent = paths.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(paths.basename(current));
      current = parent;
    }
  }
}

/** Pure component comparison; the caller supplies trusted roots and an absolute target. */
export function isTemporaryWorktreePath(
  target: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!absolute(target, platform)) throw new TypeError('invalid_worktree_target_path');
  const paths = pathImplementation(platform);
  return roots.some((root) => {
    if (!absolute(root, platform)) throw new TypeError('invalid_worktree_temporary_root');
    const local = paths.relative(paths.normalize(root), paths.normalize(target));
    return (
      local === '' ||
      (!paths.isAbsolute(local) && local !== '..' && !local.startsWith(`..${paths.sep}`))
    );
  });
}

/** Capture only host-selected temporary locations, never command assignments or Model input. */
export async function captureTemporaryWorktreeRoots(
  options: TemporaryWorktreePathOptions,
): Promise<readonly string[]> {
  const { platform, environment } = options;
  const paths = pathImplementation(platform);
  const env = (name: string) =>
    platform === 'win32'
      ? Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
      : environment[name];
  const candidates = [options.temporaryDirectory, env('TMPDIR'), env('TMP'), env('TEMP')];
  if (platform === 'win32') {
    const local = env('LOCALAPPDATA');
    const system = env('SystemRoot') ?? env('WINDIR');
    if (local) candidates.push(paths.join(local, 'Temp'));
    if (system) candidates.push(paths.join(system, 'Temp'));
  } else {
    candidates.push('/tmp', '/var/tmp');
    if (platform === 'darwin')
      candidates.push('/private/tmp', '/var/folders', '/private/var/folders');
  }
  const roots = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || !absolute(candidate, platform)) continue;
    const normalized = paths.normalize(candidate);
    roots.add(normalized);
    // Synthetic other-platform path tests remain lexical. Filesystem aliases
    // are captured only on the actual host that owns these paths.
    if (platform !== process.platform) continue;
    roots.add(await physicalPath(normalized, platform));
  }
  return Object.freeze([...roots]);
}

/** Resolve the nearest existing ancestor without creating or deleting any entry. */
export async function inspectTemporaryWorktreeTarget(
  target: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (isTemporaryWorktreePath(target, roots, platform)) return true;
  if (platform !== process.platform) throw new TypeError('worktree_path_platform_mismatch');
  return isTemporaryWorktreePath(await physicalPath(target, platform), roots, platform);
}
