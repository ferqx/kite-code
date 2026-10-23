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
    holdReport?: boolean;
    apply?: (input: Parameters<Apply>[0], actual: Apply) => ReturnType<Apply>;
    plan?: (input: Parameters<Plan>[0], actual: Plan) => ReturnType<Plan>;
    slowObservers?: boolean;
    childContent?: string;
  } = {},
) {
  const holdReport = options.holdReport ?? false,
    holdOriginal = options.active ?? false,
    holdAuthorization = false;
  const root = temporaryDirectory('kite-completion-notification-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const actualStore = await openSqliteStore(profile);
  const store = new Proxy(actualStore, {
    get(target, key) {
      if (key === 'receiveAgentMessages' && options.apply)
        return async (mailInput: Parameters<Store['receiveAgentMessages']>[0]) => {
          if (!mailInput.resultOptions || mailInput.messageIds.length !== 1)
            return target.receiveAgentMessages(mailInput);
          const commandId = mailInput.messageIds[0]!;
          let received: string[] = [];
          // Existing fault assertions observe the old application result shape,
          // but every commit below executes the real unified mailbox receiver.
          const apply: Apply = async (input) => {
            const before = await target.getCommand(commandId);
            received = await target.receiveAgentMessages({
              ...mailInput,
              resultOptions: {
                authorization: input.authorization,
                activeOnly: input.activeOnly,
                carriedMessageIds: input.carriedMessageIds,
                recovery: input.recovery,
              },
            });
            const command = (await target.getCommand(commandId))!;
            const receipt = command.receipt as { runId?: string; mode?: string };
            return {
              command,
              run: receipt.runId ? await target.getRun(receipt.runId) : null,
              started:
                before?.status !== 'applied' &&
                command.status === 'applied' &&
                receipt.mode === 'idle_new_turn',
            };
          };
          await options.apply!(
            {
              expectedStoreId: mailInput.expectedStoreId,
              owner: mailInput.owner,
              commandId,
              ...mailInput.resultOptions,
            },
            apply,
          );
          return received;
        };
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
      yield { type: 'text_delta', text: options.childContent ?? `Complete result C${index + 1}` };
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

async function expectPublicChildResult(
  f: Awaited<ReturnType<typeof fixture>>,
  sourceId: string,
  executionId: string,
) {
  const execution = (await f.store.getExecution(executionId))!;
  const child = (await f.store.getSession(execution.childSessionId!))!;
  const messages = await f.store.listMessages('root');
  const projected = messages.filter((message) => message.agentResult);
  expect(projected).toHaveLength(1);
  const message = projected[0]!;
  expect(message).toMatchObject({
    id: sourceId,
    role: 'system',
    status: 'complete',
    content: 'Complete result C1',
    sourceIds: [sourceId],
    agentResult: {
      sourceId,
      executionId,
      resultRevision: execution.resultRevision,
      childSessionId: child.id,
      name: child.title,
      outcome: 'succeeded',
      contentComplete: true,
    },
  });
  expect(message.agentResult!.childRunId).toBeString();
  expect((await f.store.getRun(message.agentResult!.childRunId!))!.sessionId).toBe(child.id);
  expect((await f.store.getRun(message.runId!))!.sessionId).toBe('root');
  expect((await f.store.getView('root')).messages).toEqual(messages);
  const paged: typeof messages = [];
  let afterSeq = '0';
  for (;;) {
    const page = await f.store.listMessages('root', { afterSeq, limit: 1 });
    if (!page.length) break;
    paged.push(...page);
    afterSeq = page[0]!.seq;
  }
  expect(paged).toEqual(messages);
  expect(
    await f.store.listMessages('root', {
      afterSeq: String(BigInt(message.seq) - 1n),
      upperSeq: message.seq,
      limit: 1,
    }),
  ).toEqual([message]);
  // Presentation is virtual: neither a second model input nor a physical message is written.
  expect(f.db.query('SELECT id FROM message WHERE id=?').get(sourceId)).toBeNull();
  expect(
    f.requests.at(-1)!.messages.filter((entry) => entry.sourceIds?.includes(sourceId)),
  ).toHaveLength(1);
  const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
  try {
    expect(await cold.listMessages('root')).toEqual(messages);
  } finally {
    await cold.close();
  }
}

test('an active parent accepts child data without a bubble, including after that parent completes and reopens', async () => {
  const accepted = gate(),
    continueParent = gate();
  const f = await fixture(1, {
    active: true,
    apply: async (input, actual) => {
      const result = await actual(input);
      if (result.command.status === 'applied') {
        accepted.release();
        await continueParent.waiting;
      }
      return result;
    },
  });
  try {
    await f.submit();
    await until(async () => (f.requests.length === 2 ? true : null));
    f.childGates[0]!.release();
    await until(async () => (f.reports().length === 1 ? true : null));
    f.reportGate.release();
    await accepted.waiting;
    const report = f.reports()[0]!;
    expect(report.receipt.mode).toBe('active');
    expect(report.receipt.outcome).toBe('report_received');
    expect((await f.store.getRun(report.receipt.runId!))!.isActive).toBe(true);
    expect((await f.store.listMessages('root')).some((message) => message.agentResult)).toBe(false);
    continueParent.release();
    await f.runtime.waitForCommand(report.id, { timeoutMs: 5000 });
    expect((await f.store.getRun(report.receipt.runId!))!.isActive).toBe(false);
    expect((await f.store.getView('root')).messages.some((message) => message.agentResult)).toBe(
      false,
    );
    expect(
      f.requests
        .at(-1)!
        .messages.filter((message) => message.sourceIds?.includes(report.receipt.sourceId!)),
    ).toHaveLength(1);
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await cold.listMessages('root')).some((message) => message.agentResult)).toBe(false);
    } finally {
      await cold.close();
    }
  } finally {
    continueParent.release();
    await f.close();
  }
}, 10000);

test('only an idle result-created continuation publishes one bubble before and after its Run ends', async () => {
  const f = await fixture(1, { holdReport: true });
  const writer = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  const update = (sql: string, ...values: string[]) => writer.query(sql).run(...values);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    f.childGates[0]!.release();
    const report = await until(
      async () => f.reports().find((entry) => entry.status === 'applied') ?? null,
    );
    await until(async () => (f.requests.length === 3 ? true : null));
    const runId = report.receipt.runId!;
    const sourceId = report.receipt.sourceId!;
    const executionId = JSON.parse(report.request_json).executionId as string;
    expect(report.receipt.mode).toBe('idle_new_turn');
    expect(report.receipt.outcome).toBe('report_started');
    expect((await f.store.getRun(runId))!.isActive).toBe(true);
    expect((await f.store.getRun(runId))!.originCommandId).toBe(report.id);
    await expectPublicChildResult(f, sourceId, executionId);
    const visible = async () =>
      (await f.store.listMessages('root')).filter((message) => message.agentResult);
    // Source consumption alone and a claimed mode are insufficient: every idle
    // report identity must match its exact Source and the Run it actually created.
    for (const [field, wrong] of [
      ['mode', 'active'],
      ['outcome', 'report_received'],
      ['sourceId', 'another-source'],
      ['executionId', 'another-carrier'],
      ['resultRevision', '999'],
      ['runId', 'another-run'],
      ['contextSelectionId', 'another-selection'],
    ]) {
      update(
        'UPDATE command SET receipt_json=? WHERE id=?',
        JSON.stringify({ ...report.receipt, [field!]: wrong }),
        report.id,
      );
      expect(await visible()).toEqual([]);
      update(
        'UPDATE command SET receipt_json=? WHERE id=?',
        JSON.stringify(report.receipt),
        report.id,
      );
    }
    for (const [field, wrong] of [
      ['executionId', 'another-carrier'],
      ['resultRevision', '999'],
      ['contextSelectionId', 'another-selection'],
    ]) {
      update(
        'UPDATE command SET request_json=? WHERE id=?',
        JSON.stringify({ ...JSON.parse(report.request_json), [field!]: wrong }),
        report.id,
      );
      expect(await visible()).toEqual([]);
      update('UPDATE command SET request_json=? WHERE id=?', report.request_json, report.id);
    }
    update('UPDATE run SET origin_command_id=? WHERE id=?', 'create', runId);
    expect(await visible()).toEqual([]);
    update('UPDATE run SET origin_command_id=? WHERE id=?', report.id, runId);
    expect(await visible()).toHaveLength(1);
    f.reportGate.release();
    await f.runtime.waitForCommand(report.id, { timeoutMs: 5000 });
    expect((await f.store.getRun(runId))!.isActive).toBe(false);
    await expectPublicChildResult(f, sourceId, executionId);
  } finally {
    f.reportGate.release();
    writer.close();
    await f.close();
  }
}, 10000);

test('public child results require accepted exact provenance, isolate malformed proofs and distinguish an artifact preview', async () => {
  const body = 'Complete large child output.\n'.repeat(3000);
  const f = await fixture(1, { childContent: body });
  const writer = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  // The real Runtime owner may briefly hold the WAL writer while the fixture
  // restores its exact index/trigger definitions after corruption probes.
  writer.exec('PRAGMA busy_timeout=1000');
  const update = (sql: string, ...values: string[]) => writer.query(sql).run(...values);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    f.childGates[0]!.release();
    const report = await until(
      async () => f.reports().find((entry) => entry.status === 'applied') ?? null,
    );
    await f.runtime.waitForCommand(report.id, { timeoutMs: 5000 });
    const sourceId = report.receipt.sourceId!;
    const resultMessage = () =>
      f.store
        .listMessages('root')
        .then((messages) => messages.find((message) => message.id === sourceId));
    const message = (await resultMessage())!;
    expect(message.agentResult?.contentComplete).toBe(false);
    expect(message.content).not.toBe(body);
    expect(message.content).toContain('complete output available');
    const executionId = message.agentResult!.executionId;
    const execution = (await f.store.getExecution(executionId))!;
    expect(message.content).toBe((execution.result as { content: string }).content);
    const source = writer.query('SELECT * FROM context_snapshot WHERE id=?').get(sourceId) as {
      request_json: string;
      subject_id: string;
    };
    const physicalMessages = (await f.store.listMessages('root')).filter(
      (entry) => !entry.agentResult,
    );
    const consume = writer
      .query(
        "SELECT id,request_json,receipt_json FROM command WHERE kind='job_result.consume' AND json_extract(receipt_json,'$.sourceId')=?",
      )
      .get(sourceId) as {
      id: string;
      request_json: string;
      receipt_json: string;
    };
    // These unrelated reconciliation/queue schema expressions evaluate receipt
    // JSON on UPDATE. This fixture removes them only to represent damaged bytes,
    // then restores their exact definitions after restoring every proof row.
    const index = writer
      .query("SELECT sql FROM sqlite_master WHERE type='index' AND name='job_reconcile_verified'")
      .get() as { sql: string };
    const queueTrigger = writer
      .query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='pending_input_queue_update'",
      )
      .get() as { sql: string };
    writer.run('DROP INDEX job_reconcile_verified');
    writer.run('DROP TRIGGER pending_input_queue_update');
    try {
      for (const [table, column, id, original] of [
        ['context_snapshot', 'request_json', sourceId, source.request_json],
        ['execution', 'result_json', executionId, JSON.stringify(execution.result)],
        ['command', 'request_json', consume.id, consume.request_json],
        ['command', 'receipt_json', consume.id, consume.receipt_json],
        ['command', 'request_json', report.id, report.request_json],
        ['command', 'receipt_json', report.id, JSON.stringify(report.receipt)],
      ]) {
        // Real SQLite corruption must hide only this virtual child result from
        // message history. View already decodes Source/Execution facts separately:
        // their damaged JSON retains that pre-existing explicit failure boundary.
        update(`UPDATE ${table} SET ${column}=? WHERE id=?`, '{broken', id!);
        try {
          expect(await f.store.listMessages('root')).toEqual(physicalMessages);
          // Consume proof is a new View dependency introduced by this projection.
          if (table === 'command' && id === consume.id)
            expect((await f.store.getView('root')).messages).toEqual(physicalMessages);
        } finally {
          update(`UPDATE ${table} SET ${column}=? WHERE id=?`, original!, id!);
        }
        expect(await resultMessage()).toEqual(message);
      }
    } finally {
      writer.run(index.sql);
      writer.run(queueTrigger.sql);
    }
    const childStart = writer
      .query(
        'SELECT c.id,c.request_json FROM command c JOIN run r ON r.origin_command_id=c.id WHERE r.id=?',
      )
      .get(message.agentResult!.childRunId!) as { id: string; request_json: string };
    update('UPDATE command SET request_json=? WHERE id=?', '{broken', childStart.id);
    try {
      const withoutRunProof = {
        ...message,
        agentResult: { ...message.agentResult!, childRunId: null },
      };
      expect(await resultMessage()).toEqual(withoutRunProof);
      expect(
        (await f.store.getView('root')).messages.find((entry) => entry.id === sourceId),
      ).toEqual(withoutRunProof);
    } finally {
      update(
        'UPDATE command SET request_json=? WHERE id=?',
        childStart.request_json,
        childStart.id,
      );
    }
    expect(await resultMessage()).toEqual(message);
    // Observation uses raw history, independently of the Model's selected context branch.
    const selection = writer
      .query("SELECT context_selection_id FROM session WHERE id='root'")
      .get() as {
      context_selection_id: string;
    };
    update("UPDATE session SET context_selection_id='other-observation-branch' WHERE id='root'");
    expect(await resultMessage()).toEqual(message);
    update(
      'UPDATE session SET context_selection_id=? WHERE id=?',
      selection.context_selection_id,
      'root',
    );
    for (const flag of ['pendingInput', 'statusOnly', 'diagnostic']) {
      update(
        'UPDATE context_snapshot SET request_json=? WHERE id=?',
        JSON.stringify({ ...JSON.parse(source.request_json), [flag]: true }),
        sourceId,
      );
      expect(await resultMessage()).toBeUndefined();
      update(
        'UPDATE context_snapshot SET request_json=? WHERE id=?',
        source.request_json,
        sourceId,
      );
    }
    update("UPDATE context_snapshot SET subject_id='foreign' WHERE id=?", sourceId);
    expect(await resultMessage()).toBeUndefined();
    update('UPDATE context_snapshot SET subject_id=? WHERE id=?', source.subject_id, sourceId);
    update('UPDATE execution SET result_revision=result_revision+1 WHERE id=?', executionId);
    expect(await resultMessage()).toBeUndefined();
    update(
      'UPDATE execution SET result_revision=? WHERE id=?',
      execution.resultRevision,
      executionId,
    );
    update(
      "UPDATE execution SET result_json=json_set(result_json,'$.outcome','failed') WHERE id=?",
      executionId,
    );
    expect(await resultMessage()).toBeUndefined();
    update(
      'UPDATE execution SET result_json=? WHERE id=?',
      JSON.stringify(execution.result),
      executionId,
    );
    update("UPDATE execution SET kind='model' WHERE id=?", executionId);
    expect(await resultMessage()).toBeUndefined();
    update("UPDATE execution SET kind='job' WHERE id=?", executionId);
    expect(await resultMessage()).toEqual(message);
  } finally {
    writer.close();
    await f.close();
  }
}, 10000);

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
        expect((await f.store.listMessages('root')).some((message) => message.agentResult)).toBe(
          false,
        );
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
        if (active) {
          // An active admission stays process data even after that parent Run ends.
          expect(committed.receipt.mode).toBe('active');
          expect((await f.store.getRun(committed.receipt.runId!))!.isActive).toBe(false);
          expect((await f.store.listMessages('root')).some((message) => message.agentResult)).toBe(
            false,
          );
          const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
          try {
            expect(
              (await cold.getView('root')).messages.some((message) => message.agentResult),
            ).toBe(false);
          } finally {
            await cold.close();
          }
          // Rewriting an active ack's label cannot make its existing Run a result-created Run.
          writer.query('UPDATE command SET receipt_json=? WHERE id=?').run(
            JSON.stringify({
              ...committed.receipt,
              mode: 'idle_new_turn',
              outcome: 'report_started',
            }),
            committed.id,
          );
          expect((await f.store.listMessages('root')).some((message) => message.agentResult)).toBe(
            false,
          );
          writer
            .query('UPDATE command SET receipt_json=? WHERE id=?')
            .run(JSON.stringify(committed.receipt), committed.id);
        } else await expectPublicChildResult(f, committed.receipt.sourceId!, executionId);
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
