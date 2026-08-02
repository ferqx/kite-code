import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const OPAQUE_IDENTITY_PATTERN = /^wt_[0-9a-f]{32}$/;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_REVIEW_FILE_BYTES = 1024 * 1024;
const MAX_UNTRACKED_REVIEW_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_BASELINE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BASELINE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_BASELINE_FILE_COUNT = 10_000;
const MAX_REPOSITORY_CONTROL_BYTES = 1024 * 1024;

export type WriterExecutionModeV1 =
  | 'foreground_tui'
  | 'foreground_headless_cli'
  | 'background'
  | 'scheduled'
  | 'unattended'
  | 'concurrent'
  | 'delegated';

export type WriterWorkspaceAdmissionV1 =
  | { allowed: true; workspace: 'shared_read_only' | 'shared_foreground_writer' | 'worktree' }
  | {
      allowed: false;
      workspace: 'none';
      reason: 'foreground_headless_write_excluded' | 'worktree_controller_disabled';
    };

export interface ResolveWriterWorkspaceAdmissionV1Input {
  featureEnabled: boolean;
  mode: WriterExecutionModeV1;
  access: 'read_only' | 'write';
  currentCheckoutSelected?: boolean;
}

/**
 * App-owned admission for writer placement. This is deliberately independent
 * of Runtime types: Core receives a canonical workspace plus an opaque binding,
 * never Git credentials or controller authority.
 */
export function resolveWriterWorkspaceAdmissionV1(
  input: ResolveWriterWorkspaceAdmissionV1Input,
): WriterWorkspaceAdmissionV1 {
  if (input.access === 'read_only') {
    return { allowed: true, workspace: 'shared_read_only' };
  }
  if (input.mode === 'foreground_tui' && input.currentCheckoutSelected === true) {
    return { allowed: true, workspace: 'shared_foreground_writer' };
  }
  if (input.mode === 'foreground_headless_cli') {
    return { allowed: false, workspace: 'none', reason: 'foreground_headless_write_excluded' };
  }
  if (!input.featureEnabled) {
    return { allowed: false, workspace: 'none', reason: 'worktree_controller_disabled' };
  }
  return { allowed: true, workspace: 'worktree' };
}

export type WorktreeControllerFailureCodeV1 =
  | 'invalid_input'
  | 'invalid_repository'
  | 'invalid_baseline'
  | 'baseline_dirty'
  | 'state_root_unsafe'
  | 'writer_lease_conflict'
  | 'operation_in_progress'
  | 'branch_collision'
  | 'git_failure'
  | 'record_unavailable'
  | 'identity_mismatch'
  | 'worktree_conflict'
  | 'worktree_dirty';

export class WorktreeControllerErrorV1 extends Error {
  readonly code: WorktreeControllerFailureCodeV1;

  constructor(code: WorktreeControllerFailureCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorktreeControllerErrorV1';
    this.code = code;
  }
}

export interface WorktreeRuntimeBindingV1 {
  readonly version: 1;
  readonly kind: 'controller_worktree';
  readonly worktreeIdentity: string;
}

export interface WriterWorkspaceLeaseV1 {
  readonly version: 1;
  readonly worktreeIdentity: string;
  readonly workspaceRoot: string;
  /** App-private ownership epoch. Never include this in the Runtime binding. */
  readonly ownershipNonce: string;
  readonly runtimeBinding: WorktreeRuntimeBindingV1;
}

export interface AcquireWriterWorkspaceV1Input {
  baselineRepoRoot: string;
  baselineCommit: string;
  taskIdentity: string;
  runIdentity: string;
  writerIdentity: string;
}

export interface WorktreeControllerV1Options {
  stateRoot: string;
  gitBinary?: string;
  now?: () => Date;
  randomIdentity?: () => string;
}

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RepositoryIdentityV1 {
  readonly repoRoot: string;
  readonly commonGitDirectory: string;
  readonly commonGitDirectoryDevice: number;
  readonly commonGitDirectoryInode: number;
}

const recordSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(['provisioning', 'active']),
    worktreeIdentity: z.string().regex(OPAQUE_IDENTITY_PATTERN),
    repoRoot: z.string().min(1),
    commonGitDirectory: z.string().min(1),
    commonGitDirectoryDevice: z.number().int().nonnegative(),
    commonGitDirectoryInode: z.number().int().nonnegative(),
    baselineCommit: z.string().regex(COMMIT_PATTERN),
    branchName: z.string().min(1),
    worktreeRoot: z.string().min(1),
    taskIdentity: z.string().regex(IDENTITY_PATTERN),
    runIdentity: z.string().regex(IDENTITY_PATTERN),
    writerIdentity: z.string().regex(IDENTITY_PATTERN),
    writerLeaseKey: z.string().regex(/^[0-9a-f]{64}$/),
    ownershipNonce: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();

