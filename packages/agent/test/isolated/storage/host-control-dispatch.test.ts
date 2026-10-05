import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixedModel } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { PermissionControlRead } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionRecord, Json, Store } from '../../../src/storage';

async function code(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code: string }).code;
  }
}
function gate() {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((r) => {
      enter = r;
    }),
    waiting: new Promise<void>((r) => {
      release = r;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('fixture_timeout')), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-control-dispatch-'),
    profile = { dataRoot: root, profile: 'new' },
    store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'user' };
  for (const id of ['w', 'other-w'])
    await store.createWorkspace({ expectedStoreId, id, rootUri: `file://${root}`, name: id });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      ...base,
      sessionId,
      workspaceId: sessionId === 's' ? 'w' : 'other-w',
      commandId: `create-${sessionId}`,
      title: sessionId,
    });
  let next = 0;
  const control = async (
    kind: 'permission.mode' | 'workspace.trust',
    value: string | boolean,
    makeDefault = false,
    sessionId = 's',
  ) => {
    const scope = kind === 'permission.mode' ? `session:${sessionId}` : 'workspace:w',
      latest = await store.readHostControl({ ...base, kind, scope });
    const safeRequest: Record<string, Json> =
      kind === 'permission.mode'
        ? {
            scope: 'session',
            sessionId,
            mode: value,
            makeDefault,
            ifRevision: latest.revision,
            ifDefaultRevision: (await store.readHostControl({ ...base, kind, scope: 'user' }))
              .revision,
          }
        : {
            scope: 'workspace',
            workspaceId: 'w',
            trusted: value,
            canonicalIdentity: 'a'.repeat(64),
            externalReadScopeDigest: 'b'.repeat(64),
            ifRevision: latest.revision,
          };
    const request = {
      ...base,
      commandId: `control-${++next}`,
      kind,
      scope,
      safeRequest,
      requestDigest: await semanticDigest(safeRequest),
    };
    await store.beginHostMutation(request);
    return store.finishHostMutation({
      ...base,
      commandId: request.commandId,
      requestDigest: request.requestDigest,
      state: 'applied',
      receipt: { status: 'applied' },
    });
  };
  const reads = async (): Promise<readonly PermissionControlRead[]> =>
    Promise.all(
      (
        [
          ['permission.mode', 'session:s'],
          ['permission.mode', 'user'],
          ['workspace.trust', 'workspace:w'],
        ] as const
      ).map(async ([kind, scope]) => ({
        kind,
        scope,
        revision: (await store.readHostControl({ ...base, kind, scope })).revision,
      })),
    );
  await control('permission.mode', 'full', true);
  await control('workspace.trust', true);
  const plan = async () => {
    await store.acceptCommand({
      ...base,
      sessionId: 's',
      commandId: 'work',
      request: { kind: 'run.start', content: 'actual control checkpoint' },
    });
    const owner = (await store.acquireSessionOwner('s', 'host'))!;
    const run = await store.startRun({
        expectedStoreId,
        owner,
        commandId: 'work',
        configuration: { tools: [{ id: 'fixture/effect', version: '1', extensionId: 'fixture' }] },
      }),
      source = { kind: 'model_decision', modelExecutionId: 'fixed' };
    await store.planExecution({
      expectedStoreId,
      owner,
      executionId: 'effect',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      stepId: 'step',
      callId: 'call',
      kind: 'tool',
      definitionId: 'fixture/effect',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    return {
      expectedStoreId,
      owner,
      executionId: 'effect',
      authorization: {
        allowed: true,
        revision: 'trusted-host',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
        controlReads: await reads(),
      },
      requirements: [],
      freshness: { checked: true, source },
    };
  };
  const db = new Database(join(root, 'new/core.db'));
  return {
    store,
    profile,
    root,
    base,
    expectedStoreId,
    control,
    reads,
    plan,
    db,
    dispatched: (id: string) =>
      (db.query('SELECT dispatched FROM execution WHERE id=?').get(id) as { dispatched: number })
        .dispatched === 1,
    async close() {
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual SQL mode/trust CAS after authorization rejects stale dispatch atomically without event or dispatched fact', async () => {
  for (const kind of ['permission.mode', 'workspace.trust'] as const) {
    const f = await fixture();
    try {
      const dispatch = await f.plan();
      await f.control(kind, kind === 'permission.mode' ? 'ask' : false);
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      expect(await code(f.store.markDispatching(dispatch))).toBe('permission_control_changed');
      expect((await f.store.getExecution('effect'))?.status).toBe('planned');
      expect(f.dispatched('effect')).toBe(false);
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      dispatch.authorization.controlReads = await f.reads();
      expect((await f.store.markDispatching(dispatch)).status).toBe('dispatching');
    } finally {
      await f.close();
    }
  }
});

test('control proofs cannot supply foreign scope/actor/Store or malformed/duplicate revision; rejected writes leave execution planned', async () => {
  const f = await fixture();
  try {
    const dispatch = await f.plan(),
      original = dispatch.authorization.controlReads;
    const cases: [unknown, string][] = [
      [
        [{ kind: 'permission.mode', scope: 'session:other', revision: '0' }],
        'permission_control_scope_denied',
      ],
      [
        [{ kind: 'workspace.trust', scope: 'workspace:other-w', revision: '0' }],
        'permission_control_scope_denied',
      ],
      [
        [{ kind: 'permission.mode', scope: 'user', revision: '0', subjectId: 'other' }],
        'invalid_permission_control_reads',
      ],
      [
        [{ kind: 'permission.mode', scope: 'user', revision: '01' }],
        'invalid_permission_control_reads',
      ],
      [[original[0], original[0]], 'invalid_permission_control_reads'],
      [Array(4).fill(original[0]), 'invalid_permission_control_reads'],
    ];
    for (const [reads, error] of cases) {
      dispatch.authorization.controlReads = reads as PermissionControlRead[];
      expect(await code(f.store.markDispatching(dispatch))).toBe(error);
      expect(f.dispatched('effect')).toBe(false);
    }
    dispatch.authorization.controlReads = original;
    expect(
      await code(f.store.markDispatching({ ...dispatch, expectedStoreId: 'other-store' })),
    ).toBe('store_identity_mismatch');
    f.db.run("UPDATE execution SET origin_store_id='foreign' WHERE id='effect'");
    expect(await code(f.store.markDispatching(dispatch))).toBe('operation_unverifiable');
    expect(f.dispatched('effect')).toBe(false);
  } finally {
    await f.close();
  }
});

test('user default is checked across roots; foreign-origin control cannot relabel proof, while already-dispatched facts remain durable', async () => {
  const f = await fixture();
  try {
    const dispatch = await f.plan();
    await f.control('permission.mode', 'ask', true, 'other');
    expect(await code(f.store.markDispatching(dispatch))).toBe('permission_control_changed');
    dispatch.authorization.controlReads = await f.reads();
    await f.store.markDispatching(dispatch);
    await f.control('workspace.trust', false);
    expect((await f.store.getExecution('effect'))?.status).toBe('dispatching');
    expect(f.dispatched('effect')).toBe(true);
    const reopened = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    expect((await reopened.getExecution('effect'))?.status).toBe('dispatching');
    await reopened.close();
  } finally {
    await f.close();
  }
  const other = await fixture();
  try {
    const dispatch = await other.plan();
    other.db.run("UPDATE host_mutation SET origin_store_id='foreign' WHERE kind='workspace.trust'");
    expect(await code(other.store.markDispatching(dispatch))).toBe('permission_control_changed');
    expect(other.dispatched('effect')).toBe(false);
  } finally {
    await other.close();
  }
});

test('actual final authorization proof reaches SQL through trusted Store barrier; revoke commits before dispatch and physical Tool effect stays zero', async () => {
  for (const scenario of [
    { kind: 'permission.mode', ask: false },
    { kind: 'workspace.trust', ask: false },
    { kind: 'workspace.trust', ask: true },
  ] as const) {
    const { kind, ask } = scenario;
    const f = await fixture(),
      barrier = gate();
    let effects = 0,
      proof: readonly PermissionControlRead[] | undefined;
    const proxied = new Proxy(f.store, {
      get(target, key) {
        if (key === 'markDispatching')
          return async (input: Parameters<Store['markDispatching']>[0]) => {
            const execution = await target.getExecution(input.executionId);
            if (execution?.kind === 'tool') {
              proof = input.authorization.controlReads;
              barrier.enter();
              await barrier.waiting;
            }
            return target.markDispatching(input);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const model = createFixedModel([
      [
        { type: 'tool_call', id: 'call', name: 'fixture.effect', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    const runtime = createRuntime({
      store: proxied,
      model,
      modelId: 'fixed',
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.effect',
              version: '1',
              description: 'Harmless physical counter',
              inputSchema: { type: 'object', additionalProperties: false },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'physical effect' };
              },
            },
          ],
        },
      ],
      permissions: {
        authorize: async (request) => ({
          allowed: request.kind === 'tool' ? !ask : true,
          ...(request.kind === 'tool' && ask
            ? { approval: { request: { title: 'Exact Tool pending approval' } } }
            : {}),
          revision: 'trusted-sql-policy',
          ...(request.kind === 'tool' ? { controlReads: await f.reads() } : {}),
        }),
      },
    });
    try {
      await runtime.submitCommand({
        ...f.base,
        commandId: 'actual',
        sessionId: 's',
        request: { kind: 'run.start', content: 'fixed harmless call' },
      });
      if (ask) {
        const deadline = Date.now() + 5000;
        let card: InteractionRecord | undefined;
        while (!card) {
          card = (await runtime.listInteractions({ ...f.base, sessionId: 's', state: 'pending' }))
            .interactions[0];
          if (Date.now() > deadline) throw new Error('approval_fixture_timeout');
          if (!card) await Bun.sleep(5);
        }
        await runtime.answerInteraction({
          ...f.base,
          presentationSessionId: card.presentationSessionId,
          interactionId: card.id,
          commandId: 'answer-exact',
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve' },
        });
      }
      await bounded(barrier.entered);
      expect(proof?.length).toBe(3);
      await f.control(kind, kind === 'permission.mode' ? 'ask' : false);
      barrier.release();
      await runtime.waitForCommand('actual', { timeoutMs: 5000 });
      expect(effects).toBe(0);
      const tool = (await f.store.listExecutions('s')).find((e) => e.kind === 'tool');
      expect(f.dispatched(tool!.id)).toBe(false);
      expect(tool?.status).toBe('failed');
      expect(JSON.stringify(tool?.result)).toContain('permission_control_changed');
    } finally {
      barrier.release();
      await runtime.close();
      await f.close();
    }
  }
}, 15000);

test('actual child Model uses original root mode and Workspace trust scopes, never the child Session spelling', async () => {
  const f = await fixture();
  try {
    const parent = await f.plan();
    await f.store.markDispatching(parent);
    const configuration = {
        modelId: 'fixed',
        tools: [{ id: 'fixture/effect', version: '1', extensionId: 'fixture' }],
      },
      source = parent.freshness.source;
    const ref = await f.store.ensureOperation({
      ...f.base,
      owner: parent.owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'effect',
      operationKey: 'child',
      request: { kind: 'agent', configurationId: 'reviewer', input: { task: 'review' } },
      childConfiguration: { id: 'reviewer', version: '1', snapshot: configuration },
    });
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: parent.owner,
      executionId: ref.executionId!,
      sessionId: 's',
      runId: null,
      originCommandId: ref.commandId,
      stepId: `operation-${ref.commandId}`,
      callId: ref.commandId,
      kind: 'job',
      parentExecutionId: 'effect',
      cancelWithParent: true,
      definitionId: 'agent/reviewer',
      definitionVersion: '1',
      input: { task: 'review' },
      decisionSource: source,
    });
    await f.store.markDispatching({
      ...parent,
      executionId: ref.executionId!,
      authorization: {
        ...parent.authorization,
        inputDigest: await semanticDigest({ task: 'review' }),
      },
    });
    const active = await f.store.activateChildRun({
      expectedStoreId: f.expectedStoreId,
      owner: parent.owner,
      executionId: ref.executionId!,
      configuration,
      requirementEvaluations: [],
      freshness: { checked: true, source },
    });
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: parent.owner,
      executionId: 'child-model',
      sessionId: ref.childSessionId!,
      runId: active.run.id,
      originCommandId: active.command.id,
      stepId: 'child-step',
      callId: 'model',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    const dispatch = { ...parent, executionId: 'child-model' };
    const correct = dispatch.authorization.controlReads;
    dispatch.authorization.controlReads = [
      {
        kind: 'permission.mode',
        scope: `session:${ref.childSessionId}`,
        revision: correct[0]!.revision,
      },
    ];
    expect(await code(f.store.markDispatching(dispatch))).toBe('permission_control_scope_denied');
    expect(f.dispatched('child-model')).toBe(false);
    dispatch.authorization.controlReads = correct;
    expect((await f.store.markDispatching(dispatch)).status).toBe('dispatching');
  } finally {
    await f.close();
  }
});

test('Runtime child intersection preserves deduplicated control proof and rejects changed trust before child Model dispatch', async () => {
  for (const conflict of [false, true]) {
    const f = await fixture(),
      barrier = gate();
    let proof: readonly PermissionControlRead[] | undefined,
      childSessionId: string | null | undefined;
    const child = createFixedModel([
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    const parent = createFixedModel([
      [
        { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    const proxied = new Proxy(f.store, {
      get(target, key) {
        if (key === 'markDispatching')
          return async (input: Parameters<Store['markDispatching']>[0]) => {
            const execution = await target.getExecution(input.executionId);
            if (execution?.kind === 'model' && execution.sessionId !== 's') {
              proof = input.authorization.controlReads;
              barrier.enter();
              await barrier.waiting;
            }
            return target.markDispatching(input);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let changed = false;
    const runtime = createRuntime({
      store: proxied,
      model: parent,
      modelId: 'parent',
      modelConcurrency: 1,
      permissions: {
        authorize: async () => ({
          allowed: true,
          revision: 'parent-policy',
          controlReads: await f.reads(),
        }),
      },
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: [],
          snapshot: {},
          permissions: {
            async authorize() {
              if (conflict && !changed) {
                changed = true;
                await f.control('workspace.trust', false);
              }
              return { allowed: true, revision: 'child-policy', controlReads: await f.reads() };
            },
          },
        },
      ],
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.delegate',
              version: '1',
              description: 'Actual ordinary child carrier',
              inputSchema: { type: 'object', additionalProperties: false },
              async execute(_input, context) {
                const ref = await context.operations.ensure({
                  key: 'child',
                  request: { kind: 'agent', configurationId: 'child', input: { content: 'child' } },
                });
                childSessionId = ref.childSessionId;
                await context.operations.wait(ref, { timeoutMs: 5000, signal: context.signal });
                return { outcome: 'succeeded', content: 'child settled' };
              },
            },
          ],
        },
      ],
    });
    try {
      await runtime.submitCommand({
        ...f.base,
        commandId: 'actual-child',
        sessionId: 's',
        request: { kind: 'run.start', content: 'delegate' },
      });
      if (!conflict) {
        await bounded(barrier.entered);
        expect(proof).toEqual(await f.reads());
        expect(proof?.length).toBe(3);
        await f.control('workspace.trust', false);
        barrier.release();
      }
      await runtime.waitForCommand('actual-child', { timeoutMs: 5000 });
      expect(child.requests).toHaveLength(0);
      expect(childSessionId).toBeTruthy();
      const model = (await f.store.listExecutions(childSessionId!)).find(
        (execution) => execution.kind === 'model',
      );
      expect(model?.status).toBe('failed');
      expect(f.dispatched(model!.id)).toBe(false);
      expect(JSON.stringify(model?.result)).toContain(
        conflict ? 'permission_denied' : 'permission_control_changed',
      );
      if (conflict) {
        expect(changed).toBe(true);
        expect(proof).toBeUndefined();
      }
    } finally {
      barrier.release();
      await runtime.close();
      await f.close();
    }
  }
}, 15000);

test('restored root creator history does not block new current-Store command and explicit controls', async () => {
  const f = await fixture();
  try {
    f.db.query("UPDATE command SET origin_store_id='historical-store' WHERE id='create-s'").run();
    await f.control('permission.mode', 'ask');
    const dispatch = await f.plan();
    await f.store.markDispatching(dispatch);
    expect(f.dispatched('effect')).toBe(true);
    const current = await f.store.getCommand('work');
    expect(current?.originStoreId).toBe(f.expectedStoreId);
    expect(dispatch.authorization.controlReads).toEqual(await f.reads());
    // Historical applied facts remain excluded even when their revision is newer.
    f.db
      .query(
        "UPDATE host_mutation SET origin_store_id='historical-store' WHERE kind='workspace.trust'",
      )
      .run();
    expect((await f.reads()).find((read) => read.kind === 'workspace.trust')?.revision).toBe('0');
  } finally {
    await f.close();
  }
});
