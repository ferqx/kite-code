import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { UnifiedExecution } from '../../../src/execution';
import { ExecutionResources } from '../../../src/execution/resources';
import type { JobDefinition } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

async function rejected(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string } | undefined)?.code).toBe(code);
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-job-store-');
  chmodSync(dataRoot, 0o700);
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 's',
    subjectId: 'user',
  });
  await store.acceptCommand({
    expectedStoreId,
    commandId: 'work',
    sessionId: 's',
    subjectId: 'user',
    request: { kind: 'run.start', content: 'fixture' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const run = await store.startRun({
    expectedStoreId,
    owner,
    commandId: 'work',
    configuration: { tools: [{ id: 'fixture/parent', version: '1', extensionId: 'fixture' }] },
  });
  const source = { kind: 'model_decision', modelExecutionId: 'model' };
  await store.planExecution({
    expectedStoreId,
    owner,
    executionId: 'parent',
    sessionId: 's',
    runId: run.id,
    kind: 'tool',
    originCommandId: 'work',
    stepId: 'step',
    callId: 'parent',
    definitionId: 'fixture/parent',
    definitionVersion: '1',
    input: {},
    decisionSource: source,
  });
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId: 'parent',
    authorization: {
      allowed: true,
      revision: '0',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    },
    requirements: [],
    freshness: { checked: true, source },
  });
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  const input = {
    expectedStoreId,
    owner,
    extensionId: 'fixture',
    sessionId: 's',
    originCommandId: 'work',
    parentExecutionId: 'parent',
    operationKey: 'job',
    request: {
      kind: 'job' as const,
      definitionId: 'fixture/job',
      definitionVersion: '1',
      input: {},
    },
  };
  return {
    store,
    dataRoot,
    db,
    run,
    input,
    source,
    owner,
    expectedStoreId,
    cleanup: async () => {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
async function dispatched(
  f: Awaited<ReturnType<typeof fixture>>,
  cancellation: 'attached' | 'detached' = 'attached',
) {
  const ref = await f.store.ensureOperation({ ...f.input, cancellation });
  await f.store.planExecution({
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId: ref.executionId!,
    sessionId: 's',
    runId: null,
    kind: 'job',
    originCommandId: ref.commandId,
    parentExecutionId: 'parent',
    cancelWithParent: cancellation === 'attached',
    stepId: `operation-${ref.commandId}`,
    callId: ref.commandId,
    definitionId: 'fixture/job',
    definitionVersion: '1',
    input: {},
    decisionSource: f.source,
  });
  await f.store.markDispatching({
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId: ref.executionId!,
    authorization: {
      allowed: true,
      revision: '0',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    },
    requirements: [],
    freshness: { checked: true, source: f.source },
  });
  return ref;
}
test('Job creation is atomic, stable-keyed, parent scoped and separate from success', async () => {
  const f = await fixture();
  try {
    f.db.exec(
      "CREATE TRIGGER fail_job BEFORE INSERT ON change_event WHEN NEW.type='execution.planned' BEGIN SELECT RAISE(ABORT,'job plan fault'); END",
    );
    let error: unknown;
    try {
      await f.store.ensureOperation(f.input);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('job plan fault');
    expect(f.db.query("SELECT id FROM command WHERE kind='operation.job'").all()).toHaveLength(0);
    f.db.exec('DROP TRIGGER fail_job');
    await rejected(
      f.store.ensureOperation({ ...f.input, extensionId: 'other' }),
      'extension_namespace_mismatch',
    );
    const ref = await f.store.ensureOperation(f.input);
    expect(ref.executionId).not.toBeNull();
    expect(await f.store.ensureOperation(f.input)).toEqual(ref);
    expect((await f.store.getCommand(ref.commandId))?.status).toBe('applied');
    expect((await f.store.getExecution(ref.executionId!))?.status).toBe('planned');
    await rejected(
      f.store.ensureOperation({ ...f.input, cancellation: 'detached' }),
      'operation_conflict',
    );
    await f.store.writeExtensionRecord({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'parent',
      write: {
        key: 'plan',
        expectedRevision: null,
        contentType: 'fixture.plan',
        contentVersion: 1,
        value: {},
        executable: true,
      },
    });
    f.db.run("UPDATE extension_record SET origin_store_id='old-store' WHERE key='plan'");
    await rejected(
      f.store.ensureOperation({
        ...f.input,
        operationKey: 'restored-missing',
        planRecordKey: 'plan',
      }),
      'operation_unverifiable',
    );
    expect(
      await f.store.getOperation({
        extensionId: 'fixture',
        sessionId: 's',
        key: 'restored-missing',
        subjectId: 'user',
        originStoreId: 'old-store',
      }),
    ).toBeNull();
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'parent',
      status: 'succeeded',
      result: {},
    });
    await rejected(
      f.store.ensureOperation({ ...f.input, operationKey: 'new' }),
      'invalid_operation_parent',
    );
    expect((await f.store.getExecution(ref.executionId!))?.decisionSource).toEqual(f.source);
  } finally {
    await f.cleanup();
  }
});
test('detached Job keeps real handle/results after local parent cancellation and delivery is a persisted fact', async () => {
  const f = await fixture();
  try {
    const ref = await dispatched(f, 'detached');
    f.db.run("UPDATE execution SET cancel_requested=1 WHERE id='parent'");
    const reference = { adapter: 'fixture', jobId: 'real-handle' };
    await f.store.markRunning({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      reference,
    });
    await rejected(
      f.store.markRunning({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: ref.executionId!,
        reference: { jobId: 'other' },
      }),
      'job_reference_conflict',
    );
    const result = await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      status: 'succeeded',
      result: { done: true },
    });
    expect(result.delivery).toBe('pending');
    expect(result.reference).toEqual(reference);
    expect(result.deliveryTargetSessionId).toBe('s');
    expect((await f.store.getRun(f.run.id))?.isActive).toBe(true);
    expect(
      (
        await f.store.markRunning({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          executionId: ref.executionId!,
          reference,
        })
      ).status,
    ).toBe('succeeded');
    await rejected(
      f.store.ensureOperation({ ...f.input, operationKey: 'after-cancel' }),
      'cancelled_before_dispatch',
    );
  } finally {
    await f.cleanup();
  }
});
test('cancel in-flight start permits actual handle fact but suppresses exact execution-cancelled delivery', async () => {
  const f = await fixture();
  try {
    const ref = await dispatched(f);
    await f.store.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      targetCommandId: 'work',
      subjectId: 'user',
    });
    expect(
      (
        await f.store.markRunning({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          executionId: ref.executionId!,
          reference: { jobId: 'started' },
        })
      ).status,
    ).toBe('running');
    const result = await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      status: 'succeeded',
      result: { real: true },
    });
    expect(result.status).toBe('succeeded');
    expect(result.delivery).toBe('suppressed');
    expect(
      f.db.query('SELECT delivery_reason FROM execution WHERE id=?').get(ref.executionId!),
    ).toEqual({ delivery_reason: 'execution_cancel' });
  } finally {
    await f.cleanup();
  }
});
test('Job output retains bounded prefix, three coalesced stream gaps and independent Decimal64 high water', async () => {
  const f = await fixture();
  try {
    const ref = await dispatched(f);
    const input = {
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      stream: 'stdout' as const,
    };
    await rejected(
      f.store.appendExecutionOutput({ ...input, content: 'x'.repeat(32769) }),
      'output_chunk_too_large',
    );
    for (let index = 0; index < 36; index++)
      await f.store.appendExecutionOutput({ ...input, content: 'x'.repeat(32768) });
    for (const stream of ['stderr', 'progress'] as const)
      for (let index = 0; index < 10; index++)
        await f.store.appendExecutionOutput({ ...input, stream, content: 'y'.repeat(100) });
    expect(
      f.db
        .query('SELECT count(*) AS count FROM execution_output WHERE execution_id=?')
        .get(ref.executionId!),
    ).toEqual({ count: 34 });
    const clipped = await f.store.listExecutionOutput({
      executionId: ref.executionId!,
      afterSeq: '33',
      upperSeq: '35',
      limit: 1,
    });
    expect(clipped.items[0]).toMatchObject({ seq: '34', throughSeq: '35', droppedBytes: null });
    expect(clipped.highWaterSeq).toBe('56');
    const tail = await f.store.listExecutionOutput({
      executionId: ref.executionId!,
      afterSeq: '31',
      limit: 1,
    });
    expect(tail.items).toHaveLength(3);
    expect(tail.items.every((item) => item.droppedBytes !== null)).toBe(true);
    await rejected(
      f.store.listExecutionOutput({ executionId: ref.executionId!, upperSeq: '57' }),
      'cursor_ahead',
    );
    f.db.query('UPDATE execution SET output_seq=9007199254740993 WHERE id=?').run(ref.executionId!);
    const large = await f.store.appendExecutionOutput({ ...input, content: 'z' });
    expect(large.throughSeq).toBe('9007199254740994');
    expect(
      (await f.store.listExecutionOutput({ executionId: ref.executionId! })).highWaterSeq,
    ).toBe('9007199254740994');
    const beforeGapOverflow = await f.store.listExecutionOutput({ executionId: ref.executionId! });
    f.db
      .query(
        "UPDATE execution_output SET dropped_bytes=9223372036854775807 WHERE execution_id=? AND stream='stdout' AND is_gap=1",
      )
      .run(ref.executionId!);
    const saturated = await f.store.listExecutionOutput({ executionId: ref.executionId! });
    await rejected(f.store.appendExecutionOutput({ ...input, content: 'z' }), 'sequence_exhausted');
    expect(await f.store.listExecutionOutput({ executionId: ref.executionId! })).toEqual(saturated);
    f.db
      .query(
        "UPDATE execution_output SET dropped_bytes=? WHERE execution_id=? AND stream='stdout' AND is_gap=1",
      )
      .run(
        beforeGapOverflow.items.find((item) => item.stream === 'stdout' && item.content === '')!
          .droppedBytes!,
        ref.executionId!,
      );
    const stableUpper = '56';
    const beforeGet = (await f.store.getMetadata()).lastChangeCursor;
    const prefix = await f.store.listExecutionOutput({
      executionId: ref.executionId!,
      afterSeq: '0',
      upperSeq: stableUpper,
      limit: 2,
    });
    expect(prefix.items.map((item) => item.seq)).toEqual(['1', '2']);
    const next = await f.store.listExecutionOutput({
      executionId: ref.executionId!,
      afterSeq: prefix.items[1]!.throughSeq,
      upperSeq: stableUpper,
      limit: 2,
    });
    expect(next.items.map((item) => item.seq)).toEqual(['3', '4']);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(beforeGet);
    f.db
      .query('UPDATE execution SET output_seq=9223372036854775807 WHERE id=?')
      .run(ref.executionId!);
    await rejected(f.store.appendExecutionOutput({ ...input, content: 'z' }), 'sequence_exhausted');
    expect(
      (await f.store.listExecutionOutput({ executionId: ref.executionId! })).highWaterSeq,
    ).toBe('9223372036854775807');
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      status: 'succeeded',
      result: { summary: 'not subject to output budget' },
    });
    expect((await f.store.getExecution(ref.executionId!))?.result).toEqual({
      summary: 'not subject to output budget',
    });
  } finally {
    await f.cleanup();
  }
});

