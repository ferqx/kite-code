import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Worktree fixtures must survive OS temporary cleanup; protected or failed trees stay intact. */
export function persistentWorktreeDirectory(prefix: string): string {
  const root = fileURLToPath(new URL('../../dist/acceptance/worktree-fixtures/', import.meta.url));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return realpathSync(mkdtempSync(join(root, prefix)));
}
