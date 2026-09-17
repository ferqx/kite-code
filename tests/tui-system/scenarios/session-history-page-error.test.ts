/** Real Service + PTY regression: a corrupt second directory page must stay visible as an error. */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trustWorkspace } from '../../../apps/kite-service/src/config/workspace-trust';
import {
  BunStdioChildRuntimeClientTransport,
  kiteAppServerVersion,
} from '../../../packages/kite-local-runtime/src/client';
import {
  createAppServerProtocolConnection,
  KITE_APP_SERVER_PROTOCOL_METHODS_,
} from '../../../packages/kite-local-runtime/src/client/protocol-connection';
import { createKiteHomeDirectoryQuery } from '../../../packages/runtime-storage-sqlite/src/kite-home-directory';
import { assertKiteSessionStoreSchema } from '../../../packages/runtime-storage-sqlite/src/kite-home-store';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { submitCommand } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import { screenContains, waitForCondition } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

test('a malformed record reached on page two shows a TUI history error without erasing valid sessions', async () => {
  const workspace = createTestWorkspace({ configOverrides: { sandbox: { enabled: false } } });
  const model = createMockModelServer();
  model.setResponses([{ message: { content: 'A durable first answer' } }]);
  let tui: PtyProcess | undefined;
  const configRoot = join(workspace.home, '.kite-code');
  const storePath = join(configRoot, 'kite-session.sqlite');
  try {
    writeFileSync(
      workspace.configPath,
      JSON.stringify({
        language: 'zh-CN',
        provider: {
          mock: {
            type: 'openai-compatible',
            apiKey: 'fixture-only',
            baseURL: model.baseURL,
            model: 'mock-model',
            models: ['mock-model'],
          },
        },
        model: { default: { provider: 'mock', name: 'mock-model' } },
        interactionMode: 'auto',
        sandbox: { enabled: false },
        mcpServers: {},
      }),
    );
    expect(
      trustWorkspace({
        workspace: workspace.workspace,
        source: 'test',
        storePath: join(configRoot, 'workspace-trust.jsonc'),
      }).status,
    ).toBe('recorded');
    const label = 'history-page-error';
    const transport = new BunStdioChildRuntimeClientTransport({
      argv: [
        process.execPath,
        join(import.meta.dir, '../../../scripts/release/entrypoints/service.ts'),
        'app-server',
        'run-stdio',
      ],
      cwd: workspace.workspace,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: workspace.home,
        USERPROFILE: workspace.home,
        NODE_ENV: 'production',
        KITE_CODE_HOME: configRoot,
        KITE_CODE_CONFIG_HOME: configRoot,
        KITE_APP_SERVER_WORKSPACE: workspace.workspace,
        KITE_APP_SERVER_BUILD_ID: label,
      },
    });
    const connection = createAppServerProtocolConnection(
      transport,
      kiteAppServerVersion(label),
      { name: 'history-page-error', version: '1', instanceId: label },
      KITE_APP_SERVER_PROTOCOL_METHODS_,
    );
    await connection.prepareAppControl();
    try {
      const firstId = 'page-session-000';
      const created = await connection.runtime.command({
        schema: 'kite.runtime-command.v1',
        commandId: 'create-000',
        type: 'create_session',
        workspace: workspace.workspace,
        bootstrapSessionId: firstId,
      });
      expect(created.status).toBe('applied');
      const projection = await connection.runtime.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId: firstId,
      });
      expect(projection.status).toBe('ok');
      if (projection.status !== 'ok' || !projection.session)
        throw new Error('Production first Session is unavailable.');
      const started = await connection.runtime.command({
        schema: 'kite.runtime-command.v1',
        commandId: 'first-turn',
        type: 'start_turn',
        sessionId: firstId,
        expectedRevision: projection.session.revision,
        input: 'Durable first question',
        phase: 'building',
      });
      expect(started.status).toBe('applied');
      const deadline = Date.now() + 15_000;
      let completed = false;
      while (Date.now() < deadline) {
        const current = await connection.runtime.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_session_projection',
          sessionId: firstId,
        });
        if (current.status === 'ok' && current.session?.currentRun?.status === 'completed') {
          completed = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect(completed).toBe(true);
      // Every Session row is created by the real Service command path, never inserted by SQL.
      for (let index = 1; index <= 101; index++) {
        const suffix = String(index).padStart(3, '0');
        const result = await connection.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: `create-${suffix}`,
          type: 'create_session',
          workspace: workspace.workspace,
          bootstrapSessionId: `page-session-${suffix}`,
        });
        expect(result.status).toBe('applied');
      }
      const listed = await connection.history.listSessions({ limit: 100 });
      expect(listed.entries.length).toBe(100);
      expect(listed.hasMore).toBe(true);
      expect(listed.nextCursor).toBeDefined();
    } finally {
      await connection.close();
    }

    // The one malformed event was written by the real turn above. Move its still-valid
    // Session metadata to the oldest position, then corrupt only that event's JSON bytes.
    const database = new Database(storePath, { strict: true });
    let originalIds: string[];
    try {
      originalIds = database
        .query<{ session_id: string }, []>(
          'SELECT session_id FROM runtime_sessions ORDER BY session_id',
        )
        .all()
        .map((row) => row.session_id);
      expect(originalIds).toHaveLength(102);
      const originalEvent = database
        .query<{ event_json: string }, [string]>(
          "SELECT event_json FROM runtime_events WHERE session_id=? AND json_extract(event_json,'$.type')='user.message_appended' LIMIT 1",
        )
        .get('page-session-000');
      expect(originalEvent).toBeDefined();
      database
        .query('UPDATE runtime_sessions SET name=?, updated_at=? WHERE session_id=?')
        .run('', 0, 'page-session-000');
      // Simulate existing on-disk damage. The ordinary writer correctly rejects malformed JSON.
      database.run('PRAGMA ignore_check_constraints=ON');
      database
        .query("UPDATE runtime_events SET event_json='{' WHERE session_id=? AND event_json=?")
        .run('page-session-000', originalEvent!.event_json);
      database.run('PRAGMA ignore_check_constraints=OFF');
      const directory = createKiteHomeDirectoryQuery(database, {
        assertStoreSchema: assertKiteSessionStoreSchema,
      });
      const firstPage = directory.listSessions({ limit: 100 });
      expect(firstPage.entries).toHaveLength(100);
      expect(firstPage.nextCursor).toBeDefined();
      expect(firstPage.entries.some((entry) => entry.sessionId === 'page-session-000')).toBe(false);
      expect(() => directory.listSessions({ limit: 100, cursor: firstPage.nextCursor! })).toThrow();
    } finally {
      database.close(false);
    }

    tui = await spawnReadyTui({ cols: 120, rows: 40, mockServer: model, workspace });
    try {
      await submitCommand(tui, '/resume');
    } catch (error) {
      throw new Error(`/resume input failed; TUI exited=${tui.exited}`, { cause: error });
    }
    await waitForCondition(
      () => screenContains(tui!.viewport(), '错误：无法加载历史会话，请稍后重试。'),
      'second-page history error to appear in the real TUI selector',
      15_000,
    );
    expect(screenContains(tui.viewport(), '暂无历史会话')).toBe(false);
    expect(screenContains(tui.viewport(), '错误：无法加载历史会话，请稍后重试。')).toBe(true);
    using retained = new Database(storePath, { readonly: true });
    const afterIds = retained
      .query<{ session_id: string }, []>(
        'SELECT session_id FROM runtime_sessions ORDER BY session_id',
      )
      .all()
      .map((row) => row.session_id);
    for (const id of originalIds) expect(afterIds).toContain(id);
    expect(afterIds.length).toBeGreaterThanOrEqual(originalIds.length);
    expect(
      retained
        .query<{ event_json: string }, [string]>(
          "SELECT event_json FROM runtime_events WHERE session_id=? AND event_json='{' LIMIT 1",
        )
        .get('page-session-000')?.event_json,
    ).toBe('{');
  } finally {
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [model], workspaces: [workspace] });
  }
}, 90_000);
