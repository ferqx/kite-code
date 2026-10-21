import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createTaskExtension } from '../../../src/extensions/task';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { readBackgroundExecutions } from '../../../src/storage/sqlite/background-directory';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test('background directory verifies each same-Session follow-up carrier and rejects changed provenance', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-background-followup-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let stage = 0,
    agentId = '',
    after = '0';
  const parent: ModelAdapter = {
    async *stream(request) {
      const body = request.messages.filter((message) => message.role === 'tool').at(-1);
      const parsed = body ? JSON.parse(body.content) : null;
      let name = '',
        args: unknown = {};
      switch (stage++) {
        case 0:
          name = 'spawn_agent';
          args = { prompt: 'first' };
          break;
        case 1:
          agentId = parsed.agent_id;
          name = 'wait_agent_events';
          args = { wait_ms: 10000 };
          break;
        case 2:
          after = parsed.next_seq;
          name = 'follow_up_agent';
          args = { agent_id: agentId, content: 'second' };
          break;
        case 3:
          name = 'wait_agent_events';
          args = { after_seq: after, wait_ms: 10000 };
          break;
        default:
          yield finish;
          return;
      }
      yield { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(args) };
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  const child: ModelAdapter = {
    async *stream() {
      yield { type: 'text_delta', text: 'done' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    artifacts: createArtifactStore({
      profile: { dataRoot: join(root, 'data'), profile: 'test' },
      store,
    }),
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'worker' }],
      }),
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  let db: Database | undefined;
  let closed = false;
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'w',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'root',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 'root',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'coordinate' },
    });
    const end = Date.now() + 10000;
    for (;;) {
      const view = await store.getView('root');
      if (
        stage >= 5 &&
        !view.runs.some((run) => run.isActive) &&
        view.executions.filter(
          (row) => row.childSessionId === agentId && row.status === 'succeeded',
        ).length === 2
      )
        break;
      if (Date.now() >= end)
        throw new Error('exact original and follow-up carriers did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const scope = { expectedStoreId, subjectId: 'owner', rootSessionId: 'root' };
    const page = await store.listBackgroundExecutions(scope);
    const rows = page.items.filter((item) => item.execution.childSessionId === agentId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((item) => item.childRun?.id)).size).toBe(2);
    for (const item of rows)
      expect((await store.getRun(item.childRun!.id))!.carrierExecutionId).toBe(item.execution.id);
    await runtime.close();
    closed = true;
    db = new Database(join(root, 'data', 'test', 'core.db'));
    const operations = new SqliteOperations(db, false);
    const next = db
      .query("SELECT * FROM command WHERE session_id=? AND kind='input.follow_up'")
      .get(agentId) as Record<string, string>;
    expect(next).toBeTruthy();
    const original = db.query('SELECT * FROM command WHERE id=?').get(next.id!) as Record<
      string,
      string
    >;
    for (const [field, bad] of [
      [
        'agent_carrier_execution_id',
        rows.find((item) => item.execution.id !== next.agent_carrier_execution_id)!.execution.id,
      ],
      ['agent_source_execution_id', 'unrelated-tool'],
      ['after_run_id', 'unrelated-run'],
      ['input_context_selection_id', 'unrelated-selection'],
      ['subject_id', 'other-subject'],
      ['root_work_command_id', 'create'],
      ['origin_store_id', 'other-store'],
    ]) {
      db.run(`UPDATE command SET ${field}=? WHERE id=?`, [bad!, next.id!]);
      expect(() => readBackgroundExecutions(operations, scope)).toThrow(
        'directory_identity_conflict',
      );
      const affectedRun = operations.row('SELECT * FROM run WHERE origin_command_id=?', next.id!);
      expect(operations.runRecord(affectedRun!).carrierExecutionId).toBeUndefined();
      db.run(`UPDATE command SET ${field}=? WHERE id=?`, [original[field!]!, next.id!]);
    }
    expect(
      readBackgroundExecutions(operations, scope).items.filter(
        (item) => item.execution.childSessionId === agentId,
      ),
    ).toHaveLength(2);
    for (const item of rows) {
      const run = operations.row('SELECT * FROM run WHERE id=?', item.childRun!.id)!;
      const command = operations.row('SELECT * FROM command WHERE id=?', run.origin_command_id!)!;
      const { carrierExecutionId, ...ledger } = operations.runRecord(run);
      expect(carrierExecutionId).toBe(item.execution.id);
      const cursor = operations.metadata().lastChangeCursor;
      db.run("UPDATE command SET request_json='null' WHERE id=?", [String(command.id)]);
      expect(operations.runRecord(run)).toEqual(ledger);
      expect(operations.metadata().lastChangeCursor).toBe(cursor);
      db.run('UPDATE command SET request_json=? WHERE id=?', [
        String(command.request_json),
        String(command.id),
      ]);
      expect(operations.runRecord(run).carrierExecutionId).toBe(item.execution.id);
    }
  } finally {
    db?.close();
    if (!closed) await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
