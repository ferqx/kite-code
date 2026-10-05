import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  const dataRoot = mkdtempSync('/private/tmp/kite-cancel-work-');
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
    commandId: 'action',
    sessionId: 's',
    subjectId: 'user',
    request: {
      kind: 'extension.invoke',
      extensionId: 'fixture',
      actionId: 'start',
      definitionVersion: '1',
      input: {},
    },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const source = {
    kind: 'action_decision',
    commandId: 'action',
    extensionId: 'fixture',
    actionId: 'start',
    definitionVersion: '1',
    preparedDigest: await semanticDigest({}),
  };
  await store.planAction({
    expectedStoreId,
    owner,
    commandId: 'action',
    executionId: 'parent',
    extensionId: 'fixture',
    definitionId: 'fixture/start',
    definitionVersion: '1',
    input: {},
    decisionSource: source,
  });
  const dispatch = async (executionId: string) =>
    store.markDispatching({
      expectedStoreId,
      owner,
      executionId,
      authorization: {
        allowed: true,
        revision: '0',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
  await dispatch('parent');
  const operation = async (key: string, cancellation: 'attached' | 'detached') =>
    store.ensureOperation({
      expectedStoreId,
      owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'action',
      parentExecutionId: 'parent',
      operationKey: key,
      cancellation,
      request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
    });
  const attached = await operation('attached', 'attached');
  const detached = await operation('detached', 'detached');
  await dispatch(attached.executionId!);
  await dispatch(detached.executionId!);
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  return {
    store,
    db,
    expectedStoreId,
    owner,
    source,
    dispatch,
    operation,
    attached,
    detached,
    cleanup: async () => {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
test('completed Action permits independently supervised Jobs and local command cancellation reaches only attached children', async () => {
  const f = await fixture();
  try {
    const parent = await f.store.applyExtensionAction({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'parent',
      extensionId: 'fixture',
      status: 'succeeded',
      result: { startup: 'accepted' },
    });
    expect(parent.status).toBe('succeeded');
    const receipt = await f.store.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      subjectId: 'user',
      targetCommandId: 'action',
    });
    expect(receipt.receipt).toMatchObject({ outcome: 'cancel_requested' });
    expect((await f.store.getCommand(f.attached.commandId))?.cancelRequestedAt).not.toBeNull();
    expect((await f.store.getExecution(f.attached.executionId!))?.cancelRequestedAt).not.toBeNull();
    expect((await f.store.getCommand(f.detached.commandId))?.cancelRequestedAt).toBeNull();
    expect((await f.store.getExecution(f.detached.executionId!))?.cancelRequestedAt).toBeNull();
    await f.store.markRunning({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: f.attached.executionId!,
      reference: { actual: 'started' },
    });
    const actual = await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: f.attached.executionId!,
      status: 'succeeded',
      result: { real: true },
    });
    expect(actual.status).toBe('succeeded');
    expect((await f.store.getExecution('parent'))?.status).toBe('succeeded');
  } finally {
    await f.cleanup();
  }
});
test('execution cancel exact scope, Session boundary, new top-level work and old retry preserve their durable targets', async () => {
  const f = await fixture();
  try {
    const base = { expectedStoreId: f.expectedStoreId, sessionId: 's', subjectId: 'user' };
    await f.store.cancelWork({
      ...base,
      commandId: 'cancel-exec',
      kind: 'execution.cancel',
      executionId: f.attached.executionId!,
    });
    expect((await f.store.getCommand('action'))?.cancelRequestedAt).toBeNull();
    expect((await f.store.getCommand(f.detached.commandId))?.cancelRequestedAt).toBeNull();
    const stopped = await f.store.cancelWork({
      ...base,
      commandId: 'stop',
      kind: 'session.cancel',
      includeBackground: true,
    });
    expect(stopped.receipt).toMatchObject({ outcome: 'cancel_requested' });
    expect((await f.store.getCommand(f.detached.commandId))?.cancelRequestedAt).not.toBeNull();
    await rejected(f.operation('late-detached', 'detached'), 'cancelled_before_dispatch');
    expect(
      await f.store.getOperation({
        extensionId: 'fixture',
        sessionId: 's',
        key: 'late-detached',
        subjectId: 'user',
        originStoreId: f.expectedStoreId,
      }),
    ).toBeNull();
    await f.store.acceptCommand({
      ...base,
      commandId: 'new',
      request: { kind: 'run.start', content: 'new explicit intent' },
    });
    const run = await f.store.startRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      commandId: 'new',
      configuration: {},
    });
    expect(run.isActive).toBe(true);
    expect(
      await f.store.cancelWork({
        ...base,
        commandId: 'stop',
        kind: 'session.cancel',
        includeBackground: true,
      }),
    ).toEqual(stopped);
    expect((await f.store.getCommand('new'))?.cancelRequestedAt).toBeNull();
    await rejected(
      f.store.cancelWork({
        ...base,
        commandId: 'stop',
        kind: 'session.cancel',
        includeBackground: false,
      }),
      'command_conflict',
    );
  } finally {
    await f.cleanup();
  }
});
test('cancel rejects foreign subject/store and transaction failure rolls back every flag and receipt', async () => {
  const f = await fixture();
  try {
    const input = {
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'user',
      commandId: 'cancel',
      kind: 'execution.cancel' as const,
      executionId: 'parent',
    };
    const before = await f.store.getView('s');
    await rejected(f.store.cancelWork({ ...input, subjectId: 'intruder' }), 'permission_denied');
    await rejected(
      f.store.cancelWork({ ...input, expectedStoreId: 'other' }),
      'store_identity_mismatch',
    );
    expect(await f.store.getView('s')).toEqual(before);
    f.db.exec(
      "CREATE TRIGGER cancel_fault BEFORE INSERT ON change_event WHEN NEW.type='command.cancel_requested' BEGIN SELECT RAISE(ABORT,'cancel commit fault'); END",
    );
    let error: unknown;
    try {
      await f.store.cancelWork(input);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('cancel commit fault');
    expect(await f.store.getView('s')).toEqual(before);
    expect(await f.store.getCommand('cancel')).toBeNull();
    expect((await f.store.getCommand(f.attached.commandId))?.cancelRequestedAt).toBeNull();
    f.db.exec('DROP TRIGGER cancel_fault');
    const applied = await f.store.cancelWork(input);
    expect(applied.status).toBe('applied');
    expect((await f.store.getExecution(f.attached.executionId!))?.status).toBe('dispatching');
  } finally {
    await f.cleanup();
  }
});

test('normal Tool execution cancellation does not widen to its Run and foreground-only stop excludes detached Jobs', async () => {
  const f = await fixture();
  try {
    const base = { expectedStoreId: f.expectedStoreId, sessionId: 's', subjectId: 'user' };
    await f.store.acceptCommand({
      ...base,
      commandId: 'run-work',
      request: { kind: 'run.start', content: 'foreground' },
    });
    const run = await f.store.startRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      commandId: 'run-work',
      configuration: { tools: [{ id: 'normal', version: '1', extensionId: 'fixture' }] },
    });
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'normal-tool',
      sessionId: 's',
      runId: run.id,
      kind: 'tool',
      originCommandId: 'run-work',
      stepId: 'step',
      callId: 'normal',
      definitionId: 'normal',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    await f.dispatch('normal-tool');
    const children = [];
    for (const cancellation of ['attached', 'detached'] as const)
      children.push(
        await f.store.ensureOperation({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          sessionId: 's',
          extensionId: 'fixture',
          originCommandId: 'run-work',
          parentExecutionId: 'normal-tool',
          operationKey: `normal-${cancellation}`,
          cancellation,
          request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
        }),
      );
    await f.store.cancelWork({
      ...base,
      commandId: 'normal-cancel',
      kind: 'execution.cancel',
      executionId: 'normal-tool',
    });
    expect((await f.store.getCommand('run-work'))?.cancelRequestedAt).toBeNull();
    expect((await f.store.getRun(run.id))?.isActive).toBe(true);
    expect(
      (await f.store.getExecution(children[0]!.executionId!))?.cancelRequestedAt,
    ).not.toBeNull();
    expect((await f.store.getExecution(children[1]!.executionId!))?.cancelRequestedAt).toBeNull();
    await rejected(f.dispatch(children[0]!.executionId!), 'cancelled_before_dispatch');
    await f.dispatch(children[1]!.executionId!);
    const stop = await f.store.cancelWork({
      ...base,
      commandId: 'foreground-stop',
      kind: 'session.cancel',
      includeBackground: false,
    });
    expect((await f.store.getCommand('run-work'))?.cancelRequestedAt).not.toBeNull();
    expect((await f.store.getCommand(children[1]!.commandId))?.cancelRequestedAt).toBeNull();
    expect((await f.store.getCommand(f.detached.commandId))?.cancelRequestedAt).toBeNull();
    await f.store.finishRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      runId: run.id,
      status: 'cancelled',
      requirements: [],
    });
    await f.store.acceptCommand({
      ...base,
      commandId: 'later-work',
      request: { kind: 'run.start', content: 'later explicit intent' },
    });
    const later = await f.store.startRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      commandId: 'later-work',
      configuration: {},
    });
    expect(
      await f.store.cancelWork({
        ...base,
        commandId: 'foreground-stop',
        kind: 'session.cancel',
        includeBackground: false,
      }),
    ).toEqual(stop);
    expect((await f.store.getCommand('later-work'))?.cancelRequestedAt).toBeNull();
    const exact = await f.store.cancelWork({
      ...base,
      commandId: 'cancel-old-run',
      kind: 'run.cancel',
      runId: run.id,
    });
    expect(exact.receipt).toMatchObject({ runId: run.id, outcome: 'cancel_requested' });
    expect((await f.store.getRun(later.id))?.isActive).toBe(true);
    expect((await f.store.getCommand('later-work'))?.cancelRequestedAt).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('independent Job lifecycle does not weaken ordinary child Tool finalization guard', async () => {
  const f = await fixture();
  try {
    const ref = await f.store.ensureOperation({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'action',
      parentExecutionId: 'parent',
      operationKey: 'ordinary-tool',
      request: { kind: 'tool', definitionId: 'tool', definitionVersion: '1', input: {} },
    });
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'ordinary',
      sessionId: 's',
      runId: null,
      kind: 'tool',
      originCommandId: ref.commandId,
      parentExecutionId: 'parent',
      stepId: 'step',
      callId: 'ordinary',
      definitionId: 'tool',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    await rejected(
      f.store.applyExtensionAction({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: 'parent',
        extensionId: 'fixture',
        status: 'succeeded',
        result: {},
      }),
      'execution_unsettled',
    );
    expect((await f.store.getExecution('parent'))?.status).toBe('dispatching');
  } finally {
    await f.cleanup();
  }
});

