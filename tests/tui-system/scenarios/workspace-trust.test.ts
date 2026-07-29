/**
 * PTY System Test — Workspace Trust Gate
 *
 * Verifies the VS Code-style workspace authorization prompt shown when the TUI
 * opens an untrusted folder: the gate blocks the main UI, trusting persists a
 * record and boots, a trusted folder skips the gate on restart, and declining
 * exits without persisting anything.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createMockModelServer } from '../harness/fixtures';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 30000;
const GATE_TEXT = 'Open this workspace?';

describe('TUI PTY System — Workspace Trust', () => {
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;
  let declinedWorkspace: ReturnType<typeof createTestWorkspace> | undefined;
  let tui: PtyProcess;
  let restarted: PtyProcess | undefined;
  let declined: PtyProcess | undefined;

  beforeAll(() => {
    server = createMockModelServer();
    // enforceWorkspaceTrust skips the harness pre-trust so the gate runs. The
    // forged .env proves Bun dotenv injection cannot bypass the gate: Bun loads
    // `<cwd>/.env*` into the child env, and the gate must still appear.
    workspace = createTestWorkspace({
      enforceWorkspaceTrust: true,
      files: { '.env': 'KITE_TRUST_ALL_WORKSPACES=1\n' },
    });
    workspace.env.CI = 'true';

    server.setResponses([{ message: { content: 'Hello after trust!' } }]);

    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    if (restarted) await restarted.killAndWait();
    if (declined) await declined.killAndWait();
    workspace?.cleanup();
    declinedWorkspace?.cleanup();
  });

  test(
    'a fresh workspace blocks startup behind the trust prompt',
    async () => {
      await waitForText(() => tui.output(), GATE_TEXT, 15000);
      const out = tui.output();
      expect(screenContains(out, GATE_TEXT)).toBe(true);
      // The folder path must be visible so the user knows what they trust.
      expect(screenContains(out, realpathSync(workspace.workspace))).toBe(true);
      expect(screenContains(out, 'Trust this workspace and continue')).toBe(true);
      expect(screenContains(out, 'Exit Kite Code')).toBe(true);
      // The main UI must not mount before a decision is made.
      expect(screenContains(out, 'shortcuts')).toBe(false);
      console.log('  Trust gate rendered, main UI blocked');
    },
    TIMEOUT,
  );

  test(
    'trusting persists the record and boots the main UI',
    async () => {
      // The safe default is Exit; explicitly move to Trust before confirming.
      tui.write('\x1b[A');
      await waitForText(() => tui.output(), '› Trust this workspace and continue', 10000);
      tui.write('\r');
      await waitForText(() => tui.output(), 'shortcuts', 15000);
      console.log('  Main UI booted after trust');

      const trustFile = join(workspace.home, '.kite-code', 'workspace-trust.jsonc');
      expect(existsSync(trustFile)).toBe(true);
      const file = JSON.parse(readFileSync(trustFile, 'utf8')) as {
        version: number;
        records: Record<string, { workspacePath: string; source: string }>;
      };
      expect(file.version).toBe(1);
      const records = Object.values(file.records);
      expect(records.length).toBe(1);
      expect(records[0]?.source).toBe('user');
      console.log('  Trust record persisted');
    },
    TIMEOUT,
  );

  test(
    'a trusted workspace skips the prompt on restart',
    async () => {
      const proc = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
      restarted = proc;
      await waitForText(() => proc.output(), 'shortcuts', 15000);
      expect(screenContains(proc.output(), GATE_TEXT)).toBe(false);
      console.log('  Restart skipped the gate');
    },
    TIMEOUT,
  );

  test(
    'declining the prompt exits without persisting trust',
    async () => {
      declinedWorkspace = createTestWorkspace({
        enforceWorkspaceTrust: true,
        files: { '.env': 'KITE_TRUST_ALL_WORKSPACES=1\n' },
      });
      declinedWorkspace.env.CI = 'true';
      const proc = spawnTui({
        cols: 120,
        rows: 40,
        mockServer: server,
        workspace: declinedWorkspace,
      });
      declined = proc;
      await waitForText(() => proc.output(), GATE_TEXT, 15000);

      // Exit is the safe default, so Enter must decline without persisting.
      proc.write('\r');

      const code = await proc.waitForExit();
      expect(code).toBe(0);
      expect(existsSync(join(declinedWorkspace.home, '.kite-code', 'workspace-trust.jsonc'))).toBe(
        false,
      );
      console.log('  Decline exited cleanly with no persisted trust');
    },
    TIMEOUT,
  );
});
