import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { AgentTaskCaseV1 } from '../../../../scripts/evals/contracts/agent-task-case-schema';
import { canonicalJsonBytes, sha256Digest } from '../../../../scripts/release/canonical-json';

const OWNER_FILE = '.kite-agent-eval-owner.json';
const RUN_PREFIX = 'kite-agent-eval-run-';
const MAX_FIXTURE_FILE_BYTES = 256 * 1024;
const MAX_COLLECTED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTED_TOTAL_BYTES = 16 * 1024 * 1024;
const FIXED_GIT_TIMESTAMP = '2000-01-01T00:00:00Z';

export interface FixtureFileArtifactV1 {
  version: 1;
  path: string;
  kind: 'file' | 'symlink';
  byteLength: number;
  sha256: `sha256:${string}`;
  text: string | null;
}

export interface FixtureArtifactV1 {
  version: 1;
  runId: string;
  caseId: string;
  baselineCommit: string;
  fixtureDigest: `sha256:${string}`;
  baselineState: 'clean' | 'dirty';
  changedFiles: string[];
  initialDirtyFiles: string[];
  files: FixtureFileArtifactV1[];
  patch: string;
  patchSha256: `sha256:${string}`;
  gitDiagnosticPatch: string;
  residualProcessIds: number[];
  residualWorktrees: string[];
}

export interface FixtureProcessLeaseV1 {
  version: 1;
  runId: string;
  ownershipNonce: string;
  processToken: string;
  pid: number;
}

export interface FixtureRunV1 {
  version: 1;
  runId: string;
  caseId: string;
  fixtureId: string;
  fixtureDigest: `sha256:${string}`;
  baselineState: 'clean' | 'dirty';
  baselineCommit: string;
  tempParent: string;
  root: string;
  workspace: string;
  ownershipNonce: string;
  initialDirtyFiles: string[];
  initialFiles: Map<string, FixtureFileArtifactV1>;
  processLeases: Map<string, FixtureProcessLeaseV1>;
}

export interface CleanupFixtureOptions {
  terminateOwnedProcess?: (lease: FixtureProcessLeaseV1) => boolean;
}

export class FixtureRunnerError extends Error {
  readonly code:
    | 'cleanup_identity_mismatch'
    | 'fixture_invalid'
    | 'git_failed'
    | 'residual_process'
    | 'unsafe_cleanup_target';

  constructor(code: FixtureRunnerError['code'], message: string) {
    super(message);
    this.name = 'FixtureRunnerError';
    this.code = code;
  }
}

export function createFixtureRun(
  task: AgentTaskCaseV1,
  options: { fixtureRoot?: string; tempParent?: string } = {},
): FixtureRunV1 {
  const fixtureRoot = resolve(options.fixtureRoot ?? join(import.meta.dir, task.fixtureId));
  const tempParent = resolve(options.tempParent ?? tmpdir());
  validateFixtureSource(fixtureRoot);
  mkdirSync(tempParent, { recursive: true });
  const root = mkdtempSync(join(tempParent, RUN_PREFIX));
  const workspace = join(root, 'workspace');
  const isolatedHome = join(root, 'home');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(isolatedHome, { mode: 0o700 });
  copyFixture(fixtureRoot, workspace);

  const runId = randomUUID();
  const ownershipNonce = randomUUID();
  const owner = {
    version: 1,
    runId,
    ownershipNonce,
    root,
    workspace,
  };
  writeFileSync(join(root, OWNER_FILE), canonicalJsonBytes(owner), { mode: 0o600 });

  initializeGitRepository(workspace, isolatedHome);
  git(workspace, isolatedHome, ['config', 'kite.evalRunId', runId]);
  const baselineCommit = git(workspace, isolatedHome, ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(baselineCommit)) {
    throw new FixtureRunnerError('git_failed', 'Fixture baseline commit identity is invalid.');
  }
  if (task.baselineState === 'dirty') {
    writeFileSync(join(workspace, 'fixture-dirty.txt'), 'intentional dirty baseline\n', 'utf8');
  }
  const initialDirtyFiles = gitChangedPaths(workspace, isolatedHome);
  if (task.baselineState === 'clean' && initialDirtyFiles.length !== 0) {
    throw new FixtureRunnerError(
      'fixture_invalid',
      'Clean fixture baseline is dirty after commit.',
    );
  }
  if (task.baselineState === 'dirty' && initialDirtyFiles.length === 0) {
    throw new FixtureRunnerError(
      'fixture_invalid',
      'Dirty fixture baseline did not produce a change.',
    );
  }
  const initialFiles = collectFiles(workspace);
  const fixtureDigest = digestFiles(initialFiles);

  return {
    version: 1,
    runId,
    caseId: task.caseId,
    fixtureId: task.fixtureId,
    fixtureDigest,
    baselineState: task.baselineState,
    baselineCommit,
    tempParent,
    root,
    workspace,
    ownershipNonce,
    initialDirtyFiles,
    initialFiles,
    processLeases: new Map(),
  };
}

