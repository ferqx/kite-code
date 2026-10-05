import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionRecord, Json } from '../../../src/storage';
import type { DispatchInput } from '../../../src/storage/port';
import { dispatchRecordRead } from '../../../src/storage/sqlite/dispatch-read-set';

async function errorCode(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code: string }).code;
  }
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-group-dispatch-');
  const profile = { dataRoot, profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'owner' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: `file://${dataRoot}`,
    name: 'temporary',
  });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      ...base,
      sessionId,
      workspaceId: 'w',
      commandId: `create-${sessionId}`,
      title: sessionId,
    });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const accept = (commandId: string, sessionId = 's') =>
    store.acceptCommand({
      ...base,
      commandId,
      sessionId,
      request: { kind: 'run.start', content: 'real new work' },
    });
  const plan = async (
    executionId: string,
    guard = true,
    records: ReturnType<typeof dispatchRecordRead>[] = [],
    originalContextRevision?: string,
  ) => {
    const commandId = `command-${executionId}`;
    await store.acceptCommand({
      ...base,
      commandId,
      sessionId: 's',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'effect',
        definitionVersion: '1',
        input: {},
      },
    });
    const contextRevision = guard
      ? (originalContextRevision ??
        (
          await store.readExecutionGroupSafety({
            ...base,
            sessionId: 's',
            boundaryCommandId: commandId,
          })
        ).contextRevision)
      : undefined;
    const source: Json = {
      kind: 'action_decision',
      commandId,
      extensionId: 'fixture',
      actionId: 'effect',
      definitionVersion: '1',
      preparedDigest: await semanticDigest({}),
      recordReads: records as unknown as Json,
      recordListReads: [],
      ...(guard
        ? {
            contextRevision: contextRevision!,
            guard: {
              kind: 'execution_group_quiescence',
              version: 1,
              rootSessionId: 's',
              originCommandId: commandId,
            },
          }
        : {}),
    };
    await store.planAction({
      expectedStoreId,
      owner,
      commandId,
      executionId,
      extensionId: 'fixture',
      definitionId: 'fixture/effect',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    const dispatch: DispatchInput = {
      expectedStoreId,
      owner,
      executionId,
      authorization: {
        allowed: true,
        revision: 'trusted',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
      readSet: { records, recordLists: [] },
    };
    const capture = async () => {
      const safety = await store.readExecutionGroupSafety({
        ...base,
        sessionId: 's',
        boundaryCommandId: commandId,
        excludeExecutionId: executionId,
      });
      if (safety.quiescent)
        dispatch.readSet!.executionGroup = {
          rootSessionId: 's',
          executionId,
          revision: safety.revision,
          contextRevision,
          quiescent: true,
        };
      return safety;
    };
    return { commandId, dispatch, capture };
  };
  return {
    store,
    profile,
    base,
    owner,
    expectedStoreId,
    accept,
    plan,
    async close() {
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('whole-root safety excludes only actual carrier/intake; final SQL rejects accepted work after fresh capture without dispatch event', async () => {
  const f = await fixture();
  try {
    const p = await f.plan('guarded');
    expect((await p.capture()).quiescent).toBe(true);
    expect(
      await errorCode(
        f.store.readExecutionGroupSafety({
          ...f.base,
          sessionId: 's',
          boundaryCommandId: p.commandId,
          excludeExecutionId: 'missing',
        }),
      ),
    ).toBe('execution_group_boundary_invalid');
    expect(
      await errorCode(
        f.store.readExecutionGroupSafety({ ...f.base, subjectId: 'foreign', sessionId: 's' }),
      ),
    ).toBe('execution_group_scope_denied');
    await f.accept('late-work');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await errorCode(f.store.markDispatching(p.dispatch))).toBe(
      'execution_group_not_quiescent',
    );
    expect((await f.store.getExecution('guarded'))!.status).toBe('planned');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await p.capture()).pendingCommandIds).toEqual(['late-work']);
  } finally {
    await f.close();
  }
});

test('original complete Message lineage remains a final SQL dependency when latest quiescence is refreshed', async () => {
  const f = await fixture();
  try {
    const p = await f.plan('original-context');
    const original = await p.capture();
    await f.accept('later-complete-work');
    const run = await f.store.startRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      commandId: 'later-complete-work',
      configuration: { tools: [] },
    });
    await f.store.finishRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      runId: run.id,
      status: 'completed',
      requirements: [],
    });
    const refreshed = await p.capture();
    expect(refreshed.quiescent).toBe(true);
    expect(refreshed.contextRevision).not.toBe(original.contextRevision);
    expect(p.dispatch.readSet!.executionGroup!.contextRevision).toBe(original.contextRevision);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await errorCode(f.store.markDispatching(p.dispatch))).toBe('dispatch_read_set_changed');
    expect((await f.store.getExecution('original-context'))!.status).toBe('planned');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('current selection is pinned independently of the shared Command and Ask allocation watermark', async () => {
  const f = await fixture();
  try {
    const original = await f.store.readExecutionGroupSafety({ ...f.base, sessionId: 's' });
    const selection = (await f.store.getSession('s'))!.contextSelectionId;
    await f.store.selectContext({
      ...f.base,
      commandId: 'select-empty',
      sessionId: 's',
      expectedContextSelectionId: selection,
      boundary: null,
    });
    const p = await f.plan('stale-selection', true, [], original.contextRevision);
    const refreshed = await p.capture();
    expect(refreshed.quiescent).toBe(true);
    expect(refreshed.contextRevision).not.toBe(original.contextRevision);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await errorCode(f.store.markDispatching(p.dispatch))).toBe('dispatch_read_set_changed');
    expect((await f.store.getExecution('stale-selection'))!.status).toBe('planned');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('committed carrier fences new same-root work and Actions; other root continues; actual known terminal releases fence', async () => {
  const f = await fixture();
  try {
    const p = await f.plan('guarded');
    await p.capture();
    expect((await f.store.markDispatching(p.dispatch)).status).toBe('dispatching');
    const beforeChild = (await f.store.getMetadata()).lastChangeCursor;
    expect(
      await errorCode(
        f.store.ensureOperation({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          sessionId: 's',
          extensionId: 'fixture',
          originCommandId: p.commandId,
          parentExecutionId: 'guarded',
          operationKey: 'guarded-child',
          request: { kind: 'agent', configurationId: 'reviewer', input: { task: 'no spawn' } },
          childConfiguration: { id: 'reviewer', version: '1', snapshot: { tools: [] } },
        }),
      ),
    ).toBe('execution_group_fenced');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(beforeChild);
    await f.accept('queued');
    expect(
      await errorCode(
        f.store.startRun({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          commandId: 'queued',
          configuration: { tools: [] },
        }),
      ),
    ).toBe('execution_group_fenced');
    expect(await errorCode(f.plan('new-action', false))).toBe('execution_group_fenced');
    await f.accept('other-work', 'other');
    const otherOwner = (await f.store.acquireSessionOwner('other', 'other-host'))!;
    expect(
      (
        await f.store.startRun({
          expectedStoreId: f.expectedStoreId,
          owner: otherOwner,
          commandId: 'other-work',
          configuration: { tools: [] },
        })
      ).sessionId,
    ).toBe('other');
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'guarded',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'known real adapter completion' },
    });
    expect(
      (
        await f.store.startRun({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          commandId: 'queued',
          configuration: { tools: [] },
        })
      ).sessionId,
    ).toBe('s');
  } finally {
    await f.close();
  }
});

