import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-context-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 's' });
  const initial = (await store.getSession('s'))!.contextSelectionId;
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'original' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const write = { expectedStoreId, owner };
  const run = await store.startRun({
    ...write,
    commandId: 'work',
    configuration: { tools: [{ id: 'parent', version: '1', extensionId: 'fixture' }] },
  });
  const source = { kind: 'model_decision', modelExecutionId: 'fixed' };
  await store.planExecution({
    ...write,
    executionId: 'parent',
    sessionId: 's',
    runId: run.id,
    originCommandId: 'work',
    kind: 'tool',
    stepId: 'parent',
    callId: 'parent',
    definitionId: 'parent',
    definitionVersion: '1',
    input: {},
    decisionSource: source,
  });
  const authorization = {
    allowed: true,
    revision: '1',
    definitionVersion: '1',
    inputDigest: await semanticDigest({}),
  };
  await store.markDispatching({
    ...write,
    executionId: 'parent',
    authorization,
    requirements: [],
    freshness: { checked: true, source },
  });
  const job = async (key: string) => {
    const ref = await store.ensureOperation({
      ...write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'parent',
      operationKey: key,
      cancellation: 'detached',
      request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
    });
    await store.markDispatching({
      ...write,
      executionId: ref.executionId!,
      authorization,
      requirements: [],
      freshness: { checked: true, source },
    });
    return ref.executionId!;
  };
  const settle = (id: string, content = id) =>
    store.finishExecution({
      ...write,
      executionId: id,
      status: 'succeeded',
      result: { outcome: 'succeeded', content },
    });
  const finish = async () => {
    await settle('parent');
    await store.finishRun({ ...write, runId: run.id, status: 'completed', requirements: [] });
  };
  const newRun = async (id: string) => {
    await store.acceptCommand({
      ...base,
      commandId: id,
      request: { kind: 'run.start', content: id },
    });
    const next = await store.startRun({ ...write, commandId: id, configuration: {} });
    await store.finishRun({ ...write, runId: next.id, status: 'completed', requirements: [] });
    return (await store.listMessages('s')).find((message) => message.sourceIds?.includes(id))!;
  };
  const rewind = (
    id: string,
    expected: string,
    boundary: Awaited<ReturnType<typeof store.listMessages>>[number] | null,
  ) =>
    store.selectContext({
      ...base,
      commandId: id,
      expectedContextSelectionId: expected,
      boundary: boundary ? { messageId: boundary.id, seq: boundary.seq } : null,
    });
  const consume = (id: string, executionId: string, contextSelectionId = initial) =>
    store.consumeJobResult({
      ...write,
      commandId: id,
      sessionId: 's',
      executionId,
      resultRevision: '1',
      contextSelectionId,
    });
  const include = (id: string, executionId: string, expectedContextSelectionId: string) =>
    store.includeResult({
      ...base,
      commandId: id,
      executionId,
      resultRevision: '1',
      expectedContextSelectionId,
    });
  const read = () => store.getSelectedContext({ expectedStoreId, sessionId: 's' });
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  return {
    store,
    profile,
    base,
    write,
    db,
    run,
    initial,
    expectedStoreId,
    source,
    job,
    settle,
    finish,
    newRun,
    rewind,
    consume,
    include,
    read,
    cleanup: async () => {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
test('R10 Rewind before/after startup suppresses pending, rejects old accepted work and explicit include adds source without any replay', async () => {
  for (const afterStartup of [false, true]) {
    const f = await fixture();
    try {
      const job = await f.job('background');
      await f.settle(job);
      await f.finish();
      const boundary = afterStartup
        ? await f.newRun('after-startup')
        : (await f.store.listMessages('s'))[0]!;
      await f.store.acceptCommand({
        ...f.base,
        commandId: 'old-start',
        request: { kind: 'run.start', content: 'old queued' },
      });
      await f.store.acceptCommand({
        ...f.base,
        commandId: 'old-action',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'start',
          definitionVersion: '1',
          input: {},
        },
      });
      const changed = await f.rewind('rewind', f.initial, boundary);
      expect(changed.selection.id).not.toBe(f.initial);
      expect((await f.store.getExecution(job))?.delivery).toBe('suppressed');
      expect((await f.store.getExecution(job))?.deliveryReason).toBe('context_rewound');
      expect((await f.store.getCommand('old-start'))?.receipt).toEqual({
        outcome: 'context_rewound',
      });
      expect((await f.store.getCommand('old-action'))?.status).toBe('rejected');
      await rejected(
        f.store.startRun({ ...f.write, commandId: 'old-start', configuration: {} }),
        'cancelled_before_dispatch',
      );
      await rejected(f.consume('old-notification', job), 'context_rewound');
      expect((await f.read()).resultSources).toHaveLength(0);
      const explicit = await f.include('include', job, changed.selection.id);
      expect(explicit.source.executionId).toBe(job);
      expect(explicit.source.originStoreId).toBe(f.expectedStoreId);
      expect(explicit.source.inclusion).toBe('explicit');
      expect((await f.read()).resultSources.map((source) => source.id)).toEqual([
        explicit.source.id,
      ]);
      expect((await f.store.getExecution(job))?.delivery).toBe('suppressed');
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      expect(await f.include('include', job, changed.selection.id)).toEqual(explicit);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      const second = await f.include('same-result', job, changed.selection.id);
      expect(second.source.id).toBe(explicit.source.id);
      expect((await f.read()).resultSources).toHaveLength(1);
      expect(f.db.query("SELECT count(*) AS n FROM execution WHERE kind='model'").get()).toEqual({
        n: 0,
      });
      expect(f.db.query('SELECT count(*) AS n FROM run').get()).toEqual({
        n: afterStartup ? 2 : 1,
      });
    } finally {
      await f.cleanup();
    }
  }
});
test('consumption before Rewind retains only selected consumed sources, repeated selection intersects old history and future tail stays visible', async () => {
  const f = await fixture();
  try {
    const job = await f.job('background');
    await f.settle(job);
    await f.finish();
    const consumed = await f.consume('consume', job);
    expect((await f.store.getExecution(job))?.delivery).toBe('consumed');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.consume('consume', job)).toEqual(consumed);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const later = await f.newRun('later');
    const preserved = await f.rewind('preserve', f.initial, later);
    expect((await f.read()).resultSources.map((source) => source.id)).toEqual([consumed.source.id]);
    const original = (await f.store.listMessages('s'))[0]!;
    const removed = await f.rewind('remove', preserved.selection.id, original);
    expect((await f.read()).messages.map((message) => message.content)).toEqual(['original']);
    expect((await f.read()).resultSources).toHaveLength(0);
    expect((await f.store.getExecution(job))?.delivery).toBe('consumed');
    await rejected(
      f.rewind('reintroduce', removed.selection.id, later),
      'context_boundary_invalid',
    );
    const fresh = await f.newRun('fresh');
    expect((await f.read()).messages.map((message) => message.content)).toEqual([
      'original',
      'fresh',
    ]);
    await f.rewind('repeat', removed.selection.id, fresh);
    expect((await f.read()).messages.map((message) => message.content)).toEqual([
      'original',
      'fresh',
    ]);
    expect((await f.store.listMessages('s')).map((message) => message.content)).toEqual([
      'original',
      'later',
      'fresh',
    ]);
  } finally {
    await f.cleanup();
  }
});
test('active whole group/unknown cannot rewind, include requires the exact active target, original scope and exact revisions/Store reject with zero sources', async () => {
  const f = await fixture();
  try {
    const child = await f.store.ensureOperation({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'parent',
      operationKey: 'child',
      cancellation: 'detached',
      request: { kind: 'agent', configurationId: 'child', input: {} },
      childConfiguration: { id: 'child', version: '1', snapshot: { modelId: 'fixed' } },
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: child.executionId!,
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const activeChild = await f.store.activateChildRun({
      ...f.write,
      executionId: child.executionId!,
      configuration: { modelId: 'fixed' },
      requirementEvaluations: [],
      freshness: { checked: true, source: f.source },
    });
    const job = await f.job('background');
    const unknownJob = await f.job('uncertain');
    await f.store.finishExecution({
      ...f.write,
      executionId: unknownJob,
      status: 'outcome_unknown',
      result: { outcome: 'outcome_unknown', content: 'lost external receipt' },
    });
    await rejected(f.rewind('active', f.initial, null), 'context_execution_unsettled');
    await f.settle(job);
    await rejected(f.include('busy', job, f.initial), 'input_target_changed');
    await rejected(f.consume('needs-target', job), 'input_target_changed');
    await f.finish();
    await rejected(
      f.store.includeResult({
        ...f.base,
        subjectId: 'intruder',
        commandId: 'intruder',
        executionId: job,
        resultRevision: '1',
        expectedContextSelectionId: f.initial,
      }),
      'permission_denied',
    );
    await rejected(
      f.store.includeResult({
        ...f.base,
        expectedStoreId: 'other',
        commandId: 'wrong-store',
        executionId: job,
        resultRevision: '1',
        expectedContextSelectionId: f.initial,
      }),
      'store_identity_mismatch',
    );
    await rejected(
      f.store.includeResult({
        ...f.base,
        commandId: 'wrong-revision',
        executionId: job,
        resultRevision: '2',
        expectedContextSelectionId: f.initial,
      }),
      'result_revision_conflict',
    );
    expect((await f.read()).resultSources).toHaveLength(0);
    await rejected(f.rewind('child-active', f.initial, null), 'context_execution_unsettled');
    await f.store.finishRun({
      ...f.write,
      runId: activeChild.run.id,
      status: 'completed',
      requirements: [],
    });
    await f.settle(child.executionId!);
    await rejected(f.rewind('unknown', f.initial, null), 'context_execution_unsettled');
  } finally {
    await f.cleanup();
  }
});
test('real select/include transaction faults roll back selection, suppression, source, receipts; readonly reopening keeps exact selected IDs/history', async () => {
  const f = await fixture();
  let readonly: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const job = await f.job('background');
    await f.settle(job);
    await f.finish();
    f.db.exec(
      "CREATE TRIGGER rewind_fault BEFORE INSERT ON change_event WHEN NEW.type='context.selected' BEGIN SELECT RAISE(ABORT,'fault'); END",
    );
    let failed = false;
    try {
      await f.rewind('fault', f.initial, null);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await f.store.getSession('s'))?.contextSelectionId).toBe(f.initial);
    expect((await f.store.getExecution(job))?.delivery).toBe('pending');
    expect(await f.store.getCommand('fault')).toBeNull();
    expect(
      f.db.query("SELECT count(*) AS n FROM context_snapshot WHERE kind='selection'").get(),
    ).toEqual({ n: 0 });
    f.db.exec('DROP TRIGGER rewind_fault');
    const changed = await f.rewind('rewind', f.initial, null);
    f.db.exec(
      "CREATE TRIGGER include_fault BEFORE INSERT ON command WHEN NEW.kind='result.include' BEGIN SELECT RAISE(ABORT,'fault'); END",
    );
    failed = false;
    try {
      await f.include('fault-include', job, changed.selection.id);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await f.read()).resultSources).toHaveLength(0);
    f.db.exec('DROP TRIGGER include_fault');
    const included = await f.include('include', job, changed.selection.id);
    readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const cursor = (await readonly.getMetadata()).lastChangeCursor;
    const selected = await readonly.getSelectedContext({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
    });
    expect(selected.selection.id).toBe(changed.selection.id);
    expect(selected.messages).toHaveLength(0);
    expect(selected.resultSources.map((source) => source.id)).toEqual([included.source.id]);
    expect((await readonly.listMessages('s')).map((message) => message.content)).toEqual([
      'original',
    ]);
    expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
    await rejected(
      readonly.selectContext({
        ...f.base,
        commandId: 'readonly',
        expectedContextSelectionId: changed.selection.id,
        boundary: null,
      }),
      'read_only',
    );
  } finally {
    await readonly?.close();
    await f.cleanup();
  }
});

