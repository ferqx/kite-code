import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { Permissions } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

const permissionSnapshot = {
  namespace: 'fixture.permissions',
  version: '1',
  data: { mode: 'auto' },
};
for (const targetKind of ['action', 'tool', 'guarded_action'] as const)
  test(`runless ${targetKind} retains its original source through one real checker and an independent human approval`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-runless-review-')));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
    let effects = 0;
    let reviews = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ordinary = createFixedModel([[finish]]);
    const definitionId = targetKind === 'tool' ? 'fixture.effect' : 'fixture/bridge';
    const request = { task: 'exact runless target', definitionId, input: {} };
    const dispatch = store.markDispatching.bind(store);
    let targetAuthorization: Parameters<typeof dispatch>[0]['authorization'] | null = null;
    store.markDispatching = async (input) => {
      const result = await dispatch(input);
      if (result.definitionId === definitionId) targetAuthorization = { ...input.authorization };
      return result;
    };
    const runtime = createRuntime({
      store,
      model: ordinary,
      modelId: 'ordinary',
      modelConcurrency: 1,
      authorizationCheck: {
        id: 'checker',
        version: '1',
        modelId: 'check-model',
        model: {
          async *stream(input) {
            reviews++;
            expect(effects).toBe(0);
            expect(input.tools).toEqual([]);
            const payload = JSON.parse(
              input.messages.find((item) => item.role === 'user')!.content!,
            );
            expect(payload.target.definitionId).toBe(definitionId);
            expect(payload.target.runId).toBeNull();
            expect(payload.target.source.commandId).toBe('reviewed-work');
            expect(payload.decisionContext).toBeNull();
            await gate;
            yield {
              type: 'text_delta',
              text: '{"decision":"approve_once","reason":"Exact runless request"}',
            };
            yield finish;
          },
        },
      },
      permissions: {
        async authorize(candidate) {
          return candidate.definitionId === definitionId
            ? {
                allowed: false,
                revision: 'p1',
                snapshot: permissionSnapshot,
                check: { request, requireApproval: true },
              }
            : { allowed: true, revision: 'trusted' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          actions: [
            {
              id: 'bridge',
              version: '1',
              description: 'Owned runless check bridge',
              inputSchema: { type: 'object', additionalProperties: false },
              async prepare(_input, context) {
                if (targetKind === 'guarded_action')
                  await context.requireExecutionGroupQuiescent!();
                return {};
              },
              async execute(_input, context) {
                if (targetKind !== 'tool') effects++;
                else {
                  const operation = await context.operations.ensure({
                    key: 'effect',
                    request: {
                      kind: 'tool',
                      definitionId: 'fixture.effect',
                      definitionVersion: '1',
                      input: {},
                    },
                  });
                  const result = await context.operations.wait(operation, { timeoutMs: 4000 });
                  expect(result.status).toBe('succeeded');
                }
                return { outcome: 'succeeded', content: 'bridge completed' };
              },
            },
          ],
          tools: [
            {
              id: 'fixture.effect',
              version: '1',
              description: 'Owned harmless counter',
              inputSchema: { type: 'object', additionalProperties: false },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'one effect' };
              },
            },
          ],
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'runless',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'reviewed-work',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'bridge',
          definitionVersion: '1',
          input: {},
        },
      });
      await eventually(async () => (reviews === 1 ? true : null));
      const target = (await store.listExecutions('s')).find(
        (item) => item.definitionId === definitionId,
      )!;
      expect(target.status).toBe('planned');
      expect(target.authorization).toMatchObject({
        dispatched: false,
        check: { status: 'dispatching', decision: 'unavailable' },
      });
      expect(target.runId).toBeNull();
      expect(effects).toBe(0);
      release();
      const interaction = await eventually(
        async () =>
          (await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
            .interactions[0] ?? null,
      );
      expect(effects).toBe(0);
      expect(reviews).toBe(1);
      const carrier = (await store.listExecutions('s')).find(
        (item) => item.kind === 'model' && item.runId === null,
      )!;
      expect(carrier.status).toBe('succeeded');
      expect((await store.getExecution(target.id))?.authorization).toMatchObject({
        dispatched: false,
        check: { executionId: carrier.id, decision: 'approve_once', requireApproval: true },
        human: { interactionId: interaction.id, state: 'pending', accepted: false },
      });
      expect((await store.getCommand(carrier.originCommandId))!.kind).toBe('authorization.check');
      expect(carrier).toMatchObject({
        kind: 'model',
        runId: null,
        childSessionId: null,
        parentExecutionId: target.id,
        definitionId: 'check-model',
      });
      expect((await store.listExecutions('s')).every((item) => item.childSessionId === null)).toBe(
        true,
      );
      expect((await runtime.listMessages('s')).length).toBe(0);
      expect(await store.listSessions()).toHaveLength(1);
      expect(
        (
          await store.getAuthorizationCheck({
            expectedStoreId,
            targetExecutionId: target.id,
            checkExecutionId: carrier.id,
            policyRevision: 'p1',
            request,
            requireApproval: true,
            checker: { id: 'checker', version: '1', modelId: 'check-model' },
          })
        ).decision,
      ).toBe('approve_once');
      await runtime.answerInteraction({
        expectedStoreId,
        commandId: 'answer',
        presentationSessionId: 's',
        interactionId: interaction.id,
        expectedRevision: interaction.revision,
        subjectId: 'owner',
        answer: { kind: 'approval', decision: 'approve' },
      });
      await runtime.waitForCommand('reviewed-work');
      const completed = (await store.getExecution(target.id))!;
      expect(completed).toMatchObject({ status: 'succeeded' });
      expect(completed.authorization).toMatchObject({
        dispatched: true,
        human: { state: 'answered', decision: 'approve', accepted: true },
      });
      expect(targetAuthorization).toMatchObject({
        checkExecutionId: carrier.id,
        interactionId: interaction.id,
        snapshot: permissionSnapshot,
      });
      expect(effects).toBe(1);
      expect(reviews).toBe(1);
      expect(ordinary.requests).toEqual([]);
      expect((await store.getView('s')).runs).toEqual([]);
    } finally {
      release();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for actual check state');
}
async function fixture(
  check: ModelAdapter,
  permissions?: Permissions,
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-auto-review-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  let effects = 0;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'call', name: 'fixture.effect', arguments: '{"value":"exact"}' },
      { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
    ],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    processConcurrency: 1,
    workspaceSerialLocks: {
      async acquire() {
        return () => {};
      },
    },
    authorizationCheck: { id: 'checker', version: '1', modelId: 'check-model', model: check },
    permissions: permissions ?? {
      async authorize(request) {
        return request.kind === 'model'
          ? { allowed: true, revision: 'p1' }
          : {
              allowed: false,
              revision: 'p1',
              snapshot: permissionSnapshot,
              check: { request: { task: 'exact harmless effect', parameters: request.input } },
            };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Harmless counter',
            inputSchema: { type: 'object' },
            resources: { slot: 'process', serial: { scope: 'workspace', key: 'effect' } },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'effect' };
            },
          },
        ],
      },
    ],
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 's',
    subjectId: 'owner',
  });
  await runtime.submitCommand({
    expectedStoreId,
    commandId: 'work',
    sessionId: 's',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'perform exact harmless effect' },
  });
  return {
    store,
    runtime,
    expectedStoreId,
    effects: () => effects,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('durable checker uses one actual Model call with zero tools and grants only original target', async () => {
  let reviews = 0;
  let release!: () => void;
  const reviewing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inputs: unknown[] = [];
  const f = await fixture({
    async *stream(input) {
      reviews++;
      inputs.push(input);
      await reviewing;
      yield {
        type: 'text_delta',
        text: '{"decision":"approve_once","reason":"Exact bounded effect"}',
      };
      yield finish;
    },
  });
  const dispatch = f.store.markDispatching.bind(f.store);
  let acceptedSnapshot: unknown;
  f.store.markDispatching = async (input) => {
    const result = await dispatch(input);
    if (result.definitionId === 'fixture.effect')
      acceptedSnapshot = structuredClone(input.authorization.snapshot);
    return result;
  };
  try {
    release();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    expect(reviews).toBe(1);
    expect(inputs[0]).toMatchObject({ tools: [] });
    expect(await f.store.listSessions()).toHaveLength(1);
    expect((await f.store.getView('s')).runs).toHaveLength(1);
    expect((await f.runtime.listMessages('s')).filter((item) => item.role === 'user')).toHaveLength(
      1,
    );
    const execution = (await f.store.listExecutions('s')).find((value) => value.kind === 'tool')!;
    expect(execution.status).toBe('succeeded');
    expect(acceptedSnapshot).toEqual(permissionSnapshot);
    expect((await f.runtime.getRun(execution.runId!))?.status).toBe('completed');
    const carrier = (await f.store.listExecutions('s')).find(
      (value) => value.kind === 'model' && value.runId === null,
    )!;
    expect(carrier.status).toBe('succeeded');
    const reviewInput = {
      expectedStoreId: f.expectedStoreId,
      targetExecutionId: execution.id,
      checkExecutionId: carrier.id,
      policyRevision: 'p1',
      request: { task: 'exact harmless effect', parameters: { value: 'exact' } },
      checker: { id: 'checker', version: '1', modelId: 'check-model' },
    };
    expect((await f.store.getAuthorizationCheck(reviewInput)).decision).toBe('approve_once');
    expect((await f.store.getAuthorizationCheck(reviewInput)).checkExecutionId).toBe(carrier.id);
    for (const [input, code] of [
      [{ ...reviewInput, request: { task: 'different' } }, 'authorization_check_binding_changed'],
      [{ ...reviewInput, expectedStoreId: 'foreign' }, 'store_identity_mismatch'],
    ] as const) {
      let error: unknown;
      try {
        await f.store.getAuthorizationCheck(input);
      } catch (caught) {
        error = caught;
      }
      expect((error as { code?: string })?.code).toBe(code);
    }
    expect(reviews).toBe(1);
  } finally {
    release();
    await f.close();
  }
});

test('failed actual checker is never replayed by duplicate original command and falls back to a real card', async () => {
  let reviews = 0;
  const f = await fixture({
    async *stream() {
      reviews++;
      yield { type: 'text_delta', text: '{"decision":' };
      throw new Error('review transport disconnected');
    },
  });
  try {
    const interaction = await eventually(
      async () =>
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
    expect(reviews).toBe(1);
    expect(f.effects()).toBe(0);
    const original = await f.store.getCommand('work');
    const duplicate = await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'perform exact harmless effect' },
    });
    expect(duplicate.id).toBe(original!.id);
    expect(
      (await f.store.listExecutions('s')).filter(
        (value) => value.kind === 'model' && value.runId === null,
      ),
    ).toHaveLength(1);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      commandId: 'deny',
      presentationSessionId: 's',
      interactionId: interaction.id,
      expectedRevision: interaction.revision,
      subjectId: 'owner',
      answer: { kind: 'approval', decision: 'deny' },
    });
    await f.runtime.waitForCommand('work');
    expect(reviews).toBe(1);
    expect(f.effects()).toBe(0);
  } finally {
    await f.close();
  }
});

