import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface ProfileSelectionOptions {
  dataRoot: string;
  profile: string;
}
export interface ProfileSelection {
  readonly dataRoot: string;
  readonly profile: string;
  readonly profilePath: string;
  readonly databasePath: string;
  readonly coordinationPath: string;
  readonly profileAccessKey: string;
}
export function assertNoSymlinkPath(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink paths are unsupported.');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
/** Readonly selection, including missing roots. It grants no database or lock authority. */
export function selectProfile(options: ProfileSelectionOptions): ProfileSelection {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.profile))
    throw new Error('Invalid profile name.');
  let existing = resolve(options.dataRoot);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    suffix.unshift(basename(existing));
    existing = dirname(existing);
  }
  const dataRoot = join(realpathSync(existing), ...suffix);
  assertNoSymlinkPath(dataRoot);
  const profileAccessKey = createHash('sha256')
    .update(dataRoot)
    .update('\0')
    .update(options.profile)
    .digest('hex');
  const profilePath = join(dataRoot, options.profile);
  return Object.freeze({
    dataRoot,
    profile: options.profile,
    profilePath,
    databasePath: join(profilePath, 'core.db'),
    coordinationPath: join(dataRoot, '.coordination', profileAccessKey),
    profileAccessKey,
  });
}