test('immutable missing prepare record is final SQL dependency; ordinary empty read-set remains compatible', async () => {
  const f = await fixture();
  try {
    const records = [dispatchRecordRead('fixture', 's', 'missing', null)];
    const p = await f.plan('ordinary', false, records);
    expect((await f.store.markDispatching(p.dispatch)).status).toBe('dispatching');
    await f.store.writeExtensionRecord({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: p.commandId,
      originExecutionId: 'ordinary',
      write: {
        key: 'missing',
        expectedRevision: null,
        contentType: 'fixture.fact',
        contentVersion: 1,
        value: { safe: true },
      },
    });
    const q = await f.plan('stale', false, records);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await errorCode(f.store.markDispatching(q.dispatch))).toBe('dispatch_read_set_changed');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.getExecution('stale'))!.status).toBe('planned');
    const empty = await f.plan('empty', false);
    expect((await f.store.markDispatching(empty.dispatch)).status).toBe('dispatching');
  } finally {
    await f.close();
  }
});

test('unknown guarded carrier retains fence in cold Store and cancel request is not known terminal', async () => {
  const f = await fixture();
  try {
    const p = await f.plan('unknown');
    await p.capture();
    await f.store.markDispatching(p.dispatch);
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'unknown',
      status: 'outcome_unknown',
      result: { outcome: 'unknown', content: 'actual adapter stop unconfirmed' },
    });
    await f.store.cancelCommand({
      ...f.base,
      sessionId: 's',
      commandId: 'cancel',
      targetCommandId: p.commandId,
    });
    expect((await f.store.getExecution('unknown'))!.status).toBe('outcome_unknown');
    await f.accept('blocked');
    expect(
      await errorCode(
        f.store.startRun({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          commandId: 'blocked',
          configuration: { tools: [] },
        }),
      ),
    ).toBe('execution_group_fenced');
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await cold.getExecution('unknown'))!.status).toBe('outcome_unknown');
      const safety = await cold.readExecutionGroupSafety({ ...f.base, sessionId: 's' });
      expect(safety.quiescent).toBe(false);
      expect(safety.unconfirmedExecutionIds).toContain('unknown');
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('trusted Host prepare seals guard; real Ask self qualifies and physical running carrier excludes concurrent new effect', async () => {
  const f = await fixture();
  const { createRuntime } = await import('../../../src');
  const { createFixedModel } = await import('@kite-ai/ai');
  let effects = 0,
    release!: () => void,
    entered!: () => void;
  const running = new Promise<void>((r) => {
    entered = r;
  });
  const finish = new Promise<void>((r) => {
    release = r;
  });
  let retained: (() => Promise<unknown>) | undefined;
  const runtime = createRuntime({
    instanceId: 'runtime-host',
    store: f.store,
    model: createFixedModel([]),
    modelId: 'fixed',
    permissions: {
      authorize: async () => ({
        allowed: false,
        revision: 'policy',
        approval: { request: { title: 'Exact quiescent Action' } },
      }),
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        actions: [
          {
            id: 'effect',
            version: '1',
            description: 'Harmless quiescent counter',
            inputSchema: { type: 'object', additionalProperties: false },
            async prepare(input, context) {
              await context.requireExecutionGroupQuiescent!();
              await context.records.get('absent');
              retained = () => context.records.get('absent');
              return input;
            },
            async execute() {
              effects++;
              entered();
              await finish;
              return { outcome: 'succeeded', content: 'physical known completion' };
            },
          },
        ],
      },
    ],
  });
  try {
    await f.store.releaseSessionOwner(f.owner);
    await runtime.submitCommand({
      ...f.base,
      commandId: 'host-action',
      sessionId: 's',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'effect',
        definitionVersion: '1',
        input: {},
      },
    });
    const deadline = Date.now() + 5000;
    let card: InteractionRecord | undefined;
    while (!card) {
      card = (await runtime.listInteractions({ ...f.base, sessionId: 's', state: 'pending' }))
        .interactions[0];
      if (Date.now() > deadline) throw Error('approval_timeout');
      if (!card) await Bun.sleep(5);
    }
    expect(effects).toBe(0);
    expect(await errorCode(retained!())).toBe('dispatch_read_context_closed');
    await runtime.answerInteraction({
      ...f.base,
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    await Promise.race([
      running,
      Bun.sleep(5000).then(() => {
        throw Error('effect_timeout');
      }),
    ]);
    expect(effects).toBe(1);
    await f.accept('while-running');
    const current = (await f.store.acquireSessionOwner('s', 'runtime-host'))!;
    expect(
      await errorCode(
        f.store.startRun({
          expectedStoreId: f.expectedStoreId,
          owner: current,
          commandId: 'while-running',
          configuration: { tools: [] },
        }),
      ),
    ).toBe('execution_group_fenced');
    release();
    await runtime.waitForCommand('host-action');
    expect((await f.store.getCommand('host-action'))!.receipt).toMatchObject({
      status: 'succeeded',
    });
    expect(effects).toBe(1);
  } finally {
    release();
    await runtime.close();
    await f.close();
  }
}, 10000);

