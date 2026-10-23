import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  privateDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { DispatchInput } from '../../../src/storage/port';
import { verifyAuthorizationReviewDispatch } from '../../../src/storage/sqlite/authorization-review';
import type { SqliteOperations } from '../../../src/storage/sqlite/operations';

// The default runner isolates this file. Use the release engine before any DB;
// never warm or rewrite a frozen original Profile to make its readonly preflight pass.
let qualified: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>> | undefined;
beforeAll(async () => {
  qualified = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => qualified?.close());

// Genuine beabc9628afa4684667733a807c9ffddb3d8beb5 Runtime profiles, frozen after a settled review and pending
// human card (approved), or an ordinary approval with no reviewer (none), then
// SIGKILL and an SQLite WAL checkpoint. Both contain only synthetic fixture
// model/tool/approval data, core.db/profile.json, and the generated Store ID; no
// credentials, real provider calls, user data, or coordination locks. No current
// producer or rewritten configuration creates these inputs.
function unpack(shape: 'approved' | 'none') {
  const root = temporaryDirectory('kite-legacy-run-resume-');
  const files = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(`../execution/fixtures/legacy-resume-${shape}.json.gz`, import.meta.url),
      ),
    ).toString(),
  ) as Record<string, string>;
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(root, name);
    privateDirectory(dirname(path));
    writeFileSync(path, Buffer.from(bytes, 'base64'), { mode: 0o600 });
  }
  return { root, profile: { dataRoot: join(root, 'data'), profile: 'test' } };
}
const cases = [
  { shape: 'approved', mutation: null },
  { shape: 'none', mutation: null },
  ...(['checker-id', 'checker-version', 'checker-model', 'tool-version', 'both-keys'] as const).map(
    (mutation) => ({ shape: 'approved' as const, mutation }),
  ),
] as const;
for (const { shape, mutation } of cases)
  test(`legacy ${shape} Run ${mutation ? `rejects ${mutation} configuration drift` : 'resumes its original human approval without rewriting configuration or replaying review'}`, async () => {
    const { root, profile } = unpack(shape);
    if (mutation === 'both-keys') {
      const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
      try {
        const row = db
          .query<{ id: string; config_json: string }, []>(
            "SELECT id,config_json FROM run WHERE session_id='s'",
          )
          .get()!;
        const config = JSON.parse(row.config_json);
        config.snapshot.authorizationCheck = config.snapshot.authorizationReview;
        db.query('UPDATE run SET config_json=? WHERE id=?').run(JSON.stringify(config), row.id);
      } finally {
        db.close();
      }
    }
    const store = await openSqliteStore(profile);
    const expectedStoreId = readFileSync(join(root, 'ready'), 'utf8');
    let effects = 0,
      checks = 0,
      models = 0;
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      modelId: 'business',
      model: {
        async *stream() {
          models++;
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      ...(shape === 'approved'
        ? {
            authorizationCheck: {
              id: mutation === 'checker-id' ? 'different' : 'reviewer',
              version: mutation === 'checker-version' ? '2' : '1',
              modelId: mutation === 'checker-model' ? 'different' : 'review',
              model: {
                async *stream() {
                  checks++;
                  yield { type: 'text_delta' as const, text: 'unexpected checker replay' };
                  throw Error('legacy_review_must_not_replay');
                },
              },
            },
          }
        : {}),
      permissions: {
        async authorize(candidate) {
          if (candidate.definitionId !== 'effect') return { allowed: true, revision: 'trusted' };
          const request = { definitionId: 'effect', input: { value: 'exact' } };
          return shape === 'approved'
            ? { allowed: false, revision: 'p1', check: { requireApproval: true, request } }
            : { allowed: false, revision: 'p1', approval: { request } };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'effect',
              version: mutation === 'tool-version' ? '2' : '1',
              description: 'Owned effect',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
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
    try {
      const target = (await store.listExecutions('s')).find(
        (item) => item.definitionId === 'effect',
      )!;
      const original = (await store.getRun(target.runId!))!;
      const card = (
        await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
      ).interactions[0]!;
      expect(card.state).toBe('pending');
      const before = await store.listExecutions('s');
      const resume = {
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'resume',
        runId: target.runId!,
        expectedOwnerGeneration: target.ownerGeneration,
      };
      if (mutation) {
        const error = await runtime.resumeRun(resume).catch((error: unknown) => error);
        expect(error).toMatchObject({ code: 'run_configuration_mismatch' });
        expect((await store.getRun(target.runId!))!.configuration).toEqual(original.configuration);
        expect(await store.listExecutions('s')).toEqual(before);
        expect(effects).toBe(0);
        expect(checks).toBe(0);
        expect(models).toBe(0);
        return;
      }
      await runtime.resumeRun(resume);
      expect(effects).toBe(0);
      await runtime.answerInteraction({
        expectedStoreId,
        commandId: 'answer',
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        subjectId: 'owner',
        answer: { kind: 'approval', decision: 'approve' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 4000 });
      expect((await store.getExecution(target.id))!.status).toBe('succeeded');
      expect((await store.getRun(target.runId!))!.configuration).toEqual(original.configuration);
      expect(effects).toBe(1);
      expect(checks).toBe(0);
      expect(models).toBe(1);
      expect((await store.listExecutions('s')).filter((item) => item.childSessionId)).toEqual(
        before
          .filter((item) => item.childSessionId)
          .map((item) => ({
            ...item,
            ownerGeneration: (BigInt(item.ownerGeneration) + 1n).toString(),
          })),
      );
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

test('legacy check pointer still rejects a saved invalidation for the exact original target', () => {
  const { root, profile } = unpack('approved');
  const sql = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
  try {
    const db = {
      row(query: string, ...args: (string | number | bigint | null)[]) {
        const statement = sql.query(query);
        (
          statement as typeof statement & { safeIntegers(value: boolean): typeof statement }
        ).safeIntegers(true);
        return statement.get(...args);
      },
      rows(query: string, ...args: (string | number | bigint | null)[]) {
        const statement = sql.query(query);
        (
          statement as typeof statement & { safeIntegers(value: boolean): typeof statement }
        ).safeIntegers(true);
        return statement.all(...args);
      },
    } as unknown as SqliteOperations;
    const target = db.row("SELECT * FROM execution WHERE adapter_id='effect'")!;
    const carrier = db.row(
      "SELECT e.* FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE c.kind='authorization.review'",
    )!;
    const card = db.row('SELECT * FROM interaction WHERE execution_id=?', target.id!)!;
    const input = {
      expectedStoreId: String(target.origin_store_id),
      executionId: String(target.id),
      authorization: {
        allowed: true,
        revision: 'p1',
        checkExecutionId: String(carrier.id),
        interactionId: String(card.id),
      },
    } as DispatchInput;
    expect(() => verifyAuthorizationReviewDispatch(db, input)).not.toThrow();
    // Fault-inject only a persisted invalidation, retaining the exact scope and
    // subject of the real original command. No model/result/approval proof is altered.
    const command = sql
      .query<Record<string, string | number | null>, [string]>('SELECT * FROM command WHERE id=?')
      .get(String(target.origin_command_id))!;
    command.id = 'legacy-invalidation';
    command.seq = Number(
      (db.row('SELECT MAX(seq) AS seq FROM command WHERE session_id=?', target.session_id!)!
        .seq as bigint) + 1n,
    );
    command.kind = 'authorization.invalidate';
    command.status = 'applied';
    command.receipt_json = JSON.stringify({
      targetExecutionId: target.id,
      reviewExecutionId: carrier.id,
      policyRevision: 'p1',
    });
    sql
      .query(
        `INSERT INTO command(${Object.keys(command).join(',')}) VALUES(${Object.keys(command)
          .map(() => '?')
          .join(',')})`,
      )
      .run(...Object.values(command));
    expect(() => verifyAuthorizationReviewDispatch(db, input)).toThrow('permission_denied');
  } finally {
    sql.close();
    rmSync(root, { recursive: true, force: true });
  }
});
