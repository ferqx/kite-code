import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Preserve protection for a private directory before its first configuration save. */
export function canonicalProtectedPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalProtectedPath(parent), basename(path));
  }
}
