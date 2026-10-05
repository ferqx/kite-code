import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { EnsureOperationInput } from '../../../src/storage/port';

async function rejects(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-result-requirements-');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: `file://${dataRoot}`,
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createSession({ ...base, workspaceId: 'w', commandId: 'create', title: 'results' });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'actual storage execution' },
  });
  const owner = (await store.acquireSessionOwner('s', 'fixture'))!;
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
    stepId: 'step',
    callId: 'call',
    definitionId: 'parent',
    definitionVersion: '1',
    input: {},
    decisionSource: source,
  });
  await store.markDispatching({
    ...write,
    executionId: 'parent',
    authorization: {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    },
    requirements: [],
    freshness: { checked: true, source },
  });
  const ensure: EnsureOperationInput = {
    ...write,
    sessionId: 's',
    extensionId: 'fixture',
    originCommandId: 'work',
    parentExecutionId: 'parent',
    operationKey: 'child',
    request: { kind: 'agent', configurationId: 'child', input: { content: 'private' } },
    childConfiguration: { id: 'child', version: '1', snapshot: { tools: [] } },
    resultRequirement: {
      recordKey: `run/${run.id}/required`,
      requirementId: 'result',
      definitionVersion: '1',
      contentType: 'fixture/result',
      contentVersion: 1,
    },
    resultRequirementSchema: {
      type: 'object',
      properties: { kind: { const: 'operation_result' } },
      required: ['kind'],
    },
  };
  const database = new Database(join(dataRoot, 'test', 'core.db'));
  const finish = async (status: 'succeeded' | 'outcome_unknown') => {
    const ref = await store.ensureOperation(ensure);
    const execution = (await store.getExecution(ref.executionId!))!;
    await store.markDispatching({
      ...write,
      executionId: execution.id,
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest(execution.input),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    await store.finishExecution({
      ...write,
      executionId: execution.id,
      status,
      result: { outcome: status, content: 'untrusted complete external body' },
      requirements: [],
    });
    return ref;
  };
  return {
    store,
    database,
    write,
    run,
    ensure,
    base,
    finish,
    async close() {
      database.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
test('carrier, immutable metadata and original Run obligation commit atomically; exact replay adds no effects and schema mismatch rolls back', async () => {
  const f = await fixture();
  try {
    f.database.run(
      "CREATE TRIGGER requirement_fault BEFORE INSERT ON change_event WHEN NEW.type='run.requirements_registered' BEGIN SELECT RAISE(ABORT,'bounded registration fault'); END",
    );
    let failed = false;
    try {
      await f.store.ensureOperation(f.ensure);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await f.store.getRun(f.run.id))?.requirements).toHaveLength(0);
    expect((await f.store.getView('s')).executions).toHaveLength(1);
    expect(
      f.database.query("SELECT COUNT(*) AS count FROM session WHERE parent_id='s'").get(),
    ).toEqual({ count: 0 });
    expect(
      await f.store.getExtensionRecord({
        extensionId: 'fixture',
        sessionId: 's',
        key: f.ensure.resultRequirement!.recordKey,
      }),
    ).toBeNull();
    f.database.run('DROP TRIGGER requirement_fault');
    await rejects(
      f.store.ensureOperation({
        ...f.ensure,
        resultRequirementSchema: { type: 'object', properties: { kind: { const: 'wrong' } } },
      }),
      'invalid_result_requirement',
    );
    expect((await f.store.getView('s')).executions).toHaveLength(1);
    const ref = await f.store.ensureOperation(f.ensure);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.ensureOperation(f.ensure)).toEqual(ref);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.getRun(f.run.id))?.requirements).toHaveLength(1);
    await rejects(
      f.store.ensureOperation({
        ...f.ensure,
        resultRequirement: undefined,
        resultRequirementSchema: undefined,
      }),
      'operation_conflict',
    );
    await rejects(
      f.store.ensureOperation({ ...f.ensure, resultRequirementSchema: { type: 'object' } }),
      'operation_conflict',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});
test('unknown diagnostic is status-only, idempotent, not acceptance; wrong Store, root stop and changed selection cannot grant a source', async () => {
  const f = await fixture();
  try {
    const ref = await f.finish('outcome_unknown');
    const requiredRef = (await f.store.getRun(f.run.id))!.requirements[0]!;
    const input = {
      ...f.write,
      sessionId: 's',
      targetRunId: f.run.id,
      executionId: ref.executionId!,
      resultRevision: '1',
      contextSelectionId: (await f.store.getSession('s'))!.contextSelectionId,
      requiredRef,
      requiredDiagnostic: true,
      commandId: 'diagnosis',
    };
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await rejects(
      f.store.consumeJobResult({ ...input, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await rejects(
      f.store.consumeJobResult({ ...input, contextSelectionId: 'foreign-selection' }),
      'context_rewound',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    const first = await f.store.consumeJobResult(input);
    expect(first.source.result).toEqual({
      outcome: 'outcome_unknown',
      content: 'required_operation_settlement',
      details: { executionId: ref.executionId!, resultRevision: '1', statusOnly: true },
    });
    expect((await f.store.getExecution(ref.executionId!))?.resultAcceptance).toBeNull();
    expect((await f.store.getExecution(ref.executionId!))?.delivery).toBe('pending');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.consumeJobResult(input)).toEqual(first);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.store.cancelWork({
      ...f.base,
      commandId: 'stop',
      kind: 'session.cancel',
      includeBackground: true,
    });
    const stopped = (await f.store.getMetadata()).lastChangeCursor;
    let denied = false;
    try {
      await f.store.consumeJobResult({ ...input, commandId: 'late-diagnosis' });
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(stopped);
    expect(
      (
        await f.store.getSelectedContext({
          expectedStoreId: f.write.expectedStoreId,
          sessionId: 's',
        })
      ).resultSources,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
