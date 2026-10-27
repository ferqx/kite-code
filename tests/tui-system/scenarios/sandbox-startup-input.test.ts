import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createPermissionManagement } from '../../../apps/service/src/permission-management';
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
      expect(server.getWorkRequestCount()).toBe(1);
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
    const profile = selectProfile(workspace);
    const openTrust = async () => {
      const store = await openSqliteStore(profile);
      const runtime = createRuntime({ store });
      const expectedStoreId = (await runtime.getMetadata()).storeId;
      const identity = { expectedStoreId, subjectId: 'local-user', workspaceId: 'git-drift' };
      const management = createPermissionManagement({
        runtime,
        profile,
        nativeShellRead: process.platform === 'darwin',
      });
      return { runtime, management, identity };
    };
    let tui: PtyProcess | undefined;
    try {
      execFileSync('git', ['init', '--bare', '--quiet', externalGit]);
      const control = await openTrust();
      let before: Awaited<ReturnType<typeof control.management.readTrust>>;
      try {
        await control.runtime.createWorkspace({
          expectedStoreId: control.identity.expectedStoreId,
          id: control.identity.workspaceId,
          name: 'External Git drift',
          rootUri: pathToFileURL(realpathSync(workspace.workspace)).href,
        });
        const initial = await control.management.readTrust(control.identity);
        expect(
          (
            await control.management.setTrust({
              ...control.identity,
              commandId: 'trust-before-git-drift',
              trusted: true,
              ifRevision: initial.revision,
              canonicalIdentity: initial.canonicalIdentity,
              externalReadScopeDigest: initial.externalReadScopeDigest,
            })
          ).state,
        ).toBe('applied');
        before = await control.management.readTrust(control.identity);
        expect(before.status).toBe('trusted');
        // A linked Git directory cannot change the host-selected trust read scopes.
        writeFileSync(join(workspace.workspace, '.git'), `gitdir: ${externalGit}\n`);
        expect(
          realpathSync.native(
            execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
              cwd: workspace.workspace,
              encoding: 'utf8',
            }).trim(),
          ),
        ).toBe(realpathSync.native(externalGit));
        const after = await control.management.readTrust(control.identity);
        expect(after.revision).toBe(before.revision);
        expect(after.canonicalIdentity).toBe(before.canonicalIdentity);
        expect(after.externalReadScopeDigest).toBe(before.externalReadScopeDigest);
        expect(after.status).toBe('trusted');
        expect(after.trusted).toBe(true);
        expect(after.readScopes.some((scope) => /git/i.test(scope.kind))).toBe(false);
        expect(JSON.stringify(after)).not.toContain(externalGit);
      } finally {
        await control.runtime.close();
      }
      server.setResponses([{ message: { content: 'ordinary turn completed' } }]);
      tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      await submitUserMessage(tui, server, 'answer without Git', { timeout: 15_000 });
      await waitForText(() => tui!.viewport(), 'ordinary turn completed', 15_000);
      expect(server.getWorkRequestCount()).toBe(1);
      // Core appends its session_files and runtime-state observations after the user input.
      // Verify the exact original input on the sole actual work request.
      expect(
        server.getWorkRequests()[0]?.messages.find((message) => message.role === 'user'),
      ).toEqual({ role: 'user', content: 'answer without Git' });
      await tui.killAndWait();
      tui = undefined;
      const reopened = await openTrust();
      try {
        const afterTurn = await reopened.management.readTrust(reopened.identity);
        expect(afterTurn.status).toBe('trusted');
        expect(afterTurn.trusted).toBe(true);
        expect(afterTurn.revision).toBe(before.revision);
        expect(afterTurn.canonicalIdentity).toBe(before.canonicalIdentity);
        expect(afterTurn.externalReadScopeDigest).toBe(before.externalReadScopeDigest);
        expect(afterTurn.readScopes).toEqual(before.readScopes);
        expect(JSON.stringify(afterTurn)).not.toContain(externalGit);
      } finally {
        await reopened.runtime.close();
      }
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