export function registerFixtureProcess(run: FixtureRunV1, pid: number): FixtureProcessLeaseV1 {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new FixtureRunnerError('fixture_invalid', 'Owned fixture process PID is invalid.');
  }
  if ([...run.processLeases.values()].some((lease) => lease.pid === pid)) {
    throw new FixtureRunnerError('fixture_invalid', 'Owned fixture process PID is already leased.');
  }
  const lease: FixtureProcessLeaseV1 = {
    version: 1,
    runId: run.runId,
    ownershipNonce: run.ownershipNonce,
    processToken: randomUUID(),
    pid,
  };
  run.processLeases.set(lease.processToken, lease);
  return lease;
}

export function markFixtureProcessExited(run: FixtureRunV1, processToken: string): void {
  if (!run.processLeases.delete(processToken)) {
    throw new FixtureRunnerError('cleanup_identity_mismatch', 'Unknown fixture process lease.');
  }
}

export function collectFixtureArtifact(run: FixtureRunV1): FixtureArtifactV1 {
  assertLeaseIdentity(run);
  const currentFiles = collectFiles(run.workspace);
  const changedFiles = changedPaths(run.initialFiles, currentFiles);
  const patch = semanticPatch(run.initialFiles, currentFiles, changedFiles);
  const isolatedHome = join(run.root, 'home');
  const residualWorktrees = git(run.workspace, isolatedHome, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => realpathSync(path) !== realpathSync(run.workspace))
    .sort();
  return {
    version: 1,
    runId: run.runId,
    caseId: run.caseId,
    baselineCommit: run.baselineCommit,
    fixtureDigest: run.fixtureDigest,
    baselineState: run.baselineState,
    changedFiles,
    initialDirtyFiles: [...run.initialDirtyFiles],
    files: [...currentFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    patch,
    patchSha256: sha256Digest(patch),
    gitDiagnosticPatch: git(run.workspace, isolatedHome, [
      'diff',
      '--binary',
      '--no-ext-diff',
      run.baselineCommit,
      '--',
    ]),
    residualProcessIds: [...run.processLeases.values()]
      .map((lease) => lease.pid)
      .sort((a, b) => a - b),
    residualWorktrees,
  };
}

/**
 * Collects diagnostics before deletion. Ownership or residual-process failure
 * preserves the complete run directory for inspection.
 */
export function cleanupFixtureRun(
  run: FixtureRunV1,
  options: CleanupFixtureOptions = {},
): FixtureArtifactV1 {
  assertSafeCleanupTarget(run);
  assertLeaseIdentity(run);
  const diagnostics = collectFixtureArtifact(run);
  for (const lease of run.processLeases.values()) {
    if (!options.terminateOwnedProcess?.(lease)) {
      throw new FixtureRunnerError(
        'residual_process',
        `Fixture process ${lease.pid} remains; preserving diagnostics at ${run.root}.`,
      );
    }
    run.processLeases.delete(lease.processToken);
  }
  rmSync(run.root, { recursive: true, force: true });
  return diagnostics;
}

function validateFixtureSource(root: string): void {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new FixtureRunnerError('fixture_invalid', `Fixture source does not exist: ${root}`);
  }
  for (const entry of walk(root, false)) {
    const name = basename(entry.absolute).toLowerCase();
    if (entry.kind === 'symlink') {
      throw new FixtureRunnerError('fixture_invalid', 'Fixture sources cannot contain symlinks.');
    }
    if (entry.kind === 'directory') {
      if (name === '.git') {
        throw new FixtureRunnerError(
          'fixture_invalid',
          'Fixture sources cannot carry Git metadata.',
        );
      }
      continue;
    }
    if (['.env', 'id_rsa', 'id_ed25519', 'credentials', 'credentials.json'].includes(name)) {
      throw new FixtureRunnerError(
        'fixture_invalid',
        `Credential-like fixture path is forbidden: ${name}`,
      );
    }
    const stats = statSync(entry.absolute);
    if (stats.size > MAX_FIXTURE_FILE_BYTES) {
      throw new FixtureRunnerError(
        'fixture_invalid',
        `Fixture file exceeds limit: ${entry.relative}`,
      );
    }
    const content = readFileSync(entry.absolute, 'utf8');
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(content) ||
      /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/.test(content)
    ) {
      throw new FixtureRunnerError(
        'fixture_invalid',
        `Credential-like fixture content: ${entry.relative}`,
      );
    }
  }
}

