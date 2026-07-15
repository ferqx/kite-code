import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { sleep, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — MCP readonly management', () => {
  let tui: PtyProcess | undefined;
  let server: MockModelServer | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test('opens a server detail directly and browses discovered capabilities', async () => {
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

    await typeText(tui, '/mcp fixture', 20);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'fixture / detail', 15_000);
    await waitForText(() => tui!.output(), 'Health: ready', 15_000);
    expect(screenContains(tui.output(), '3/3 tools')).toBe(true);

    let outputOffset = tui.output().length;
    tui.write('t');
    await waitForText(() => tui!.output().slice(outputOffset), 'fixture / tools', 10_000);
    expect(screenContains(tui.output(), 'echo')).toBe(true);
    expect(screenContains(tui.output(), 'add')).toBe(true);

    outputOffset = tui.output().length;
    tui.write('\x1b');
    await waitForText(() => tui!.output().slice(outputOffset), 'fixture / detail', 10_000);
    outputOffset = tui.output().length;
    tui.write('u');
    await waitForText(() => tui!.output().slice(outputOffset), 'info://server', 10_000);

    outputOffset = tui.output().length;
    tui.write('\x1b');
    await waitForText(() => tui!.output().slice(outputOffset), 'fixture / detail', 10_000);
    outputOffset = tui.output().length;
    tui.write('p');
    await waitForText(() => tui!.output().slice(outputOffset), '/greet', 10_000);
  }, 40_000);
});
