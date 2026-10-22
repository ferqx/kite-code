import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
function gate() {
  let release!: () => void;
  return {
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('collaboration_notification_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(
  count: number,
  holdReport = false,
  holdOriginal = false,
  holdAuthorization = false,
) {
  const root = temporaryDirectory('kite-completion-notification-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId: storeId, subjectId: 'owner' };
  const childGates = Array.from({ length: count }, gate),
    reportGate = gate(),
    authorizationGate = gate(),
    businessGate = gate();
  const requests: ModelRequest[] = [],
    childRequests: ModelRequest[] = [];
  let applyPolicies = 0;
  const parent: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        for (let index = 0; index < count; index++)
          yield {
            type: 'tool_call',
            id: `spawn-${index}`,
            name: 'spawn_agent',
            arguments: JSON.stringify({ prompt: `Assignment C${index + 1}` }),
          };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        if (
          request.messages.filter((message) => message.role === 'user').at(-1)?.content ===
          'Independent B'
        )
          await businessGate.waiting;
        if ((holdReport && requests.length === 3) || (holdOriginal && requests.length === 2))
          await reportGate.waiting;
        yield { type: 'text_delta', text: 'Actual parent response using received sources' };
        yield finish;
      }
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      childRequests.push(structuredClone(request));
      const content = request.messages.map((message) => message.content).join('\n');
      const index = Number(content.match(/Assignment C([0-9]+)/)?.[1]) - 1;
      if (!Number.isInteger(index) || index < 0 || !childGates[index])
        throw Error('child_assignment_missing');
      await childGates[index]!.waiting;
      yield { type: 'text_delta', text: `Complete result C${index + 1}` };
      yield finish;
    },
  };
  const task = createTaskExtension({
    roles: [{ id: 'worker', configurationId: 'worker', description: 'General child' }],
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 4,
    extensions: [task],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture-current' };
      },
    },
    afterTurn: {
      async authorize(input) {
        if (input.phase === 'apply') {
          applyPolicies++;
          if (holdAuthorization) await authorizationGate.waiting;
        }
        return { allowed: true, revision: 'completion-policy' };
      },
    },
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...base,
    sessionId: 'root',
    commandId: 'create',
    workspaceId: 'w',
    title: 'root',
  });
  const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'), { readonly: true });
  const reports = () =>
    (
      db
        .query(
          "SELECT id,status,receipt_json,request_json,root_work_command_id FROM command WHERE session_id='root' AND kind='job.report' ORDER BY seq",
        )
        .all() as {
        id: string;
        status: string;
        receipt_json: string;
        request_json: string;
        root_work_command_id: string;
      }[]
    ).map((row) => ({
      ...row,
      receipt: JSON.parse(row.receipt_json) as {
        runId?: string;
        sourceId?: string;
        reason?: string;
        mode?: string;
        outcome?: string;
      },
    }));
  const submit = (commandId = 'work', content = 'Coordinate original work') =>
    runtime.submitCommand({
      ...base,
      sessionId: 'root',
      commandId,
      request: { kind: 'run.start', content },
    });
  return {
    runtime,
    store,
    base,
    profile,
    requests,
    childRequests,
    childGates,
    reportGate,
    authorizationGate,
    businessGate,
    reports,
    submit,
    policies: () => applyPolicies,
    db,
    async close() {
      for (const child of childGates) child.release();
      reportGate.release();
      authorizationGate.release();
      businessGate.release();
      await runtime.close();
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('new completion subscription wakes an idle parent once and prepares its exact durable result Source with all on observers absent', async () => {
  const f = await fixture(1);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.requests).toHaveLength(2);
    await until(async () => (f.childRequests.length === 1 ? true : null));
    f.childGates[0]!.release();
    const report = await until(
      async () => f.reports().find((row) => row.status === 'applied') ?? null,
    );
    await f.runtime.waitForCommand(report.id, { timeoutMs: 5000 });
    expect(report.receipt.mode).toBe('idle_new_turn');
    expect(report.receipt.sourceId).toBeString();
    expect(f.requests).toHaveLength(3);
    expect(
      f.requests[2]!.messages.some(
        (message) =>
          message.sourceIds?.includes(report.receipt.sourceId!) &&
          message.content.includes('Complete result C1'),
      ),
    ).toBe(true);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    expect((await readonly.getCommand(report.id))?.status).toBe('applied');
    await readonly.close();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.requests).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test('a later ordinary turn receives the old child result without selecting or reopening its original work', async () => {
  const f = await fixture(1);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await f.submit('b', 'Independent B');
    await until(async () => (f.requests.length === 3 ? true : null));
    const b = (await f.store.getView('root')).runs.find((run) => run.originCommandId === 'b')!;
    f.childGates[0]!.release();
    await until(async () =>
      (await f.store.listExecutions('root')).some(
        (execution) => execution.childSessionId && execution.status === 'succeeded',
      )
        ? true
        : null,
    );
    await until(async () => (f.reports().length === 1 ? true : null));
    expect(f.policies()).toBe(0);
    f.businessGate.release();
    await f.runtime.waitForCommand('b', { timeoutMs: 5000 });
    const report = f.reports()[0]!;
    expect(report).toMatchObject({ status: 'applied', receipt: { mode: 'active', runId: b.id } });
    expect(f.policies()).toBe(0);
    expect(f.requests).toHaveLength(4);
    expect(f.requests[3]!.messages.some((m) => m.content.includes('Complete result C1'))).toBe(
      true,
    );
    expect((await f.store.getView('root')).runs.map((r) => r.originCommandId)).toEqual([
      'work',
      'b',
    ]);
    const source = f.db
      .query('SELECT request_json FROM context_snapshot WHERE id=?')
      .get(report.receipt.sourceId!) as { request_json: string };
    expect(JSON.parse(source.request_json).targetRunId).toBe(b.id);
    const count = f.requests.length;
    await f.runtime.createWorkspace({
      expectedStoreId: f.base.expectedStoreId,
      id: 'unrelated',
      name: 'unrelated',
      rootUri: pathToFileURL(f.profile.dataRoot).href,
    });
    await Bun.sleep(100);
    expect(f.requests).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test('a completion received during the original active parent Run prepares a Source without an idle authorization or extra Run', async () => {
  const f = await fixture(1, false, true);
  try {
    await f.submit();
    await until(async () => (f.requests.length === 2 ? true : null));
    f.childGates[0]!.release();
    await until(async () => (f.reports().length === 1 ? true : null));
    f.reportGate.release();
    const original = await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const report = await until(
      async () => f.reports().find((row) => row.status === 'applied') ?? null,
    );
    expect(report.receipt.mode).toBe('active');
    expect(report.receipt.runId).toBe((original.receipt as { runId: string }).runId);
    expect(f.policies()).toBe(0);
    expect(
      f.requests.some((request) =>
        request.messages.some((message) => message.sourceIds?.includes(report.receipt.sourceId!)),
      ),
    ).toBe(true);
    expect(
      f.db.query("SELECT COUNT(*) AS count FROM run WHERE session_id='root'").get(),
    ).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

test('two ready results merge into one idle continuation Run and both exact Sources reach its actual Model input', async () => {
  const f = await fixture(2, false, false, true);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    for (const child of f.childGates) child.release();
    await until(async () => (f.reports().length === 2 && f.policies() === 1 ? true : null));
    expect(f.requests).toHaveLength(2);
    f.authorizationGate.release();
    const reports = await until(async () => {
      const rows = f.reports();
      return rows.length === 2 && rows.every((row) => row.status === 'applied') ? rows : null;
    });
    await f.runtime.waitForCommand(
      reports.find((row) => row.receipt.mode === 'idle_new_turn')!.id,
      { timeoutMs: 5000 },
    );
    expect(new Set(reports.map((row) => row.receipt.runId)).size).toBe(1);
    expect(f.requests).toHaveLength(3);
    for (const report of reports)
      expect(
        f.requests[2]!.messages.some((message) =>
          message.sourceIds?.includes(report.receipt.sourceId!),
        ),
      ).toBe(true);
  } finally {
    await f.close();
  }
});

test('a later C2 completion joins the active C1 report Run with a separate Source and durable ack', async () => {
  const f = await fixture(2, true);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    f.childGates[0]!.release();
    await until(async () => (f.requests.length === 3 ? true : null));
    const first = f.reports().find((row) => row.status === 'applied')!;
    f.childGates[1]!.release();
    await until(async () => (f.reports().length === 2 ? true : null));
    f.reportGate.release();
    const all = await until(async () => {
      const reports = f.reports();
      return reports.length === 2 && reports.every((row) => row.status === 'applied')
        ? reports
        : null;
    });
    await f.runtime.waitForCommand(first.id, { timeoutMs: 5000 });
    expect(new Set(all.map((row) => row.receipt.runId)).size).toBe(1);
    expect(all.map((row) => row.receipt.mode).sort()).toEqual(['active', 'idle_new_turn']);
    expect(new Set(all.map((row) => row.receipt.sourceId)).size).toBe(2);
    for (const report of all)
      expect(
        f.requests.some((request) =>
          request.messages.some((message) => message.sourceIds?.includes(report.receipt.sourceId!)),
        ),
      ).toBe(true);
    expect(
      f.db
        .query(
          "SELECT COUNT(*) AS count FROM run WHERE session_id='root' AND origin_command_id IN(SELECT id FROM command WHERE kind='job.report')",
        )
        .get(),
    ).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});
