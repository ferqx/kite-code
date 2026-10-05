import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  throw new Error('Timed out at original guarded review boundary');
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
    authorizationReview: {
      id: 'reviewer',
      version: '1',
      modelId: 'review-model',
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
              review: { request: { task: 'guarded' }, requireApproval: true },
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
    rootUri: `file://${root}`,
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
  const carrier = (await store.listExecutions('s')).find((item) => item.childSessionId)!;
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
  test(`real reviewer does not wash away ${mutation} context drift (owned SQLite fault)`, async () => {
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
        f.clone('session', f.carrier.childSessionId!, {
          id: 'ordinary-child',
          title: 'Owned unrelated child fault',
        });
      await f.answer(await f.ask());
      await f.rejected();
    } finally {
      await f.close();
    }
  }, 10000);

for (const mutation of [
  'extra_review_run',
  'extra_review_message',
  'extra_review_command',
  'review_selector',
  'extra_review_part',
  'review_part_content',
  'review_descendant',
  'unknown_reviewer',
  'cancel_target',
] as const)
  test(`real review and Ask cannot dispatch after ${mutation} proof drift (owned SQLite fault)`, async () => {
    const f = await fixture();
    try {
      const interaction = await f.ask();
      expect((await f.store.getExecution(f.carrier.id))!.status).toBe('succeeded');
      if (mutation === 'extra_review_run') {
        const reference = {
          expectedStoreId: f.base.expectedStoreId,
          targetExecutionId: f.target.id,
          reviewExecutionId: f.carrier.id,
          policyRevision: 'p1',
          request: { task: 'guarded' },
          requireApproval: true,
          reviewer: { id: 'reviewer', version: '1', modelId: 'review-model' },
        };
        expect((await f.store.getAuthorizationReview(reference)).decision).toBe('approve_once');
        const run = (await f.store.getView(f.carrier.childSessionId!)).runs[0]!;
        // Copying this row is an integrity fault, not a second actual completed Model.
        f.clone('command', run.originCommandId, { id: 'extra-review-origin', seq: 999 });
        f.clone('run', run.id, {
          id: 'extra-review-run',
          origin_command_id: 'extra-review-origin',
        });
        expect((await f.store.getAuthorizationReview(reference)).decision).toBe('unavailable');
      }
      if (mutation === 'extra_review_message') {
        const message = f.db
          .query('SELECT id FROM message WHERE session_id=? ORDER BY seq LIMIT 1')
          .get(f.carrier.childSessionId!) as { id: string };
        f.clone('message', message.id, { id: 'extra-review-message', seq: 999 });
      }
      if (mutation === 'extra_review_command') {
        f.clone('command', `child-create-${f.carrier.id}`, {
          id: 'extra-review-command',
          seq: 999,
        });
      }
      if (mutation === 'review_selector') {
        f.db.run("UPDATE session SET context_selection_id='extra-review-selector' WHERE id=?", [
          f.carrier.childSessionId!,
        ]);
      }
      if (mutation === 'extra_review_part') {
        f.db.run(
          'INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) SELECT message_id,1,kind,content_version,revision,json FROM message_part WHERE message_id=(SELECT id FROM message WHERE session_id=? ORDER BY seq LIMIT 1)',
          [f.carrier.childSessionId!],
        );
      }
      if (mutation === 'review_part_content') {
        f.db.run(
          "UPDATE message_part SET json='{}',revision=revision+1 WHERE message_id IN (SELECT id FROM message WHERE session_id=?)",
          [f.carrier.childSessionId!],
        );
      }
      if (mutation === 'review_descendant') {
        f.clone('session', f.carrier.childSessionId!, {
          id: 'extra-review-descendant',
          parent_id: f.carrier.childSessionId!,
        });
      }
      if (mutation === 'unknown_reviewer') {
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
