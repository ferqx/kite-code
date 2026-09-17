import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  getTrustedWorkspaceExternalReadRoots,
  getWorkspaceTrustSnapshot,
  getWorkspaceTrustStatus,
  trustWorkspace,
} from '../../../apps/kite-service/src/config/workspace-trust';
import { resolveWorkspaceGitMetadataReadOnlyRoots } from '../../../packages/builtin-runtime/src/git/metadata-scope';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, submitUserMessage, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30_000;

describe('TUI PTY System - background sandbox startup', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace();
    workspace.env.CI = 'true';
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      entryPath: resolve(import.meta.dir, '..', 'fixtures', 'deferred-sandbox-tui.tsx'),
      mockServer: server,
      workspace,
    });
  });

  afterAll(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  test(
    'keeps the prompt editable while sandbox preparation is still pending',
    async () => {
      const text = 'sandbox is warming';
      await typeText(tui, text);
      await clearInput(tui, text.length);
    },
    TIMEOUT,
  );
});

test(
  'sandbox unavailability does not block an unrelated TUI model turn',
  async () => {
    const server = createMockModelServer();
    const workspace = createTestWorkspace();
    let tui: PtyProcess | undefined;
    try {
      server.setResponses([{ message: { content: 'model turn completed' } }]);
      tui = await spawnReadyTui({
        cols: 120,
        rows: 40,
        entryPath: resolve(import.meta.dir, '..', 'fixtures', 'unavailable-sandbox-tui.tsx'),
        mockServer: server,
        workspace,
      });
      await submitUserMessage(tui, server, 'answer without shell', { timeout: 15_000 });
      await waitForText(() => tui!.viewport(), 'model turn completed', 15_000);
      expect(server.getRequestCount()).toBe(1);
    } finally {
      await cleanupTuiSystemFixtures({
        tuis: [tui],
        mockServers: [server],
        workspaces: [workspace],
      });
    }
  },
  TIMEOUT,
);

test(
  'external Git metadata drift does not block a TUI model turn or authorize its read root',
  async () => {
    const server = createMockModelServer();
    const workspace = createTestWorkspace();
    const externalGit = mkdtempSync(join(tmpdir(), 'kite-tui-external-git-'));
    const trustStore = join(workspace.home, '.kite-code', 'workspace-trust.jsonc');
    let tui: PtyProcess | undefined;
    try {
      execFileSync('git', ['init', '--bare', '--quiet', externalGit]);
      expect(trustWorkspace({ workspace: workspace.workspace, storePath: trustStore }).status).toBe(
        'recorded',
      );
      const before = getWorkspaceTrustSnapshot(workspace.workspace, trustStore);
      expect(before?.status).toBe('trusted');
      // Simulate a workspace that acquires a linked Git directory after it was trusted.
      writeFileSync(join(workspace.workspace, '.git'), `gitdir: ${externalGit}\n`);
      expect(resolveWorkspaceGitMetadataReadOnlyRoots(workspace.workspace)).toEqual([
        realpathSync.native(externalGit),
      ]);
      const after = getWorkspaceTrustSnapshot(workspace.workspace, trustStore);
      expect(after?.revision).toBe(before?.revision);
      expect(after?.externalReadScope.roots).toEqual([]);
      expect(getWorkspaceTrustStatus(workspace.workspace, trustStore)).toBe('trusted');
      expect(getTrustedWorkspaceExternalReadRoots(workspace.workspace, trustStore)).toEqual([]);
      server.setResponses([{ message: { content: 'ordinary turn completed' } }]);
      tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await submitUserMessage(tui, server, 'answer without Git', { timeout: 15_000 });
      await waitForText(() => tui!.viewport(), 'ordinary turn completed', 15_000);
      expect(server.getRequestCount()).toBe(1);
      expect(server.hasRequestMessage('answer without Git', 0)).toBe(true);
      expect(getTrustedWorkspaceExternalReadRoots(workspace.workspace, trustStore)).toEqual([]);
    } finally {
      await cleanupTuiSystemFixtures({
        tuis: [tui],
        mockServers: [server],
        workspaces: [workspace],
      });
      rmSync(externalGit, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