test('prepare full projection pins unchanged JSON revision and list absence against later real writer', async () => {
  const f = await fixture();
  try {
    const writer = await f.plan('writer', false);
    await f.store.markDispatching(writer.dispatch);
    const write = (key: string, expectedRevision: string | null) =>
      f.store.writeExtensionRecord({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        sessionId: 's',
        extensionId: 'fixture',
        originCommandId: writer.commandId,
        originExecutionId: 'writer',
        write: {
          key,
          expectedRevision,
          contentType: 'fixture.fact',
          contentVersion: 1,
          value: { same: 'body' },
        },
      });
    await write('head', null);
    const record = await f.store.getExtensionRecord({
      sessionId: 's',
      extensionId: 'fixture',
      key: 'head',
    });
    const stale = await f.plan('same-json', false, [
      dispatchRecordRead('fixture', 's', 'head', record),
    ]);
    await write('head', record!.revision);
    expect(await errorCode(f.store.markDispatching(stale.dispatch))).toBe(
      'dispatch_read_set_changed',
    );
    const list = await f.store.listExtensionRecords({
      sessionId: 's',
      extensionId: 'fixture',
      afterKey: 'head',
      limit: 10,
    });
    const original = {
      extensionId: 'fixture',
      sessionId: 's',
      afterKey: 'head',
      limit: 10,
      contentType: null,
      digest: await semanticDigest(list as unknown as Json),
    };
    const p = await f.plan('list', false);
    // Public planAction enforces immutable source equality, so create a separate exact Action instead.
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'list',
      status: 'failed',
      result: { outcome: 'failed', content: 'unused exact original empty source' },
    });
    const commandId = 'list-command';
    await f.store.acceptCommand({
      ...f.base,
      sessionId: 's',
      commandId,
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'effect',
        definitionVersion: '1',
        input: {},
      },
    });
    const source: Json = {
      kind: 'action_decision',
      commandId,
      extensionId: 'fixture',
      actionId: 'effect',
      definitionVersion: '1',
      preparedDigest: await semanticDigest({}),
      recordReads: [],
      recordListReads: [original],
    };
    await f.store.planAction({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      commandId,
      executionId: 'list-exact',
      extensionId: 'fixture',
      definitionId: 'fixture/effect',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await write('new-key', null);
    expect(
      await errorCode(
        f.store.markDispatching({
          ...p.dispatch,
          executionId: 'list-exact',
          freshness: { checked: true, source },
          readSet: { records: [], recordLists: [original] },
        }),
      ),
    ).toBe('dispatch_read_set_changed');
  } finally {
    await f.close();
  }
});