test('cancellation forbids automatic delivery, explicit historical include preserves origin across restore and uses no new execution', async () => {
  const f = await fixture();
  try {
    const job = await f.job('background');
    await f.settle(job);
    await f.finish();
    await f.store.cancelWork({
      ...f.base,
      commandId: 'stop',
      kind: 'session.cancel',
      includeBackground: true,
    });
    await rejected(f.consume('late-consume', job), 'result_delivery_cancelled');
    expect((await f.read()).resultSources).toHaveLength(0);
    f.db.exec("UPDATE storage_meta SET store_id='restored-store'");
    await rejected(
      f.store.consumeJobResult({
        ...f.write,
        expectedStoreId: 'restored-store',
        commandId: 'restored-auto',
        sessionId: 's',
        executionId: job,
        resultRevision: '1',
        contextSelectionId: f.initial,
      }),
      'operation_unverifiable',
    );
    const explicit = await f.store.includeResult({
      ...f.base,
      expectedStoreId: 'restored-store',
      commandId: 'explicit-history',
      executionId: job,
      resultRevision: '1',
      expectedContextSelectionId: f.initial,
    });
    expect(explicit.source.originStoreId).toBe(f.expectedStoreId);
    expect(explicit.command.originStoreId).toBe('restored-store');
    expect((await f.store.getExecution(job))?.originStoreId).toBe(f.expectedStoreId);
    expect(
      (
        await f.store.getSelectedContext({ expectedStoreId: 'restored-store', sessionId: 's' })
      ).resultSources.map((source) => source.id),
    ).toEqual([explicit.source.id]);
    expect(f.db.query('SELECT count(*) AS n FROM execution').get()).toEqual({ n: 2 });
  } finally {
    await f.cleanup();
  }
});
test('selected-context paging pins a high water and enforces explicit item budgets, Provider call pairs cannot be split by Rewind', async () => {
  const f = await fixture();
  try {
    const job = await f.job('background');
    const largeJob = await f.job('oversize');
    await f.settle(largeJob, 'x'.repeat(1200000));
    await f.settle(job);
    await f.finish();
    await f.consume('consume', job);
    await f.newRun('second');
    await f.newRun('third');
    const first = await f.store.getSelectedContext({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      messageLimit: 1,
      sourceLimit: 1,
    });
    expect(first.messages.map((message) => message.content)).toEqual(['original']);
    expect(first.nextAfterSeq).not.toBeNull();
    await f.newRun('after-water');
    const rest = await f.store.getSelectedContext({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      contextSelectionId: first.selection.id,
      afterSeq: first.nextAfterSeq!,
      upperSeq: first.highWaterSeq,
      messageLimit: 100,
      afterSourceId: first.nextAfterSourceId ?? undefined,
    });
    expect(rest.messages.map((message) => message.content)).toEqual(['second', 'third']);
    expect(rest.highWaterSeq).toBe(first.highWaterSeq);
    await rejected(
      f.store.getSelectedContext({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        upperSeq: '9223372036854775807',
      }),
      'cursor_ahead',
    );
    await f.consume('consume-large', largeJob);
    await rejected(f.read(), 'context_item_too_large');
    expect(
      (
        await f.store.getSelectedContext({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          byteLimit: 2 * 1024 * 1024,
        })
      ).resultSources.find((source) => source.executionId === largeJob)?.result,
    ).toMatchObject({ content: 'x'.repeat(1200000) });
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'pair-run',
      request: { kind: 'run.start', content: 'pair' },
    });
    const run = await f.store.startRun({ ...f.write, commandId: 'pair-run', configuration: {} });
    const source = { kind: 'model_request', requestId: 'pair-model' };
    await f.store.planExecution({
      ...f.write,
      executionId: 'pair-model',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'pair-run',
      kind: 'model',
      stepId: 'pair-model',
      callId: 'pair-model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: 'pair-model',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    await f.store.finishExecution({
      ...f.write,
      executionId: 'pair-model',
      status: 'succeeded',
      result: {},
      message: {
        role: 'assistant',
        content: 'calls',
        toolCalls: [{ id: 'paired-call', name: 'fixed', arguments: '{}' }],
      },
    });
    await f.store.planExecution({
      ...f.write,
      executionId: 'paired-tool',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'pair-run',
      kind: 'tool',
      stepId: 'pair-model',
      callId: 'paired-call',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: 'paired-tool',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    await f.store.finishExecution({
      ...f.write,
      executionId: 'paired-tool',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'paired' },
      message: { role: 'tool', content: 'paired', toolCallId: 'paired-call' },
    });
    await f.store.finishRun({ ...f.write, runId: run.id, status: 'completed', requirements: [] });
    const messages = await f.store.listMessages('s');
    const assistant = messages.find((message) => message.content === 'calls')!,
      tool = messages.find((message) => message.content === 'paired')!;
    await rejected(f.rewind('split', f.initial, assistant), 'context_boundary_unpaired');
    await f.rewind('complete-pair', f.initial, tool);
    expect(
      (
        await f.store.getSelectedContext({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          byteLimit: 2 * 1024 * 1024,
        })
      ).messages.some((message) => message.toolCallId === 'paired-call'),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test('pending Job results freeze actual completion cursor across two Workers and reject invalid reads without writes', async () => {
  const f = await fixture();
  const peer = await openSqliteStore(f.profile);
  try {
    f.db.run('UPDATE storage_meta SET last_change_cursor=9007199254740993 WHERE singleton=1');
    const a = await f.job('a'),
      b = await f.job('b'),
      c = await f.job('c');
    await f.settle(b);
    await f.settle(a);
    const first = await peer.listPendingJobResults({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      limit: 1,
    });
    expect(first.jobs.map((job) => job.executionId)).toEqual([b]);
    expect(first.nextAfterCursor).toBe(first.jobs[0]!.completedCursor);
    expect(first.jobs[0]!.resultRevision).toBe('1');
    expect(BigInt(first.jobs[0]!.completedCursor)).toBeGreaterThan(9007199254740993n);
    expect(first.jobs[0]!.originStoreId).toBe(f.expectedStoreId);
    expect(first.jobs[0]!.contextSelectionId).toBe(f.initial);
    await f.settle(c);
    const second = await f.store.listPendingJobResults({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      afterCursor: first.nextAfterCursor!,
      upperCursor: first.highWaterCursor,
      limit: 1,
    });
    expect(second.jobs.map((job) => job.executionId)).toEqual([a]);
    expect(second.nextAfterCursor).toBeNull();
    expect(second.highWaterCursor).toBe(first.highWaterCursor);
    expect(BigInt(second.snapshotCursor)).toBeGreaterThan(BigInt(first.highWaterCursor));
    const later = await peer.listPendingJobResults({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      afterCursor: first.highWaterCursor,
    });
    expect(later.jobs.map((job) => job.executionId)).toEqual([c]);
    await f.finish();
    f.db.run("DELETE FROM change_event WHERE type='execution.finished'");
    expect(
      (
        await peer.listPendingJobResults({ expectedStoreId: f.expectedStoreId, sessionId: 's' })
      ).jobs.map((job) => job.executionId),
    ).toEqual([b, a, c]);
    const metadata = await f.store.getMetadata();
    await rejected(
      peer.listPendingJobResults({ expectedStoreId: 'other', sessionId: 's' }),
      'store_identity_mismatch',
    );
    await rejected(
      peer.listPendingJobResults({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        upperCursor: String(BigInt(metadata.lastChangeCursor) + 1n),
      }),
      'cursor_ahead',
    );
    await rejected(
      peer.listPendingJobResults({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        afterCursor: '9223372036854775808',
      }),
      'invalid_context_cursor',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(metadata.lastChangeCursor);
    f.db.run(
      "CREATE TRIGGER fail_consume BEFORE INSERT ON command WHEN NEW.kind='job_result.consume' BEGIN SELECT RAISE(ABORT,'consume failure'); END",
    );
    let failed = false;
    try {
      await f.consume('rollback-consume', a);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(await f.store.getCommand('rollback-consume')).toBeNull();
    expect((await f.store.getExecution(a))!.delivery).toBe('pending');
    expect((await f.read()).resultSources).toEqual([]);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(metadata.lastChangeCursor);
    f.db.run('DROP TRIGGER fail_consume');
    await f.consume('consume-a', a);
    expect(
      (
        await peer.listPendingJobResults({ expectedStoreId: f.expectedStoreId, sessionId: 's' })
      ).jobs.map((job) => job.executionId),
    ).toEqual([b, c]);
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(
        (
          await readonly.listPendingJobResults({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
          })
        ).jobs.map((job) => job.executionId),
      ).toEqual([b, c]);
    } finally {
      await readonly.close();
    }
  } finally {
    await peer.close();
    await f.cleanup();
  }
});

test('child Loop consumes only its own Job under root group owner and closed original child subject', async () => {
  const f = await fixture();
  try {
    const configuration = {
      modelId: 'fixed',
      tools: [{ id: 'child-parent', version: '1', extensionId: 'fixture' }],
    };
    const ref = await f.store.ensureOperation({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'parent',
      operationKey: 'child-consume',
      cancellation: 'detached',
      request: { kind: 'agent', configurationId: 'child', input: {} },
      childConfiguration: { id: 'child', version: '1', snapshot: configuration },
    });
    const authorization = {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    };
    await f.store.markDispatching({
      ...f.write,
      executionId: ref.executionId!,
      authorization,
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const child = await f.store.activateChildRun({
      ...f.write,
      executionId: ref.executionId!,
      configuration,
      requirementEvaluations: [],
      freshness: { checked: true, source: f.source },
    });
    await f.store.planExecution({
      ...f.write,
      executionId: 'child-parent',
      sessionId: child.session.id,
      runId: child.run.id,
      originCommandId: child.command.id,
      kind: 'tool',
      stepId: 'child-parent',
      callId: 'child-parent',
      definitionId: 'child-parent',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: 'child-parent',
      authorization,
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const job = await f.store.ensureOperation({
      ...f.write,
      sessionId: child.session.id,
      extensionId: 'fixture',
      originCommandId: child.command.id,
      parentExecutionId: 'child-parent',
      operationKey: 'background',
      cancellation: 'detached',
      request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: job.executionId!,
      authorization,
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    await f.settle(job.executionId!);
    await f.finish();
    const pending = await f.store.listPendingJobResults({
      expectedStoreId: f.expectedStoreId,
      sessionId: child.session.id,
    });
    expect(pending.jobs.map((item) => item.executionId)).toEqual([job.executionId!]);
    expect(
      (await f.store.listPendingJobResults({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
        .jobs,
    ).toEqual([]);
    await rejected(
      f.store.consumeJobResult({
        ...f.write,
        commandId: 'root-spoof',
        sessionId: 's',
        executionId: job.executionId!,
        resultRevision: '1',
        contextSelectionId: f.initial,
      }),
      'context_result_scope_denied',
    );
    const input = {
      ...f.write,
      commandId: 'child-consume',
      sessionId: child.session.id,
      executionId: job.executionId!,
      resultRevision: '1',
      contextSelectionId: child.session.contextSelectionId,
      targetRunId: child.run.id,
    };
    const consumed = await f.store.consumeJobResult(input);
    expect(consumed.command.subjectId).toBe('user');
    expect(consumed.command.sessionId).toBe(child.session.id);
    expect(
      (
        await f.store.getSelectedContext({
          expectedStoreId: f.expectedStoreId,
          sessionId: child.session.id,
        })
      ).resultSources.map((item) => item.id),
    ).toEqual([consumed.source.id]);
    expect((await f.read()).resultSources).toEqual([]);
    await rejected(
      f.store.includeResult({
        ...f.base,
        sessionId: child.session.id,
        commandId: 'public-child',
        expectedContextSelectionId: child.session.contextSelectionId,
        executionId: job.executionId!,
        resultRevision: '1',
      }),
      'group_root_required',
    );
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.consumeJobResult(input)).toEqual(consumed);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.settle('child-parent');
    await f.store.finishRun({
      ...f.write,
      runId: child.run.id,
      status: 'completed',
      requirements: [],
    });
    await f.settle(ref.executionId!);
  } finally {
    await f.cleanup();
  }
});

test('legal one MiB input whose JSON expands beyond four MiB remains fully readable with finite eight MiB budget', async () => {
  const f = await fixture();
  try {
    await f.finish();
    const content = '\0'.repeat(1024 * 1024);
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'expanded',
      request: { kind: 'run.start', content },
    });
    const run = await f.store.startRun({ ...f.write, commandId: 'expanded', configuration: {} });
    await f.store.finishRun({ ...f.write, runId: run.id, status: 'completed', requirements: [] });
    await rejected(f.read(), 'context_item_too_large');
    const page = await f.store.getSelectedContext({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      byteLimit: 8 * 1024 * 1024,
    });
    expect(page.messages.at(-1)!.content).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(page.messages.at(-1)!))).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    expect(page.nextAfterSeq).toBeNull();
    const before = await f.store.getMetadata();
    f.db.run("UPDATE session SET next_seq=9223372036854775807 WHERE id='s'");
    await rejected(f.rewind('exhausted-rewind', f.initial, null), 'sequence_exhausted');
    expect((await f.store.getSession('s'))!.contextSelectionId).toBe(f.initial);
    expect(await f.store.getCommand('exhausted-rewind')).toBeNull();
    expect(
      f.db.query("SELECT count(*) AS n FROM context_snapshot WHERE kind='selection'").get(),
    ).toEqual({ n: 0 });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
  } finally {
    await f.cleanup();
  }
});

test('active explicit include has one pending boundary: source/message/receipt rollback together, same-id application is immutable, stale Run cannot drift', async () => {
  const f = await fixture();
  try {
    const job = await f.job('active-result');
    await f.settle(job);
    const input = {
      ...f.base,
      commandId: 'active-include',
      expectedContextSelectionId: f.initial,
      executionId: job,
      resultRevision: '1',
      targetRunId: f.run.id,
    };
    const pending = await f.store.includeResult(input);
    expect(pending.command.status).toBe('accepted');
    expect((await f.read()).resultSources).toHaveLength(0);
    expect((await f.store.getExecution(job))!.resultAcceptance).toBeNull();
    await rejected(
      f.store.applyInput({
        ...f.write,
        commandId: 'active-include',
        kind: 'result_include',
        runId: 'wrong',
      }),
      'input_target_changed',
    );
    const frozen = await f.read();
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const messages = (await f.store.getView('s')).messages;
    f.db.run(
      "CREATE TRIGGER active_include_apply_fault BEFORE UPDATE ON context_snapshot WHEN OLD.kind='result_ref' BEGIN SELECT RAISE(ABORT,'active inclusion rollback'); END",
    );
    let error: unknown;
    try {
      await f.store.applyInput({
        ...f.write,
        commandId: 'active-include',
        kind: 'result_include',
        runId: f.run.id,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect((await f.store.getView('s')).messages).toEqual(messages);
    expect((await f.read()).resultSources).toHaveLength(0);
    expect((await f.store.getCommand('active-include'))!.status).toBe('accepted');
    f.db.run('DROP TRIGGER active_include_apply_fault');
    const applied = await f.store.applyInput({
      ...f.write,
      commandId: 'active-include',
      kind: 'result_include',
      runId: f.run.id,
    });
    expect(applied.command.status).toBe('applied');
    const published = await f.read();
    expect(published.resultSources.map((source) => source.id)).toEqual([pending.source.id]);
    expect(BigInt(published.resultSources[0]!.seq)).toBeGreaterThan(BigInt(frozen.highWaterSeq));
    expect(
      (
        await f.store.getSelectedContext({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          upperSeq: frozen.highWaterSeq,
        })
      ).resultSources,
    ).toHaveLength(0);
    expect((await f.store.getExecution(job))!.resultAcceptance!.runId).toBe(f.run.id);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(
      await f.store.applyInput({
        ...f.write,
        commandId: 'active-include',
        kind: 'result_include',
        runId: f.run.id,
      }),
    ).toEqual(applied);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.finish();
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'new',
      request: { kind: 'run.start', content: 'new' },
    });
    await f.store.startRun({ ...f.write, commandId: 'new', configuration: {} });
    await rejected(
      f.store.includeResult({ ...input, commandId: 'stale-include' }),
      'input_target_changed',
    );
    expect(await f.store.getCommand('stale-include')).toBeNull();
  } finally {
    await f.cleanup();
  }
});
