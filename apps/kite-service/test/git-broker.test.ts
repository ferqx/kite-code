import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGitBroker,
  type GitProcessAdapter,
  type GitProcessRequest,
  qualifyBrokeredGitNativeDeny,
  resolveRegisteredGitMetadataReadOnlyRoots,
} from '@kite-ai/builtin-runtime/git';
import { createProtectedPathEvaluator } from '@kite-ai/builtin-runtime/sandbox';
import { BROKERED_GIT_FEATURE_REVISION_ } from '@kite-ai/runtime-spi';
import type { AgentConfig } from '#kite-service/config/index';
import { composeAppGitBroker } from '#kite-service/git/composition';
import { createAppGitProcessAdapter } from '#kite-service/git/process-adapter';

function fixture(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-git-broker-'));
  mkdirSync(join(workspace, '.git', 'info'), { recursive: true });
  mkdirSync(join(workspace, '.git', 'refs'), { recursive: true });
  writeFileSync(join(workspace, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(workspace, 'safe.txt'), 'safe\n');
  return workspace;
}

function platform(): 'darwin' | 'linux' | 'win32' {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform;
  return 'linux';
}

function qualifiedEvidence() {
  return {
    featureRevision: BROKERED_GIT_FEATURE_REVISION_,
    platform: platform(),
    backend:
      platform() === 'darwin'
        ? ('seatbelt' as const)
        : platform() === 'win32'
          ? ('windows_restricted_token' as const)
          : ('bubblewrap' as const),
    outcome: 'qualified' as const,
    metadataReadDeny: true,
    metadataWriteDeny: true,
    profileRevision: 'profile-r1',
    profileDigest: 'sha256:profile',
    protectedRulesDigest: 'sha256:rules',
  };
}

function protectedEvaluator(workspace: string) {
  return createProtectedPathEvaluator({ workspaceRoot: workspace, mode: 'deny' });
}

function git(workspace: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Kite Test',
      GIT_AUTHOR_EMAIL: 'kite@example.invalid',
      GIT_COMMITTER_NAME: 'Kite Test',
      GIT_COMMITTER_EMAIL: 'kite@example.invalid',
      PATH: '/usr/bin:/bin',
    },
  });
}

function realRepository(fileCount = 1): string {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-real-git-broker-'));
  git(workspace, 'init', '--quiet');
  for (let index = 0; index < fileCount; index++) {
    writeFileSync(join(workspace, `file-${String(index).padStart(3, '0')}.txt`), `v1-${index}\n`);
  }
  writeFileSync(join(workspace, '.env'), 'protected-secret\n');
  git(workspace, 'add', '--', '.');
  git(workspace, 'commit', '--quiet', '-m', 'initial');
  return workspace;
}

