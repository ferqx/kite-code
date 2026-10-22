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
import type { Store } from '../../../../src/storage/port';

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
type Apply = Store['applyJobReport'];
type Plan = Store['planExecution'];
async function fixture(
  count: number,
  options: {
    active?: boolean;
    apply?: (input: Parameters<Apply>[0], actual: Apply) => ReturnType<Apply>;
    plan?: (input: Parameters<Plan>[0], actual: Plan) => ReturnType<Plan>;
    slowObservers?: boolean;
  } = {},
) {
  const holdReport = false,
    holdOriginal = options.active ?? false,
    holdAuthorization = false;
  const root = temporaryDirectory('kite-completion-notification-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const actualStore = await openSqliteStore(profile);
  const store = new Proxy(actualStore, {
    get(target, key) {
      if (key === 'applyJobReport' && options.apply)
        return (input: Parameters<Apply>[0]) =>
          options.apply!(input, target.applyJobReport.bind(target));
      if (key === 'planExecution' && options.plan)
        return (input: Parameters<Plan>[0]) =>
          options.plan!(input, target.planExecution.bind(target));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const storeId = (await store.getMetadata()).storeId;
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
  let observations = 0;
  const observe = () => {
    observations++;
    return new Promise<void>(() => {});
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: parent,
    modelId: 'parent',
    modelConcurrency: 4,
    extensions: [
      task,
      ...(options.slowObservers
        ? [
            {
              id: 'slow-observer',
              version: '1',
              apiMajor: 1 as const,
              lifecycle: {
                onModelStart: observe,
                onModelEnd: observe,
                onRunStart: observe,
                onRunEnd: observe,
              },
            },
          ]
        : []),
    ],
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
    observations: () => observations,
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

for (const active of [false, true])
  for (const stage of ['source', 'ack'] as const) {
    test(`new completion ${active ? 'active' : 'idle'} ${stage} SQL failure rolls target Source and ack back, exact retry commits once`, async () => {
      const fault = gate(),
        retry = gate();
      let failure: unknown,
        once = false;
      const f = await fixture(1, {
        active,
        apply: async (input, actual) => {
          try {
            return await actual(input);
          } catch (error) {
            if (once) throw error;
            once = true;
            failure = error;
            fault.release();
            await retry.waiting;
            return actual(input);
          }
        },
      });
      const writer = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
      try {
        await f.submit();
        if (active) await until(async () => (f.requests.length === 2 ? true : null));
        else await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
        await until(async () => (f.childRequests.length === 1 ? true : null));
        const initialRuns = (await f.store.getView('root')).runs;
        writer.run(
          stage === 'source'
            ? "CREATE TRIGGER report_fault BEFORE INSERT ON context_snapshot WHEN NEW.kind='result_ref' BEGIN SELECT RAISE(ABORT,'source_fault'); END"
            : "CREATE TRIGGER report_fault BEFORE UPDATE OF receipt_json ON command WHEN NEW.kind='job.report' AND json_extract(NEW.receipt_json,'$.sourceId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'ack_fault'); END",
        );
        f.childGates[0]!.release();
        if (active) {
          await until(async () => (f.reports().length === 1 ? true : null));
          f.reportGate.release();
        }
        await fault.waiting;
        expect(failure).toBeTruthy();
        const report = f.reports()[0]!;
        expect(report.status).toBe('accepted');
        expect(report.receipt.runId).toBeUndefined();
        expect(report.receipt.sourceId).toBeUndefined();
        expect((await f.store.getView('root')).runs).toEqual(initialRuns);
        const executionId = JSON.parse(report.request_json).executionId as string;
        expect((await f.store.getExecution(executionId))!.delivery).toBe('pending');
        expect(
          f.db
            .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
            .all(executionId),
        ).toHaveLength(0);
        expect(await f.store.getCommand(`consume-${report.id}`)).toBeNull();
        writer.run('DROP TRIGGER report_fault');
        retry.release();
        const committed = await until(
          async () => f.reports().find((value) => value.status === 'applied') ?? null,
        );
        if (active) f.reportGate.release();
        await f.runtime.waitForCommand(report.id, { timeoutMs: 5000 });
        expect(committed.id).toBe(report.id);
        expect(committed.receipt.sourceId).toBeString();
        expect(
          f.db
            .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
            .all(executionId),
        ).toHaveLength(1);
        expect((await f.store.getView('root')).runs).toHaveLength(active ? 1 : 2);
        expect(f.childRequests).toHaveLength(1);
        expect(f.requests).toHaveLength(3);
        expect(
          f.requests
            .at(-1)!
            .messages.some((message) => message.sourceIds?.includes(committed.receipt.sourceId!)),
        ).toBe(true);
      } finally {
        writer.run('DROP TRIGGER IF EXISTS report_fault');
        retry.release();
        writer.close();
        await f.close();
      }
    });
  }

for (const active of [false, true])
  test(`committed ${active ? 'active' : 'idle'} report with a genuinely lost Store response resumes its saved Run and Source once`, async () => {
    const committed = gate();
    let lost = false;
    let saved: Awaited<ReturnType<Apply>> | undefined;
    const f = await fixture(1, {
      active,
      apply: async (input, actual) => {
        const result = await actual(input);
        if (!lost && result.command.status === 'applied') {
          lost = true;
          saved = result;
          committed.release();
          throw Error('owned fixture lost applyJobReport response after commit');
        }
        return result;
      },
    });
    try {
      await f.submit();
      if (active) await until(async () => (f.requests.length === 2 ? true : null));
      else await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      await until(async () => (f.childRequests.length === 1 ? true : null));
      f.childGates[0]!.release();
      if (active) {
        await until(async () => (f.reports().length === 1 ? true : null));
        f.reportGate.release();
      }
      await committed.waiting;
      const report = await f.store.getCommand(saved!.command.id);
      expect(report?.status).toBe('applied');
      expect(report?.receipt).toEqual(saved!.command.receipt);
      expect((await f.store.getView('root')).runs).toHaveLength(active ? 1 : 2);
      const receipt = report!.receipt as { runId: string; sourceId: string };
      expect((await f.store.getRun(receipt.runId))!.id).toBe(saved!.run!.id);
      expect(
        f.db
          .query("SELECT id FROM context_snapshot WHERE id=? AND kind='result_ref'")
          .all(receipt.sourceId),
      ).toHaveLength(1);
      await until(async () =>
        f.requests.length === 3 && !(await f.store.getRun(receipt.runId))!.isActive ? true : null,
      );
      expect(f.requests).toHaveLength(3);
      expect(f.childRequests).toHaveLength(1);
      expect(
        f.requests[2]!.messages.some((message) => message.sourceIds?.includes(receipt.sourceId)),
      ).toBe(true);
      expect(f.reports()).toHaveLength(1);
      expect((await f.store.getView('root')).runs).toHaveLength(active ? 1 : 2);
    } finally {
      await f.close();
    }
  });

test('a queued ordinary prompt wins idle completion admission; its active Run receives the original result once', async () => {
  const entered = gate(),
    admit = gate();
  let held = false;
  let deferred: Awaited<ReturnType<Apply>> | undefined;
  const f = await fixture(1, {
    apply: async (input, actual) => {
      const hold = !held && !!input.authorization;
      if (hold) {
        held = true;
        entered.release();
        await admit.waiting;
      }
      const result = await actual(input);
      if (hold) deferred = result;
      return result;
    },
  });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => (f.childRequests.length === 1 ? true : null));
    f.childGates[0]!.release();
    await entered.waiting;
    const view = await f.store.getView('root');
    await f.runtime.submitCommand({
      ...f.base,
      sessionId: 'root',
      commandId: 'queued',
      request: {
        kind: 'input.follow_up',
        content: 'Queued B',
        afterRunId: view.runs.at(-1)!.id,
        contextSelectionId: view.session.contextSelectionId,
      },
    });
    expect((await f.store.getView('root')).runs).toHaveLength(1);
    admit.release();
    await f.runtime.waitForCommand('queued', { timeoutMs: 5000 });
    expect(deferred?.command.receipt).toMatchObject({
      outcome: 'report_deferred',
      reason: 'human_business_queued',
    });
    const current = await f.store.getView('root');
    expect(current.runs.map((run) => run.originCommandId)).toEqual(['work', 'queued']);
    expect(f.reports()[0]?.receipt).toMatchObject({ mode: 'active', runId: current.runs[1]!.id });
    expect(f.requests).toHaveLength(3);
    expect(
      f.requests[2]!.messages.some((message) => message.content.includes('Complete result C1')),
    ).toBe(true);
    expect(
      f.db.query("SELECT id FROM context_snapshot WHERE kind='result_ref'").all(),
    ).toHaveLength(1);
    expect(
      f.db
        .query("SELECT id FROM command WHERE kind IN ('human.input','human.input.decision')")
        .all(),
    ).toHaveLength(0);
  } finally {
    admit.release();
    await f.close();
  }
});

test('stopping after report ack but before Model preparation retains its original target and never retargets the Source to B', async () => {
  const preparing = gate(),
    release = gate();
  let held = false;
  const f = await fixture(1, {
    plan: async (input, actual) => {
      if (
        !held &&
        input.kind === 'model' &&
        input.sessionId === 'root' &&
        input.originCommandId.startsWith('report-')
      ) {
        held = true;
        preparing.release();
        await release.waiting;
      }
      return actual(input);
    },
  });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => (f.childRequests.length === 1 ? true : null));
    f.childGates[0]!.release();
    await preparing.waiting;
    const report = f.reports().find((value) => value.status === 'applied')!,
      originalReceipt = JSON.stringify(report.receipt);
    expect(report.receipt.runId).toBeString();
    expect(report.receipt.sourceId).toBeString();
    expect(f.requests).toHaveLength(2);
    expect(
      f.db
        .query(
          "SELECT id FROM execution WHERE session_id='root' AND origin_command_id=? AND kind='model'",
        )
        .all(report.id),
    ).toHaveLength(0);
    await f.runtime.cancelRun({
      ...f.base,
      sessionId: 'root',
      commandId: 'stop',
      runId: report.receipt.runId!,
    });
    release.release();
    await until(async () =>
      !(await f.store.getRun(report.receipt.runId!))!.isActive ? true : null,
    );
    await f.submit('b', '新任务 B');
    await f.runtime.waitForCommand('b', { timeoutMs: 5000 });
    expect(JSON.stringify(f.reports()[0]!.receipt)).toBe(originalReceipt);
    expect(f.requests).toHaveLength(3);
    expect(
      f.db
        .query(
          "SELECT id FROM execution WHERE session_id='root' AND origin_command_id=? AND kind='model'",
        )
        .all(report.id),
    ).toHaveLength(0);
    const source = f.db
      .query('SELECT request_json FROM context_snapshot WHERE id=?')
      .get(report.receipt.sourceId!) as { request_json: string };
    expect(JSON.parse(source.request_json).targetRunId).toBe(report.receipt.runId);
    expect(
      f.db.query("SELECT id FROM context_snapshot WHERE kind='result_ref'").all(),
    ).toHaveLength(1);
  } finally {
    release.release();
    await f.close();
  }
});

test('slow never-settling lifecycle observers overflow while two real child completions still reach actual parent Models', async () => {
  const f = await fixture(2, { slowObservers: true });
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => (f.childRequests.length === 2 ? true : null));
    for (const child of f.childGates) child.release();
    const reports = await until(async () => {
      const rows = f.reports();
      return rows.length === 2 && rows.every((value) => value.status === 'applied') ? rows : null;
    });
    await until(async () =>
      (await f.store.getView('root')).runs.every((value) => !value.isActive) ? true : null,
    );
    expect(f.observations()).toBe(1);
    expect(f.childRequests).toHaveLength(2);
    const views = await Promise.all(
      [
        ...new Set([
          'root',
          ...(await f.store.listExecutions('root')).flatMap((value) =>
            value.childSessionId ? [value.childSessionId] : [],
          ),
        ]),
      ].map((id) => f.store.getView(id)),
    );
    const modelFacts = views
      .flatMap((view) => view.executions)
      .filter((value) => value.kind === 'model');
    const runFacts = views.flatMap((view) => view.runs);
    expect((modelFacts.length + runFacts.length) * 2).toBeGreaterThan(17);
    for (const report of reports)
      expect(
        f.requests.some((request) =>
          request.messages.some((message) => message.sourceIds?.includes(report.receipt.sourceId!)),
        ),
      ).toBe(true);
    expect(
      f.db.query("SELECT id FROM context_snapshot WHERE kind='result_ref'").all(),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});
