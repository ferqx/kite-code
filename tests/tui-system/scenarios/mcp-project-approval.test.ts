import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { submitCommand } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { waitForCondition, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

const fixture = (name: string) => resolve(import.meta.dir, '..', '..', 'fixtures', name);
const envReference = (name: string) => `\${${name}}`;

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  await waitForCondition(() => existsSync(path), `file ${path}`, timeoutMs);
}

describe('TUI PTY System — project MCP approval', () => {
  let tui: PtyProcess | undefined;
  let server: MockModelServer | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
    tui = undefined;
    server = undefined;
    workspace = undefined;
  });

  test('keeps stdio stopped until a real keyboard approval and then connects it', async () => {
    server = createMockModelServer();
    server.setResponses([]);
    const markerName = 'project-mcp-started';
    workspace = createTestWorkspace({
      projectMcpServers: {
        project_stdio: {
          type: 'stdio',
          command: process.execPath,
          args: [fixture('mcp-auth-stdio-server.ts')],
          env: {
            MCP_AUTH_TOKEN: 'valid',
            MCP_EXPECTED_TOKEN: 'valid',
            MCP_AUTH_SCOPE: 'project',
            MCP_STARTUP_MARKER: envReference('MCP_STARTUP_MARKER'),
          },
          trust: 'trusted',
          tools: {
            authenticated_echo: {
              minimumApproval: 'none',
              retry: 'safe_read',
            },
          },
        },
      },
    });
    const markerPath = join(workspace.workspace, markerName);
    workspace.env.MCP_STARTUP_MARKER = markerPath;
    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: server, workspace });

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(markerPath)).toBe(false);

    await submitCommand(tui, '/mcp', 20);
    await waitForText(() => tui!.viewport(), 'project_stdio · ✘ approval required', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.viewport(), 'Review server', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '> Decide later', 10_000);
    expect(existsSync(markerPath)).toBe(false);
    tui.write('\x1b[B');
    await waitForText(() => tui!.viewport(), '> Approve and connect', 10_000);
    tui.write('\r');
    await waitForFile(markerPath);
    await waitForText(
      () => tui!.outputSinceLastAction(),
      'Approved project MCP server project_stdio.',
      10_000,
    );
  }, 30_000);
});
