import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AgentError } from '../../storage/types';
import { normalizeWorktreeError } from './errors';
import {
  canonicalDirectory,
  containsPath,
  exists,
  fail,
  identity,
  inspectPath,
  type PathIdentity,
  readOrdinaryFile,
  sameIdentity,
  samePath,
  sha256,
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
  if (!exists(path))
    fail('worktree_root_unverifiable', 'A required Git worktree pointer is missing.');
  const text = utf8(readOrdinaryFile(path, limits.pathBytes + 32));
  if (!text.endsWith('\n') || text.includes('\0'))
    fail('worktree_root_unverifiable', 'A required Git worktree pointer is malformed.');
  return text.slice(0, -1).replace(/\r$/, '');
}

interface WorktreeRepositoryAnchor {
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly kind: 'main' | 'linked' | 'bare';
  readonly rootIdentity: PathIdentity;
  readonly gitIdentity: PathIdentity;
  readonly commonIdentity: PathIdentity;
  readonly markerIdentity: PathIdentity;
}

function anchor(
  root: string,
  gitDir: string,
  commonDir: string,
  kind: WorktreeRepositoryAnchor['kind'],
  marker: string,
): WorktreeRepositoryAnchor {
  inspectPath(join(gitDir, 'HEAD'), false);
  return {
    root,
    gitDir,
    commonDir,
    kind,
    rootIdentity: identity(root),
    gitIdentity: identity(gitDir),
    commonIdentity: identity(commonDir),
    markerIdentity: identity(marker),
  };
}

function checkout(root: string) {
  const dotGit = join(root, '.git');
  inspectPath(dotGit);
  if (lstatSync(dotGit).isDirectory()) {
    const gitDir = canonicalDirectory(dotGit);
    return anchor(root, gitDir, gitDir, 'main', dotGit);
  }
  const marker = identity(dotGit);
  const link = pointer(dotGit);
  if (!link.startsWith('gitdir: ') || !link.slice(8))
    fail('worktree_root_unverifiable', 'The checkout Git pointer is malformed.');
  const admin = canonicalDirectory(resolve(root, link.slice(8)));
  const commonDir = canonicalDirectory(resolve(admin, pointer(join(admin, 'commondir'))));
  // A linked checkout is a direct registration in this common directory.
  // Both Git pointers must name each other before the common directory confers identity.
  if (
    !samePath(dirname(admin), join(commonDir, 'worktrees')) ||
    !basename(admin) ||
    !samePath(resolve(admin, pointer(join(admin, 'gitdir'))), dotGit)
  )
    fail('worktree_root_unverifiable', 'The Git worktree registration and its backlink disagree.');
  const result = anchor(root, admin, commonDir, 'linked', dotGit);
  if (!sameIdentity(marker, result.markerIdentity))
    fail('worktree_root_changed', 'The checkout Git pointer changed during verification.');
  return result;
}

/** Search only the explicitly authorized root and its descendants. */
export function inspectWorktreeSource(sourcePath: string, authorizedRoot = sourcePath) {
  const boundary = canonicalDirectory(authorizedRoot);
  const source = samePath(sourcePath, authorizedRoot) ? boundary : canonicalDirectory(sourcePath);
  if (!containsPath(boundary, source))
    fail('not_git_repository', 'The source checkout is outside the authorized workspace.');
  for (let candidate = source; ; candidate = dirname(candidate)) {
    if (exists(join(candidate, '.git'))) return checkout(candidate);
    if (samePath(candidate, boundary)) {
      // Existing read-only inventory support for an independently selected bare
      // repository. Git must still classify this exact directory as bare.
      const head = join(candidate, 'HEAD');
      const objects = join(candidate, 'objects');
      const refs = join(candidate, 'refs');
      if (exists(head) && exists(objects) && exists(refs)) {
        inspectPath(objects, true);
        inspectPath(refs, true);
        return anchor(candidate, candidate, candidate, 'bare', head);
      }
      fail(
        'not_git_repository',
        'There is no verified Git checkout within the authorized workspace. Open the Git checkout as the workspace before using this tool.',
      );
    }
  }
}

export function sameWorktreeRepositoryAnchor(
  expected: WorktreeRepositoryAnchor,
  current: WorktreeRepositoryAnchor,
) {
  return (
    expected.kind === current.kind &&
    samePath(expected.root, current.root) &&
    samePath(expected.gitDir, current.gitDir) &&
    samePath(expected.commonDir, current.commonDir) &&
    sameIdentity(expected.rootIdentity, current.rootIdentity, false) &&
    sameIdentity(expected.gitIdentity, current.gitIdentity, false) &&
    sameIdentity(expected.commonIdentity, current.commonIdentity, false) &&
    sameIdentity(expected.markerIdentity, current.markerIdentity, expected.kind === 'linked')
  );
}

/** Bounded read-only filesystem proof; no Git process, hooks or project code is run. */
export function inspectWorktreeExecutionRoot(
  sourcePath: string,
  targetPath: string,
  authorizedRoot = sourcePath,
) {
  try {
    return inspectWorktreeSelection(sourcePath, targetPath, authorizedRoot);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'ENOENT' || errno === 'ENOTDIR') throw new AgentError('worktree_root_changed');
    throw new AgentError(normalizeWorktreeError(error).code);
  }
}

function inspectWorktreeSelection(sourcePath: string, targetPath: string, authorizedRoot: string) {
  const origin = inspectWorktreeSource(sourcePath, authorizedRoot);
  if (origin.kind === 'bare') throw new AgentError('unsupported_repository_configuration');
  if (!exists(targetPath)) throw new AgentError('not_linked_worktree');
  const target = canonicalDirectory(targetPath);
  const beforeTarget = identity(target);
  if (!exists(join(target, '.git'))) throw new AgentError('not_linked_worktree');
  const destination = checkout(target);
  if (
    !samePath(origin.commonDir, destination.commonDir) ||
    !sameIdentity(origin.commonIdentity, destination.commonIdentity, false)
  )
    throw new AgentError('worktree_repository_mismatch');
  if (destination.kind !== 'linked') throw new AgentError('not_linked_worktree');
  if (
    !sameIdentity(beforeTarget, identity(target)) ||
    !sameWorktreeRepositoryAnchor(origin, inspectWorktreeSource(sourcePath, authorizedRoot)) ||
    !sameWorktreeRepositoryAnchor(destination, checkout(target))
  )
    throw new AgentError('worktree_root_changed');
  return {
    path: target,
    identity: { dev: beforeTarget.dev, ino: beforeTarget.ino },
    repositoryRevision: sha256(
      JSON.stringify(
        [origin, destination].map((value) => ({
          kind: value.kind,
          root: value.root,
          gitDir: value.gitDir,
          commonDir: value.commonDir,
          entries: [
            value.rootIdentity,
            value.gitIdentity,
            value.commonIdentity,
            value.markerIdentity,
          ].map(({ dev, ino, birthtimeNs }) => ({ dev, ino, birthtimeNs })),
          ...(value.kind === 'linked' ? { markerGeneration: value.markerIdentity.ctimeNs } : {}),
        })),
      ),
    ),
  };
}