describe('ACORE-GIT hardened broker', () => {
  test('App composition atomically requires flag, surface revision and qualified native evidence', () => {
    const workspace = realRepository();
    const surface = {
      inProcessReadOnlyTools: null,
      network: false,
      process: true,
      write: true,
      workspaceWrite: true,
      shell: true,
      skillChild: false,
      localStdioMcp: false,
      gitInspect: true,
      brokeredGitFeatureRevision: BROKERED_GIT_FEATURE_REVISION_,
    } as const;
    try {
      expect(
        composeAppGitBroker({
          workspace,
          executable: process.execPath,
          config: {
            features: { brokeredGit: false },
            executionCapabilitySurface: surface,
            executionBoundary: { workspaceRoot: workspace, protectedPathPolicy: 'deny' },
          } as AgentConfig,
          shellDenyEvidence: qualifiedEvidence(),
        }),
      ).toBeUndefined();
      expect(
        composeAppGitBroker({
          workspace,
          executable: process.execPath,
          config: {
            features: { brokeredGit: true },
            executionCapabilitySurface: surface,
            executionBoundary: { workspaceRoot: workspace, protectedPathPolicy: 'deny' },
          } as AgentConfig,
          shellDenyEvidence: qualifiedEvidence(),
        })?.featureRevision,
      ).toBe(BROKERED_GIT_FEATURE_REVISION_);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  test('three-platform qualification excludes every platform without proven metadata read and write deny', () => {
    for (const [platformName, backend] of [
      ['darwin', 'seatbelt'],
      ['linux', 'bubblewrap'],
      ['win32', 'windows_restricted_token'],
    ] as const) {
      expect(
        qualifyBrokeredGitNativeDeny({
          ...qualifiedEvidence(),
          platform: platformName,
          backend,
          metadataReadDeny: false,
        }),
      ).toEqual({ outcome: 'excluded', reason: 'metadata_read_deny_unproven' });
      expect(
        qualifyBrokeredGitNativeDeny({
          ...qualifiedEvidence(),
          platform: platformName,
          backend,
          metadataWriteDeny: false,
        }),
      ).toEqual({ outcome: 'excluded', reason: 'metadata_write_deny_unproven' });
    }
  });
  test('runs a fixed bounded inspect argv under a clean environment and emits bound receipt', async () => {
    const workspace = fixture();
    const requests: GitProcessRequest[] = [];
    const adapter: GitProcessAdapter = {
      run: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: ' M safe.txt\n', stderr: '' };
      },
    };
    try {
      const result = await createGitBroker({
        workspace,
        executable: process.execPath,
        processAdapter: adapter,
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      }).inspect({ operation: 'status', paths: ['safe.txt'] });
      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.args).toEqual([
        expect.stringContaining('--git-dir='),
        expect.stringContaining('--work-tree='),
        '--literal-pathspecs',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        'safe.txt',
      ]);
      expect(requests[0]?.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      });
      expect(requests[0]?.env).not.toHaveProperty('PATH');
      expect(result.receipt).toMatchObject({
        featureRevision: BROKERED_GIT_FEATURE_REVISION_,
        operation: 'status',
        effect: 'git_inspect',
        exitCode: 0,
      });
      expect(result.receipt?.repositoryBinding).toMatch(/^sha256:/);
      expect(result.receipt?.executableIdentity).toMatch(/^sha256:/);
      expect(result.receipt?.nativeDenyEvidenceIdentity).toMatch(/^sha256:/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('hostile config, attributes, protected paths and missing native deny fail before process dispatch', async () => {
    const workspace = fixture();
    let calls = 0;
    const adapter: GitProcessAdapter = {
      run: async () => {
        calls++;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    try {
      const noEvidence = createGitBroker({
        workspace,
        executable: process.execPath,
        processAdapter: adapter,
        protectedPathEvaluator: protectedEvaluator(workspace),
      });
      expect(
        (await noEvidence.inspect({ operation: 'status', paths: ['safe.txt'] })).failureCode,
      ).toBe('sandbox_capability_missing');
      const broker = createGitBroker({
        workspace,
        executable: process.execPath,
        processAdapter: adapter,
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      expect(
        (await broker.inspect({ operation: 'diff', paths: ['.git/config'] })).failureCode,
      ).toBe('protected_path_denied');
      writeFileSync(join(workspace, '.git', 'config'), '[include]\npath=/tmp/hostile\n');
      expect((await broker.inspect({ operation: 'status', paths: ['safe.txt'] })).failureCode).toBe(
        'repository_hostile',
      );
      expect(calls).toBe(0);

      writeFileSync(
        join(workspace, '.git', 'config'),
        '[core]\n\trepositoryformatversion = 0\n\thooksPath = /tmp/hooks\n',
      );
      expect((await broker.inspect({ operation: 'status', paths: ['safe.txt'] })).failureCode).toBe(
        'repository_hostile',
      );
      expect(calls).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('rejects Git pathspec magic, globs and casefold syntax before real diff dispatch', async () => {
    const workspace = realRepository();
    writeFileSync(join(workspace, '.env'), 'changed-protected\n');
    const marker = join(workspace, 'adapter-called');
    const adapter: GitProcessAdapter = {
      run: async () => {
        writeFileSync(marker, 'called');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    try {
      const broker = createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: adapter,
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      for (const path of [':(glob)*', ':(icase).ENV', '*.txt', '[.]env', 'file-???.txt']) {
        expect((await broker.inspect({ operation: 'diff', paths: [path] })).failureCode).toBe(
          'protected_path_denied',
        );
      }
      expect(existsSync(marker)).toBe(false);
      expect(git(workspace, 'diff', '--', '.env')).toContain('changed-protected');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('rejects external gitfiles and symlinked metadata before reading a private repository', async () => {
    const privateRepo = realRepository();
    const workspace = mkdtempSync(join(tmpdir(), 'kite-external-gitfile-'));
    writeFileSync(join(privateRepo, 'private.txt'), 'must-not-read\n');
    writeFileSync(join(workspace, '.git'), `gitdir: ${join(privateRepo, '.git')}\n`);
    writeFileSync(join(workspace, 'safe.txt'), 'safe\n');
    let calls = 0;
    const adapter: GitProcessAdapter = {
      run: async () => {
        calls += 1;
        return { exitCode: 0, stdout: 'must-not-read', stderr: '' };
      },
    };
    try {
      const result = await createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: adapter,
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      }).inspect({ operation: 'status' });
      expect(result).toMatchObject({ ok: false, failureCode: 'repository_invalid' });
      expect(result.output).not.toContain('private');
      expect(calls).toBe(0);

      rmSync(join(workspace, '.git'));
      mkdirSync(join(workspace, '.git'), { recursive: true });
      symlinkSync(join(privateRepo, '.git', 'config'), join(workspace, '.git', 'config'));
      const symlinked = await createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: adapter,
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      }).inspect({ operation: 'status' });
      expect(symlinked.failureCode).toBe('repository_invalid');
      expect(calls).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(privateRepo, { recursive: true, force: true });
    }
  });

  test('accepts only an explicitly authorized linked worktree with reciprocal metadata backlink', async () => {
    const primary = realRepository();
    const linked = mkdtempSync(join(tmpdir(), 'kite-linked-worktree-'));
    rmSync(linked, { recursive: true, force: true });
    try {
      git(primary, 'worktree', 'add', '--quiet', '-b', 'linked-test', linked);
      expect(resolveRegisteredGitMetadataReadOnlyRoots(linked)).toEqual([
        realpathSync.native(join(primary, '.git')),
      ]);
      const broker = createGitBroker({
        workspace: linked,
        authorizedRepositoryRoot: primary,
        executable: '/usr/bin/git',
        processAdapter: createAppGitProcessAdapter(),
        protectedPathEvaluator: protectedEvaluator(linked),
        shellDenyEvidence: qualifiedEvidence(),
      });
      expect(await broker.inspect({ operation: 'status', paths: ['file-000.txt'] })).toMatchObject({
        ok: true,
      });
    } finally {
      try {
        git(primary, 'worktree', 'remove', '--force', linked);
      } catch {
        // The final recursive fixture cleanup remains bounded to the two temp roots.
      }
      rmSync(linked, { recursive: true, force: true });
      rmSync(primary, { recursive: true, force: true });
    }
  });

  test('real status includes deleted and renamed files beyond 128 entries while branch_list does not inventory the workspace', async () => {
    const workspace = realRepository(160);
    try {
      rmSync(join(workspace, 'file-000.txt'));
      execFileSync('/bin/mv', ['file-001.txt', 'renamed-001.txt'], { cwd: workspace });
      git(workspace, 'branch', 'bounded-branch');
      const broker = createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: createAppGitProcessAdapter(),
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      const status = await broker.inspect({ operation: 'status', maxRecords: 200 });
      expect(status.ok).toBe(true);
      expect(status.output).toContain('file-000.txt');
      expect(status.output).toContain('renamed-001.txt');
      const branches = await broker.inspect({ operation: 'branch_list', maxRecords: 10 });
      expect(branches.ok).toBe(true);
      expect(branches.output).toContain('bounded-branch');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('real diff/log/branch use fixed repository binding and UTF-8 truncation never exceeds max bytes', async () => {
    const workspace = realRepository();
    try {
      writeFileSync(join(workspace, 'file-000.txt'), 'v2\n');
      const broker = createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: createAppGitProcessAdapter(),
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      expect(
        (await broker.inspect({ operation: 'diff', paths: ['file-000.txt'] })).output,
      ).toContain('+v2');
      expect((await broker.inspect({ operation: 'log', paths: ['file-000.txt'] })).output).toMatch(
        /[a-f0-9]{40}/,
      );

      const unicodeBroker = createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: { run: async () => ({ exitCode: 0, stdout: '🙂'.repeat(40), stderr: '' }) },
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      const truncated = await unicodeBroker.inspect({
        operation: 'diff',
        paths: ['file-000.txt'],
        maxOutputBytes: 19,
      });
      expect(Buffer.byteLength(truncated.output)).toBeLessThanOrEqual(19);
      expect(truncated.output).not.toContain('�');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('adapter exceptions are stable and never expose private diagnostic bodies', async () => {
    const workspace = realRepository();
    try {
      const result = await createGitBroker({
        workspace,
        executable: process.execPath,
        processAdapter: {
          run: async () => {
            throw new Error('private /path stdout body');
          },
        },
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      }).inspect({ operation: 'status', paths: ['safe.txt'] });
      expect(result.failureCode).toBe('process_failed');
      expect(result.output).not.toContain('private');
      expect(result.output).not.toContain('/path');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('real process adapter terminates descendants on timeout before they can write a marker', async () => {
    if (process.platform === 'win32') return;
    const workspace = mkdtempSync(join(tmpdir(), 'kite-git-adapter-cancel-'));
    const marker = join(workspace, 'late-marker');
    try {
      const result = await createAppGitProcessAdapter().run({
        executable: '/bin/sh',
        args: ['-c', `(sleep 0.15; printf late > "${marker}") & wait`],
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 20,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      });
      await Bun.sleep(220);
      expect(result.timedOut).toBe(true);
      expect(result.cleanupConfirmed).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('cross-boundary config and protected diff provenance fail closed before requested dispatch', async () => {
    const workspace = realRepository();
    try {
      writeFileSync(
        join(workspace, '.git', 'config'),
        '[core]\n\trepositoryformatversion = 0\n\texcludesFile = /tmp/private-ignore\n',
      );
      let calls = 0;
      const hostile = createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: {
          run: async () => {
            calls += 1;
            return { exitCode: 0, stdout: 'private', stderr: '' };
          },
        },
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      expect(await hostile.inspect({ operation: 'status', paths: ['file-000.txt'] })).toMatchObject(
        {
          ok: false,
          failureCode: 'repository_hostile',
        },
      );
      expect(calls).toBe(0);

      writeFileSync(join(workspace, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
      git(workspace, 'mv', '--', '.env', 'safe-renamed.txt');
      git(workspace, 'commit', '--quiet', '-m', 'rename protected');
      writeFileSync(join(workspace, 'safe-renamed.txt'), 'changed public-looking content\n');
      const broker = createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: createAppGitProcessAdapter(),
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      const denied = await broker.inspect({ operation: 'diff', paths: ['safe-renamed.txt'] });
      expect(denied).toMatchObject({ ok: false, failureCode: 'protected_path_denied' });
      expect(denied.output).not.toContain('.env');
      expect(denied.output).not.toContain('protected-secret');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('pre-aborted request performs zero process dispatch and adapter enforces UTF-8 byte ceilings', async () => {
    const workspace = realRepository();
    try {
      let calls = 0;
      const broker = createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: {
          run: async () => {
            calls += 1;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        },
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      const controller = new AbortController();
      controller.abort();
      expect(
        await broker.inspect({ operation: 'status', paths: ['file-000.txt'] }, controller.signal),
      ).toMatchObject({ failureCode: 'cancelled' });
      expect(calls).toBe(0);

      let spawns = 0;
      const appPreAborted = await createAppGitProcessAdapter({
        spawn: (() => {
          spawns += 1;
          throw new Error('spawn must not run');
        }) as unknown as typeof Bun.spawn,
      }).run({
        executable: '/usr/bin/git',
        args: ['status'],
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 1_000,
        maxStdoutBytes: 128,
        maxStderrBytes: 128,
        signal: controller.signal,
      });
      expect(appPreAborted).toMatchObject({ cancelled: true, cleanupConfirmed: true });
      expect(spawns).toBe(0);

      const bounded = await createAppGitProcessAdapter().run({
        executable: '/bin/sh',
        args: ['-c', "printf '\\342\\202\\254%.0s' $(seq 1 200)"],
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 2_000,
        maxStdoutBytes: 31,
        maxStderrBytes: 31,
      });
      expect(bounded.adapterErrorCode).toBe('output_limit_exceeded');
      expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(31);
      expect(() =>
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bounded.stdout)),
      ).not.toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('metadata attribute/graft/replace paths reject external symlinks and packed replace refs', async () => {
    for (const target of [
      '.gitattributes',
      '.git/info/attributes',
      '.git/info/grafts',
      '.git/refs/replace',
      '.git/packed-refs',
    ]) {
      const workspace = realRepository();
      const outside = mkdtempSync(join(tmpdir(), 'kite-git-private-metadata-'));
      let calls = 0;
      try {
        const targetPath = join(workspace, ...target.split('/'));
        rmSync(targetPath, { recursive: true, force: true });
        const external = target.endsWith('/replace')
          ? join(outside, 'replace')
          : join(outside, 'file');
        if (target.endsWith('/replace')) mkdirSync(external);
        else writeFileSync(external, target.includes('packed-refs') ? '' : '');
        symlinkSync(external, targetPath, target.endsWith('/replace') ? 'dir' : 'file');
        const broker = createGitBroker({
          workspace,
          executable: '/usr/bin/git',
          processAdapter: {
            run: async () => {
              calls += 1;
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          },
          protectedPathEvaluator: protectedEvaluator(workspace),
          shellDenyEvidence: qualifiedEvidence(),
        });
        expect(
          await broker.inspect({ operation: 'status', paths: ['file-000.txt'] }),
        ).toMatchObject({
          ok: false,
        });
        expect(calls).toBe(0);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }

    const workspace = realRepository();
    let calls = 0;
    try {
      writeFileSync(
        join(workspace, '.git', 'packed-refs'),
        `${'a'.repeat(40)} refs/replace/${'b'.repeat(40)}\n`,
      );
      const broker = createGitBroker({
        workspace,
        executable: '/usr/bin/git',
        processAdapter: {
          run: async () => {
            calls += 1;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        },
        protectedPathEvaluator: protectedEvaluator(workspace),
        shellDenyEvidence: qualifiedEvidence(),
      });
      expect(await broker.inspect({ operation: 'status', paths: ['file-000.txt'] })).toMatchObject({
        ok: false,
        failureCode: 'repository_hostile',
      });
      expect(calls).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
