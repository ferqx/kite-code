import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AgentError } from '../../storage/types';
import {
  canonicalDirectory,
  identity,
  inspectPath,
  readOrdinaryFile,
  sameIdentity,
  samePath,
  utf8,
} from './paths';
import { jsonObject, limits, strictText } from './protocol';

export type WorktreeRootRequest = { action: 'use'; path: string } | { action: 'exit' };

/** An explicit host operation. Creation, observations and Shell workdir never enter here. */
export function parseWorktreeRootRequest(input: unknown): WorktreeRootRequest | null {
  if (!jsonObject(input)) return null;
  if (input.action === 'exit') return Object.keys(input).length === 1 ? { action: 'exit' } : null;
  if (
    input.action !== 'use' ||
    Object.keys(input).length !== 2 ||
    !strictText(input.path, limits.pathBytes) ||
    !isAbsolute(input.path)
  )
    return null;
  return { action: 'use', path: input.path };
}

function pointer(path: string): string {
  const text = utf8(readOrdinaryFile(path, limits.pathBytes + 32));
  if (!text.endsWith('\n') || text.includes('\0'))
    throw new AgentError('worktree_root_unverifiable');
  return text.slice(0, -1).replace(/\r$/, '');
}

function checkout(root: string) {
  const dotGit = join(root, '.git');
  inspectPath(dotGit);
  if (lstatSync(dotGit).isDirectory()) {
    const commonDir = canonicalDirectory(dotGit);
    inspectPath(join(commonDir, 'HEAD'), false);
    return { root, commonDir, linked: false };
  }
  const link = pointer(dotGit);
  if (!link.startsWith('gitdir: ') || !link.slice(8))
    throw new AgentError('worktree_root_unverifiable');
  const admin = canonicalDirectory(resolve(root, link.slice(8)));
  const commonDir = canonicalDirectory(resolve(admin, pointer(join(admin, 'commondir'))));
  // A linked checkout must be an actual direct registration in this repository,
  // with both pointers agreeing. An arbitrary .git file is not authority.
  if (
    !samePath(dirname(admin), join(commonDir, 'worktrees')) ||
    !basename(admin) ||
    !samePath(resolve(admin, pointer(join(admin, 'gitdir'))), dotGit)
  )
    throw new AgentError('worktree_root_unverifiable');
  inspectPath(join(admin, 'HEAD'), false);
  return { root, commonDir, linked: true };
}

/** Bounded read-only filesystem proof; no Git process, hooks or project code is run. */
export function inspectWorktreeExecutionRoot(sourcePath: string, targetPath: string) {
  const source = canonicalDirectory(sourcePath);
  const target = canonicalDirectory(targetPath);
  const beforeSource = identity(source),
    beforeTarget = identity(target);
  const origin = checkout(source),
    destination = checkout(target);
  if (!destination.linked || !samePath(origin.commonDir, destination.commonDir))
    throw new AgentError('worktree_repository_mismatch');
  if (
    !sameIdentity(beforeSource, identity(source)) ||
    !sameIdentity(beforeTarget, identity(target)) ||
    JSON.stringify(origin) !== JSON.stringify(checkout(source)) ||
    JSON.stringify(destination) !== JSON.stringify(checkout(target))
  )
    throw new AgentError('worktree_root_changed');
  return {
    path: target,
    identity: { dev: beforeTarget.dev, ino: beforeTarget.ino },
  };
}
