import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const directory = mkdtempSync(join(tmpdir(), 'kite-condition-result-wait-'));
  const dataRoot = join(directory, 'data');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: pathToFileURL(dataRoot).href,
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
  };
  return {
    store,
    write,
    run,
    ensure,
    base,
    async close() {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('a custom exact receipt may wait after terminal settlement; foreign facts and changed revisions never bind it', async () => {
  for (const damage of ['none', 'parent', 'work', 'selection', 'revision'] as const) {
    const f = await fixture();
    try {
      const ref = await f.store.ensureOperation(f.ensure);
      const execution = (await f.store.getExecution(ref.executionId!))!;
      const recordKey = `run/${f.run.id}/custom-receipt`;
      const record = await f.store.writeExtensionRecord({
        ...f.write,
        sessionId: 's',
        extensionId: 'fixture',
        originCommandId: 'work',
        originExecutionId: 'parent',
        write: {
          key: recordKey,
          expectedRevision: null,
          contentType: 'fixture/custom-receipt',
          contentVersion: 1,
          executable: true,
          value: {
            kind: 'custom_receipt',
            executionId: execution.id,
            sessionId: 's',
            runId: f.run.id,
            parentExecutionId: damage === 'parent' ? 'foreign-parent' : execution.parentExecutionId,
            originStoreId: f.write.expectedStoreId,
            originCommandId: execution.originCommandId,
            rootWorkCommandId: damage === 'work' ? 'foreign-work' : execution.rootWorkCommandId,
            rootWorkSeq: execution.rootWorkSeq,
            contextSelectionId:
              damage === 'selection'
                ? 'foreign-selection'
                : (await f.store.getSession('s'))!.contextSelectionId,
          },
        },
      });
      await f.store.registerRunRequirements({
        ...f.write,
        runId: f.run.id,
        requirements: [
          {
            extensionId: 'fixture',
            definitionVersion: '1',
            requirementId: 'custom-receipt',
            recordKey,
            revision: record.revision,
            phase: 'completion',
            sessionId: 's',
            runId: f.run.id,
          },
        ],
      });
      if (damage === 'revision')
        await f.store.writeExtensionRecord({
          ...f.write,
          sessionId: 's',
          extensionId: 'fixture',
          originCommandId: 'work',
          originExecutionId: 'parent',
          write: {
            key: recordKey,
            expectedRevision: record.revision,
            contentType: record.contentType,
            contentVersion: 1,
            executable: true,
            value: record.value,
          },
        });
      await f.store.markDispatching({
        ...f.write,
        executionId: execution.id,
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest(execution.input),
        },
        requirements: [],
        freshness: { checked: true, source: { kind: 'model_decision', modelExecutionId: 'fixed' } },
      });
      await f.store.finishExecution({
        ...f.write,
        executionId: execution.id,
        status: 'succeeded',
        result: { outcome: 'succeeded', content: 'Original receipt; not yet included' },
        requirements: [],
      });
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      const waiting = f.store.setRunResultWait({
        ...f.write,
        runId: f.run.id,
        executionIds: [execution.id],
      });
      if (damage === 'none') {
        expect(await waiting).toMatchObject({
          status: 'waiting_execution',
          isActive: true,
        });
        expect((await f.store.getExecution(execution.id))!.resultAcceptance).toBeNull();
      } else {
        await rejects(waiting, 'required_result_unverifiable');
        expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      }
    } finally {
      await f.close();
    }
  }
});
