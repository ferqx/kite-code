import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { type DbTiming, openSqliteStore } from '../../../src/sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import { UnstartedSqliteWrite } from '../../../src/storage/sqlite/write-lock';

test('a real Run waits for a peer writer when saving a Tool result and never repeats the Tool', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-writer-run-')));
  const timings: DbTiming[] = [];
  const store = await openSqliteStore({
    dataRoot: root,
    profile: 'test',
    onTiming: (value) => timings.push(value),
  });
  const peer = new Database(join(root, 'test', 'core.db'));
  let effects = 0;
  let held = false;
  let release: ReturnType<typeof setTimeout> | undefined;
  const finish: Extract<ModelEvent, { type: 'finish' }> = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'one', name: 'fixture.effect', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'finished once' }, finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixed' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'One harmless observed effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              peer.run('BEGIN IMMEDIATE');
              held = true;
              release = setTimeout(() => {
                peer.run('ROLLBACK');
                held = false;
              }, 1450);
              return { outcome: 'succeeded', content: 'actual result' };
            },
          },
        ],
      },
    ],
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'w',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'user',
      title: 's',
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'run',
      sessionId: 's',
      subjectId: 'user',
      request: { kind: 'run.start', content: 'work' },
    });
    const command = await runtime.waitForCommand('run', { timeoutMs: 8000 });
    const runId = (command.receipt as { runId: string }).runId;
    expect(await store.getRun(runId)).toMatchObject({ status: 'completed', isActive: false });
    expect(held).toBe(false);
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    const executions = await store.listExecutions('s');
    expect(executions).toHaveLength(3);
    expect(executions.every((item) => item.status === 'succeeded')).toBe(true);
    const toolFinishes = timings.filter(
      (item) => item.operation === 'finishExecution' && item.totalMs > 1000,
    );
    expect(toolFinishes).toHaveLength(1);
    expect(toolFinishes[0]?.outcome).toBe('succeeded');
  } finally {
    clearTimeout(release);
    if (held) peer.run('ROLLBACK');
    peer.close(true);
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('writer wait proof excludes entered callbacks and any later transaction in a committed request', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-writer-proof-')));
  const db = new Database(join(root, 'proof.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1; CREATE TABLE effect(value INTEGER)');
  const peer = new Database(join(root, 'proof.db'));
  const operations = new SqliteOperations(db, false);
  let held = false;
  try {
    operations.beginRequest();
    const bodyError = Object.assign(new Error('actual callback failure'), { code: 'SQLITE_BUSY' });
    let caught: unknown;
    try {
      operations.tx(() => {
        throw bodyError;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(bodyError);
    expect(caught instanceof UnstartedSqliteWrite).toBe(false);

    operations.beginRequest();
    operations.tx(() => operations.run('INSERT INTO effect VALUES(1)'));
    peer.run('BEGIN IMMEDIATE');
    held = true;
    try {
      operations.tx(() => operations.run('INSERT INTO effect VALUES(2)'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'SQLITE_BUSY' });
    expect(caught instanceof UnstartedSqliteWrite).toBe(false);
    expect(db.query('SELECT count(*) AS count FROM effect').get()).toEqual({ count: 1 });

    operations.beginRequest();
    try {
      operations.tx(() => operations.run('INSERT INTO effect VALUES(3)'));
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof UnstartedSqliteWrite).toBe(true);
    expect(db.inTransaction).toBe(false);
  } finally {
    if (held) peer.run('ROLLBACK');
    operations.releaseStatements();
    peer.close(true);
    db.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});