test('invalid checker output preserves zero effects until real human approval', async () => {
  let reviews = 0;
  const f = await fixture({
    async *stream() {
      reviews++;
      yield {
        type: 'text_delta',
        text: '{"decision":"approve_once","reason":"claim","executionId":"forged"}',
      };
      yield finish;
    },
  });
  try {
    const interaction = await eventually(
      async () =>
        (
          await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0] ?? null,
    );
    expect(f.effects()).toBe(0);
    expect(reviews).toBe(1);
    await f.runtime.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: interaction.id,
      expectedRevision: interaction.revision,
      subjectId: 'owner',
      answer: { kind: 'approval', decision: 'approve' },
    });
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    expect(reviews).toBe(1);
  } finally {
    await f.close();
  }
});

test('policy revision changes while the actual checker is running cannot grant the old target', async () => {
  let release!: () => void;
  let entered = false;
  let revision = 'p1';
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    {
      async *stream() {
        entered = true;
        await gate;
        yield { type: 'text_delta', text: '{"decision":"approve_once","reason":"old policy"}' };
        yield finish;
      },
    },
    {
      async authorize(request) {
        return request.kind === 'model'
          ? { allowed: true, revision }
          : { allowed: false, revision, check: { request: { task: 'same target' } } };
      },
    },
  );
  try {
    await eventually(async () => (entered ? true : null));
    expect(f.effects()).toBe(0);
    const target = (await f.store.listExecutions('s')).find((value) => value.kind === 'tool')!;
    expect(target.status).toBe('planned');
    revision = 'p2';
    release();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(0);
    const failed = await f.store.getExecution(target.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.result).toMatchObject({
      details: { adapterAttempted: false, dispatchCommitted: false },
    });
  } finally {
    release();
    await f.close();
  }
});

