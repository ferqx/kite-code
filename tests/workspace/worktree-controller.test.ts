import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChangeHandoffV1 } from '@/app/workspace/change-handoff';
import {
  resolveWriterWorkspaceAdmissionV1,
  WorktreeControllerErrorV1,
  WorktreeControllerV1,
} from '@/app/workspace/worktree-controller';

const roots: string[] = [];

function git(cwd: string, args: readonly string[], accepted = [0]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!accepted.includes(result.exitCode)) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function fixture(): {
  root: string;
  repo: string;
  state: string;
  baselineCommit: string;
  controller: WorktreeControllerV1;
} {
  const root = mkdtempSync(join(tmpdir(), 'openpx-worktree-controller-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(repo);
  mkdirSync(state, { mode: 0o700 });
  git(repo, ['init', '--initial-branch=main']);
  writeFileSync(join(repo, 'tracked.txt'), 'baseline\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'baseline',
  ]);
  const baselineCommit = git(repo, ['rev-parse', 'HEAD']);
  const controller = new WorktreeControllerV1({ stateRoot: state });
  return { root, repo, state, baselineCommit, controller };
}

function acquire(
  item: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<WorktreeControllerV1['acquire']>[0]> = {},
) {
  return item.controller.acquire({
    baselineRepoRoot: item.repo,
    baselineCommit: item.baselineCommit,
    taskIdentity: 'task-1b.6',
    runIdentity: 'run-001',
    writerIdentity: 'writer-001',
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('writer workspace admission', () => {
  test('keeps shared checkout read-only except an explicitly selected foreground TUI writer', () => {
    expect(
      resolveWriterWorkspaceAdmissionV1({
        featureEnabled: false,
        mode: 'delegated',
        access: 'read_only',
      }),
    ).toEqual({ allowed: true, workspace: 'shared_read_only' });
    expect(
      resolveWriterWorkspaceAdmissionV1({
        featureEnabled: false,
        mode: 'foreground_tui',
        access: 'write',
        currentCheckoutSelected: true,
      }),
    ).toEqual({ allowed: true, workspace: 'shared_foreground_writer' });
    expect(
      resolveWriterWorkspaceAdmissionV1({
        featureEnabled: true,
        mode: 'foreground_headless_cli',
        access: 'write',
      }),
    ).toEqual({
      allowed: false,
      workspace: 'none',
      reason: 'foreground_headless_write_excluded',
    });
    expect(
      resolveWriterWorkspaceAdmissionV1({
        featureEnabled: false,
        mode: 'foreground_headless_cli',
        access: 'write',
      }),
    ).toEqual({
      allowed: false,
      workspace: 'none',
      reason: 'foreground_headless_write_excluded',
    });
  });

  test('requires an enabled controller for every background/concurrent/delegated writer', () => {
    for (const mode of [
      'background',
      'scheduled',
      'unattended',
      'concurrent',
      'delegated',
    ] as const) {
      expect(
        resolveWriterWorkspaceAdmissionV1({ featureEnabled: true, mode, access: 'write' }),
      ).toEqual({ allowed: true, workspace: 'worktree' });
      expect(
        resolveWriterWorkspaceAdmissionV1({ featureEnabled: false, mode, access: 'write' }),
      ).toEqual({
        allowed: false,
        workspace: 'none',
        reason: 'worktree_controller_disabled',
      });
    }
  });
});

describe('App-owned worktree controller', () => {
  test('routes a delegated writer through an isolated review handoff', () => {
    const item = fixture();
    expect(
      resolveWriterWorkspaceAdmissionV1({
        featureEnabled: true,
        mode: 'delegated',
        access: 'write',
      }),
    ).toEqual({ allowed: true, workspace: 'worktree' });
    const lease = acquire(item, { runIdentity: 'run-headless' });
    expect(lease.workspaceRoot).not.toBe(item.repo);
    writeFileSync(join(lease.workspaceRoot, 'tracked.txt'), 'headless change\n');
    const handoff = createChangeHandoffV1({ controller: item.controller, lease });
    expect(handoff.runIdentity).toBe('run-headless');
    expect(handoff.writerIdentity).toBe('writer-001');
    expect(handoff.changedFiles).toEqual([{ path: 'tracked.txt', tracked: true }]);
    expect(handoff.diff).toContain('+headless change');
    expect(git(item.repo, ['status', '--porcelain'])).toBe('');
  });

  test('creates an identity-bound worktree and produces a complete review handoff', () => {
    const item = fixture();
    const lease = acquire(item);

    expect(lease.worktreeIdentity).toMatch(/^wt_[0-9a-f]{32}$/);
    expect(lease.runtimeBinding).toEqual({
      version: 1,
      kind: 'controller_worktree',
      worktreeIdentity: lease.worktreeIdentity,
    });
    expect(git(item.repo, ['status', '--porcelain'])).toBe('');
    expect(git(lease.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(item.baselineCommit);
    expect(git(lease.workspaceRoot, ['branch', '--show-current'])).toStartWith('codex/writer/');

    writeFileSync(join(lease.workspaceRoot, 'tracked.txt'), 'changed\n');
    writeFileSync(join(lease.workspaceRoot, 'new.txt'), 'new\n');
    const handoff = createChangeHandoffV1({ controller: item.controller, lease });
    expect(handoff.worktreeIdentity).toBe(lease.worktreeIdentity);
    expect(handoff.baselineCommit).toBe(item.baselineCommit);
    expect(handoff.hasUncommittedChanges).toBe(true);
    expect(handoff.changedFiles).toEqual([
      { path: 'new.txt', tracked: false },
      { path: 'tracked.txt', tracked: true },
    ]);
    expect(handoff.diff).toContain('-baseline');
    expect(handoff.diff).toContain('+changed');
    expect(handoff.status).toContain('tracked.txt');
    expect(handoff.status).toContain('new.txt');
  });

  test('supports crash recovery and clean cleanup while retaining the controller branch', () => {
    const item = fixture();
    const lease = acquire(item);
    writeFileSync(join(lease.workspaceRoot, 'tracked.txt'), 'committed handoff\n');
    git(lease.workspaceRoot, ['add', 'tracked.txt']);
    git(lease.workspaceRoot, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'writer change',
    ]);

    const recoveredController = new WorktreeControllerV1({ stateRoot: item.state });
    const recovered = recoveredController.recover(lease.worktreeIdentity);
    expect(() => item.controller.inspect(lease)).toThrow('does not match its ownership record');
    const branch = git(recovered.workspaceRoot, ['branch', '--show-current']);
    const handoff = createChangeHandoffV1({ controller: recoveredController, lease: recovered });
    expect(handoff.hasUncommittedChanges).toBe(false);
    expect(handoff.changedFiles).toEqual([{ path: 'tracked.txt', tracked: true }]);

    recoveredController.cleanup(recovered);
    expect(git(item.repo, ['show-ref', '--verify', `refs/heads/${branch}`])).not.toBe('');
    expect(() => recoveredController.recover(lease.worktreeIdentity)).toThrow(
      WorktreeControllerErrorV1,
    );
  });

  test('retains dirty worktrees and refuses branch or lease reuse', () => {
    const item = fixture();
    const lease = acquire(item);
    writeFileSync(join(lease.workspaceRoot, 'tracked.txt'), 'dirty\n');

    expect(() => item.controller.cleanup(lease)).toThrow('uncommitted changes and was retained');
    expect(readFileSync(join(lease.workspaceRoot, 'tracked.txt'), 'utf8')).toBe('dirty\n');
    expect(() => acquire(item)).toThrow('writer workspace lease already exists');

    git(lease.workspaceRoot, ['restore', 'tracked.txt']);
    const branch = git(lease.workspaceRoot, ['branch', '--show-current']);
    item.controller.cleanup(lease);
    expect(() => acquire(item)).toThrow(`Controller branch already exists: ${branch}`);
  });

  test('fails closed for dirty baselines without touching the shared checkout', () => {
    const item = fixture();
    writeFileSync(join(item.repo, 'tracked.txt'), 'user change\n');
    expect(() => acquire(item)).toThrow('Baseline checkout is dirty');
    expect(readFileSync(join(item.repo, 'tracked.txt'), 'utf8')).toBe('user change\n');
    expect(git(item.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(
      1,
    );
  });

  test('rejects subdirectory repos, symbolic state roots, unsafe names and mutable revisions', () => {
    const item = fixture();
    const subdirectory = join(item.repo, 'subdirectory');
    mkdirSync(subdirectory);
    expect(() => acquire(item, { baselineRepoRoot: subdirectory })).toThrow(
      'canonical repository root',
    );
    expect(() => acquire(item, { writerIdentity: '../writer' })).toThrow(
      'safe identity characters',
    );
    expect(() => acquire(item, { baselineCommit: 'HEAD' })).toThrow(
      'full lowercase commit identity',
    );
    if (process.platform !== 'win32') {
      const stateAlias = join(item.root, 'state-alias');
      symlinkSync(item.state, stateAlias, 'dir');
      expect(() => new WorktreeControllerV1({ stateRoot: stateAlias })).toThrow(
        'state root is unavailable or unsafe',
      );
    }
  });

  test('blocks conflict handoff and cleanup without altering the conflicted worktree', () => {
    const item = fixture();
    const lease = acquire(item, { runIdentity: 'run-conflict' });
    writeFileSync(join(lease.workspaceRoot, 'tracked.txt'), 'writer side\n');
    git(lease.workspaceRoot, ['add', 'tracked.txt']);
    git(lease.workspaceRoot, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'writer side',
    ]);
    writeFileSync(join(item.repo, 'tracked.txt'), 'baseline side\n');
    git(item.repo, ['add', 'tracked.txt']);
    git(item.repo, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'baseline side',
    ]);
    git(lease.workspaceRoot, ['merge', 'main'], [1]);

    expect(() => createChangeHandoffV1({ controller: item.controller, lease })).toThrow(
      'unresolved conflicts',
    );
    expect(() => item.controller.cleanup(lease)).toThrow('unresolved conflicts');
    expect(readFileSync(join(lease.workspaceRoot, 'tracked.txt'), 'utf8')).toContain('<<<<<<<');
  });

  test('detects branch identity drift and preserves the worktree for manual recovery', () => {
    const item = fixture();
    const lease = acquire(item);
    git(lease.workspaceRoot, ['switch', '-c', 'user/recovery-branch']);
    expect(() => item.controller.cleanup(lease)).toThrow(
      'Worktree repository or branch identity changed',
    );
    expect(git(lease.workspaceRoot, ['branch', '--show-current'])).toBe('user/recovery-branch');
  });

  test('fails closed on an abandoned controller operation lock and retains evidence', () => {
    const item = fixture();
    const lease = acquire(item, { runIdentity: 'run-operation-crash' });
    const operationPath = join(item.state, 'locks', `${lease.worktreeIdentity}.operation`);
    writeFileSync(operationPath, '{"simulated":"crash"}\n', { mode: 0o600 });

    expect(() => createChangeHandoffV1({ controller: item.controller, lease })).toThrow(
      'requires manual recovery',
    );
    expect(git(lease.workspaceRoot, ['rev-parse', 'HEAD'])).toBe(item.baselineCommit);
    rmSync(operationPath);
    expect(createChangeHandoffV1({ controller: item.controller, lease }).changedFiles).toEqual([]);
  });

  test('contains Git startup failures instead of falling back to the shared checkout', () => {
    const item = fixture();
    expect(
      () => new WorktreeControllerV1({ stateRoot: item.state, gitBinary: 'missing-openpx-git' }),
    ).not.toThrow();
    const failedController = new WorktreeControllerV1({
      stateRoot: item.state,
      gitBinary: 'missing-openpx-git',
    });
    expect(() =>
      failedController.acquire({
        baselineRepoRoot: item.repo,
        baselineCommit: item.baselineCommit,
        taskIdentity: 'task-1b.6',
        runIdentity: 'run-git-failure',
        writerIdentity: 'writer-001',
      }),
    ).toThrow(WorktreeControllerErrorV1);
    expect(git(item.repo, ['status', '--porcelain'])).toBe('');
  });

  test('preserves a provisioning record when worktree creation reports disk exhaustion', () => {
    if (process.platform === 'win32') return;
    const item = fixture();
    const wrapper = join(item.root, 'git-no-space');
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        'previous=""',
        'for argument in "$@"; do',
        '  if [ "$previous" = "worktree" ] && [ "$argument" = "add" ]; then',
        '    echo "fatal: no space left on device" >&2',
        '    exit 28',
        '  fi',
        '  previous="$argument"',
        'done',
        'exec git "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    chmodSync(wrapper, 0o700);
    const controller = new WorktreeControllerV1({ stateRoot: item.state, gitBinary: wrapper });

    expect(() =>
      controller.acquire({
        baselineRepoRoot: item.repo,
        baselineCommit: item.baselineCommit,
        taskIdentity: 'task-1b.6',
        runIdentity: 'run-no-space',
        writerIdentity: 'writer-001',
      }),
    ).toThrow('no space left on device');
    expect(readdirSync(join(item.state, 'records'))).toHaveLength(1);
    expect(readdirSync(join(item.state, 'locks'))).toHaveLength(1);
    expect(git(item.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(
      1,
    );
    expect(git(item.repo, ['status', '--porcelain'])).toBe('');
  });

  test('does not execute repository checkout hooks while provisioning', () => {
    if (process.platform === 'win32') return;
    const item = fixture();
    const sentinel = join(item.root, 'hook-ran');
    const hook = join(item.repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\nprintf ran > "${sentinel}"\n`, { mode: 0o700 });
    chmodSync(hook, 0o700);

    acquire(item, { runIdentity: 'run-hooks-disabled' });
    expect(existsSync(sentinel)).toBe(false);
  });
});