test('durable cancellation wins late failed Run settlement while an earlier completion remains final', async () => {
  const f = await fixture();
  try {
    const base = { expectedStoreId: f.expectedStoreId, sessionId: 's', subjectId: 'user' };
    const write = { expectedStoreId: f.expectedStoreId, owner: f.owner };
    for (const id of ['cancel-first', 'complete-first']) {
      await f.store.acceptCommand({
        ...base,
        commandId: id,
        request: { kind: 'run.start', content: id },
      });
      const run = await f.store.startRun({ ...write, commandId: id, configuration: {} });
      if (id === 'cancel-first') {
        await f.store.cancelCommand({
          ...base,
          commandId: 'cancel-first-request',
          targetCommandId: id,
        });
        const terminal = await f.store.finishRun({
          ...write,
          runId: run.id,
          status: 'failed',
          reason: 'late model dispatch refused',
          requirements: [],
        });
        expect(terminal.status).toBe('cancelled');
        expect(terminal.reason).toBe('late model dispatch refused');
        expect(
          await f.store.finishRun({
            ...write,
            runId: run.id,
            status: 'failed',
            reason: 'late model dispatch refused',
            requirements: [],
          }),
        ).toEqual(terminal);
      } else {
        const terminal = await f.store.finishRun({
          ...write,
          runId: run.id,
          status: 'completed',
          requirements: [],
        });
        await f.store.cancelCommand({
          ...base,
          commandId: 'complete-first-request',
          targetCommandId: id,
        });
        expect(await f.store.getRun(run.id)).toEqual(terminal);
        expect(terminal.status).toBe('completed');
      }
    }
  } finally {
    await f.cleanup();
  }
});