test('reject cancels the original work without target I/O or human fabrication', async () => {
  const f = await fixture({
    async *stream() {
      yield { type: 'text_delta', text: '{"decision":"reject","reason":"bounded check rejects"}' };
      yield finish;
    },
  });
  try {
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(0);
    expect(
      (await f.runtime.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
        .interactions,
    ).toHaveLength(0);
    const target = (await f.store.listExecutions('s')).find((value) => value.kind === 'tool')!;
    expect((await f.runtime.getRun(target.runId!))?.status).toBe('cancelled');
    expect(target.authorization).toMatchObject({
      dispatched: false,
      check: { decision: 'reject', reason: 'bounded check rejects' },
    });
    const carrier = (await f.store.listExecutions('s')).find(
      (item) => item.kind === 'model' && item.runId === null,
    )!;
    let stoppedGrant: unknown;
    try {
      await f.store.getAuthorizationCheck({
        expectedStoreId: f.expectedStoreId,
        targetExecutionId: target.id,
        checkExecutionId: carrier.id,
        policyRevision: 'p1',
        request: { task: 'exact harmless effect', parameters: { value: 'exact' } },
        checker: { id: 'checker', version: '1', modelId: 'check-model' },
      });
    } catch (error) {
      stoppedGrant = error;
    }
    expect(stoppedGrant).toMatchObject({ code: 'authorization_check_unverifiable' });
  } finally {
    await f.close();
  }
});

test('precise original Command cancellation propagates to running checker and never revives target', async () => {
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    async *stream() {
      entered = true;
      await gate;
      yield { type: 'text_delta', text: '{"decision":"approve_once","reason":"late"}' };
      yield finish;
    },
  });
  try {
    await eventually(async () => (entered ? true : null));
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      targetCommandId: 'work',
      subjectId: 'owner',
    });
    release();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(0);
    const executions = await f.store.listExecutions('s');
    expect(executions.find((value) => value.kind === 'tool')?.status).not.toBe('succeeded');
    expect(
      executions.find((value) => value.kind === 'model' && value.runId === null)?.status,
    ).not.toBe('succeeded');
  } finally {
    release();
    await f.close();
  }
});