test('Job handle/output facts reject foreign identity and stale generation; failed output commit leaves high water intact', async () => {
  const f = await fixture();
  try {
    const ref = await dispatched(f);
    const input = {
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      stream: 'stdout' as const,
      content: 'actual output',
    };
    await rejected(
      f.store.appendExecutionOutput({ ...input, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await rejected(
      f.store.markRunning({
        expectedStoreId: f.expectedStoreId,
        owner: { ...f.owner, generation: '99' },
        executionId: ref.executionId!,
        reference: {},
      }),
      'owner_changed',
    );
    f.db.exec(
      "CREATE TRIGGER output_fault BEFORE INSERT ON change_event WHEN NEW.type='execution.output' BEGIN SELECT RAISE(ABORT,'output commit fault'); END",
    );
    let error: unknown;
    try {
      await f.store.appendExecutionOutput(input);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('output commit fault');
    expect(await f.store.listExecutionOutput({ executionId: ref.executionId! })).toEqual({
      items: [],
      highWaterSeq: '0',
    });
    f.db.exec('DROP TRIGGER output_fault');
    await f.store.markRunning({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      reference: { id: 'started' },
    });
    const first = await f.store.appendExecutionOutput(input);
    expect(first.seq).toBe('1');
    expect(first.throughSeq).toBe('1');
    expect(first.droppedBytes).toBe('0');
    f.db.run("UPDATE session SET context_selection_id='changed' WHERE id='s'");
    const result = await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      status: 'outcome_unknown',
      result: { real: 'unknown' },
    });
    expect(result.delivery).toBe('suppressed');
    expect(
      f.db.query('SELECT delivery_reason FROM execution WHERE id=?').get(ref.executionId!),
    ).toEqual({ delivery_reason: 'context_changed' });
    await rejected(
      f.store.listExecutionOutput({ executionId: ref.executionId!, afterSeq: '1.5' }),
      'invalid_cursor',
    );
    await rejected(
      f.store.listExecutionOutput({
        executionId: ref.executionId!,
        afterSeq: '9223372036854775808',
      }),
      'invalid_cursor',
    );
    expect((await f.store.getExecution(ref.executionId!))?.status).toBe('outcome_unknown');
  } finally {
    await f.cleanup();
  }
});

test('Job freezes parent requirements and refuses success without their exact record evaluation', async () => {
  const f = await fixture();
  try {
    await f.store.writeExtensionRecord({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'parent',
      write: {
        key: 'validation',
        expectedRevision: null,
        contentType: 'fixture.validation',
        contentVersion: 1,
        value: { passed: true },
        executable: true,
      },
    });
    const proposed = {
      extensionId: 'fixture',
      definitionVersion: '1',
      requirementId: 'validation',
      revision: '1',
      phase: 'completion' as const,
      sessionId: 's',
      runId: f.run.id,
      recordKey: 'validation',
    };
    const registered = await f.store.registerRunRequirements({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      runId: f.run.id,
      requirements: [proposed],
    });
    const requirement = registered.requirements[0]!;
    expect(requirement.originStoreId).toBe(f.expectedStoreId);
    const ref = await dispatched(f);
    expect((await f.store.getExecution(ref.executionId!))?.requirements).toEqual([requirement]);
    await f.store.writeExtensionRecord({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'parent',
      write: {
        key: 'later-validation',
        expectedRevision: null,
        contentType: 'fixture.validation',
        contentVersion: 1,
        value: { passed: true },
        executable: true,
      },
    });
    const later = await f.store.registerRunRequirements({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      runId: f.run.id,
      requirements: [
        { ...proposed, requirementId: 'later-validation', recordKey: 'later-validation' },
      ],
    });
    expect(later.requirements).toHaveLength(2);
    expect((await f.store.getExecution(ref.executionId!))?.requirements).toEqual([requirement]);
    const finish = {
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      status: 'succeeded' as const,
      result: { actual: true },
    };
    await rejected(f.store.finishExecution(finish), 'requirement_not_satisfied');
    await rejected(
      f.store.finishExecution({
        ...finish,
        requirements: [{ requirement, recordRevision: '2', outcome: 'satisfied', evidence: {} }],
      }),
      'requirement_not_satisfied',
    );
    expect((await f.store.getExecution(ref.executionId!))?.status).toBe('dispatching');
    expect(
      (
        await f.store.finishExecution({
          ...finish,
          requirements: [
            {
              requirement,
              recordRevision: '1',
              outcome: 'satisfied',
              evidence: { record: 'validation' },
            },
          ],
        })
      ).status,
    ).toBe('succeeded');
  } finally {
    await f.cleanup();
  }
});

test('real Job effect with lost terminal commit remains queryable and ensure never starts it again', async () => {
  const f = await fixture();
  try {
    const ref = await f.store.ensureOperation(f.input);
    const ledger = join(f.dataRoot, 'external-job-ledger');
    const definition: JobDefinition = {
      id: 'fixture/job',
      version: '1',
      description: 'disposable ledger',
      inputSchema: { type: 'object' },
      async start() {
        appendFileSync(ledger, 'effect\n', { mode: 0o600 });
        return { reference: { id: 'ledger-job' } };
      },
      async *observe() {
        yield {
          type: 'terminal',
          supervision: 'ended',
          result: { outcome: 'succeeded', content: 'done' },
        };
      },
      async cancel() {
        return { status: 'already_finished' };
      },
      async dispose() {},
    };
    const executor = new UnifiedExecution({
      store: f.store,
      permissions: {
        async authorize() {
          return { allowed: true, revision: '0' };
        },
      },
      resources: new ExecutionResources(),
    });
    f.db.exec(
      "CREATE TRIGGER terminal_fault BEFORE INSERT ON change_event WHEN NEW.type='execution.finished' BEGIN SELECT RAISE(ABORT,'terminal commit fault'); END",
    );
    let error: unknown;
    try {
      await executor.job(
        {
          command: (await f.store.getCommand(ref.commandId))!,
          owner: f.owner,
          workspaceId: 'w',
          parentExecutionId: 'parent',
          signal: new AbortController().signal,
        },
        {
          executionId: ref.executionId!,
          definition,
          request: {},
          source: f.source,
          cancelWithParent: true,
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('terminal commit fault');
    expect((await f.store.getExecution(ref.executionId!))?.status).toBe('running');
    expect((await f.store.getExecution(ref.executionId!))?.reference).toEqual({ id: 'ledger-job' });
    expect(await f.store.ensureOperation(f.input)).toEqual(ref);
    expect(readFileSync(ledger, 'utf8')).toBe('effect\n');
    f.db.exec('DROP TRIGGER terminal_fault');
  } finally {
    await f.cleanup();
  }
});

test('output budget includes JSON escaping and rejects empty facts without allocating a sequence', async () => {
  const f = await fixture();
  try {
    const ref = await dispatched(f);
    const input = {
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      stream: 'stdout' as const,
    };
    await rejected(
      f.store.appendExecutionOutput({ ...input, content: '' }),
      'empty_execution_output',
    );
    expect(
      (await f.store.listExecutionOutput({ executionId: ref.executionId! })).highWaterSeq,
    ).toBe('0');
    for (let index = 0; index < 16; index++)
      await f.store.appendExecutionOutput({ ...input, content: '\n'.repeat(32768) });
    expect(
      f.db.query('SELECT output_bytes FROM execution WHERE id=?').get(ref.executionId!),
    ).toEqual({ output_bytes: 15 * (65538 + 128) });
    const page = await f.store.listExecutionOutput({ executionId: ref.executionId! });
    expect(page.items).toHaveLength(16);
    expect(page.items[15]).toMatchObject({
      seq: '16',
      throughSeq: '16',
      content: '',
      droppedBytes: '32768',
    });
  } finally {
    await f.cleanup();
  }
});

test('ordinary Tool progress uses bounded output facts only while dispatched; stdout, planned and terminal output cannot masquerade as progress', async () => {
  const f = await fixture();
  const input = {
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId: 'parent',
    stream: 'progress' as const,
    content: '{"stage":"started"}',
  };
  try {
    const before = await f.store.getExecution('parent');
    expect(before?.status).toBe('dispatching');
    const progress = await f.store.appendExecutionOutput(input);
    expect(progress.seq).toBe('1');
    expect((await f.store.getExecution('parent'))?.status).toBe('dispatching');
    await rejected(
      f.store.appendExecutionOutput({ ...input, stream: 'stdout' }),
      'invalid_execution_output',
    );
    await rejected(
      f.store.appendExecutionOutput({ ...input, expectedStoreId: 'different' }),
      'store_identity_mismatch',
    );
    await rejected(
      f.store.appendExecutionOutput({ ...input, owner: { ...f.owner, generation: '999' } }),
      'owner_changed',
    );
    await rejected(
      f.store.appendExecutionOutput({ ...input, content: 'x'.repeat(32769) }),
      'output_chunk_too_large',
    );
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'not-dispatched',
      sessionId: 's',
      runId: f.run.id,
      originCommandId: 'work',
      stepId: 'step2',
      callId: 'call2',
      kind: 'tool',
      definitionId: 'fixture/parent',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    await rejected(
      f.store.appendExecutionOutput({ ...input, executionId: 'not-dispatched' }),
      'invalid_execution_output',
    );
    await f.store.cancelWork({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'user',
      commandId: 'cancel-progress',
      kind: 'execution.cancel',
      executionId: 'parent',
    });
    expect(
      (await f.store.appendExecutionOutput({ ...input, content: 'late actual progress' })).seq,
    ).toBe('2');
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'parent',
      status: 'cancelled',
      result: { outcome: 'cancelled', content: 'stopped' },
    });
    await rejected(f.store.appendExecutionOutput(input), 'invalid_execution_output');
    const page = await f.store.listExecutionOutput({ executionId: 'parent' });
    expect(page.highWaterSeq).toBe('2');
    expect(page.items.map((row) => row.stream)).toEqual(['progress', 'progress']);
    expect((await f.store.getExecution('parent'))?.status).toBe('cancelled');
  } finally {
    await f.cleanup();
  }
});

test('two hundred real content rows merge with interleaved stream gaps; clipping prevents unread chunks or overlapped tails from being skipped', async () => {
  const f = await fixture();
  try {
    const ref = await dispatched(f);
    const append = (
      stream: 'stdout' | 'stderr' | 'progress',
      content: string,
      droppedBytes?: string,
    ) =>
      f.store.appendExecutionOutput({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: ref.executionId!,
        stream,
        content,
        ...(droppedBytes ? { droppedBytes } : {}),
      });
    for (let index = 0; index < 100; index++) await append('stderr', `chunk-${index}`);
    await append('stdout', 'drop-stdout', '1');
    for (let index = 100; index < 220; index++) await append('stderr', `chunk-${index}`);
    await append('progress', 'drop-progress', '1');
    await append('stdout', 'tail-stdout', '1');
    await append('stderr', 'drop-stderr', '1');
    await append('progress', 'tail-progress', '1');
    const upper = '225';
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const first = await f.store.listExecutionOutput({
      executionId: ref.executionId!,
      upperSeq: upper,
      limit: 200,
    });
    expect(first.items.filter((item) => item.droppedBytes === '0')).toHaveLength(200);
    expect(first.items.find((item) => item.stream === 'stdout')).toMatchObject({
      seq: '101',
      throughSeq: '201',
      droppedBytes: null,
    });
    const after = first.items.reduce(
      (maximum, item) => (BigInt(item.throughSeq) > BigInt(maximum) ? item.throughSeq : maximum),
      '0',
    );
    expect(after).toBe('201');
    const second = await f.store.listExecutionOutput({
      executionId: ref.executionId!,
      afterSeq: after,
      upperSeq: upper,
      limit: 200,
    });
    expect(second.items.filter((item) => item.droppedBytes === '0')).toHaveLength(20);
    expect(second.items.find((item) => item.stream === 'stdout')).toMatchObject({
      seq: '202',
      throughSeq: '223',
      droppedBytes: null,
    });
    expect(second.items.find((item) => item.stream === 'progress')).toMatchObject({
      seq: '222',
      throughSeq: '225',
    });
    expect(
      second.items.find((item) => item.stream === 'stderr' && item.droppedBytes !== '0'),
    ).toMatchObject({ seq: '224', throughSeq: '224' });
    expect(second.items.at(-1)?.throughSeq).toBe('224');
    const complete = second.items.reduce(
      (maximum, item) => (BigInt(item.throughSeq) > BigInt(maximum) ? item.throughSeq : maximum),
      after,
    );
    expect(complete).toBe(upper);
    expect(
      (
        await f.store.listExecutionOutput({
          executionId: ref.executionId!,
          afterSeq: complete,
          upperSeq: upper,
          limit: 200,
        })
      ).items,
    ).toHaveLength(0);
    const retained = [...first.items, ...second.items].filter((item) => item.droppedBytes === '0');
    expect(retained).toHaveLength(220);
    expect(new Set(retained.map((item) => item.content)).size).toBe(220);
    expect(first.items.length).toBeLessThanOrEqual(203);
    expect(second.items.length).toBeLessThanOrEqual(203);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.cleanup();
  }
});
