import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { sleep, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — MCP readonly list', () => {
  let tui: PtyProcess | undefined;
  let server: MockModelServer | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test('shows only effective server names and connection status', async () => {
    server = createMockModelServer();
    server.setResponses([{ message: { content: 'unused' } }]);
    workspace = createTestWorkspace({
      configOverrides: {
        mcpServers: {
          fixture: {
            type: 'stdio',
            command: process.execPath,
            args: [resolve(import.meta.dir, '..', '..', 'fixtures', 'mcp-test-server.ts')],
          },
        },
      },
      projectConfigOverrides: {},
    });
    tui = spawnTui({ cols: 120, rows: 40, mockServer: server, workspace });
    await waitForText(() => tui!.output(), '❯', 15_000);
    tui.setRawMode(true);
    await sleep(300);

    await typeText(tui, '/mcp', 20);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'MCP Servers', 15_000);
    await waitForText(() => tui!.output(), '[ready] fixture', 15_000);
    expect(screenContains(tui.output(), 'stdio')).toBe(false);
    expect(screenContains(tui.output(), 'user')).toBe(false);
    expect(screenContains(tui.output(), '3/3 tools')).toBe(false);
    expect(screenContains(tui.output(), 'echo')).toBe(false);

    const outputOffset = tui.output().length;
    tui.write('\r');
    tui.write('t');
    tui.write('a');
    await sleep(200);
    expect(screenContains(tui.output().slice(outputOffset), 'detail')).toBe(false);
    expect(screenContains(tui.output().slice(outputOffset), 'add')).toBe(false);
    expect(screenContains(tui.output(), '[ready] fixture')).toBe(true);
  }, 40_000);
});