test('checker usage returned with cancellation is retained without granting the target', async () => {
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const usage = { inputTokens: 13, outputTokens: 5, totalTokens: 18 };
  let calls = 0;
  const f = await fixture({
    async *stream(_request, { signal }) {
      calls++;
      entered = true;
      await gate;
      expect(signal.aborted).toBe(true);
      // A usage event already returned by the adapter survives the cancellation race.
      yield { type: 'usage', usage };
      yield { type: 'text_delta', text: '{"decision":"approve_once","reason":"late"}' };
      yield finish;
    },
  });
  try {
    await eventually(async () => (entered ? true : null));
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      targetCommandId: 'work',
      subjectId: 'owner',
    });
    release();
    await f.runtime.waitForCommand('work');
    const check = await eventually(async () => {
      const execution = (await f.store.listExecutions('s')).find(
        (value) => value.kind === 'model' && value.runId === null,
      );
      return execution?.status === 'cancelled' ? execution : null;
    });
    expect(check.result).toMatchObject({ incomplete: true, content: '', usage });
    expect(check.result).not.toHaveProperty('authorizationCheckOutput');
    expect(f.effects()).toBe(0);
    expect(calls).toBe(1);
    expect(
      (await f.store.listExecutions('s')).find((value) => value.kind === 'tool')?.status,
    ).not.toBe('succeeded');
  } finally {
    release();
    await f.close();
  }
});