type WorktreeRecordV1 = z.infer<typeof recordSchema>;

export interface OwnedWorktreeSnapshotV1 {
  readonly worktreeIdentity: string;
  readonly workspaceRoot: string;
  readonly repoRoot: string;
  readonly baselineCommit: string;
  readonly branchName: string;
  readonly taskIdentity: string;
  readonly runIdentity: string;
  readonly writerIdentity: string;
  readonly createdAt: string;
}

export interface WorktreeHandoffEvidenceV1 extends OwnedWorktreeSnapshotV1 {
  readonly conflicts: string;
  readonly status: string;
  readonly uncommitted: string;
  readonly trackedPaths: string;
  readonly untrackedPaths: string;
  readonly untrackedReview: string;
  readonly diff: string;
  readonly currentCommit: string;
}

function collectUntrackedReview(root: string, nulPaths: string): string {
  const paths = nulPaths === '' ? [] : nulPaths.split('\0').filter(Boolean);
  let total = 0;
  const records: string[] = [];
  for (const path of paths.sort()) {
    const absolute = resolve(root, path);
    if (!isInside(root, absolute) || relative(root, absolute).split(sep).join('/') !== path) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Untracked review path escaped or changed identity.',
      );
    }
    const before = lstatSync(absolute);
    const ownerMismatch = process.platform !== 'win32' && before.uid !== process.getuid?.();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      ownerMismatch ||
      before.size > MAX_UNTRACKED_REVIEW_FILE_BYTES
    ) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Untracked review accepts only bounded, owned regular files.',
      );
    }
    total += before.size;
    if (total > MAX_UNTRACKED_REVIEW_TOTAL_BYTES) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Untracked review content exceeds the bounded handoff limit.',
      );
    }
    let fd: number | undefined;
    try {
      const flags =
        constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
      fd = openSync(absolute, flags);
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new WorktreeControllerErrorV1(
          'identity_mismatch',
          'Untracked review file changed during secure open.',
        );
      }
      const content = readFileSync(fd);
      const after = fstatSync(fd);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        content.byteLength !== opened.size
      ) {
        throw new WorktreeControllerErrorV1(
          'identity_mismatch',
          'Untracked review file changed while being read.',
        );
      }
      records.push(
        `KITE_UNTRACKED_FILE_V1 ${JSON.stringify({
          path,
          size: content.byteLength,
          sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
          encoding: 'base64',
          content: content.toString('base64'),
        })}`,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return records.join('\n');
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validateIdentity(name: string, value: string): void {
  if (!IDENTITY_PATTERN.test(value)) {
    throw new WorktreeControllerErrorV1(
      'invalid_input',
      `${name} must contain only 1-64 safe identity characters.`,
    );
  }
}

function slug(value: string): string {
  return value.toLowerCase().slice(0, 24);
}

function writerLeaseKey(input: {
  taskIdentity: string;
  runIdentity: string;
  writerIdentity: string;
}): string {
  return createHash('sha256')
    .update('kite.writer-workspace-lease.v1\0')
    .update(JSON.stringify([input.taskIdentity, input.runIdentity, input.writerIdentity]))
    .digest('hex');
}

function branchName(input: {
  taskIdentity: string;
  runIdentity: string;
  writerIdentity: string;
}): string {
  const key = writerLeaseKey(input);
  return `codex/writer/${slug(input.taskIdentity)}-${slug(input.runIdentity)}-${slug(input.writerIdentity)}-${key.slice(0, 12)}`;
}

function opaqueIdentity(value: string): string {
  const normalized = value.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new WorktreeControllerErrorV1('invalid_input', 'Generated worktree identity is invalid.');
  }
  return `wt_${normalized}`;
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_ATTR_NOSYSTEM = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GCM_INTERACTIVE = 'Never';
  env.SSH_ASKPASS_REQUIRE = 'never';
  env.LC_ALL = 'C';
  return env;
}

function readPrivateFile(path: string): string {
  const stat = lstatSync(path);
  const ownerMismatch = process.platform !== 'win32' && stat.uid !== process.getuid?.();
  const permissionsUnsafe = process.platform !== 'win32' && (stat.mode & 0o077) !== 0;
  if (!stat.isFile() || stat.isSymbolicLink() || ownerMismatch || permissionsUnsafe) {
    throw new Error('not a private regular file');
  }
  return readFileSync(path, 'utf8');
}

