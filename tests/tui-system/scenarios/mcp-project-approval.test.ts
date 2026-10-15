import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer, type MockModelServer } from '../harness/fixtures';
import { sleep, submitCommand } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace, type TestWorkspace } from '../harness/test-workspace';

const fixture = (name: string) => resolve(import.meta.dir, '..', '..', 'fixtures', name);
const envReference = (name: string) => `\${${name}}`;

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

  test('records keyboard approval but keeps unqualified local stdio stopped', async () => {
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
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      mockServer: server,
      workspace,
      entryPath: join(import.meta.dir, '../fixtures/mcp-project-tui.tsx'),
    });

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(markerPath)).toBe(false);

    await submitCommand(tui, '/mcp', 20);
    await waitForText(() => tui!.viewport(), '● 需要审批', 10_000);
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '审核服务器', 10_000);
    tui.write('\r');
    // The source directory does not own pending answers. Close only its read,
    // then approve the exact ordinary Action before answering its Source Question.
    await waitForText(() => tui!.viewport(), '原来源决定申请： 1', 10_000);
    tui.write('\x03');
    await waitForCondition(
      () =>
        screenContains(tui!.viewport(), '❯ 允许一次') ||
        screenContains(tui!.viewport(), '❯ 稍后决定'),
      'the actual independent pending approval or Source Question',
      10_000,
    );
    if (screenContains(tui.viewport(), '❯ 允许一次')) {
      await waitForText(() => tui!.viewport(), '仅批准本次执行', 10_000);
      expect(existsSync(markerPath)).toBe(false);
      tui.write('\r');
    }
    await waitForText(() => tui!.viewport(), '❯ 稍后决定', 10_000);
    using pendingDb = new Database(workspace.databasePath, { readonly: true });
    const question = pendingDb
      .query<
        {
          id: string;
          execution_id: string;
          session_id: string;
          origin_store_id: string;
          state: string;
          answer_json: string | null;
        },
        []
      >(
        "SELECT id,execution_id,session_id,origin_store_id,state,answer_json FROM interaction WHERE kind='question' AND definition_id='builtin.mcp.sources/mcp.source.approve'",
      )
      .all();
    expect(question).toHaveLength(1);
    expect(question[0]!.state).toBe('pending');
    expect(question[0]!.answer_json).toBeNull();
    tui.write('\r');
    await tui.settleScreen();
    expect(
      pendingDb
        .query('SELECT id,state,answer_json FROM interaction WHERE id=?')
        .get(question[0]!.id),
    ).toEqual({ id: question[0]!.id, state: 'pending', answer_json: null });
    expect(screenContains(tui.viewport(), '❯ 稍后决定')).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
    tui.write('\x1b[B');
    await waitForText(() => tui!.viewport(), '❯ 批准并连接', 10_000);
    tui.write('\r');
    // Read the saved original decision explicitly; answering is not publication proof.
    await waitForText(() => tui!.viewport(), '❯', 10_000);
    await submitCommand(tui, '/mcp', 20);
    await waitForText(() => tui!.viewport(), 'project_stdio', 10_000);
    const select = async (label: string) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const viewport = tui!.viewport();
        if (screenContains(viewport, `❯ ${label}`)) return;
        if (Date.now() >= deadline)
          throw Error(`original_project_source_navigation:${label}\n${viewport}`);
        if (/❯\s+\S/u.test(viewport)) tui!.write('\x1b[B');
        await sleep(50);
      }
    };
    await select('项目来源');
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '来源列表已就绪', 10_000);
    await select('查询原来源决定');
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '来源批准已保存', 10_000);
    const original = pendingDb
      .query<
        { id: string; state: string; result_json: string; origin_command_id: string },
        [string, string, string]
      >(
        "SELECT id,state,result_json,origin_command_id FROM execution WHERE id=? AND session_id=? AND origin_store_id=? AND adapter_id='builtin.mcp.sources/mcp.source.approve'",
      )
      .get(question[0]!.execution_id, question[0]!.session_id, question[0]!.origin_store_id);
    expect(original?.state).toBe('succeeded');
    const saved = JSON.parse(original!.result_json);
    expect(saved.outcome).toBe('succeeded');
    expect(saved.details).toMatchObject({
      decision: 'approved',
      mutation: {
        id: `mcp-source-${original!.id}`,
        originStoreId: question[0]!.origin_store_id,
        state: 'applied',
      },
      connectionAttempted: false,
      credentialLookupAttempted: false,
      proof: {
        interactionId: question[0]!.id,
        sessionId: question[0]!.session_id,
        storeId: question[0]!.origin_store_id,
      },
    });
    expect(
      pendingDb.query("SELECT id,adapter_id,state FROM execution WHERE kind='job'").all(),
    ).toEqual([
      {
        id: original!.id,
        adapter_id: 'builtin.mcp.sources/mcp.source.approve',
        state: 'succeeded',
      },
    ]);
    expect(server.getRequestCount()).toBe(0);
    tui.write('\x03');
    await submitCommand(tui, '/mcp', 20);
    // The Source result already contains this name. Wait for the refreshed
    // directory's ready state and exact selected row before opening details;
    // a new directory observation invalidates the previous detail selection.
    await waitForCondition(
      () => {
        const viewport = tui!.viewport();
        return (
          screenContains(viewport, 'MCP servers') &&
          screenContains(viewport, '1 个服务器') &&
          screenContains(viewport, '❯ project_stdio · 禁用 · 不可用')
        );
      },
      'the refreshed ready project MCP directory and exact selected server',
      10_000,
    );
    tui.write('\r');
    await waitForText(() => tui!.viewport(), '重试连接', 10_000);
    expect(existsSync(markerPath)).toBe(false);
  }, 30_000);
});