test('resource-held final policy flip releases the permit without starting a human wait', async () => {
  let held = 0;
  let changed = false;
  let reviews = 0;
  const f = await fixture(
    {
      async *stream() {
        reviews++;
        expect(held).toBe(0);
        yield { type: 'text_delta', text: '{"decision":"approve_once","reason":"before permit"}' };
        yield finish;
      },
    },
    {
      async authorize(request) {
        if (request.kind === 'model') return { allowed: true, revision: 'p1' };
        return changed
          ? { allowed: false, revision: 'p2', approval: { request: { title: 'new policy' } } }
          : { allowed: false, revision: 'p1', check: { request: { task: 'original' } } };
      },
    },
    {
      workspaceSerialLocks: {
        async acquire() {
          held++;
          changed = true;
          return () => {
            held--;
          };
        },
      },
    },
  );
  try {
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(0);
    expect(reviews).toBe(1);
    expect(held).toBe(0);
    expect(
      (await f.runtime.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
        .interactions,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('changed check request at the same policy revision cannot borrow an earlier approval', async () => {
  let release!: () => void;
  let entered = false;
  let task = 'original exact task';
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    {
      async *stream() {
        entered = true;
        await gate;
        yield { type: 'text_delta', text: '{"decision":"approve_once","reason":"original task"}' };
        yield finish;
      },
    },
    {
      async authorize(request) {
        return request.kind === 'model'
          ? { allowed: true, revision: 'p1' }
          : { allowed: false, revision: 'p1', check: { request: { task } } };
      },
    },
  );
  try {
    await eventually(async () => (entered ? true : null));
    task = 'changed task';
    release();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(0);
    expect((await f.store.listExecutions('s')).find((value) => value.kind === 'tool')?.status).toBe(
      'failed',
    );
  } finally {
    release();
    await f.close();
  }
});

test('authorization check inside a delegated child does not consume its already-held single user child slot', async () => {
  let effects = 0;
  let reviews = 0;
  const toolCall = (name: string): ModelEvent[] => [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
    { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
  ];
  const rootModel = createFixedModel([toolCall('fixture.delegate'), [finish]]);
  const childModel = createFixedModel([toolCall('fixture.effect'), [finish]]);
  const f = await fixture(
    {
      async *stream(input) {
        reviews++;
        expect(input.tools).toEqual([]);
        yield {
          type: 'text_delta',
          text: '{"decision":"approve_once","reason":"child exact call"}',
        };
        yield finish;
      },
    },
    {
      async authorize(request) {
        return request.definitionId === 'fixture.effect'
          ? { allowed: false, revision: 'p1', check: { request: { task: 'child effect' } } }
          : { allowed: true, revision: 'p1' };
      },
    },
    {
      model: rootModel,
      maxConcurrentSubagents: 1,
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: childModel,
          modelId: 'child-model',
          toolIds: ['fixture.effect'],
          snapshot: {},
          maxConcurrentSubagents: 1,
        },
      ],
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.effect',
              version: '1',
              description: 'effect',
              inputSchema: { type: 'object' },
              async execute() {
                effects++;
                return { outcome: 'succeeded', content: 'child effect' };
              },
            },
            {
              id: 'fixture.delegate',
              version: '1',
              description: 'delegate',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                const operation = await context.operations.ensure({
                  key: 'child',
                  request: {
                    kind: 'agent',
                    configurationId: 'child',
                    input: { content: 'perform child effect' },
                  },
                  cancellation: 'attached',
                });
                const result = await context.operations.wait(operation);
                return {
                  outcome: result?.status === 'succeeded' ? 'succeeded' : 'failed',
                  content: 'child done',
                };
              },
            },
          ],
        },
      ],
    },
  );
  try {
    await f.runtime.waitForCommand('work');
    expect(effects).toBe(1);
    expect(reviews).toBe(1);
    expect(childModel.requests).toHaveLength(2);
    expect(rootModel.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('cold planned authorization check is observation only and ordinary children cannot borrow its target exception', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cold-review-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  let store = await openSqliteStore(profile);
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    await store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 's',
      subjectId: 'owner',
    });
    await store.acceptCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'original actual task' },
    });
    const owner = (await store.acquireSessionOwner('s', 'host'))!;
    const run = await store.startRun({
      expectedStoreId,
      owner,
      commandId: 'work',
      configuration: {
        modelId: 'fixed',
        tools: [{ id: 'fixture.effect', version: '1', extensionId: 'fixture' }],
      },
    });
    const source = {
      kind: 'model_decision',
      sources: [{ id: 'fixture:plan', digest: 'v1', content: 'actual plan' }],
    };
    await store.planExecution({
      expectedStoreId,
      owner,
      executionId: 'target',
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      stepId: 'step',
      callId: 'call',
      kind: 'tool',
      definitionId: 'fixture.effect',
      definitionVersion: '1',
      input: { value: 'exact' },
      decisionSource: source,
    });
    const input = {
      expectedStoreId,
      owner,
      targetExecutionId: 'target',
      policyRevision: 'p1',
      request: { task: 'actual task' },
      checker: { id: 'checker', version: '1', modelId: 'check-model' },
    };
    const first = await store.ensureAuthorizationCheck(input);
    const repeated = await store.ensureAuthorizationCheck(input);
    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.execution.id).toEqual(first.execution.id);
    expect(first.input).toMatchObject({
      originCommandRequest: { content: 'original actual task' },
      rootWorkRequest: { content: 'original actual task' },
      target: { input: { value: 'exact' }, source },
    });
    let error: unknown;
    try {
      await store.ensureOperation({
        expectedStoreId,
        owner,
        sessionId: 's',
        extensionId: 'fixture',
        originCommandId: 'work',
        parentExecutionId: 'target',
        operationKey: 'spoof',
        request: { kind: 'agent', configurationId: 'spoof', input: {} },
        childConfiguration: {
          id: 'spoof',
          version: '1',
          snapshot: { authorizationCheck: first.input, tools: [], extensions: [] },
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string })?.code).toBe('invalid_operation_parent');
    try {
      await store.markDispatching({
        expectedStoreId,
        owner,
        executionId: 'target',
        authorization: {
          allowed: true,
          revision: 'p1',
          definitionVersion: '1',
          inputDigest: await semanticDigest({ value: 'exact' }),
        },
        requirements: [],
        freshness: { checked: true, source },
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string })?.code).toBe('authorization_check_required');
    await store.close();
    store = await openSqliteStore(profile);
    const reference = {
      expectedStoreId,
      targetExecutionId: 'target',
      checkExecutionId: first.execution.id,
      policyRevision: 'p1',
      request: input.request,
      checker: input.checker,
    };
    expect((await store.getAuthorizationCheck(reference)).decision).toBe('unavailable');
    expect((await store.getExecution(first.execution.id))?.status).toBe('planned');
    expect(first.execution).toMatchObject({ kind: 'model', runId: null, childSessionId: null });
    expect((await store.getView('s')).runs).toHaveLength(1);
    expect(await store.listExecutions('s')).toHaveLength(2);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual source changes during check invalidate the old target and reach the next ordinary Model body', async () => {
  let release!: () => void;
  let entered = false;
  let digest = 'original plan';
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ordinary = createFixedModel([
    [
      { type: 'tool_call', id: 'source-call', name: 'fixture.effect', arguments: '{}' },
      { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
    ],
    [finish],
  ]);
  const f = await fixture(
    {
      async *stream(input) {
        expect(
          input.messages.some((message) => message.role === 'system' && message.content === digest),
        ).toBe(false);
        const payload = JSON.parse(
          input.messages.find((message) => message.role === 'user')!.content!,
        );
        expect(payload.originCommandRequest.content).toBe('perform exact harmless effect');
        expect(payload.target.source.sources).toContainEqual(
          expect.objectContaining({
            id: 'workspace:plan',
            digest: 'original plan',
            content: 'original plan',
          }),
        );
        entered = true;
        await gate;
        yield {
          type: 'text_delta',
          text: '{"decision":"approve_once","reason":"original plan only"}',
        };
        yield finish;
      },
    },
    undefined,
    {
      model: ordinary,
      sources: {
        async capture() {
          return [
            {
              id: 'workspace:plan',
              kind: 'instruction',
              scope: 'workspace',
              digest,
              content: digest,
            },
          ];
        },
      },
    },
  );
  try {
    await eventually(async () => (entered ? true : null));
    digest = 'changed plan';
    release();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(0);
    expect(ordinary.requests).toHaveLength(2);
    expect(ordinary.requests[1]?.messages).toContainEqual({
      role: 'system',
      content: 'changed plan',
      sourceIds: ['workspace:plan'],
    });
    expect(
      (await f.store.listExecutions('s')).find((value) => value.kind === 'tool')?.result,
    ).toMatchObject({ details: { adapterAttempted: false } });
  } finally {
    release();
    await f.close();
  }
});