function readStrictRecord(path: string): WorktreeRecordV1 {
  try {
    return recordSchema.parse(JSON.parse(readPrivateFile(path)));
  } catch (error) {
    throw new WorktreeControllerErrorV1(
      'record_unavailable',
      'Writer worktree ownership record is missing or invalid.',
      { cause: error },
    );
  }
}

function writeNewPrivateFile(path: string, value: unknown): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function replacePrivateRecord(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeNewPrivateFile(temporary, value);
    renameSync(temporary, path);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the original error. A residual private temp file is evidence
      // that recovery needs operator attention; no worktree fallback occurs.
    }
    throw error;
  }
}

export class WorktreeControllerV1 {
  private readonly stateRoot: string;
  private readonly recordsRoot: string;
  private readonly locksRoot: string;
  private readonly worktreesRoot: string;
  private readonly hooksRoot: string;
  private readonly gitBinary: string;
  private readonly now: () => Date;
  private readonly randomIdentity: () => string;

  constructor(options: WorktreeControllerV1Options) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.now = options.now ?? (() => new Date());
    this.randomIdentity = options.randomIdentity ?? randomUUID;
    const requestedRoot = resolve(options.stateRoot);
    try {
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
      const rootStat = lstatSync(requestedRoot);
      const canonicalRoot = realpathSync.native(requestedRoot);
      const ownerMismatch = process.platform !== 'win32' && rootStat.uid !== process.getuid?.();
      const permissionsUnsafe = process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0;
      if (
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        ownerMismatch ||
        permissionsUnsafe
      ) {
        throw new Error('state root must be a canonical, non-symlink directory');
      }
      this.stateRoot = canonicalRoot;
      this.recordsRoot = this.createPrivateChild('records');
      this.locksRoot = this.createPrivateChild('locks');
      this.worktreesRoot = this.createPrivateChild('worktrees');
      this.hooksRoot = this.createPrivateChild('disabled-hooks');
    } catch (error) {
      throw new WorktreeControllerErrorV1(
        'state_root_unsafe',
        'Worktree controller state root is unavailable or unsafe.',
        { cause: error },
      );
    }
  }

  acquire(input: AcquireWriterWorkspaceV1Input): WriterWorkspaceLeaseV1 {
    validateIdentity('taskIdentity', input.taskIdentity);
    validateIdentity('runIdentity', input.runIdentity);
    validateIdentity('writerIdentity', input.writerIdentity);
    if (!COMMIT_PATTERN.test(input.baselineCommit)) {
      throw new WorktreeControllerErrorV1(
        'invalid_baseline',
        'baselineCommit must be a full lowercase commit identity.',
      );
    }

    const repository = this.resolveRepository(input.baselineRepoRoot);
    if (
      isInside(repository.repoRoot, this.stateRoot) ||
      isInside(this.stateRoot, repository.repoRoot)
    ) {
      throw new WorktreeControllerErrorV1(
        'state_root_unsafe',
        'Controller state and worktrees must be outside the baseline repository.',
      );
    }
    // This preflight must precede every worktree-aware Git command. In
    // particular, `git status` may invoke a configured clean/process filter
    // for a stat-dirty tracked file even when the checkout is content-clean.
    this.assertBaselineHasNoExternalFilters(repository, input.baselineCommit);
    const resolvedCommit = this.git(repository.repoRoot, [
      'rev-parse',
      '--verify',
      `${input.baselineCommit}^{commit}`,
    ]).stdout.trim();
    if (resolvedCommit !== input.baselineCommit) {
      throw new WorktreeControllerErrorV1(
        'invalid_baseline',
        'baselineCommit does not resolve to the requested immutable commit.',
      );
    }
    if (
      this.git(repository.repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
        .stdout.length > 0
    ) {
      throw new WorktreeControllerErrorV1(
        'baseline_dirty',
        'Baseline checkout is dirty; isolated writer creation is blocked.',
      );
    }

    const createdAt = this.now();
    if (!Number.isFinite(createdAt.getTime())) {
      throw new WorktreeControllerErrorV1('invalid_input', 'Controller clock is invalid.');
    }
    const leaseKey = writerLeaseKey(input);
    const worktreeIdentity = opaqueIdentity(this.randomIdentity());
    const lockPath = this.lockPath(leaseKey);
    try {
      writeNewPrivateFile(lockPath, { version: 1, leaseKey, worktreeIdentity });
    } catch (error) {
      throw new WorktreeControllerErrorV1(
        'writer_lease_conflict',
        'A writer workspace lease already exists for this task/run/writer identity.',
        { cause: error },
      );
    }

    const targetBranch = branchName(input);
    const targetRoot = resolve(this.worktreesRoot, worktreeIdentity);
    const recordPath = this.recordPath(worktreeIdentity);
    const record: WorktreeRecordV1 = {
      version: 1,
      state: 'provisioning',
      worktreeIdentity,
      ...repository,
      baselineCommit: input.baselineCommit,
      branchName: targetBranch,
      worktreeRoot: targetRoot,
      taskIdentity: input.taskIdentity,
      runIdentity: input.runIdentity,
      writerIdentity: input.writerIdentity,
      writerLeaseKey: leaseKey,
      ownershipNonce: randomUUID(),
      createdAt: createdAt.toISOString(),
    };

    try {
      writeNewPrivateFile(recordPath, record);
      const branchProbe = this.git(
        repository.repoRoot,
        ['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`],
        [0, 1],
      );
      if (branchProbe.status === 0) {
        throw new WorktreeControllerErrorV1(
          'branch_collision',
          `Controller branch already exists: ${targetBranch}`,
        );
      }
      if (existsSync(targetRoot)) {
        throw new WorktreeControllerErrorV1(
          'identity_mismatch',
          'Generated worktree path already exists.',
        );
      }
      this.git(repository.repoRoot, [
        'worktree',
        'add',
        '--no-checkout',
        '--no-track',
        '-b',
        targetBranch,
        targetRoot,
        input.baselineCommit,
      ]);
      this.materializeBaselineWithoutCheckout(targetRoot, input.baselineCommit);
      this.assertBaselineHasNoExternalFilters(repository, input.baselineCommit);
      this.assertRecordBinding(record);
      const activeRecord = { ...record, state: 'active' as const };
      replacePrivateRecord(recordPath, activeRecord);
      return this.leaseFromRecord(activeRecord);
    } catch (error) {
      // Keep the ownership record and lease lock. A partial Git operation or
      // disk failure must remain blocked for operator diagnosis, never become
      // active, fall back to the shared checkout, or trigger broad deletion.
      if (error instanceof WorktreeControllerErrorV1) throw error;
      throw new WorktreeControllerErrorV1(
        'git_failure',
        'Failed to provision an isolated writer worktree.',
        { cause: error },
      );
    }
  }

  recover(worktreeIdentity: string): WriterWorkspaceLeaseV1 {
    return this.withOperationLock(worktreeIdentity, () => {
      const record = this.readRecord(worktreeIdentity);
      this.assertLeaseLock(record);
      if (record.state !== 'active') {
        throw new WorktreeControllerErrorV1(
          'record_unavailable',
          'Provisioning worktree cannot be recovered automatically; discard and recreate it explicitly.',
        );
      }
      this.assertRecordBinding(record);
      const recoveredRecord = {
        ...record,
        ownershipNonce: randomUUID(),
      };
      try {
        replacePrivateRecord(this.recordPath(worktreeIdentity), recoveredRecord);
      } catch (error) {
        throw new WorktreeControllerErrorV1(
          'record_unavailable',
          'Cannot persist the recovered writer ownership epoch.',
          { cause: error },
        );
      }
      return this.leaseFromRecord(recoveredRecord);
    });
  }

  inspect(lease: WriterWorkspaceLeaseV1): OwnedWorktreeSnapshotV1 {
    const record = this.readRecord(lease.worktreeIdentity);
    if (
      lease.version !== 1 ||
      lease.workspaceRoot !== record.worktreeRoot ||
      lease.ownershipNonce !== record.ownershipNonce ||
      lease.runtimeBinding.version !== 1 ||
      lease.runtimeBinding.kind !== 'controller_worktree' ||
      lease.runtimeBinding.worktreeIdentity !== record.worktreeIdentity
    ) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Writer workspace lease does not match its ownership record.',
      );
    }
    this.assertLeaseLock(record);
    this.assertRecordBinding(record);
    return {
      worktreeIdentity: record.worktreeIdentity,
      workspaceRoot: record.worktreeRoot,
      repoRoot: record.repoRoot,
      baselineCommit: record.baselineCommit,
      branchName: record.branchName,
      taskIdentity: record.taskIdentity,
      runIdentity: record.runIdentity,
      writerIdentity: record.writerIdentity,
      createdAt: record.createdAt,
    };
  }

  cleanup(lease: WriterWorkspaceLeaseV1): void {
    this.withOperationLock(lease.worktreeIdentity, () => {
      const snapshot = this.inspect(lease);
      const conflicts = this.git(snapshot.workspaceRoot, [
        'diff',
        '--name-only',
        '--diff-filter=U',
        '-z',
        '--',
      ]).stdout;
      if (conflicts.length > 0) {
        throw new WorktreeControllerErrorV1(
          'worktree_conflict',
          'Writer worktree contains unresolved conflicts and was retained.',
        );
      }
      const status = this.git(snapshot.workspaceRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]).stdout;
      if (status.length > 0) {
        throw new WorktreeControllerErrorV1(
          'worktree_dirty',
          'Writer worktree contains uncommitted changes and was retained.',
        );
      }

      this.inspect(lease);
      this.git(snapshot.repoRoot, ['worktree', 'remove', '--', snapshot.workspaceRoot]);
      const record = this.readRecord(snapshot.worktreeIdentity);
      if (record.ownershipNonce !== lease.ownershipNonce) {
        throw new WorktreeControllerErrorV1(
          'identity_mismatch',
          'Writer ownership epoch changed during cleanup.',
        );
      }
      this.assertLeaseLock(record);
      this.removePrivateIdentityFile(this.recordPath(record.worktreeIdentity));
      this.removePrivateIdentityFile(this.lockPath(record.writerLeaseKey));
    });
  }

  collectHandoffEvidence(lease: WriterWorkspaceLeaseV1): WorktreeHandoffEvidenceV1 {
    return this.withOperationLock(lease.worktreeIdentity, () =>
      this.collectHandoffEvidenceLocked(lease),
    );
  }

  private collectHandoffEvidenceLocked(lease: WriterWorkspaceLeaseV1): WorktreeHandoffEvidenceV1 {
    const snapshot = this.inspect(lease);
    const conflicts = this.git(snapshot.workspaceRoot, [
      'diff',
      '--name-only',
      '--diff-filter=U',
      '-z',
      '--',
    ]).stdout;
    const uncommitted = this.git(snapshot.workspaceRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]).stdout;
    const status = this.git(snapshot.workspaceRoot, [
      'status',
      '--short',
      '--branch',
      '--untracked-files=all',
    ]).stdout.trimEnd();
    const trackedPaths = this.git(snapshot.workspaceRoot, [
      'diff',
      '--name-only',
      '-z',
      snapshot.baselineCommit,
      '--',
    ]).stdout;
    const untrackedPaths = this.git(snapshot.workspaceRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
    ]).stdout;
    const untrackedReview = collectUntrackedReview(snapshot.workspaceRoot, untrackedPaths);
    const diff = this.git(snapshot.workspaceRoot, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      snapshot.baselineCommit,
      '--',
    ]).stdout;
    const currentCommit = this.git(snapshot.workspaceRoot, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]).stdout.trim();
    const finalUncommitted = this.git(snapshot.workspaceRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]).stdout;
    const finalCommit = this.git(snapshot.workspaceRoot, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]).stdout.trim();
    const finalTrackedPaths = this.git(snapshot.workspaceRoot, [
      'diff',
      '--name-only',
      '-z',
      snapshot.baselineCommit,
      '--',
    ]).stdout;
    const finalUntrackedPaths = this.git(snapshot.workspaceRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
    ]).stdout;
    const finalUntrackedReview = collectUntrackedReview(
      snapshot.workspaceRoot,
      finalUntrackedPaths,
    );
    const finalDiff = this.git(snapshot.workspaceRoot, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      snapshot.baselineCommit,
      '--',
    ]).stdout;
    if (
      uncommitted !== finalUncommitted ||
      currentCommit !== finalCommit ||
      trackedPaths !== finalTrackedPaths ||
      untrackedPaths !== finalUntrackedPaths ||
      untrackedReview !== finalUntrackedReview ||
      diff !== finalDiff
    ) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Writer worktree changed while collecting handoff evidence.',
      );
    }
    return {
      ...snapshot,
      conflicts,
      status,
      uncommitted,
      trackedPaths,
      untrackedPaths,
      untrackedReview,
      diff: [diff.trimEnd(), untrackedReview].filter(Boolean).join('\n'),
      currentCommit,
    };
  }

  private withOperationLock<T>(worktreeIdentity: string, operation: () => T): T {
    if (!OPAQUE_IDENTITY_PATTERN.test(worktreeIdentity)) {
      throw new WorktreeControllerErrorV1('invalid_input', 'Invalid opaque worktree identity.');
    }
    const operationPath = resolve(this.locksRoot, `${worktreeIdentity}.operation`);
    try {
      writeNewPrivateFile(operationPath, {
        version: 1,
        worktreeIdentity,
        nonce: randomUUID(),
      });
    } catch (error) {
      throw new WorktreeControllerErrorV1(
        'operation_in_progress',
        'Another controller operation is active or requires manual recovery.',
        { cause: error },
      );
    }
    try {
      return operation();
    } finally {
      this.removePrivateIdentityFile(operationPath);
    }
  }

  private createPrivateChild(name: string): string {
    const path = resolve(this.stateRoot, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    const ownerMismatch = process.platform !== 'win32' && stat.uid !== process.getuid?.();
    const permissionsUnsafe = process.platform !== 'win32' && (stat.mode & 0o077) !== 0;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync.native(path) !== path ||
      ownerMismatch ||
      permissionsUnsafe
    ) {
      throw new Error(`unsafe controller child directory: ${name}`);
    }
    return path;
  }

  private resolveRepository(requestedRoot: string): RepositoryIdentityV1 {
    let canonicalRequested: string;
    try {
      canonicalRequested = realpathSync.native(resolve(requestedRoot));
      if (!statSync(canonicalRequested).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new WorktreeControllerErrorV1(
        'invalid_repository',
        'Baseline repository root is unavailable.',
        { cause: error },
      );
    }
    let topLevel: string;
    let commonGitDirectory: string;
    try {
      topLevel = realpathSync.native(
        resolve(this.git(canonicalRequested, ['rev-parse', '--show-toplevel']).stdout.trim()),
      );
      if (topLevel !== canonicalRequested) {
        throw new WorktreeControllerErrorV1(
          'invalid_repository',
          'baselineRepoRoot must resolve to the canonical repository root.',
        );
      }
      const common = this.git(canonicalRequested, ['rev-parse', '--git-common-dir']).stdout.trim();
      commonGitDirectory = realpathSync.native(resolve(canonicalRequested, common));
      const commonStat = statSync(commonGitDirectory);
      if (!commonStat.isDirectory()) throw new Error('Git common directory is not a directory');
      return {
        repoRoot: topLevel,
        commonGitDirectory,
        commonGitDirectoryDevice: commonStat.dev,
        commonGitDirectoryInode: commonStat.ino,
      };
    } catch (error) {
      if (error instanceof WorktreeControllerErrorV1) throw error;
      throw new WorktreeControllerErrorV1(
        'invalid_repository',
        'Cannot establish the canonical Git repository identity.',
        { cause: error },
      );
    }
  }

  private assertRecordBinding(record: WorktreeRecordV1): void {
    const repository = this.resolveRepository(record.repoRoot);
    if (
      repository.commonGitDirectory !== record.commonGitDirectory ||
      repository.commonGitDirectoryDevice !== record.commonGitDirectoryDevice ||
      repository.commonGitDirectoryInode !== record.commonGitDirectoryInode ||
      resolve(this.worktreesRoot, record.worktreeIdentity) !== record.worktreeRoot
    ) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Repository or controller worktree identity changed.',
      );
    }
    let worktreeRoot: string;
    try {
      worktreeRoot = realpathSync.native(record.worktreeRoot);
    } catch (error) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Controller-owned worktree is missing.',
        { cause: error },
      );
    }
    const observedRoot = realpathSync.native(
      resolve(this.git(worktreeRoot, ['rev-parse', '--show-toplevel']).stdout.trim()),
    );
    const observedCommon = realpathSync.native(
      resolve(
        worktreeRoot,
        this.git(worktreeRoot, ['rev-parse', '--git-common-dir']).stdout.trim(),
      ),
    );
    const observedBranch = this.git(worktreeRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]).stdout.trim();
    if (
      worktreeRoot !== record.worktreeRoot ||
      observedRoot !== record.worktreeRoot ||
      observedCommon !== record.commonGitDirectory ||
      observedBranch !== record.branchName
    ) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Worktree repository or branch identity changed.',
      );
    }
  }

  private assertLeaseLock(record: WorktreeRecordV1): void {
    try {
      const lock = JSON.parse(readPrivateFile(this.lockPath(record.writerLeaseKey))) as {
        version?: unknown;
        leaseKey?: unknown;
        worktreeIdentity?: unknown;
      };
      if (
        lock.version !== 1 ||
        lock.leaseKey !== record.writerLeaseKey ||
        lock.worktreeIdentity !== record.worktreeIdentity
      ) {
        throw new Error('lease lock identity mismatch');
      }
    } catch (error) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Writer lease lock is missing or does not match the worktree record.',
        { cause: error },
      );
    }
  }

  private readRecord(worktreeIdentity: string): WorktreeRecordV1 {
    if (!OPAQUE_IDENTITY_PATTERN.test(worktreeIdentity)) {
      throw new WorktreeControllerErrorV1('invalid_input', 'Invalid opaque worktree identity.');
    }
    return readStrictRecord(this.recordPath(worktreeIdentity));
  }

  private leaseFromRecord(record: WorktreeRecordV1): WriterWorkspaceLeaseV1 {
    return Object.freeze({
      version: 1 as const,
      worktreeIdentity: record.worktreeIdentity,
      workspaceRoot: record.worktreeRoot,
      ownershipNonce: record.ownershipNonce,
      runtimeBinding: Object.freeze({
        version: 1 as const,
        kind: 'controller_worktree' as const,
        worktreeIdentity: record.worktreeIdentity,
      }),
    });
  }

  private recordPath(identity: string): string {
    return resolve(this.recordsRoot, `${identity}.json`);
  }

  private assertBaselineHasNoExternalFilters(
    repository: RepositoryIdentityV1,
    commit: string,
  ): void {
    // Replacement refs are disabled in every subprocess too, but reject their
    // repository-local presence so an immutable baseline never has two
    // competing interpretations at the controller boundary.
    const replacementRefsPath = resolve(repository.commonGitDirectory, 'refs', 'replace');
    if (existsSync(replacementRefsPath)) {
      throw new WorktreeControllerErrorV1(
        'invalid_baseline',
        'Repository replacement refs are present; immutable baseline admission is blocked.',
      );
    }
    const graftsPath = resolve(repository.commonGitDirectory, 'info', 'grafts');
    if (existsSync(graftsPath)) {
      throw new WorktreeControllerErrorV1(
        'invalid_baseline',
        'Repository legacy grafts are present; immutable baseline admission is blocked.',
      );
    }
    const packedRefsPath = resolve(repository.commonGitDirectory, 'packed-refs');
    if (existsSync(packedRefsPath)) {
      const packedRefs = this.readRepositoryControlFile(
        repository.commonGitDirectory,
        packedRefsPath,
        'Repository packed refs are unsafe.',
      );
      if (/^[0-9a-f]{40} refs\/replace\//mu.test(packedRefs)) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Repository packed replacement refs are present; immutable baseline admission is blocked.',
        );
      }
    }

    const paths = this.git(repository.repoRoot, [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      commit,
      '--',
    ])
      .stdout.split('\0')
      .filter((path) => path === '.gitattributes' || path.endsWith('/.gitattributes'));
    for (const path of paths) {
      const contents = this.git(repository.repoRoot, ['show', `${commit}:${path}`]).stdout;
      if (this.attributesDeclareFilter(contents)) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Baseline declares a Git content filter and cannot be materialized safely.',
        );
      }
    }

    const configPath = resolve(repository.commonGitDirectory, 'config');
    if (existsSync(configPath)) {
      const config = this.readRepositoryControlFile(
        repository.commonGitDirectory,
        configPath,
        'Repository Git config is unsafe.',
      );
      if (/^\s*\[(?:filter\b|include\b|includeif\b)/imu.test(config)) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Repository Git config declares a filter or include and cannot be materialized safely.',
        );
      }
    }

    const infoAttributesPath = resolve(repository.commonGitDirectory, 'info', 'attributes');
    if (existsSync(infoAttributesPath)) {
      const attributes = this.readRepositoryControlFile(
        repository.commonGitDirectory,
        infoAttributesPath,
        'Repository info attributes are unsafe.',
      );
      if (this.attributesDeclareFilter(attributes)) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Repository info attributes declare a Git content filter.',
        );
      }
    }
  }

  private materializeBaselineWithoutCheckout(worktreeRoot: string, commit: string): void {
    // Populate the index without running checkout, then materialize exact blob
    // bytes ourselves. This structurally prevents Git smudge/process filters,
    // credential helpers, and checkout-time external drivers from executing.
    this.git(worktreeRoot, ['read-tree', '--reset', commit]);
    const listing = this.gitBytes(worktreeRoot, [
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      commit,
      '--',
    ]);
    let total = 0;
    let fileCount = 0;
    let decodedListing: string;
    try {
      decodedListing = new TextDecoder('utf-8', { fatal: true }).decode(
        listing.subarray(0, Math.max(0, listing.length - 1)),
      );
    } catch (error) {
      throw new WorktreeControllerErrorV1(
        'invalid_baseline',
        'Baseline contains a non-UTF-8 path that cannot be materialized safely.',
        { cause: error },
      );
    }
    for (const rawEntry of decodedListing.split('\0')) {
      if (rawEntry === '') continue;
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(rawEntry);
      if (!match) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Baseline contains a non-regular or unsupported Git tree entry.',
        );
      }
      const [, mode, objectId, path] = match;
      fileCount += 1;
      if (fileCount > MAX_BASELINE_FILE_COUNT) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Baseline contains too many files for bounded materialization.',
        );
      }
      const absolute = resolve(worktreeRoot, path!);
      if (
        !isInside(worktreeRoot, absolute) ||
        relative(worktreeRoot, absolute).split(sep).join('/') !== path
      ) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Baseline tree path escaped the controller worktree.',
        );
      }
      const content = this.gitBytes(worktreeRoot, ['cat-file', 'blob', objectId!]);
      if (content.byteLength > MAX_BASELINE_FILE_BYTES) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Baseline file exceeds the bounded materialization limit.',
        );
      }
      total += content.byteLength;
      if (total > MAX_BASELINE_TOTAL_BYTES) {
        throw new WorktreeControllerErrorV1(
          'invalid_baseline',
          'Baseline exceeds the bounded materialization limit.',
        );
      }
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
      let fd: number | undefined;
      try {
        fd = openSync(absolute, 'wx', mode === '100755' ? 0o700 : 0o600);
        writeFileSync(fd, content);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  }

  private attributesDeclareFilter(contents: string): boolean {
    return contents.split(/\r?\n/u).some((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return false;
      return trimmed
        .split(/\s+/u)
        .slice(1)
        .some((attribute) => /^(?:-|!)?filter(?:=|$)/u.test(attribute));
    });
  }

  private readRepositoryControlFile(root: string, path: string, message: string): string {
    const absolute = resolve(path);
    if (!isInside(root, absolute)) {
      throw new WorktreeControllerErrorV1('identity_mismatch', message);
    }
    const before = lstatSync(absolute);
    const ownerMismatch = process.platform !== 'win32' && before.uid !== process.getuid?.();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      ownerMismatch ||
      before.size > MAX_REPOSITORY_CONTROL_BYTES
    ) {
      throw new WorktreeControllerErrorV1('identity_mismatch', message);
    }
    let fd: number | undefined;
    try {
      const flags =
        constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
      fd = openSync(absolute, flags);
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new WorktreeControllerErrorV1('identity_mismatch', message);
      }
      const contents = readFileSync(fd, 'utf8');
      const after = fstatSync(fd);
      if (
        opened.dev !== after.dev ||
        opened.ino !== after.ino ||
        opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs ||
        Buffer.byteLength(contents, 'utf8') !== opened.size
      ) {
        throw new WorktreeControllerErrorV1('identity_mismatch', message);
      }
      return contents;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private lockPath(key: string): string {
    return resolve(this.locksRoot, `${key}.json`);
  }

  private removePrivateIdentityFile(path: string): void {
    const before = lstatSync(path);
    const ownerMismatch = process.platform !== 'win32' && before.uid !== process.getuid?.();
    const permissionsUnsafe = process.platform !== 'win32' && (before.mode & 0o077) !== 0;
    if (!before.isFile() || before.isSymbolicLink() || ownerMismatch || permissionsUnsafe) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Controller identity file was replaced.',
      );
    }
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new WorktreeControllerErrorV1(
        'identity_mismatch',
        'Controller identity file changed during cleanup.',
      );
    }
    unlinkSync(path);
  }

  private git(cwd: string, args: readonly string[], accepted = [0]): GitResult {
    const result = spawnSync(
      this.gitBinary,
      [
        '--no-pager',
        '-c',
        `core.hooksPath=${this.hooksRoot}`,
        '-c',
        'credential.helper=',
        '-c',
        'core.askPass=',
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.attributesFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: safeGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const status = result.status ?? -1;
    if (result.error || !accepted.includes(status)) {
      const diagnostic = (result.stderr || result.error?.message || 'unknown Git failure')
        .trim()
        .slice(0, 1_000);
      throw new WorktreeControllerErrorV1(
        'git_failure',
        `Git command failed closed: ${diagnostic}`,
        { cause: result.error },
      );
    }
    return { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  private gitBytes(cwd: string, args: readonly string[]): Buffer {
    const result = spawnSync(
      this.gitBinary,
      [
        '--no-pager',
        '-c',
        `core.hooksPath=${this.hooksRoot}`,
        '-c',
        'credential.helper=',
        '-c',
        'core.askPass=',
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.attributesFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        ...args,
      ],
      {
        cwd,
        env: safeGitEnvironment(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const status = result.status ?? -1;
    if (result.error || status !== 0 || !Buffer.isBuffer(result.stdout)) {
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr.toString('utf8')
        : String(result.stderr ?? result.error?.message ?? 'unknown Git failure');
      throw new WorktreeControllerErrorV1(
        'git_failure',
        `Git command failed closed: ${stderr.trim().slice(0, 1_000)}`,
        { cause: result.error },
      );
    }
    return result.stdout;
  }
}
