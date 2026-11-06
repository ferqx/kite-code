import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Json } from '../../extensions';
import {
  captureTemporaryWorktreeRoots,
  inspectTemporaryWorktreeTarget,
} from '../../permissions/worktree-path-policy';
import { Git, type ListedWorktree, nulRecords, type Repository } from './git';
import {
  acquireLock,
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
  scanTrackedTree,
  sha256,
  type TrackedTreeEvidence,
  targetPath,
  utf8,
  verifyTrackedTree,
  WorktreeError,
} from './paths';
import {
  decodeWorkerRequest,
  digest,
  limits,
  validateRequest,
  type WorktreeFrame,
  type WorktreePlan,
  type WorktreeRequest,
} from './protocol';

interface Evidence {
  repository: Repository;
  parent: {
    path: string;
    identity: PathIdentity;
    defaultRoot?: string;
    missingParents?: string[];
  };
  target?: {
    identity: PathIdentity;
    pointerDigest: string;
    adminGitDir: string;
    adminIdentity: PathIdentity;
    head: string;
    branch: string | null;
    registrationDigest: string;
  };
}
function evidence(plan: WorktreePlan): Evidence {
  return plan.evidence as unknown as Evidence;
}
function oid(value: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
    fail('worktree_protocol_error', 'Git returned an invalid object identifier.');
  return value;
}
function absent(path: string): void {
  if (exists(path))
    fail('target_exists', 'The requested path already exists, including an empty directory.');
}
function rejectOverlap(path: string, repository: Repository, worktrees: ListedWorktree[]): void {
  if (
    containsPath(repository.commonDir, path) ||
    containsPath(path, repository.commonDir) ||
    worktrees.some((tree) => containsPath(tree.path, path) || containsPath(path, tree.path))
  )
    fail('unsafe_target_path', 'The target overlaps repository metadata or an existing worktree.');
}
async function rejectTemporaryTarget(path: string): Promise<void> {
  const roots = await captureTemporaryWorktreeRoots({
    platform: process.platform,
    temporaryDirectory: tmpdir(),
    environment: process.env,
  });
  if (await inspectTemporaryWorktreeTarget(path, roots))
    fail(
      'temporary_worktree_target',
      'Create worktrees in a persistent directory outside temporary roots.',
    );
}
function defaultCreateParent(
  path: string,
  defaultRoot: string,
): {
  target: string;
  parent: Evidence['parent'];
} {
  if (!samePath(dirname(path), defaultRoot) || !/^worktree-[a-f0-9]{64}$/.test(basename(path)))
    fail(
      'worktree_protocol_error',
      'The default target is not a direct stable child of its trusted root.',
    );
  const missing: string[] = [];
  let existing = dirname(path);
  while (!exists(existing)) {
    missing.unshift(existing);
    const next = dirname(existing);
    if (next === existing || missing.length > 64)
      fail('unsafe_target_path', 'The default root has no verifiable existing ancestor.');
    existing = next;
  }
  const canonical = canonicalDirectory(existing);
  const physical = (entry: string) => resolve(canonical, relative(existing, entry));
  return {
    target: physical(path),
    parent: {
      path: canonical,
      identity: identity(canonical),
      defaultRoot: physical(defaultRoot),
      missingParents: missing.map(physical),
    },
  };
}
async function prepareCreate(
  request: WorktreeRequest,
  git: Git,
  repository: Repository,
): Promise<WorktreePlan> {
  const input = request.input;
  if (input?.action !== 'create')
    fail('worktree_protocol_error', 'Create preparation requires its normalized input.');
  await git.checkSupported(repository);
  const allocation =
    input.path === undefined
      ? defaultCreateParent(request.resolvedTarget!.path, request.resolvedTarget!.defaultRoot)
      : { target: targetPath(input.path), parent: undefined };
  const target = allocation.target;
  await rejectTemporaryTarget(target);
  absent(target);
  rejectOverlap(target, repository, await git.list(repository));
  if (input.newBranch) await git.branchAbsent(repository.root, input.newBranch);
  const base = await git.run(
    repository.root,
    ['rev-parse', '--verify', '--end-of-options', `${input.baseRef}^{commit}`],
    { allowFailure: true },
  );
  if (base.exitCode !== 0)
    fail('invalid_base_ref', 'The requested base reference is not a readable commit.');
  const baseOid = oid(utf8(base.stdout).replace(/\n$/, ''));
  const parent = allocation.parent ?? {
    path: dirname(target),
    identity: identity(dirname(target)),
  };
  return {
    action: 'create',
    sourceCwd: request.sourceCwd,
    sourceRoot: repository.root,
    commonDir: repository.commonDir,
    targetPath: target,
    baseRef: input.baseRef,
    baseOid,
    ...(input.newBranch ? { newBranch: input.newBranch } : {}),
    evidence: { repository, parent } as unknown as Json,
  };
}
async function linkedTarget(
  git: Git,
  repository: Repository,
  target: string,
  worktrees: ListedWorktree[],
): Promise<NonNullable<Evidence['target']>> {
  const registrations = worktrees.filter((tree) => samePath(tree.path, target));
  if (registrations.length !== 1)
    fail('not_linked_worktree', 'The target is not a unique linked worktree in this repository.');
  const item = registrations[0]!;
  if (item.isMain || item.bare) fail('main_worktree', 'The main worktree cannot be removed.');
  if (samePath(target, repository.root))
    fail('current_worktree', 'The source checkout cannot be removed.');
  if (item.locked) fail('worktree_locked', 'The target worktree is locked.');
  if (item.prunable || !exists(target))
    fail('not_linked_worktree', 'The target is missing or its registration is prunable.');
  if (
    containsPath(target, repository.root) ||
    containsPath(target, repository.commonDir) ||
    worktrees.some((tree) => !samePath(tree.path, target) && containsPath(target, tree.path))
  )
    fail(
      'unsafe_target_path',
      'The target contains source, metadata, or another registered worktree.',
    );
  inspectPath(target, true);
  const pointer = readOrdinaryFile(join(target, '.git'), 4096);
  const pointerText = utf8(pointer);
  if (!pointerText.startsWith('gitdir: ') || !pointerText.endsWith('\n'))
    fail('not_linked_worktree', 'The linked worktree Git pointer is malformed.');
  const pointerValue = pointerText.slice(8, -1),
    adminGitDir = canonicalDirectory(
      isAbsolute(pointerValue) ? pointerValue : resolve(target, pointerValue),
    );
  if (
    !containsPath(join(repository.commonDir, 'worktrees'), adminGitDir) ||
    samePath(join(repository.commonDir, 'worktrees'), adminGitDir)
  )
    fail(
      'wrong_repository',
      'The linked worktree administrative directory is outside this repository.',
    );
  const backlinkText = utf8(readOrdinaryFile(join(adminGitDir, 'gitdir'), 4096));
  if (!backlinkText.endsWith('\n') || !samePath(backlinkText.slice(0, -1), join(target, '.git')))
    fail('not_linked_worktree', 'The administrative backlink does not identify this target.');
  const targetRepository = await git.repository(target);
  if (
    !samePath(targetRepository.root, target) ||
    !samePath(targetRepository.commonDir, repository.commonDir) ||
    !samePath(targetRepository.gitDir, adminGitDir)
  )
    fail('wrong_repository', 'The target does not resolve to the prepared repository.');
  const head = oid(await git.text(target, ['rev-parse', '--verify', 'HEAD^{commit}']));
  const branchResult = await git.run(target, ['symbolic-ref', '--quiet', 'HEAD'], {
    allowFailure: true,
  });
  if (![0, 1].includes(branchResult.exitCode))
    fail('worktree_verification_failed', 'The target branch could not be verified.');
  const branch = branchResult.exitCode === 0 ? utf8(branchResult.stdout).replace(/\n$/, '') : null;
  if (head !== item.head || branch !== item.branch)
    fail('target_identity_changed', 'The target HEAD or registration changed during inspection.');
  return {
    identity: identity(target),
    pointerDigest: sha256(pointer),
    adminGitDir,
    adminIdentity: identity(adminGitDir),
    head,
    branch,
    registrationDigest: digest(item),
  };
}
interface CheckedFile {
  path: string;
  stat: BigIntStats;
}
interface CheckedContent {
  files: CheckedFile[];
  tree: TrackedTreeEvidence;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size &&
    left.mode === right.mode
  );
}
function verifyCheckedFiles(files: CheckedFile[]): void {
  for (const file of files) {
    inspectPath(file.path, false);
    if (!sameFile(file.stat, lstatSync(file.path, { bigint: true })))
      fail('target_identity_changed', 'A tracked file changed during removal inspection.');
  }
}
function verifyCheckedContent(content: CheckedContent): void {
  verifyCheckedFiles(content.files);
  verifyTrackedTree(content.tree);
}
async function checkFiles(
  git: Git,
  repository: Repository,
  target: string,
): Promise<CheckedContent> {
  const targetRepository = await git.repository(target),
    config = await git.checkSupported(targetRepository);
  if (!samePath(repository.commonDir, targetRepository.commonDir))
    fail('wrong_repository', 'The target repository changed.');
  const status = await git.run(
    target,
    ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching'],
    { config },
  );
  if (status.stdout.length) {
    nulRecords(status.stdout); // Establish complete UTF-8 before reporting local data.
    fail('worktree_dirty', 'Tracked, untracked, or ignored local changes prevent removal.');
  }
  const marks = nulRecords((await git.run(target, ['ls-files', '-v', '-z'], { config })).stdout);
  for (const entry of marks) {
    if (!/^[A-Za-z?] /.test(entry))
      fail('worktree_protocol_error', 'The index flag listing is malformed.');
    const mark = entry[0]!;
    if (mark !== mark.toUpperCase() || mark === 'S')
      fail(
        'unsupported_index_flags',
        'Assume-unchanged and skip-worktree index flags prevent removal.',
      );
  }
  const staged = nulRecords(
      (await git.run(target, ['ls-files', '--stage', '-z'], { config })).stdout,
    ),
    files = new Set<string>(),
    checked: CheckedFile[] = [],
    blobs = new Set<string>();
  for (const entry of staged) {
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (!match) fail('worktree_protocol_error', 'The index entry listing is malformed.');
    if (match[1] === '160000')
      fail(
        'unsupported_submodule_worktree',
        'Worktrees containing gitlinks or initialized submodules cannot be removed.',
      );
    if (match[3] !== '0') fail('worktree_dirty', 'Conflicting index stages prevent removal.');
    if (!['100644', '100755'].includes(match[1]!))
      fail('unsupported_path_type', 'Only ordinary tracked files can be safely removed.');
    const file = match[4]!;
    if (isAbsolute(file) || file.split('/').includes('..') || files.has(file))
      fail('worktree_protocol_error', 'The tracked path listing is contradictory.');
    files.add(file);
    const path = join(target, file),
      blob = match[2]!;
    inspectPath(path, false);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!sameFile(before, lstatSync(path, { bigint: true })))
        fail('target_identity_changed', 'A tracked file changed while it was opened.');
      // Git's stat cache and core.filemode are deliberately not evidence of clean
      // content or mode. Hash every opened file, with internal clean conversions
      // but all executable filters disabled, and require its retained index blob.
      if (process.platform !== 'win32' && Boolean(before.mode & 0o100n) !== (match[1] === '100755'))
        fail('worktree_dirty', 'A tracked executable mode differs from its index entry.');
      if (!blobs.has(blob)) {
        if ((await git.text(target, ['cat-file', '-t', blob], { config })) !== 'blob')
          fail('worktree_verification_failed', 'A tracked index blob is unavailable.');
        const size = await git.text(target, ['cat-file', '-s', blob], { config });
        if (!/^(0|[1-9][0-9]*)$/.test(size))
          fail('worktree_protocol_error', 'A retained blob has an invalid size.');
        // Read and verify the entire stored object, not only its header: a missing
        // or corrupt body must never justify deleting the sole ordinary-file copy.
        const retained = await git.run(target, ['cat-file', 'blob', blob], {
          config,
          outputHash: {
            algorithm: blob.length === 40 ? 'sha1' : 'sha256',
            prefix: `blob ${size}\0`,
            bytes: BigInt(size),
          },
        });
        if (retained.stdoutHash !== blob)
          fail('worktree_verification_failed', 'The complete retained index blob is corrupt.');
        blobs.add(blob);
      }
      const hashed = await git.run(target, ['hash-object', '--stdin', `--path=${file}`], {
        config,
        inputFd: fd,
      });
      if (oid(utf8(hashed.stdout).replace(/\n$/, '')) !== blob)
        fail('worktree_dirty', 'Tracked file content differs from its retained index blob.');
      if (
        !sameFile(before, fstatSync(fd, { bigint: true })) ||
        !sameFile(before, lstatSync(path, { bigint: true }))
      )
        fail('target_identity_changed', 'A tracked file changed while its content was checked.');
      checked.push({ path, stat: before });
    } finally {
      closeSync(fd);
    }
  }
  const tree = scanTrackedTree(target, files, limits.scanEntries);
  verifyCheckedFiles(checked);
  return { files: checked, tree };
}
async function dependsOnRemovedAdmin(
  git: Git,
  repository: Repository,
  ref: string,
  removedAdmin: string,
): Promise<boolean> {
  const seen = new Set<string>();
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(ref)) fail('worktree_verification_failed', 'A protection reference is cyclic.');
    seen.add(ref);
    const path = await git.text(repository.root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      ref,
    ]);
    if (!isAbsolute(path)) fail('worktree_protocol_error', 'A reference path is not absolute.');
    if (samePath(path, removedAdmin) || containsPath(removedAdmin, path)) return true;
    if (exists(path)) inspectPath(path, false);
    const symbolic = await git.run(
      repository.root,
      ['symbolic-ref', '--no-recurse', '--quiet', ref],
      { allowFailure: true },
    );
    if (symbolic.exitCode === 1) return false;
    if (symbolic.exitCode !== 0)
      fail('worktree_verification_failed', 'A protection reference dependency is unreadable.');
    ref = utf8(symbolic.stdout).replace(/\n$/, '');
    if (
      !ref ||
      [...ref].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
    )
      fail('worktree_protocol_error', 'A symbolic reference dependency is malformed.');
    // Private HEADs (including other detached worktrees) are not independent
    // retained branches or tags. Every hop must stay in shared protection refs.
    if (!/^refs\/(heads|tags)\//.test(ref)) return true;
  }
  fail('inspection_limit', 'A symbolic reference chain exceeds the inspection limit.');
}
interface ProtectionEvidence {
  packedRefsPath: string;
  packedRefs?: { identity: PathIdentity; digest: string };
}
function packedRefsEvidence(path: string): ProtectionEvidence {
  if (!exists(path)) return { packedRefsPath: path };
  const before = identity(path);
  const bytes = readOrdinaryFile(path, limits.gitStdoutBytes);
  if (!sameIdentity(before, identity(path)))
    fail(
      'worktree_verification_failed',
      'The shared packed reference file changed during inspection.',
    );
  return { packedRefsPath: path, packedRefs: { identity: before, digest: sha256(bytes) } };
}
function verifyProtectionEvidence(evidence: ProtectionEvidence): void {
  if (digest(packedRefsEvidence(evidence.packedRefsPath)) !== digest(evidence))
    fail(
      'worktree_verification_failed',
      'The shared packed reference backing changed during inspection.',
    );
}
async function protectedCommits(
  git: Git,
  repository: Repository,
  target: string,
  head: string,
  removedAdmin: string,
): Promise<ProtectionEvidence> {
  // A packed branch is independent protection only while its actual shared
  // backing is ordinary metadata, rather than an alias into disposable admin data.
  const protection = packedRefsEvidence(join(repository.commonDir, 'packed-refs'));
  const backend = await git.run(target, ['rev-parse', '--show-ref-format'], { allowFailure: true });
  if (backend.exitCode !== 0 || utf8(backend.stdout) !== 'files\n')
    fail(
      'unsupported_reflog_backend',
      'Strict removal requires a verified files reference backend.',
    );
  const objectFormat = await git.text(target, ['rev-parse', '--show-object-format']);
  if (!['sha1', 'sha256'].includes(objectFormat))
    fail('unsupported_reflog', 'The repository object format is unsupported.');
  const length = objectFormat === 'sha1' ? 40 : 64;
  const reflogPath = await git.text(target, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'logs/HEAD',
  ]);
  let bytes: Buffer;
  try {
    bytes = readOrdinaryFile(reflogPath, limits.gitStdoutBytes);
  } catch (error) {
    if (error instanceof WorktreeError && error.code === 'unsupported_path_encoding') throw error;
    fail(
      'unsupported_reflog',
      'The complete ordinary HEAD reflog is unavailable; preserve the worktree.',
    );
  }
  const text = utf8(bytes);
  if (!text.endsWith('\n')) fail('unsupported_reflog', 'The HEAD reflog is missing or truncated.');
  const commits = new Set<string>([head]),
    expression = new RegExp(
      `^([a-f0-9]{${length}}) ([a-f0-9]{${length}}) [^\\t\\n]+ <[^\\t\\n<>]*> \\d+ [+-]\\d{4}(?:\\t[^\\n]*)?$`,
    );
  for (const line of text.slice(0, -1).split('\n')) {
    const match = expression.exec(line);
    if (!match)
      fail('unsupported_reflog', 'A HEAD reflog record is malformed; no entries may be skipped.');
    for (const commit of [match[1]!, match[2]!]) if (!/^0+$/.test(commit)) commits.add(commit);
    if (commits.size > limits.commits)
      fail('inspection_limit', 'The HEAD reflog contains too many unique commits.');
  }
  for (const commit of commits)
    if ((await git.text(target, ['cat-file', '-t', commit])) !== 'commit')
      fail('unsupported_reflog', 'A HEAD reflog object is not an available commit.');
  const referenceResult = await git.run(repository.root, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads/',
    'refs/tags/',
  ]);
  if (referenceResult.stderr.length)
    fail(
      'worktree_verification_failed',
      'The complete protection reference inventory could not be read without anomalies.',
      { diagnostic: utf8(referenceResult.stderr).slice(0, 4096) },
    );
  const refs = utf8(referenceResult.stdout).replace(/\n$/, '');
  const tips = new Set<string>();
  for (const ref of refs ? refs.split('\n') : []) {
    if (
      !/^refs\/(heads|tags)\/[^\s]+$/.test(ref) ||
      [...ref].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      fail('worktree_protocol_error', 'A protected reference name is malformed.');
    if (await dependsOnRemovedAdmin(git, repository, ref, removedAdmin)) continue;
    const peel = await git.run(
      repository.root,
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{}`],
      { allowFailure: true },
    );
    if (peel.exitCode !== 0)
      fail('worktree_verification_failed', 'A protected reference could not be completely peeled.');
    const commit = oid(utf8(peel.stdout).replace(/\n$/, '')),
      type = await git.text(repository.root, ['cat-file', '-t', commit]);
    if (type === 'commit') tips.add(commit);
    else if (!ref.startsWith('refs/tags/') || !['blob', 'tree'].includes(type))
      fail('worktree_verification_failed', 'A local branch does not retain a readable commit.');
    if (tips.size > limits.commits) fail('inspection_limit', 'Too many protected reference tips.');
  }
  if (!tips.size)
    fail('unprotected_commits', 'No local branch or tag retains the worktree commits.');
  const input = `${[...commits, ...[...tips].map((tip) => `^${tip}`)].join('\n')}\n`;
  const unprotected = await git.run(target, ['rev-list', '--stdin', '--max-count=1'], { input });
  if (unprotected.stderr.length)
    fail(
      'worktree_verification_failed',
      'Commit reachability could not be inspected without anomalies.',
      { diagnostic: utf8(unprotected.stderr).slice(0, 4096) },
    );
  if (unprotected.stdout.length) {
    oid(utf8(unprotected.stdout).replace(/\n$/, ''));
    fail(
      'unprotected_commits',
      'HEAD or its old/new reflog history has commits not retained by a local branch or tag. Preserve those commits first.',
    );
  }
  verifyProtectionEvidence(protection);
  return protection;
}
async function prepareRemove(
  request: WorktreeRequest,
  git: Git,
  repository: Repository,
): Promise<WorktreePlan> {
  if (request.input?.action !== 'remove')
    fail('worktree_protocol_error', 'Remove preparation requires its normalized input.');
  await git.checkSupported(repository);
  const target = targetPath(request.input.path),
    worktrees = await git.list(repository);
  const targetEvidence = await linkedTarget(git, repository, target, worktrees);
  const checked = await checkFiles(git, repository, target);
  const protection = await protectedCommits(
    git,
    repository,
    target,
    targetEvidence.head,
    targetEvidence.adminGitDir,
  );
  const refreshed = await linkedTarget(git, repository, target, await git.list(repository));
  if (digest(refreshed) !== digest(targetEvidence))
    fail('target_identity_changed', 'The target changed during preparation.');
  verifyCheckedContent(checked);
  verifyProtectionEvidence(protection);
  return {
    action: 'remove',
    sourceCwd: request.sourceCwd,
    sourceRoot: repository.root,
    commonDir: repository.commonDir,
    targetPath: target,
    evidence: {
      repository,
      parent: { path: dirname(target), identity: identity(dirname(target)) },
      target: targetEvidence,
    } as unknown as Json,
  };
}
async function observe(
  git: Git,
  repository: Repository,
  plan: WorktreePlan,
): Promise<Record<string, Json>> {
  let registered: boolean | 'unknown' = 'unknown',
    pathExists: boolean | 'unknown' = 'unknown',
    newBranchExists: boolean | 'unknown' = 'unknown';
  try {
    registered = (await git.list(repository)).some((tree) => samePath(tree.path, plan.targetPath));
  } catch {}
  try {
    pathExists = exists(plan.targetPath);
  } catch {}
  if (plan.newBranch) {
    try {
      const result = await git.run(
        repository.root,
        ['show-ref', '--verify', '--quiet', `refs/heads/${plan.newBranch}`],
        { allowFailure: true },
      );
      if ([0, 1].includes(result.exitCode)) newBranchExists = result.exitCode === 0;
    } catch {}
  }
  return { pathExists, registered, ...(plan.newBranch ? { newBranchExists } : {}) };
}
async function create(
  git: Git,
  repository: Repository,
  plan: WorktreePlan,
  setMutation: (state: 'partial' | 'completed') => void,
): Promise<Record<string, Json>> {
  const saved = evidence(plan);
  git.assertRepository(saved.repository, repository);
  await git.checkSupported(repository);
  await rejectTemporaryTarget(plan.targetPath);
  inspectPath(saved.parent.path, true);
  if (!sameIdentity(saved.parent.identity, identity(saved.parent.path)))
    fail('target_identity_changed', 'The target parent changed since preparation.');
  if (saved.parent.defaultRoot !== undefined) {
    const current = defaultCreateParent(plan.targetPath, saved.parent.defaultRoot);
    if (
      !samePath(current.parent.path, saved.parent.path) ||
      JSON.stringify(current.parent.missingParents) !== JSON.stringify(saved.parent.missingParents)
    )
      fail('target_identity_changed', 'The default root ancestor chain changed since preparation.');
  } else if (!samePath(dirname(plan.targetPath), saved.parent.path))
    fail('target_identity_changed', 'The target parent differs from its prepared path.');
  absent(plan.targetPath);
  rejectOverlap(plan.targetPath, repository, await git.list(repository));
  if (plan.newBranch) await git.branchAbsent(repository.root, plan.newBranch);
  await git.run(repository.root, ['cat-file', '-e', `${plan.baseOid}^{commit}`]);
  let parentPath = saved.parent.path;
  let parentIdentity = saved.parent.identity;
  for (const path of saved.parent.missingParents ?? []) {
    if (!samePath(dirname(path), parentPath))
      fail('worktree_protocol_error', 'The default root allocation chain is not contiguous.');
    inspectPath(parentPath, true);
    if (!sameIdentity(parentIdentity, identity(parentPath)))
      fail('target_identity_changed', 'The default root ancestor was replaced before allocation.');
    absent(path);
    mkdirSync(path, { recursive: false, mode: 0o700 });
    setMutation('partial');
    inspectPath(path, true);
    if (!sameIdentity(parentIdentity, identity(parentPath), false))
      fail('target_identity_changed', 'The default root ancestor was replaced during allocation.');
    parentPath = path;
    parentIdentity = identity(path);
  }
  if (!samePath(parentPath, dirname(plan.targetPath)))
    fail('worktree_protocol_error', 'The allocation chain does not end at the target parent.');
  inspectPath(parentPath, true);
  if (!sameIdentity(parentIdentity, identity(parentPath)))
    fail('target_identity_changed', 'The target parent changed before allocation.');
  mkdirSync(plan.targetPath, { recursive: false });
  setMutation('partial');
  inspectPath(plan.targetPath, true);
  if (!sameIdentity(parentIdentity, identity(parentPath), false))
    fail('target_identity_changed', 'The target parent was replaced during allocation.');
  const allocation = identity(plan.targetPath);
  await git.run(repository.root, [
    'worktree',
    'add',
    '--no-checkout',
    ...(plan.newBranch ? ['--no-track', '-b', plan.newBranch] : ['--detach']),
    '--',
    plan.targetPath,
    plan.baseOid!,
  ]);
  if (!sameIdentity(allocation, identity(plan.targetPath), false))
    fail('target_identity_changed', 'The newly reserved target was replaced.');
  const target = await linkedTarget(git, repository, plan.targetPath, await git.list(repository));
  const names = readdirSync(plan.targetPath, { encoding: 'buffer' }).map(utf8);
  if (
    names.length !== 1 ||
    names[0] !== '.git' ||
    target.head !== plan.baseOid ||
    target.branch !== (plan.newBranch ? `refs/heads/${plan.newBranch}` : null)
  )
    fail(
      'target_identity_changed',
      'The newly registered target contains unexpected content or branch state.',
    );
  const location = { gitDir: target.adminGitDir, workTree: plan.targetPath };
  const destination = await git.repository(plan.targetPath),
    config = await git.checkSupported(destination, location);
  if (
    !sameIdentity(allocation, identity(plan.targetPath), false) ||
    readdirSync(plan.targetPath).join() !== '.git'
  )
    fail(
      'target_identity_changed',
      'Foreign content appeared before checkout; it was left intact.',
    );
  await git.run(plan.targetPath, ['reset', '--hard', '--no-recurse-submodules', plan.baseOid!], {
    location,
    config,
  });
  const final = await linkedTarget(git, repository, plan.targetPath, await git.list(repository));
  if (
    !sameIdentity(allocation, final.identity, false) ||
    final.head !== plan.baseOid ||
    final.branch !== (plan.newBranch ? `refs/heads/${plan.newBranch}` : null)
  )
    fail(
      'worktree_verification_failed',
      'Created worktree postconditions could not be established.',
    );
  setMutation('completed');
  return {
    path: plan.targetPath,
    baseRef: plan.baseRef!,
    baseCommit: plan.baseOid!,
    head: final.head,
    branch: final.branch,
    detached: final.branch === null,
    observed: {
      pathExists: true,
      registered: true,
      ...(plan.newBranch ? { newBranchExists: true } : {}),
    },
  };
}
async function remove(
  git: Git,
  repository: Repository,
  plan: WorktreePlan,
  setMutation: (state: 'partial' | 'completed') => void,
): Promise<Record<string, Json>> {
  const saved = evidence(plan);
  git.assertRepository(saved.repository, repository);
  await git.checkSupported(repository);
  inspectPath(saved.parent.path, true);
  if (!sameIdentity(saved.parent.identity, identity(saved.parent.path)))
    fail('target_identity_changed', 'The target parent changed since preparation.');
  const current = await linkedTarget(git, repository, plan.targetPath, await git.list(repository));
  if (!saved.target || digest(current) !== digest(saved.target))
    fail(
      'target_identity_changed',
      'The target generation changed since preparation; preserve the replacement.',
    );
  const checked = await checkFiles(git, repository, plan.targetPath);
  const protection = await protectedCommits(
    git,
    repository,
    plan.targetPath,
    current.head,
    current.adminGitDir,
  );
  const finalInspection = await linkedTarget(
    git,
    repository,
    plan.targetPath,
    await git.list(repository),
  );
  if (digest(finalInspection) !== digest(saved.target))
    fail('target_identity_changed', 'The target changed during final inspection.');
  const targetConfiguration = await git.checkSupported(await git.repository(plan.targetPath));
  verifyCheckedContent(checked);
  verifyProtectionEvidence(protection);
  setMutation('partial');
  await git.run(repository.root, ['worktree', 'remove', '--', plan.targetPath], {
    config: targetConfiguration,
  });
  const observed = await observe(git, repository, plan);
  if (observed.pathExists !== false || observed.registered !== false)
    fail(
      'worktree_verification_failed',
      'Git returned but deletion postconditions are not established.',
      { observed },
    );
  setMutation('completed');
  return {
    path: plan.targetPath,
    head: current.head,
    branch: current.branch,
    removed: true,
    observed,
  };
}

export async function executeWorktreeRequest(request: WorktreeRequest): Promise<WorktreeFrame> {
  if (!validateRequest(request)) throw new Error('worktree_protocol_error');
  let mutation: 'not_started' | 'partial' | 'completed' = 'not_started',
    repository: Repository | undefined,
    git: Git | undefined;
  let lock: ReturnType<typeof acquireLock> | undefined;
  let result: Record<string, Json> | undefined, failure: unknown;
  const details = (): Record<string, Json> => ({
    action:
      request.phase === 'list' ? 'list' : request.phase.endsWith('create') ? 'create' : 'remove',
    observedAt: new Date().toISOString(),
    cwdChanged: false,
    mutation,
    ...(repository
      ? { repository: { root: repository.root, commonDir: repository.commonDir } }
      : {}),
  });
  try {
    inspectPath(request.hooksPath, true);
    if (readdirSync(request.hooksPath).length)
      fail('worktree_asset_changed', 'The trusted hooks directory is no longer empty.');
    git = new Git(request.git.path, request.git.sha256, request.hooksPath);
    repository = await git.repository(request.sourceCwd);
    if (request.phase === 'list') {
      const worktrees = await git.list(repository);
      const payload = {
        ...details(),
        sourceWorktree: repository.root,
        worktrees: worktrees as unknown as Json,
      };
      if (
        worktrees.length > limits.listItems ||
        Buffer.byteLength(JSON.stringify(payload)) > limits.listBytes
      )
        fail('inspection_limit', 'The complete worktree list exceeds the public result limit.');
      return {
        protocolVersion: 1,
        operationToken: request.operationToken,
        phase: request.phase,
        businessOutcome: 'succeeded',
        details: payload,
      };
    }
    if (request.phase === 'prepare_create' || request.phase === 'prepare_remove') {
      const plan =
        request.phase === 'prepare_create'
          ? await prepareCreate(request, git, repository)
          : await prepareRemove(request, git, repository);
      return {
        protocolVersion: 1,
        operationToken: request.operationToken,
        phase: request.phase,
        businessOutcome: 'prepared',
        details: details(),
        plan,
        planDigest: digest(plan),
      };
    }
    const plan = request.plan!;
    if (
      !samePath(plan.sourceRoot, repository.root) ||
      !samePath(plan.commonDir, repository.commonDir)
    )
      fail('target_identity_changed', 'The repository differs from the prepared plan.');
    lock = acquireLock(repository.commonDir, request.operationToken);
    result =
      request.phase === 'create'
        ? await create(git, repository, plan, (state) => {
            mutation = state;
          })
        : await remove(git, repository, plan, (state) => {
            mutation = state;
          });
  } catch (error) {
    failure = error;
  }
  let observed: Record<string, Json> | undefined;
  if (failure && lock && git && repository && request.plan && mutation !== 'not_started')
    observed = await observe(git, repository, request.plan);
  if (lock) {
    try {
      lock.release();
    } catch (error) {
      failure = error;
    }
  }
  if (failure) {
    const known =
      failure instanceof WorktreeError
        ? failure
        : new WorktreeError(
            'git_operation_failed',
            'The worker could not complete this operation; inspect the original result before another intent.',
          );
    return {
      protocolVersion: 1,
      operationToken: request.operationToken,
      phase: request.phase,
      businessOutcome: 'failed',
      details: {
        ...details(),
        code: known.code,
        message: known.message,
        ...(known.facts as Record<string, Json>),
        ...(request.plan ? { path: request.plan.targetPath } : {}),
        ...(observed ? { observed } : result?.observed ? { observed: result.observed } : {}),
      },
    };
  }
  return {
    protocolVersion: 1,
    operationToken: request.operationToken,
    phase: request.phase,
    businessOutcome: 'succeeded',
    details: { ...details(), ...result },
  };
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('worktree_protocol_error');
    const frame = await executeWorktreeRequest(decodeWorkerRequest(process.argv[2]!));
    const output = JSON.stringify(frame);
    if (Buffer.byteLength(output) > limits.frameBytes) throw new Error('inspection_limit');
    process.stdout.write(`${output}\n`);
  } catch {
    process.stderr.write('worktree_worker_protocol_failure\n');
    process.exitCode = 1;
  }
}