function initializeGitRepository(workspace: string, isolatedHome: string): void {
  git(workspace, isolatedHome, ['init', '-q', '--initial-branch=main']);
  git(workspace, isolatedHome, ['config', 'core.autocrlf', 'false']);
  git(workspace, isolatedHome, ['config', 'commit.gpgsign', 'false']);
  git(workspace, isolatedHome, ['add', '--all', '--']);
  git(workspace, isolatedHome, ['commit', '-q', '-m', 'synthetic fixture baseline']);
}

function git(workspace: string, isolatedHome: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: isolatedHome,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Kite Synthetic Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@invalid.example',
      GIT_COMMITTER_NAME: 'Kite Synthetic Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@invalid.example',
      GIT_AUTHOR_DATE: FIXED_GIT_TIMESTAMP,
      GIT_COMMITTER_DATE: FIXED_GIT_TIMESTAMP,
      LC_ALL: 'C',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new FixtureRunnerError(
      'git_failed',
      `Offline fixture Git command failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

function gitChangedPaths(workspace: string, isolatedHome: string): string[] {
  const output = git(workspace, isolatedHome, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '-z',
  ]);
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => record.slice(3))
    .sort();
}

function copyFixture(source: string, destination: string): void {
  for (const entry of walk(source, false)) {
    const target = join(destination, entry.relative);
    if (entry.kind === 'directory') mkdirSync(target, { recursive: true, mode: 0o700 });
    else if (entry.kind === 'file')
      writeFileSync(target, readFileSync(entry.absolute), { mode: 0o600 });
  }
}

function collectFiles(workspace: string): Map<string, FixtureFileArtifactV1> {
  const files = new Map<string, FixtureFileArtifactV1>();
  let totalBytes = 0;
  for (const entry of walk(workspace, true)) {
    if (entry.kind === 'directory') continue;
    if (entry.kind === 'symlink') {
      files.set(entry.relative, {
        version: 1,
        path: entry.relative,
        kind: 'symlink',
        byteLength: 0,
        sha256: sha256Digest('symlink'),
        text: null,
      });
      continue;
    }
    const fileSize = statSync(entry.absolute).size;
    totalBytes += fileSize;
    if (fileSize > MAX_COLLECTED_FILE_BYTES || totalBytes > MAX_COLLECTED_TOTAL_BYTES) {
      throw new FixtureRunnerError(
        'fixture_invalid',
        `Fixture artifact collection limit exceeded at ${entry.relative}.`,
      );
    }
    const bytes = readFileSync(entry.absolute);
    files.set(entry.relative, {
      version: 1,
      path: entry.relative,
      kind: 'file',
      byteLength: bytes.byteLength,
      sha256: sha256Digest(bytes),
      text: bytes.byteLength <= MAX_FIXTURE_FILE_BYTES ? decodeText(bytes) : null,
    });
  }
  return files;
}

function walk(
  root: string,
  excludeGit: boolean,
): Array<{ absolute: string; relative: string; kind: 'directory' | 'file' | 'symlink' }> {
  const entries: Array<{
    absolute: string;
    relative: string;
    kind: 'directory' | 'file' | 'symlink';
  }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (excludeGit && directory === root && name === '.git') continue;
      const absolute = join(directory, name);
      const path = relative(root, absolute).split('\\').join('/');
      const stats = lstatSync(absolute);
      const kind = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file';
      entries.push({ absolute, relative: path, kind });
      if (kind === 'directory') visit(absolute);
    }
  };
  visit(root);
  return entries;
}

function changedPaths(
  initial: Map<string, FixtureFileArtifactV1>,
  current: Map<string, FixtureFileArtifactV1>,
): string[] {
  const paths = new Set([...initial.keys(), ...current.keys()]);
  return [...paths]
    .filter((path) => {
      const before = initial.get(path);
      const after = current.get(path);
      return !before || !after || before.kind !== after.kind || before.sha256 !== after.sha256;
    })
    .sort();
}

function semanticPatch(
  initial: Map<string, FixtureFileArtifactV1>,
  current: Map<string, FixtureFileArtifactV1>,
  changed: string[],
): string {
  return changed
    .map((path) => {
      const before = initial.get(path);
      const after = current.get(path);
      return [
        `--- ${before ? `a/${path}` : '/dev/null'}`,
        `+++ ${after ? `b/${path}` : '/dev/null'}`,
        '@@ synthetic-evaluator-v1 @@',
        ...(before?.text?.split('\n').map((line) => `-${line}`) ?? []),
        ...(after?.text?.split('\n').map((line) => `+${line}`) ?? []),
      ].join('\n');
    })
    .join('\n');
}

function digestFiles(files: Map<string, FixtureFileArtifactV1>): `sha256:${string}` {
  return sha256Digest(
    canonicalJsonBytes(
      [...files.values()]
        .map(({ path, kind, byteLength, sha256 }) => ({ path, kind, byteLength, sha256 }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function assertLeaseIdentity(run: FixtureRunV1): void {
  const ownerPath = join(run.root, OWNER_FILE);
  let owner: unknown;
  try {
    const ownerStats = lstatSync(ownerPath);
    if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) throw new Error('not a regular file');
    owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as unknown;
  } catch {
    throw new FixtureRunnerError(
      'cleanup_identity_mismatch',
      'Fixture owner record is unreadable.',
    );
  }
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new FixtureRunnerError('cleanup_identity_mismatch', 'Fixture owner record is invalid.');
  }
  const record = owner as Record<string, unknown>;
  const ownerKeys = Object.keys(record).sort();
  if (
    ownerKeys.join(',') !== 'ownershipNonce,root,runId,version,workspace' ||
    record.version !== 1 ||
    record.runId !== run.runId ||
    record.ownershipNonce !== run.ownershipNonce ||
    record.root !== run.root ||
    record.workspace !== run.workspace
  ) {
    throw new FixtureRunnerError(
      'cleanup_identity_mismatch',
      'Fixture ownership identity mismatch.',
    );
  }
  const workspaceStats = lstatSync(run.workspace);
  if (
    workspaceStats.isSymbolicLink() ||
    !workspaceStats.isDirectory() ||
    dirname(realpathSync(run.workspace)) !== realpathSync(run.root)
  ) {
    throw new FixtureRunnerError(
      'cleanup_identity_mismatch',
      'Fixture repository identity drifted.',
    );
  }
  try {
    if (
      git(run.workspace, join(run.root, 'home'), ['config', '--get', 'kite.evalRunId']).trim() !==
      run.runId
    ) {
      throw new Error('run identity mismatch');
    }
  } catch {
    throw new FixtureRunnerError(
      'cleanup_identity_mismatch',
      'Fixture Git repository identity drifted.',
    );
  }
}

function assertSafeCleanupTarget(run: FixtureRunV1): void {
  const resolvedParent = realpathSync(run.tempParent);
  const resolvedRoot = realpathSync(run.root);
  const rootStats = lstatSync(run.root);
  const relativeTarget = relative(resolvedParent, resolvedRoot);
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    !relativeTarget ||
    relativeTarget.startsWith('..') ||
    relativeTarget.includes(`/../`) ||
    dirname(resolvedRoot) !== resolvedParent ||
    !basename(resolvedRoot).startsWith(RUN_PREFIX)
  ) {
    throw new FixtureRunnerError(
      'unsafe_cleanup_target',
      'Refusing unsafe fixture cleanup target.',
    );
  }
}
