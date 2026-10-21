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
  reuseChild = false,
) {
  const root = temporaryDirectory('kite-completion-notification-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId: storeId, subjectId: 'owner' };
  const childGates = Array.from({ length: count }, gate),
    reportGate = gate(),
    authorizationGate = gate(),
    businessGate = gate(),
    reusedChildGate = gate();
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
      } else if (reuseChild && requests.length === 3) {
        const spawn = request.messages.find(
          (message) => message.role === 'tool' && message.content?.includes('agent_id'),
        );
        const agent = JSON.parse(spawn!.content!).agent_id;
        yield {
          type: 'tool_call',
          id: 'reuse',
          name: 'follow_up_agent',
          arguments: JSON.stringify({ agent_id: agent, content: 'Continue Assignment C1' }),
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
      if (reuseChild && childRequests.length === 2) await reusedChildGate.waiting;
      else await childGates[index]!.waiting;
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
          "SELECT id,kind,status,receipt_json,request_json,root_work_command_id FROM command WHERE session_id='root' AND kind IN('job.report','job.report.continue','job.report.qualification') ORDER BY seq",
        )
        .all() as {
        id: string;
        kind: string;
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
    reusedChildGate,
    reports,
    submit,
    policies: () => applyPolicies,
    db,
    async close() {
      for (const child of childGates) child.release();
      reportGate.release();
      authorizationGate.release();
      businessGate.release();
      reusedChildGate.release();
      await runtime.close();
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function expectSealedRejectedContinue(
  f: Awaited<ReturnType<typeof fixture>>,
  reason: 'work_resume_unavailable' | 'work_resume_outcome_unknown',
) {
  const scope = { ...f.base, sessionId: 'root' };
  const original = (await f.store.listExecutions('root')).find(
    (execution) => execution.childSessionId,
  )!;
  const childSessionId = original.childSessionId!;
  const appliedDecisions = () =>
    f.db
      .query(
        "SELECT id,seq,request_json,receipt_json,root_work_command_id,root_work_seq FROM command WHERE session_id='root' AND kind='human.input.decision' AND status='applied' ORDER BY seq",
      )
      .all();
  const before = {
    appliedDecisions: appliedDecisions(),
    contextSelectionId: (await f.store.getSession('root'))!.contextSelectionId,
    work: await f.store.readHumanWorkState(scope),
    carrier: await f.store.getExecution(original.id),
    reports: f.reports(),
    rootRuns: (await f.store.getView('root')).runs,
    childRuns: (await f.store.getView(childSessionId)).runs,
    parentRequests: f.requests.length,
    childRequests: f.childRequests.length,
  };
  // Registering the real raw input consumes one revision. The refused decision
  // must seal that exact post-intake revision without applying a control/selection.
  const intakeRevision = String(BigInt(before.work.controlRevision) + 1n);
  const returned = await f.submit('continue', '继续当前任务 work');
  expect(returned).toMatchObject({
    kind: 'run.start',
    status: 'rejected',
    receipt: {
      outcome: 'human_input_rejected',
      controlRevision: intakeRevision,
      reason,
      businessCommandId: null,
      runId: null,
      ...(reason === 'work_resume_unavailable' ? { revocationReason: 'work_stopped' } : {}),
    },
  });
  const receipt = returned.receipt as { humanInputCommandId: string; decisionCommandId: string };
  const publicCommand = (await f.store.getCommand('continue'))!;
  expect(returned).toEqual(publicCommand);
  const raw = (await f.store.getCommand(receipt.humanInputCommandId))!;
  expect(raw).toMatchObject({
    kind: 'human.input',
    sessionId: 'root',
    originStoreId: f.base.expectedStoreId,
    subjectId: f.base.subjectId,
    request: { publicCommandId: 'continue', content: '继续当前任务 work' },
    receipt: {
      state: 'decided',
      observedControlRevision: before.work.controlRevision,
      controlRevision: intakeRevision,
      applicationState: 'rejected',
      decisionCommandId: receipt.decisionCommandId,
      businessCommandId: null,
      rejection: returned.receipt,
    },
  });
  const decision = (await f.store.getCommand(receipt.decisionCommandId))!;
  expect(decision).toMatchObject({
    kind: 'human.input.decision',
    status: 'rejected',
    sessionId: raw.sessionId,
    originStoreId: raw.originStoreId,
    subjectId: raw.subjectId,
    request: {
      inputCommandId: raw.id,
      inputDigest: raw.requestDigest,
      expectedControlRevision: intakeRevision,
      proposal: {
        relation: 'same_work',
        purpose: 'continue',
        targetRootWorkCommandId: 'work',
        selectionEffect: 'select_work',
      },
    },
    receipt: {
      outcome: 'human_input_rejected',
      controlRevision: intakeRevision,
      reason,
      purpose: 'continue',
      targetRootWorkCommandId: 'work',
      selectionEffect: 'keep',
      businessCommandId: null,
      runId: null,
      rejection: returned.receipt,
      ...(reason === 'work_resume_unavailable' ? { revocationReason: 'work_stopped' } : {}),
    },
  });
  const afterWork = await f.store.readHumanWorkState(scope);
  expect(afterWork.selectedWork).toEqual(before.work.selectedWork);
  expect(afterWork.controlRevision).toBe(intakeRevision);
  expect(appliedDecisions()).toEqual(before.appliedDecisions);
  expect((await f.store.getSession('root'))!.contextSelectionId).toBe(before.contextSelectionId);
  expect(afterWork.pendingInputIds).not.toContain(raw.id);
  expect(await f.store.getExecution(original.id)).toEqual(before.carrier);
  expect(f.reports()).toEqual(before.reports);
  expect((await f.store.getView('root')).runs).toEqual(before.rootRuns);
  expect((await f.store.getView(childSessionId)).runs).toEqual(before.childRuns);
  expect(f.requests).toHaveLength(before.parentRequests);
  expect(f.childRequests).toHaveLength(before.childRequests);
  const snapshot = async () => ({
    metadata: await f.store.getMetadata(),
    root: await f.store.getView('root'),
    child: await f.store.getView(childSessionId),
    work: await f.store.readHumanWorkState(scope),
    reports: f.reports(),
    appliedDecisions: appliedDecisions(),
    publicCommand: await f.store.getCommand('continue'),
    raw: await f.store.getCommand(raw.id),
    decision: await f.store.getCommand(decision.id),
    parentRequests: f.requests.length,
    childRequests: f.childRequests.length,
  });
  const beforeReplay = await snapshot();
  expect(await f.submit('continue', '继续当前任务 work')).toEqual(publicCommand);
  expect(await snapshot()).toEqual(beforeReplay);
}

for (const settleBeforeContinue of [true, false]) {
  test(`explicit continue admits original unconsumed result once (${settleBeforeContinue ? 'already suppressed' : 'future carrier'})`, async () => {
    const f = await fixture(1);
    try {
      await f.submit();
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      await until(async () => (f.childRequests.length === 1 ? true : null));
      const carrier = (await f.store.listExecutions('root')).find((value) => value.kind === 'job')!;
      const originalDeadline = carrier.afterTurn;
      await f.submit('pause', '暂停当前任务 work');
      await f.runtime.waitForCommand('pause', { timeoutMs: 5000 });
      let historical: string | undefined;
      if (settleBeforeContinue) {
        f.childGates[0]!.release();
        const suppressed = await until(
          async () =>
            f
              .reports()
              .find((value) => value.kind === 'job.report' && value.status === 'rejected') ?? null,
        );
        expect(suppressed.receipt.reason).toBe('work_paused');
        historical = JSON.stringify(suppressed);
      }
      await f.submit('continue', '继续当前任务 work');
      const qualification = await until(
        async () => f.reports().find((value) => value.kind === 'job.report.qualification') ?? null,
      );
      const proof = JSON.parse(qualification.request_json);
      expect(proof.carrierExecutionId).toBe(carrier.id);
      expect(proof.startCommandId).toBe(`child-start-${carrier.id}`);
      expect(proof.resultRevision).toBeUndefined();
      expect(proof.controlRevision).toBeString();
      if (!settleBeforeContinue) {
        await f.runtime.waitForCommand('continue', { timeoutMs: 5000 });
        await f.submit('continue-before-result', '继续当前任务 work');
        await f.runtime.waitForCommand('continue-before-result', { timeoutMs: 5000 });
        expect(
          f.reports().filter((value) => value.kind === 'job.report.qualification'),
        ).toHaveLength(1);
        f.childGates[0]!.release();
      }
      const report = await until(
        async () =>
          f
            .reports()
            .find((value) => value.kind === 'job.report.continue' && value.status === 'applied') ??
          null,
      );
      await f.runtime.waitForCommand('continue', { timeoutMs: 5000 });
      await until(async () =>
        (await f.store.getView('root')).runs.every((value) => !value.isActive) ? true : null,
      );
      const original = f.reports().find((value) => value.kind === 'job.report')!;
      if (historical) expect(JSON.stringify(original)).toBe(historical);
      expect(JSON.parse(report.request_json).originalReportCommandId).toBe(original.id);
      expect(report.receipt.sourceId).toBeString();
      expect(f.childRequests).toHaveLength(1);
      const saved = (await f.store.getExecution(carrier.id))!;
      expect(saved.afterTurn).toEqual(originalDeadline);
      expect(saved.delivery).toBe('consumed');
      const sources = f.db
        .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
        .all(carrier.id);
      expect(sources).toHaveLength(1);
      await f.submit('continue-again', '继续当前任务 work');
      await f.runtime.waitForCommand('continue-again', { timeoutMs: 5000 });
      expect(
        f.db
          .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
          .all(carrier.id),
      ).toHaveLength(1);
      expect(
        f
          .reports()
          .filter((value) => value.kind === 'job.report.continue' && value.status === 'applied'),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

test('continued report admission fault rolls back exact decision and qualification without altering the suppressed history', async () => {
  const f = await fixture(1);
  const writer = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  writer.run('PRAGMA busy_timeout=1000');
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => (f.childRequests.length === 1 ? true : null));
    await f.submit('pause', '暂停当前任务 work');
    f.childGates[0]!.release();
    const suppressed = await until(
      async () =>
        f.reports().find((value) => value.kind === 'job.report' && value.status === 'rejected') ??
        null,
    );
    const history = JSON.stringify(suppressed);
    const revision = (await f.store.getSession('root'))!.controlRevision;
    writer.run(
      "CREATE TRIGGER fail_continuation BEFORE INSERT ON command WHEN NEW.kind='job.report.continue' BEGIN SELECT RAISE(ABORT,'continuation_fault'); END",
    );
    let failure: unknown;
    try {
      await f.submit('continue', '继续当前任务 work');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeTruthy();
    expect((await f.store.getSession('root'))!.controlRevision).toBe(String(BigInt(revision) + 1n));
    const pendingPublic = (await f.store.getCommand('continue'))!;
    const pendingRaw = (await f.store.getCommand(
      (pendingPublic.receipt as { humanInputCommandId: string }).humanInputCommandId,
    ))!;
    expect((pendingRaw.receipt as { state: string }).state).toBe('pending');
    expect(f.reports().filter((value) => value.kind === 'job.report.qualification')).toHaveLength(
      0,
    );
    expect(JSON.stringify(f.reports().find((value) => value.id === suppressed.id))).toBe(history);
    writer.run('DROP TRIGGER fail_continuation');
    await f.submit('continue', '继续当前任务 work');
    const applied = await until(
      async () =>
        f
          .reports()
          .find((value) => value.kind === 'job.report.continue' && value.status === 'applied') ??
        null,
    );
    await f.runtime.waitForCommand('continue', { timeoutMs: 5000 });
    expect(applied.receipt.sourceId).toBeString();
    expect(f.reports().filter((value) => value.kind === 'job.report.qualification')).toHaveLength(
      1,
    );
    expect(f.childRequests).toHaveLength(1);
  } finally {
    writer.close();
    await f.close();
  }
});

test('a real stop after pause cannot create continuation eligibility or revive the original child', async () => {
  const f = await fixture(1);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => (f.childRequests.length === 1 ? true : null));
    await f.submit('pause', '暂停当前任务 work');
    await f.submit('stop', '停止当前任务 work');
    await expectSealedRejectedContinue(f, 'work_resume_unavailable');
    expect(
      f
        .reports()
        .filter(
          (value) =>
            value.kind === 'job.report.qualification' || value.kind === 'job.report.continue',
        ),
    ).toHaveLength(0);
    f.childGates[0]!.release();
    await until(async () =>
      f.reports().some((value) => value.kind === 'job.report' && value.status === 'rejected')
        ? true
        : null,
    );
    expect(
      f
        .reports()
        .some((value) => value.status === 'applied' && value.kind === 'job.report.continue'),
    ).toBe(false);
    expect(f.childRequests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('an unknown original carrier blocks the exact continue decision and preserves original outcome facts', async () => {
  const f = await fixture(1);
  const writer = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  writer.run('PRAGMA busy_timeout=1000');
  let carrierId: string | undefined;
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => (f.childRequests.length === 1 ? true : null));
    await f.submit('pause', '暂停当前任务 work');
    carrierId = (await f.store.listExecutions('root')).find((value) => value.kind === 'job')!.id;
    writer.query("UPDATE execution SET state='outcome_unknown' WHERE id=?").run(carrierId);
    const prior = writer
      .query('SELECT result_revision,result_json,after_turn_json FROM execution WHERE id=?')
      .get(carrierId);
    await expectSealedRejectedContinue(f, 'work_resume_outcome_unknown');
    expect(
      f
        .reports()
        .filter(
          (value) =>
            value.kind === 'job.report.qualification' || value.kind === 'job.report.continue',
        ),
    ).toHaveLength(0);
    expect(
      writer
        .query('SELECT result_revision,result_json,after_turn_json FROM execution WHERE id=?')
        .get(carrierId),
    ).toEqual(prior);
    expect((await f.store.getExecution(carrierId))!.status).toBe('outcome_unknown');
    expect(f.childRequests).toHaveLength(1);
  } finally {
    try {
      if (carrierId)
        writer
          .query("UPDATE execution SET state='running' WHERE id=? AND state='outcome_unknown'")
          .run(carrierId);
    } finally {
      try {
        writer.close();
      } finally {
        await f.close();
      }
    }
  }
});

test('a reused child exact trusted follow-up retains future continuation eligibility without a third child Run', async () => {
  const f = await fixture(1, false, false, false, true);
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => (f.childRequests.length === 1 ? true : null));
    f.childGates[0]!.release();
    await until(async () => (f.childRequests.length === 2 ? true : null));
    await until(async () =>
      (await f.store.getView('root')).runs.every((value) => !value.isActive) ? true : null,
    );
    const carriers = (await f.store.listExecutions('root')).filter((value) => value.kind === 'job');
    const second = carriers.find((value) => value.status === 'running')!;
    const start = f.db
      .query('SELECT kind,agent_carrier_execution_id FROM command WHERE id=?')
      .get(`child-start-${second.id}`) as { kind: string; agent_carrier_execution_id: string };
    expect(start.kind).toBe('input.follow_up');
    expect(start.agent_carrier_execution_id).toBe(second.id);
    await f.submit('pause', '暂停当前任务 work');
    await f.submit('continue', '继续当前任务 work');
    const qualification = await until(
      async () => f.reports().find((value) => value.kind === 'job.report.qualification') ?? null,
    );
    expect(JSON.parse(qualification.request_json).carrierExecutionId).toBe(second.id);
    f.reusedChildGate.release();
    const report = await until(
      async () =>
        f
          .reports()
          .find((value) => value.kind === 'job.report.continue' && value.status === 'applied') ??
        null,
    );
    expect(JSON.parse(report.request_json).executionId).toBe(second.id);
    expect(f.childRequests).toHaveLength(2);
    expect((await f.store.getView(second.childSessionId!)).runs).toHaveLength(2);
    expect(
      f.db
        .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
        .all(second.id),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('an invalidated future qualification cannot fall back to the original subscription after continue', async () => {
  const f = await fixture(1);
  const writer = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  writer.run('PRAGMA busy_timeout=1000');
  let startId: string | undefined, originalDigest: string | undefined;
  try {
    await f.submit();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await until(async () => (f.childRequests.length === 1 ? true : null));
    const carrier = (await f.store.listExecutions('root')).find((value) => value.kind === 'job')!;
    await f.submit('pause', '暂停当前任务 work');
    await f.submit('continue', '继续当前任务 work');
    await f.runtime.waitForCommand('continue', { timeoutMs: 5000 });
    expect(f.reports().filter((value) => value.kind === 'job.report.qualification')).toHaveLength(
      1,
    );
    startId = `child-start-${carrier.id}`;
    originalDigest = (
      writer.query('SELECT request_digest FROM command WHERE id=?').get(startId) as {
        request_digest: string;
      }
    ).request_digest;
    writer.query("UPDATE command SET request_digest='invalidated-fixture' WHERE id=?").run(startId);
    f.childGates[0]!.release();
    const old = await until(
      async () =>
        f.reports().find((value) => value.kind === 'job.report' && value.status === 'rejected') ??
        null,
    );
    expect(old.receipt.reason).toBe('continuation_required');
    expect(f.reports().filter((value) => value.kind === 'job.report.continue')).toHaveLength(0);
    expect(
      f.db
        .query("SELECT id FROM context_snapshot WHERE kind='result_ref' AND execution_id=?")
        .all(carrier.id),
    ).toHaveLength(0);
    expect(f.childRequests).toHaveLength(1);
  } finally {
    try {
      if (startId && originalDigest)
        writer.query('UPDATE command SET request_digest=? WHERE id=?').run(originalDigest, startId);
    } finally {
      try {
        writer.close();
      } finally {
        await f.close();
      }
    }
  }
});
