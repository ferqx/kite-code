import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { type LaunchIdentity, launchIdentity, verifyLaunchIdentities } from './launch-identity';

/** Private denied names, never executable/input assets: contents and file digests are not read. */
export interface ProtectedFile {
  readonly path: string;
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly parent: LaunchIdentity;
}
function observe(path: string): ProtectedFile {
  if (!isAbsolute(path) || path.includes('\0') || path.length > 8192)
    throw Error('shell_protected_file_invalid');
  path = resolve(path);
  const suffix = [basename(path)];
  let directory = dirname(path);
  for (;;) {
    try {
      lstatSync(directory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(directory) === directory)
        throw error;
      suffix.unshift(basename(directory));
      directory = dirname(directory);
    }
  }
  const parent = launchIdentity(directory),
    canonical = join(parent.canonical, ...suffix);
  const aliases = new Set([path, canonical]);
  let symbolic = false;
  try {
    symbolic = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (symbolic) aliases.add(realpathSync.native(path));
  return Object.freeze({ path, canonical, aliases: Object.freeze([...aliases]), parent });
}

/** Missing children may appear and files may rotate; their denied canonical name cannot redirect. */
export function captureProtectedFiles(paths: readonly string[]) {
  if (!Array.isArray(paths) || paths.length > 128) throw Error('shell_protected_file_invalid');
  const files = Object.freeze([...new Set(paths)].map(observe));
  const deniedPaths = Object.freeze([...new Set(files.flatMap((file) => [...file.aliases]))]);
  const missingParents = Object.freeze([
    ...new Set(
      files.flatMap((file) => {
        const parents: string[] = [];
        for (
          let path = dirname(file.canonical);
          path !== file.parent.canonical;
          path = dirname(path)
        ) {
          if (dirname(path) === path) throw Error('shell_protected_file_invalid');
          parents.push(path);
        }
        return parents;
      }),
    ),
  ]);
  return {
    files,
    deniedPaths,
    missingParents,
    verify() {
      verifyLaunchIdentities(files.map((file) => file.parent));
      for (const file of files) {
        const current = observe(file.path);
        if (
          current.canonical !== file.canonical ||
          current.aliases.some((alias) => !file.aliases.includes(alias))
        )
          throw Error('shell_protected_file_changed');
      }
    },
  };
}
