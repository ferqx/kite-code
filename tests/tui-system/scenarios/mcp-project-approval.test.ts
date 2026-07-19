import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { sleep, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

const fixture = (name: string) => resolve(import.meta.dir, '..', '..', 'fixtures', name);
const envReference = (name: string) => `\${${name}}`;

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe('TUI PTY System — project MCP approval', () => {
  let tui: PtyProcess | undefined;
  let server: MockModelServer | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
    tui = undefined;
    server = undefined;
    workspace = undefined;
  });

  test('keeps stdio stopped until a real keyboard approval and then connects it', async () => {
    server = createMockModelServer();
    server.setResponses([{ message: { content: 'unused' } }]);
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
    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui!.output(), '❯', 15_000);
    tui.setRawMode(true);
    await sleep(300);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(markerPath)).toBe(false);

    await typeText(tui, '/mcp', 20);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'project_stdio · ✘ approval required', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'Review server', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'Decide later', 10_000);
    expect(existsSync(markerPath)).toBe(false);
    tui.write('\x1b[B');
    await sleep(100);
    tui.write('\r');
    await waitForFile(markerPath);
    await waitForText(() => tui!.output(), 'Approved project MCP server project_stdio.', 10_000);
  }, 30_000);
});