test('whole root observes actual runless child carrier and activated child Run plus all execution kinds', async () => {
  const f = await fixture();
  try {
    const parent = await f.plan('parent', false);
    await f.store.markDispatching(parent.dispatch);
    const configuration = {
      modelId: 'fixed',
      tools: [{ id: 'fixture/tool', version: '1', extensionId: 'fixture' }],
    };
    const child = await f.store.ensureOperation({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: parent.commandId,
      parentExecutionId: 'parent',
      operationKey: 'child',
      request: { kind: 'agent', configurationId: 'reviewer', input: { task: 'read' } },
      childConfiguration: { id: 'reviewer', version: '1', snapshot: configuration },
    });
    const source = parent.dispatch.freshness.source;
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: child.executionId!,
      sessionId: 's',
      runId: null,
      originCommandId: child.commandId,
      stepId: `operation-${child.commandId}`,
      callId: child.commandId,
      kind: 'job',
      parentExecutionId: 'parent',
      definitionId: 'agent/reviewer',
      definitionVersion: '1',
      input: { task: 'read' },
      decisionSource: source,
    });
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: child.executionId!,
      authorization: {
        allowed: true,
        revision: 'trusted',
        definitionVersion: '1',
        inputDigest: await semanticDigest({ task: 'read' }),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    const active = await f.store.activateChildRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: child.executionId!,
      configuration,
      requirementEvaluations: [],
      freshness: { checked: true, source },
    });
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-tool',
      sessionId: child.childSessionId!,
      runId: active.run.id,
      originCommandId: active.command.id,
      kind: 'tool',
      stepId: 'child-step',
      callId: 'child-call',
      definitionId: 'fixture/tool',
      definitionVersion: '1',
      input: {},
      decisionSource: { kind: 'model_decision', modelExecutionId: 'original' },
    });
    const childToolSource: Json = { kind: 'model_decision', modelExecutionId: 'original' };
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-tool',
      authorization: {
        allowed: true,
        revision: 'trusted',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: childToolSource },
    });
    const grandchild = await f.store.ensureOperation({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: child.childSessionId!,
      extensionId: 'fixture',
      originCommandId: active.command.id,
      parentExecutionId: 'child-tool',
      operationKey: 'detached-grandchild',
      cancellation: 'detached',
      request: { kind: 'agent', configurationId: 'reviewer', input: { task: 'nested' } },
      childConfiguration: { id: 'reviewer', version: '1', snapshot: configuration },
    });
    const nestedExecution = await f.store.getExecution(grandchild.executionId!);
    expect(nestedExecution!.cancelWithParent).toBe(false);
    const childCommand = 'child-action-command';
    await f.store.acceptCommand({
      ...f.base,
      sessionId: child.childSessionId!,
      commandId: childCommand,
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'effect',
        definitionVersion: '1',
        input: {},
      },
    });
    const childSource: Json = {
      kind: 'action_decision',
      commandId: childCommand,
      extensionId: 'fixture',
      actionId: 'effect',
      definitionVersion: '1',
      preparedDigest: await semanticDigest({}),
    };
    await f.store.planAction({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      commandId: childCommand,
      executionId: 'child-action',
      extensionId: 'fixture',
      definitionId: 'fixture/effect',
      definitionVersion: '1',
      input: {},
      decisionSource: childSource,
    });
    const facts = await f.store.readExecutionGroupSafety({ ...f.base, sessionId: 's' });
    expect(facts.quiescent).toBe(false);
    expect(facts.activeRunIds).toContain(active.run.id);
    expect(facts.unconfirmedExecutionIds).toContain('parent');
    expect(facts.unconfirmedExecutionIds).toContain(child.executionId!);
    expect(facts.unconfirmedExecutionIds).toContain('child-tool');
    expect(facts.unconfirmedExecutionIds).toContain('child-action');
    expect(facts.unconfirmedExecutionIds).toContain(grandchild.executionId!);
    const nestedFacts = await f.store.readExecutionGroupSafety({
      ...f.base,
      sessionId: grandchild.childSessionId!,
    });
    expect(nestedFacts.rootSessionId).toBe('s');
    expect(nestedFacts.activeRunIds).toContain(active.run.id);
  } finally {
    await f.close();
  }
});

test('final guard sees a different Run and planned Model admitted while the original Action is still only planned', async () => {
  const f = await fixture();
  try {
    const p = await f.plan('before-model');
    await p.capture();
    await f.accept('new-run');
    const run = await f.store.startRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      commandId: 'new-run',
      configuration: { modelId: 'fixed', tools: [] },
    });
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'new-model',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'new-run',
      stepId: 'step',
      callId: 'call',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: { kind: 'model_decision', modelExecutionId: 'new-model' },
    });
    const facts = await f.store.readExecutionGroupSafety({ ...f.base, sessionId: 's' });
    expect(facts.activeRunIds).toEqual([run.id]);
    expect(facts.unconfirmedExecutionIds).toContain('new-model');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await errorCode(f.store.markDispatching(p.dispatch))).toBe(
      'execution_group_not_quiescent',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.getExecution('before-model'))!.status).toBe('planned');
  } finally {
    await f.close();
  }
});
