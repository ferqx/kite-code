import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { sleep, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

describe('TUI PTY System — MCP config management', () => {
  let tui: PtyProcess | undefined;
  let server: MockModelServer | undefined;
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  test('adds, disables, enables, and removes a local stdio server in a narrow terminal', async () => {
    server = createMockModelServer();
    server.setResponses([{ message: { content: 'unused' } }]);
    workspace = createTestWorkspace({ configOverrides: {}, projectConfigOverrides: {} });
    tui = spawnTui({ cols: 58, rows: 30, mockServer: server, workspace });
    await waitForText(() => tui!.output(), '❯', 15_000);
    tui.setRawMode(true);
    await sleep(250);

    await command(tui, '/mcp add');
    await waitForText(() => tui!.output(), 'MCP Management / add', 10_000);
    await line(tui, 'managed');
    await line(tui); // stdio
    await line(tui, process.execPath);
    await line(
      tui,
      JSON.stringify([resolve(import.meta.dir, '..', '..', 'fixtures', 'mcp-test-server.ts')]),
    );
    await line(tui); // cwd
    await line(tui, 'MCP_PHASE2=$' + '{HOME}');
    await line(tui); // local scope
    await line(tui, '3000');
    await waitForText(() => tui!.output(), 'Ready to save.', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.output(), 'managed', 10_000);
    await waitForText(() => tui!.output(), '[ready]', 15_000);

    let offset = tui.output().length;
    tui.write('\r');
    await waitForText(() => tui!.output().slice(offset), 'managed / detail', 10_000);
    offset = tui.output().length;
    tui.write('d');
    await waitForText(() => tui!.output().slice(offset), 'Confirm disable: managed', 10_000);
    offset = tui.output().length;
    tui.write('\r');
    await waitForText(() => tui!.output().slice(offset), 'Disabled MCP server managed.', 10_000);
    await waitForText(() => tui!.output().slice(offset), '[disabled]', 10_000);

    offset = tui.output().length;
    tui.write('\x1b');
    await waitForText(() => tui!.output().slice(offset), '❯', 10_000);
    await command(tui, '/mcp enable managed');
    await waitForText(() => tui!.output(), 'Confirm enable: managed', 10_000);
    offset = tui.output().length;
    tui.write('\r');
    await waitForText(() => tui!.output().slice(offset), 'Enabled MCP server managed.', 10_000);
    await waitForText(() => tui!.output().slice(offset), '[ready]', 15_000);

    offset = tui.output().length;
    tui.write('\x1b');
    await waitForText(() => tui!.output().slice(offset), '❯', 10_000);
    await command(tui, '/mcp remove managed');
    await waitForText(() => tui!.output(), 'Confirm remove: managed', 10_000);
    offset = tui.output().length;
    tui.write('\r');
    await waitForText(() => tui!.output().slice(offset), 'Removed MCP server managed', 10_000);
    await waitForText(() => tui!.output().slice(offset), 'No MCP servers configured.', 10_000);

    const projectsRoot = join(workspace.home, '.kite-code', 'projects');
    const workspaceKeys = readdirSync(projectsRoot);
    expect(workspaceKeys).toHaveLength(1);
    const localConfig = readFileSync(join(projectsRoot, workspaceKeys[0]!, 'mcp.jsonc'), 'utf8');
    expect(localConfig).toContain('"mcpServers"');
    expect(localConfig).not.toContain('"managed"');
    expect(localConfig).not.toContain(process.execPath);
  }, 60_000);
});

async function command(tui: PtyProcess, value: string): Promise<void> {
  await typeText(tui, value, 25);
  tui.write('\r');
  await sleep(100);
}

async function line(tui: PtyProcess, value = ''): Promise<void> {
  if (value) await typeText(tui, value, 2);
  tui.write('\r');
  await sleep(30);
}
