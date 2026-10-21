import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

export interface CleanupLink {
  path: string;
  target: string;
}

/** Read only: inspect ancestors, then walk physical directories without following links. */
export function inspectCleanupTree(directory: string): CleanupLink[] {
  if (!isAbsolute(directory)) throw Error('cleanup_path_must_be_absolute');
  const root = resolve(directory);
  const ancestors: string[] = [];
  let ancestor = root;
  while (true) {
    ancestors.push(ancestor);
    if (ancestor === parse(ancestor).root) break;
    ancestor = dirname(ancestor);
  }
  for (const item of ancestors.reverse()) {
    const stat = lstatSync(item);
    if (stat.isSymbolicLink()) return [{ path: item, target: readlinkSync(item) }];
    if (!stat.isDirectory()) throw Error('cleanup_path_must_be_directory');
  }
  const links: CleanupLink[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    // Recheck after enumeration; a changed directory must not become a traversal root.
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      links.push({ path: current, target: readlinkSync(current) });
      continue;
    }
    if (!stat.isDirectory()) throw Error('cleanup_tree_changed');
    for (const name of readdirSync(current)) {
      const entry = join(current, name);
      const child = lstatSync(entry);
      if (child.isSymbolicLink()) links.push({ path: entry, target: readlinkSync(entry) });
      else if (child.isDirectory()) pending.push(entry);
    }
  }
  return links;
}

function samePath(a: string, b: string) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function checkWorktreeCleanup(repository: string, directory: string) {
  if (!isAbsolute(directory)) throw Error('cleanup_path_must_be_absolute');
  const target = resolve(directory);
  const listed = execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain', '-z'], {
    encoding: 'utf8',
  });
  const worktrees = listed
    .split('\0')
    .filter((item) => item.startsWith('worktree '))
    .map((item) => resolve(item.slice('worktree '.length)));
  if (!worktrees.length || samePath(target, worktrees[0]!))
    throw Error('cleanup_primary_worktree_forbidden');
  if (!worktrees.some((item) => samePath(item, target)))
    throw Error('cleanup_unregistered_worktree_forbidden');
  const links = inspectCleanupTree(target);
  if (links.length) return { safe: false, reason: 'links_present', links } as const;
  return { safe: true, worktree: realpathSync(target), links } as const;
}

if (import.meta.main) {
  try {
    const arg = process.argv[2];
    if (process.argv.length !== 3 || !arg?.startsWith('--worktree='))
      throw Error('usage: bun scripts/check-worktree-cleanup.ts --worktree=<absolute-path>');
    const result = checkWorktreeCleanup(resolve(import.meta.dir, '..'), arg.slice(11));
    console.log(JSON.stringify(result, null, 2));
    if (!result.safe) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'cleanup_inspection_failed');
    process.exitCode = 1;
  }
}