test('review decisionContext is derived from the actual succeeded Model input after steer', async () => {
  let release!: () => void;
  let reviews = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = (): ModelEvent[] => [
    { type: 'tool_call', id: crypto.randomUUID(), name: 'fixture.effect', arguments: '{}' },
    { ...finish, type: 'finish', reason: 'tool_calls' } as ModelEvent,
  ];
  const ordinary = createFixedModel([call(), call(), [finish]]);
  const f = await fixture(
    {
      async *stream(input) {
        reviews++;
        const payload = JSON.parse(
          input.messages.find((message) => message.role === 'user')!.content!,
        );
        expect(payload.decisionContext.modelExecutionId).toBeTruthy();
        if (reviews === 1) await gate;
        else {
          expect(JSON.stringify(payload.decisionContext.messages)).toContain(
            'updated precise instruction',
          );
          const appliedSteer = await f.store.getCommand('steer');
          expect(appliedSteer).toMatchObject({
            kind: 'input.steer',
            status: 'applied',
            request: { targetRunId: payload.target.runId },
            receipt: { runId: payload.target.runId },
          });
          const instruction = payload.decisionContext.messages.find(
            (message: { content?: string }) =>
              message.content?.includes('updated precise instruction'),
          );
          expect(instruction?.sourceIds).toEqual([appliedSteer!.id]);
        }
        yield {
          type: 'text_delta',
          text: '{"decision":"approve_once","reason":"actual current task"}',
        };
        yield finish;
      },
    },
    undefined,
    { model: ordinary },
  );
  try {
    await eventually(async () => (reviews === 1 ? true : null));
    const target = (await f.store.listExecutions('s')).find((value) => value.kind === 'tool')!;
    const session = (await f.store.getSession('s'))!;
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'steer',
      sessionId: 's',
      subjectId: 'owner',
      request: {
        kind: 'input.steer',
        content: '补充：updated precise instruction',
        targetRunId: target.runId!,
        contextSelectionId: session.contextSelectionId,
      },
    });
    release();
    await f.runtime.waitForCommand('work');
    expect(f.effects()).toBe(1);
    expect(reviews).toBe(2);
    expect((await f.store.getExecution(target.id))?.status).not.toBe('succeeded');
  } finally {
    release();
    await f.close();
  }
});
