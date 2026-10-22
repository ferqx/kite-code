import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';

async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw new Error('Timed out at original guarded check boundary');
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-guarded-context-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'owned' });
  let entered = false;
  let effects = 0;
  let reviews = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createRuntime({
    store,
    model: createFixedModel([
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]),
    modelId: 'ordinary',
    modelConcurrency: 1,
    authorizationCheck: {
      id: 'checker',
      version: '1',
      modelId: 'check-model',
      model: {
        async *stream(input) {
          expect(input.tools).toEqual([]);
          reviews++;
          entered = true;
          await gate;
          yield {
            type: 'text_delta',
            text: '{"decision":"approve_once","reason":"Original operation only"}',
          };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    },
    permissions: {
      async authorize(request) {
        return request.definitionId === 'fixture/guarded'
          ? {
              allowed: false,
              revision: 'p1',
              check: { request: { task: 'guarded' }, requireApproval: true },
            }
          : { allowed: true, revision: 'trusted' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        actions: [
          {
            id: 'guarded',
            version: '1',
            description: 'Owned guarded effect',
            inputSchema: { type: 'object', additionalProperties: false },
            async prepare(_input, context) {
              await context.requireExecutionGroupQuiescent!();
              return {};
            },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'effect' };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'owned' });
  await runtime.submitCommand({
    ...base,
    commandId: 'seed',
    request: { kind: 'run.start', content: 'original complete user' },
  });
  await runtime.waitForCommand('seed');
  await runtime.submitCommand({
    ...base,
    commandId: 'guarded',
    request: {
      kind: 'extension.invoke',
      extensionId: 'fixture',
      actionId: 'guarded',
      definitionVersion: '1',
      input: {},
    },
  });
  await eventually(async () => (entered ? true : null));
  const db = new Database(join(root, 'data/owned/core.db'));
  const target = (await store.listExecutions('s')).find(
    (item) => item.definitionId === 'fixture/guarded',
  )!;
  const carrier = (await store.listExecutions('s')).find(
    (item) => item.kind === 'model' && item.runId === null,
  )!;
  const clone = (
    table: 'session' | 'message' | 'run' | 'command',
    id: string,
    changes: Record<string, unknown>,
  ) => {
    const original = db.query(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<
      string,
      unknown
    >;
    const row = { ...original, ...changes };
    const columns = Object.keys(row);
    db.query(
      `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    ).run(...(columns.map((key) => row[key]) as never[]));
  };
  const ask = async () => {
    release();
    return eventually(
      async () =>
        (await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
          .interactions[0] ?? null,
    );
  };
  return {
    db,
    store,
    runtime,
    base,
    target,
    carrier,
    clone,
    release,
    ask,
    effects: () => effects,
    async answer(interaction: Awaited<ReturnType<typeof ask>>) {
      await runtime.answerInteraction({
        expectedStoreId,
        commandId: 'answer',
        presentationSessionId: 's',
        interactionId: interaction.id,
        expectedRevision: interaction.revision,
        subjectId: 'owner',
        answer: { kind: 'approval', decision: 'approve' },
      });
      await runtime.waitForCommand('guarded');
    },
    async rejected() {
      expect(effects).toBe(0);
      expect(reviews).toBe(1);
      expect((await store.getExecution(target.id))!.status).not.toBe('succeeded');
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM change_event WHERE object_id=? AND type='execution.dispatching'",
          )
          .get(target.id),
      ).toEqual({ n: 0 });
    },
    async close() {
      release();
      db.close();
      try {
        await runtime.close();
      } catch {
        /* Fault-created unknown remains unconfirmed. */
      }
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const mutation of [
  'complete_message',
  'part_revision',
  'selector',
  'unrelated_child',
] as const)
  test(`real checker does not wash away ${mutation} context drift (owned SQLite fault)`, async () => {
    const f = await fixture();
    try {
      expect(f.effects()).toBe(0);
      if (mutation === 'complete_message') {
        const message = f.db
          .query(
            "SELECT id FROM message WHERE session_id='s' AND role='user' AND status='complete' LIMIT 1",
          )
          .get() as { id: string };
        f.clone('message', message.id, { id: 'late-user', seq: 999 });
      }
      if (mutation === 'part_revision') {
        const parts = f.db
          .query(
            "SELECT count(*) AS n FROM message_part WHERE message_id IN (SELECT id FROM message WHERE session_id='s' AND status='complete')",
          )
          .get() as { n: number };
        expect(parts.n).toBeGreaterThan(0);
        f.db.run(
          "UPDATE message_part SET revision=revision+1 WHERE message_id IN (SELECT id FROM message WHERE session_id='s' AND status='complete')",
        );
      }
      if (mutation === 'selector')
        f.db.run("UPDATE session SET context_selection_id='owned-drift' WHERE id='s'");
      if (mutation === 'unrelated_child')
        f.clone('session', 's', {
          id: 'ordinary-child',
          title: 'Owned unrelated child fault',
          parent_id: 's',
        });
      await f.answer(await f.ask());
      await f.rejected();
    } finally {
      await f.close();
    }
  }, 10000);

for (const mutation of [
  'model_kind',
  'model_run',
  'model_child_session',
  'model_child_configuration',
  'check_command',
  'check_command_status',
  'check_command_scope',
  'check_command_extension',
  'check_input',
  'unknown_checker',
  'cancel_target',
] as const)
  test(`direct permission check and Ask cannot dispatch after ${mutation} proof drift`, async () => {
    const f = await fixture();
    try {
      const interaction = await f.ask();
      expect((await f.store.getExecution(f.carrier.id))!).toMatchObject({
        kind: 'model',
        status: 'succeeded',
        runId: null,
        childSessionId: null,
        parentExecutionId: f.target.id,
      });
      expect(
        (await f.store.listExecutions('s')).every((item) => item.childSessionId === null),
      ).toBe(true);
      if (mutation === 'model_kind')
        f.db.run("UPDATE execution SET kind='job' WHERE id=?", [f.carrier.id]);
      if (mutation === 'model_run')
        f.db.run(
          "UPDATE execution SET run_id=(SELECT id FROM run WHERE session_id='s' LIMIT 1) WHERE id=?",
          [f.carrier.id],
        );
      if (mutation === 'model_child_session')
        f.db.run("UPDATE execution SET child_session_id='s' WHERE id=?", [f.carrier.id]);
      if (mutation === 'model_child_configuration')
        f.db.run("UPDATE execution SET child_configuration_json='{}' WHERE id=?", [f.carrier.id]);
      if (mutation === 'check_command')
        f.db.run('UPDATE command SET request_digest=? WHERE id=?', [
          '0'.repeat(64),
          f.carrier.originCommandId,
        ]);
      if (mutation === 'check_command_status')
        f.db.run("UPDATE command SET status='rejected' WHERE id=?", [f.carrier.originCommandId]);
      if (mutation === 'check_command_scope')
        f.db.run("UPDATE command SET scope_id='foreign-session' WHERE id=?", [
          f.carrier.originCommandId,
        ]);
      if (mutation === 'check_command_extension')
        f.db.run("UPDATE command SET extension_id='ordinary-extension' WHERE id=?", [
          f.carrier.originCommandId,
        ]);
      if (mutation === 'check_input')
        f.db.run("UPDATE execution SET intent_json='{}' WHERE id=?", [f.carrier.id]);
      if (mutation === 'unknown_checker') {
        f.db.run("UPDATE execution SET state='outcome_unknown' WHERE id=?", [f.carrier.id]);
        const safety = await f.store.readExecutionGroupSafety({
          ...f.base,
          boundaryCommandId: 'guarded',
          excludeExecutionId: f.target.id,
        });
        expect(safety.quiescent).toBe(false);
        expect(safety.unconfirmedExecutionIds).toContain(f.carrier.id);
      }
      if (mutation === 'cancel_target')
        f.db.run('UPDATE execution SET cancel_requested=1 WHERE id=?', [f.target.id]);
      await f.answer(interaction);
      await f.rejected();
    } finally {
      await f.close();
    }
  }, 10000);
