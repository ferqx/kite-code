/**
 * PTY System Test — Workspace Trust Gate
 *
 * Verifies the VS Code-style workspace authorization prompt shown when the TUI
 * opens an untrusted folder: the gate blocks the main UI, trusting persists a
 * record and boots, a trusted folder skips the gate on restart, and declining
 * exits without persisting anything.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceGitMetadataReadOnlyRoots } from '../../../packages/builtin-runtime/src/git/metadata-scope';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { createTuiSystemJourney, TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS } from '../harness/journey';
import { type PtyProcess, spawnReadyTui, waitForTuiReady } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;
const GATE_TEXT = 'Open this workspace?';

describe('TUI PTY System — Workspace Trust', () => {
  const journey = createTuiSystemJourney();
  const step = journey.step;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let declinedServer: ReturnType<typeof createMockModelServer> | undefined;
  let declinedWorkspace: ReturnType<typeof createTestWorkspace> | undefined;
  let tui: PtyProcess;
  let restarted: PtyProcess | undefined;
  let declined: PtyProcess | undefined;
  let externalGitDir = '';

  beforeAll(async () => {
    server = createMockModelServer();
    // enforceWorkspaceTrust skips the harness pre-trust so the gate runs. The
    // forged .env proves Bun dotenv injection cannot bypass the gate: Bun loads
    // `<cwd>/.env*` into the child env, and the gate must still appear.
    workspace = createTestWorkspace({
      configOverrides: { language: 'en-US' },
      enforceWorkspaceTrust: true,
      files: { '.env': 'KITE_TRUST_ALL_WORKSPACES=1\n' },
    });
    workspace.env.CI = 'true';
    externalGitDir = join(workspace.home, 'external-repository.git');
    execFileSync('git', ['init', '--bare', '--quiet', externalGitDir]);
    externalGitDir = realpathSync(externalGitDir);
    writeFileSync(join(workspace.workspace, '.git'), `gitdir: ${externalGitDir}\n`);
    expect(resolveWorkspaceGitMetadataReadOnlyRoots(workspace.workspace)).toEqual([externalGitDir]);

    server.setResponses([]);

    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      readiness: 'workspace-trust',
    });
  }, TIMEOUT);

  afterAll(async () => {
    await cleanupTuiSystemFixtures({
      tuis: [tui, restarted, declined],
      mockServers: [server, declinedServer],
      workspaces: [workspace, declinedWorkspace],
    });
  }, TIMEOUT);

  step(
    'a fresh workspace blocks startup behind the trust prompt',
    async () => {
      await waitForText(() => tui.outputSinceLastAction(), GATE_TEXT, 15000);
      const out = tui.viewport();
      expect(screenContains(out, GATE_TEXT)).toBe(true);
      // The folder path must be visible so the user knows what they trust.
      expect(screenContains(out, realpathSync(workspace.workspace))).toBe(true);
      // Ordinary Workspace Trust never includes linked Git metadata authority.
      expect(screenContains(out, 'This workspace also requires read-only access to:')).toBe(true);
      expect(screenContains(out, '当前工作区内的文件、项目指令与 Skill 资料')).toBe(true);
      if (process.platform === 'darwin') {
        expect(screenContains(out, '明确装配的 macOS Native Shell')).toBe(true);
        expect(screenContains(out, '广泛文件视图')).toBe(true);
      }
      if (existsSync(join(workspace.profilePath, 'skills')))
        expect(screenContains(out, '当前 profile 的宿主限定 Skill 根目录资料')).toBe(true);
      expect(screenContains(out, externalGitDir)).toBe(false);
      expect(screenContains(out, 'Trust this workspace and continue')).toBe(true);
      expect(screenContains(out, 'Exit Kite Code')).toBe(true);
      // The main UI must not mount before a decision is made.
      expect(screenContains(out, 'shortcuts')).toBe(false);
      console.log('  Trust gate rendered, main UI blocked');
    },
    TIMEOUT,
  );

  step(
    'trusting persists the record and boots the main UI',
    async () => {
      // The safe default is Exit; explicitly move to Trust before confirming.
      tui.write('\x1b[A');
      await waitForText(() => tui.viewport(), '› Trust this workspace and continue', 10000);
      tui.write('\r');
      await waitForTuiReady(tui, 'main', workspace);
      console.log('  Main UI booted after trust');

      expect(existsSync(workspace.databasePath)).toBe(true);
      const db = new Database(workspace.databasePath, { readonly: true });
      try {
        const version = db
          .query<{ format_major: number }, []>('SELECT format_major FROM storage_meta')
          .get();
        expect(version?.format_major).toBe(1);
        const records = db
          .query<
            { state: string; subject_id: string; safe_request_json: string; receipt_json: string },
            []
          >(
            "SELECT state,subject_id,safe_request_json,receipt_json FROM host_mutation WHERE kind='workspace.trust'",
          )
          .all();
        expect(records).toHaveLength(1);
        expect(records[0]?.state).toBe('applied');
        expect(records[0]?.subject_id).toBeTruthy();
        const trust = JSON.parse(records[0]!.safe_request_json);
        const actualWorkspace = db
          .query<{ id: string; root_uri: string }, []>('SELECT id,root_uri FROM workspace')
          .all()
          .find((row) => fileURLToPath(row.root_uri) === realpathSync(workspace.workspace));
        expect(actualWorkspace).toBeDefined();
        expect(trust.scope).toBe('workspace');
        expect(trust.workspaceId).toBe(actualWorkspace!.id);
        expect(trust.trusted).toBe(true);
        expect(trust.canonicalIdentity).toMatch(/^[a-f0-9]{64}$/);
        expect(trust.externalReadScopeDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(trust)).not.toContain(externalGitDir);
        expect(records[0]!.receipt_json).not.toContain(externalGitDir);
        expect(readFileSync(join(workspace.workspace, '.git'), 'utf8')).toBe(
          `gitdir: ${externalGitDir}\n`,
        );
      } finally {
        db.close();
      }
      console.log('  Trust record persisted');
    },
    TIMEOUT,
  );

  step(
    'a trusted workspace skips the prompt on restart',
    async () => {
      // RA-04 admits only one Runtime Host for a workspace. Release the
      // original TUI's Host lease before starting the restarted process.
      await tui.killAndWait();
      const proc = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });
      restarted = proc;
      expect(screenContains(proc.viewport(), GATE_TEXT)).toBe(false);
      expect(screenContains(proc.viewport(), 'Kite Code')).toBe(true);
      await proc.killAndWait();
      restarted = undefined;
      console.log('  Restart skipped the gate');
    },
    TIMEOUT,
  );

  step(
    'declining the prompt exits without persisting trust',
    async () => {
      declinedWorkspace = createTestWorkspace({
        configOverrides: { language: 'en-US' },
        enforceWorkspaceTrust: true,
        files: { '.env': 'KITE_TRUST_ALL_WORKSPACES=1\n' },
      });
      declinedWorkspace.env.CI = 'true';
      // A distinct workspace owns a distinct fixture tool baseline and response queue.
      declinedServer = createMockModelServer();
      declinedServer.setResponses([]);
      const proc = await spawnReadyTui({
        cols: 120,
        rows: 40,
        mockServer: declinedServer,
        workspace: declinedWorkspace,
        readiness: 'workspace-trust',
      });
      declined = proc;
      proc.write('\r');

      const code = await proc.waitForExit();
      expect(code).toBe(0);
      if (existsSync(declinedWorkspace.databasePath)) {
        const db = new Database(declinedWorkspace.databasePath, { readonly: true });
        try {
          expect(
            db
              .query<{ n: number }, []>(
                "SELECT COUNT(*) AS n FROM host_mutation WHERE kind='workspace.trust'",
              )
              .get()?.n,
          ).toBe(0);
        } finally {
          db.close();
        }
      }
      console.log('  Decline exited cleanly with no persisted trust');
    },
    TIMEOUT,
  );
  test(
    'runs the complete stateful journey',
    () => journey.run(),
    TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS,
  );
});
