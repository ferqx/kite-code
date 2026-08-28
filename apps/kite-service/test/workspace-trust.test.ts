import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getTrustedWorkspaceExternalReadRoots,
  getWorkspaceTrustSnapshot,
  getWorkspaceTrustStatus,
  readWorkspaceTrustStore,
  shouldPromptWorkspaceTrust,
  trustWorkspace,
} from '#kite-service/config/workspace-trust';

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'kite-trust-test-')), 'workspace-trust.jsonc');
}

const workspace = mkdtempSync(join(tmpdir(), 'kite-trust-ws-'));

function git(workspace: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: workspace,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Kite Test',
      GIT_AUTHOR_EMAIL: 'kite@example.invalid',
      GIT_COMMITTER_NAME: 'Kite Test',
      GIT_COMMITTER_EMAIL: 'kite@example.invalid',
    },
  });
}

describe('workspace trust store', () => {
  test('unknown workspace has no trust record', () => {
    const storePath = tempStorePath();
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('unknown');
  });

  test('trustWorkspace persists a record and marks the workspace trusted', () => {
    const storePath = tempStorePath();
    const result = trustWorkspace({ workspace, storePath });
    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') return;
    expect(result.record.source).toBe('user');
    expect(result.record.workspacePath).toBe(workspace);
    expect(result.record.trustedAt).toBeTruthy();

    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('trusted');

    // The persisted file round-trips through the reader.
    const store = readWorkspaceTrustStore(storePath);
    expect(store.status).toBe('ready');
    if (store.status !== 'ready') return;
    const records = Object.values(store.records);
    expect(records.length).toBe(1);
    expect(records[0]?.workspaceKey).toBe(result.record.workspaceKey);
  });

  test('re-trusting the same workspace updates a single record', () => {
    const storePath = tempStorePath();
    trustWorkspace({ workspace, storePath });
    trustWorkspace({ workspace, source: 'test', storePath });
    const store = readWorkspaceTrustStore(storePath);
    expect(store.status).toBe('ready');
    if (store.status !== 'ready') return;
    const records = Object.values(store.records);
    expect(records.length).toBe(1);
    expect(records[0]?.source).toBe('test');
  });

  test('equivalent paths resolve to the same workspace key', () => {
    const storePath = tempStorePath();
    trustWorkspace({ workspace, storePath });
    // A path with a trailing self-reference canonicalizes to the same identity.
    expect(getWorkspaceTrustStatus(join(workspace, '.'), storePath)).toBe('trusted');
  });

  test('different workspaces stay independent', () => {
    const storePath = tempStorePath();
    const other = mkdtempSync(join(tmpdir(), 'kite-trust-ws2-'));
    trustWorkspace({ workspace, storePath });
    expect(getWorkspaceTrustStatus(other, storePath)).toBe('unknown');
  });

  test.skipIf(process.platform === 'win32')(
    'external repository metadata requires an exact Workspace Trust decision and identity drift prompts again',
    () => {
      const storePath = tempStorePath();
      const primary = mkdtempSync(join(tmpdir(), 'kite-trust-primary-'));
      const linked = mkdtempSync(join(tmpdir(), 'kite-trust-linked-'));
      rmSync(linked, { recursive: true, force: true });
      try {
        git(primary, 'init', '--quiet');
        writeFileSync(join(primary, 'README.md'), 'fixture\n');
        git(primary, 'add', 'README.md');
        git(primary, 'commit', '--quiet', '-m', 'initial');
        git(primary, 'worktree', 'add', '--quiet', '-b', 'trust-linked', linked);

        const commonDir = realpathSync.native(join(primary, '.git'));
        const observed = getWorkspaceTrustSnapshot(linked, storePath);
        expect(observed).toMatchObject({
          status: 'unknown',
          externalReadScope: { roots: [commonDir] },
        });
        expect(getTrustedWorkspaceExternalReadRoots(linked, storePath)).toEqual([]);

        expect(
          trustWorkspace({
            workspace: linked,
            storePath,
            expectedRevision: observed!.revision,
          }).status,
        ).toBe('recorded');
        expect(getWorkspaceTrustStatus(linked, storePath)).toBe('trusted');
        expect(getTrustedWorkspaceExternalReadRoots(linked, storePath)).toEqual([commonDir]);

        writeFileSync(join(linked, '.git'), 'gitdir: /nonexistent/kite-worktree\n');
        expect(getWorkspaceTrustStatus(linked, storePath)).toBe('unknown');
        expect(getTrustedWorkspaceExternalReadRoots(linked, storePath)).toEqual([]);
      } finally {
        rmSync(linked, { recursive: true, force: true });
        rmSync(primary, { recursive: true, force: true });
      }
    },
  );

  test('an unregistered external repository is surfaced for confirmation instead of rejected', () => {
    const storePath = tempStorePath();
    const opened = mkdtempSync(join(tmpdir(), 'kite-trust-external-workspace-'));
    const externalGitDir = mkdtempSync(join(tmpdir(), 'kite-trust-external-gitdir-'));
    try {
      git(externalGitDir, 'init', '--bare', '--quiet');
      expect(trustWorkspace({ workspace: opened, storePath }).status).toBe('recorded');
      expect(getWorkspaceTrustStatus(opened, storePath)).toBe('trusted');

      writeFileSync(join(opened, '.git'), `gitdir: ${externalGitDir}\n`);
      const observed = getWorkspaceTrustSnapshot(opened, storePath);
      expect(observed).toMatchObject({
        status: 'unknown',
        externalReadScope: { roots: [realpathSync.native(externalGitDir)] },
      });
      expect(getTrustedWorkspaceExternalReadRoots(opened, storePath)).toEqual([]);

      expect(
        trustWorkspace({
          workspace: opened,
          storePath,
          expectedRevision: observed!.revision,
        }).status,
      ).toBe('recorded');
      expect(getTrustedWorkspaceExternalReadRoots(opened, storePath)).toEqual([
        realpathSync.native(externalGitDir),
      ]);
    } finally {
      rmSync(opened, { recursive: true, force: true });
      rmSync(externalGitDir, { recursive: true, force: true });
    }
  });

  test('records a decision only against the observed trust revision', () => {
    const storePath = tempStorePath();
    const other = mkdtempSync(join(tmpdir(), 'kite-trust-cas-'));
    const observed = getWorkspaceTrustSnapshot(workspace, storePath);
    expect(observed?.status).toBe('unknown');

    expect(trustWorkspace({ workspace: other, storePath }).status).toBe('recorded');
    expect(
      trustWorkspace({
        workspace,
        storePath,
        expectedRevision: observed!.revision,
      }),
    ).toMatchObject({ status: 'conflict' });
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('unknown');

    const refreshed = getWorkspaceTrustSnapshot(workspace, storePath);
    expect(refreshed?.revision).not.toBe(observed?.revision);
    expect(
      trustWorkspace({
        workspace,
        storePath,
        expectedRevision: refreshed!.revision,
      }).status,
    ).toBe('recorded');
  });

  test('malformed store is reported corrupt and refuses writes', () => {
    const storePath = tempStorePath();
    writeFileSync(storePath, '{ not json', 'utf8');
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('corrupt');
    const result = trustWorkspace({ workspace, storePath });
    expect(result.status).toBe('store_corrupt');
  });

  test('version mismatch is corrupt', () => {
    const storePath = tempStorePath();
    writeFileSync(storePath, JSON.stringify({ version: 2, records: {} }), 'utf8');
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('corrupt');
  });

  test('records as an array is corrupt', () => {
    const storePath = tempStorePath();
    writeFileSync(storePath, JSON.stringify({ version: 1, records: [] }), 'utf8');
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('corrupt');
  });

  test('record stored under a mismatched key is corrupt', () => {
    const storePath = tempStorePath();
    const good = trustWorkspace({ workspace, storePath });
    expect(good.status).toBe('recorded');
    if (good.status !== 'recorded') return;
    const tampered = {
      version: 1,
      records: { 'wrong-key': good.record },
    };
    writeFileSync(storePath, JSON.stringify(tampered, null, 2), 'utf8');
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('corrupt');
  });

  test('unreadable store path is unavailable and refuses writes', () => {
    // Point the store at a directory: existsSync passes, readFileSync throws.
    const dir = mkdtempSync(join(tmpdir(), 'kite-trust-dir-'));
    const storePath = join(dir, 'blocked');
    mkdirSync(storePath, { recursive: true });
    expect(getWorkspaceTrustStatus(workspace, storePath)).toBe('unavailable');
    const result = trustWorkspace({ workspace, storePath });
    expect(result.status).toBe('store_unavailable');
  });
});

describe('shouldPromptWorkspaceTrust', () => {
  test('unknown and corrupt states prompt (fail closed)', () => {
    const storePath = tempStorePath();
    expect(shouldPromptWorkspaceTrust(workspace, storePath)).toBe(true);
    writeFileSync(storePath, '{ broken', 'utf8');
    expect(shouldPromptWorkspaceTrust(workspace, storePath)).toBe(true);
  });

  test('trusted workspaces do not prompt', () => {
    const storePath = tempStorePath();
    trustWorkspace({ workspace, storePath });
    expect(shouldPromptWorkspaceTrust(workspace, storePath)).toBe(false);
  });
});
