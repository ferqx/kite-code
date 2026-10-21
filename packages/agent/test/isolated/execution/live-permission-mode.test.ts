import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src';
import { semanticDigest } from '../../../src/json';
import { createPermissionPolicy, type PermissionMode } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionRecord, Store } from '../../../src/storage';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 0, outputTokens: 0 },
} satisfies ModelEvent;
const effect = [
  { type: 'tool_call', id: 'effect', name: 'fixture.effect', arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
] as ModelEvent[];
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > end) throw Error('live_mode_fixture_timeout');
    await Bun.sleep(5);
  }
}
function barrier() {
  let arrive!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      arrive = resolve;
    }),
    waiting: new Promise<void>((resolve) => {
      release = resolve;
    }),
    arrive: () => arrive(),
    release: () => release(),
  };
}
async function fixture(
  options: {
    holdDispatch?: boolean;
    holdResource?: boolean;
    childDepth?: number;
    reviewer?: ModelAdapter;
    readOnly?: boolean;
    holdEffect?: boolean;
    sameRunNextTool?: boolean;
  } = {},
) {
  const root = temporaryDirectory('kite-live-mode-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'user' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'test',
    rootUri: pathToFileURL(root).href,
  });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      ...base,
      sessionId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: sessionId,
    });
  let mutation = 0;
  const setMode = async (mode: PermissionMode, sessionId = 's') => {
    const scope = `session:${sessionId}`;
    const current = await store.readHostControl({ ...base, kind: 'permission.mode', scope });
    const defaults = await store.readHostControl({
      ...base,
      kind: 'permission.mode',
      scope: 'user',
    });
    const safeRequest = {
      scope: 'session',
      sessionId,
      mode,
      ifRevision: current.revision,
      makeDefault: false,
      ifDefaultRevision: defaults.revision,
    };
    const request = {
      ...base,
      commandId: `mode-${++mutation}`,
      kind: 'permission.mode' as const,
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
  const policy = createPermissionPolicy({
    async readPolicy(request) {
      const session = (await store.getSession(request.sessionId))!;
      const scope = `session:${session.rootSessionId}`;
      const current = await store.readHostControl({ ...base, kind: 'permission.mode', scope });
      const mode =
        (current.record?.safeRequest as { mode?: PermissionMode })?.mode ?? 'accept_edits';
      return {
        mode,
        workspaceTrust: true,
        revision: current.revision,
        controlReads: [{ kind: 'permission.mode', scope, revision: current.revision }],
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      };
    },
    describeCapability: (request) => ({
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      revision: 'fixture-capability',
      effects:
        request.kind === 'model'
          ? ['read']
          : request.kind === 'job' || request.definitionId === 'fixture.delegate'
            ? ['record_write']
            : ['external'],
      ...(request.kind === 'job' || request.definitionId === 'fixture.delegate'
        ? { internalRecordOnly: true as const }
        : {}),
      hardAllowed: request.kind === 'model' || !options.readOnly,
      safeRead: request.kind === 'model',
    }),
  });
  const held = barrier();
  const dispatches: Parameters<Store['markDispatching']>[0][] = [];
  let hold = options.holdDispatch;
  const proxy = new Proxy(store, {
    get(target, key) {
      if (key === 'markDispatching')
        return async (input: Parameters<Store['markDispatching']>[0]) => {
          if (hold && (await target.getExecution(input.executionId))?.kind === 'tool') {
            hold = false;
            held.arrive();
            await held.waiting;
          }
          const result = await target.markDispatching(input);
          dispatches.push(structuredClone(input));
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let effects = 0;
  const resource = barrier();
  const effectRunning = barrier();
  const effectStarts: { executionId: string; signal: AbortSignal }[] = [];
  let resourceAborts = 0;
  const delegate = (level: number): ModelEvent[] => [
    {
      type: 'tool_call',
      id: `delegate-${level}`,
      name: 'fixture.delegate',
      arguments: JSON.stringify({ configuration: `level${level}` }),
    },
    { ...finish, reason: 'tool_calls' },
  ];
  const runtime = createRuntime({
    store: proxy,
    model: createFixedModel([
      options.childDepth ? delegate(1) : effect,
      ...(options.sameRunNextTool && !options.childDepth ? [effect] : []),
      [finish],
      ...(options.holdEffect && !options.sameRunNextTool ? [effect, [finish]] : []),
    ]),
    modelId: 'fixed',
    permissions: policy,
    ...(options.holdResource
      ? {
          workspaceSerialLocks: {
            async acquire(_input: unknown, signal: AbortSignal) {
              resource.arrive();
              await new Promise<void>((resolve, reject) => {
                const abort = () => {
                  resourceAborts++;
                  reject(signal.reason);
                };
                signal.addEventListener('abort', abort, { once: true });
                void resource.waiting.then(() => {
                  signal.removeEventListener('abort', abort);
                  resolve();
                });
                if (signal.aborted) abort();
              });
              signal.throwIfAborted();
              return () => {};
            },
          },
        }
      : {}),
    childConfigurations: Array.from({ length: options.childDepth ?? 0 }, (_, index) => ({
      id: `level${index + 1}`,
      version: '1',
      modelId: `child${index + 1}`,
      model: createFixedModel([
        index + 1 < (options.childDepth ?? 0) ? delegate(index + 2) : effect,
        ...(options.sameRunNextTool && index + 1 === options.childDepth ? [effect] : []),
        [finish],
      ]),
      toolIds: ['fixture.delegate', 'fixture.effect'],
      snapshot: {},
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'trusted-child-ceiling' };
        },
      },
    })),
    ...(options.reviewer
      ? {
          authorizationReview: {
            id: 'reviewer',
            version: '1',
            modelId: 'reviewer',
            model: options.reviewer,
          },
        }
      : {}),
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Harmless counter representing external effect',
            inputSchema: { type: 'object' },
            ...(options.holdResource
              ? { resources: { serial: { scope: 'workspace' as const, key: 'effect' } } }
              : {}),
            async execute(_input, context) {
              effects++;
              effectStarts.push({ executionId: context.executionId, signal: context.signal });
              if (options.holdEffect && effects === 1) {
                effectRunning.arrive();
                await effectRunning.waiting;
                context.signal.throwIfAborted();
              }
              return { outcome: 'succeeded', content: 'done' };
            },
          },
          {
            id: 'fixture.delegate',
            version: '1',
            description: 'Create the next exact child',
            inputSchema: { type: 'object' },
            async execute(input, context) {
              const target = (input as { configuration: string }).configuration;
              const operation = await context.operations.ensure({
                key: target,
                request: { kind: 'agent', configurationId: target, input: { content: target } },
              });
              await context.operations.wait(operation, { timeoutMs: 5000, signal: context.signal });
              return { outcome: 'succeeded', content: 'child settled' };
            },
          },
        ],
      },
    ],
  });
  const submit = (commandId = 'work') =>
    runtime.submitCommand({
      ...base,
      sessionId: 's',
      commandId,
      request: {
        kind: 'run.start',
        content: commandId === 'work' ? 'one effect' : `New task: ${commandId}`,
      },
    });
  const pending = () =>
    until(
      async () =>
        (await store.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' }))
          .interactions[0] ?? null,
    );
  const approve = (card: InteractionRecord, commandId = 'approve') =>
    runtime.answerInteraction({
      ...base,
      commandId,
      presentationSessionId: card.presentationSessionId,
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
  return {
    runtime,
    store,
    base,
    root,
    held,
    resource,
    effectRunning,
    effectStarts,
    dispatches,
    resourceAborts: () => resourceAborts,
    setMode,
    submit,
    pending,
    approve,
    effects: () => effects,
    async close() {
      held.release();
      resource.release();
      effectRunning.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('pending exact action follows root relaxation without an answer and retains policy invalidation provenance', async () => {
  const f = await fixture();
  try {
    await f.setMode('accept_edits');
    await f.submit();
    const old = await f.pending();
    expect(f.effects()).toBe(0);
    await f.setMode('full');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(1);
    const saved = await f.store.getInteraction({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 's',
      interactionId: old.id,
    });
    expect(saved?.state).toBe('cancelled');
    expect(saved?.answer).toBeNull();
    expect(saved?.request).toEqual(old.request);
    expect(
      (await f.store.getChanges({ after: '0', limit: 200 })).events.some(
        (event) =>
          event.type === 'interaction.invalidated' &&
          (event.payload as { reason: string }).reason === 'permission_policy_changed',
      ),
    ).toBe(true);
    await f.approve(old, 'late-old-answer').catch(() => {});
    expect(f.effects()).toBe(1);
  } finally {
    await f.close();
  }
});

test('tightening before final SQL dispatch reauthorizes original action and old full proof produces zero effects', async () => {
  const f = await fixture({ holdDispatch: true });
  try {
    await f.setMode('full');
    await f.submit();
    await f.held.entered;
    await f.setMode('accept_edits');
    f.held.release();
    const card = await f.pending();
    expect(f.effects()).toBe(0);
    await f.approve(card);
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(1);
    expect(
      (await f.store.listExecutions('s')).filter((execution) => execution.kind === 'tool'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('tightening after actual effect dispatch preserves the running action and requires fresh approval for the next invocation', async () => {
  const f = await fixture({ holdEffect: true });
  try {
    await f.setMode('full');
    const full = await f.store.readHostControl({
      ...f.base,
      kind: 'permission.mode',
      scope: 'session:s',
    });
    await f.submit();
    await f.effectRunning.entered;
    expect(f.effects()).toBe(1);
    expect(f.effectStarts).toHaveLength(1);
    const firstId = f.effectStarts[0]!.executionId;
    const firstDispatch = f.dispatches.find((input) => input.executionId === firstId)!;
    expect(firstDispatch.authorization).toMatchObject({
      allowed: true,
      controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: full.revision }],
    });
    const running = (await f.store.getExecution(firstId))!;
    // Ordinary Tool execution remains dispatching while its actual execute awaits.
    expect(running.status).toBe('dispatching');
    expect(running.authorization?.dispatched).toBe(true);
    await f.setMode('accept_edits');
    const strict = await f.store.readHostControl({
      ...f.base,
      kind: 'permission.mode',
      scope: 'session:s',
    });
    expect(strict.revision).not.toBe(full.revision);
    expect(f.effectStarts[0]!.signal.aborted).toBe(false);
    expect((await f.store.getExecution(firstId))?.cancelRequestedAt).toBeNull();
    expect((await f.store.getExecution(firstId))?.status).toBe('dispatching');
    f.effectRunning.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect((await f.store.getExecution(firstId))?.status).toBe('succeeded');
    expect((await f.store.getExecution(firstId))?.cancelRequestedAt).toBeNull();
    expect(f.effectStarts[0]!.signal.aborted).toBe(false);
    expect(f.effects()).toBe(1);
    expect(f.dispatches.filter((input) => input.executionId === firstId)).toHaveLength(1);

    await f.submit('next-effect');
    const pending = await f.pending();
    expect(pending.executionId).not.toBe(firstId);
    expect(pending.runId).not.toBe(running.runId);
    expect(f.effects()).toBe(1);
    expect(f.effectStarts).toHaveLength(1);
    expect(f.dispatches.some((input) => input.executionId === pending.executionId)).toBe(false);
    await f.approve(pending, 'approve-next-effect');
    await f.runtime.waitForCommand('next-effect', { timeoutMs: 5000 });
    expect(f.effects()).toBe(2);
    expect(f.effectStarts.map((start) => start.executionId)).toEqual([
      firstId,
      pending.executionId,
    ]);
    expect(
      f.dispatches.find((input) => input.executionId === pending.executionId)?.authorization,
    ).toMatchObject({
      allowed: true,
      controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: strict.revision }],
    });
    expect(
      (await f.store.listExecutions('s')).filter((execution) => execution.kind === 'tool'),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('local root mode never relaxes another root or a hard read-only capability', async () => {
  for (const readOnly of [false, true]) {
    const f = await fixture({ readOnly });
    try {
      await f.setMode('accept_edits');
      await f.setMode('full', 'other');
      await f.submit();
      if (!readOnly) {
        await f.pending();
        expect(f.effects()).toBe(0);
        await f.setMode('full');
      } else await f.setMode('full');
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects()).toBe(readOnly ? 0 : 1);
    } finally {
      await f.close();
    }
  }
});

test('explicit refusal is not revived by later mode relaxation', async () => {
  const f = await fixture();
  try {
    await f.setMode('accept_edits');
    await f.submit();
    const card = await f.pending();
    await f.runtime.answerInteraction({
      ...f.base,
      commandId: 'deny',
      presentationSessionId: card.presentationSessionId,
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    await f.setMode('full');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(0);
  } finally {
    await f.close();
  }
});

test('a running stale automatic review cannot delay a root relaxation or apply its late refusal', async () => {
  const held = barrier();
  let reviewCalls = 0;
  const f = await fixture({
    reviewer: {
      async *stream() {
        reviewCalls++;
        held.arrive();
        await held.waiting;
        yield { type: 'text_delta', text: '{"decision":"reject","reason":"old mode review"}' };
        yield finish;
      },
    },
  });
  try {
    await f.setMode('auto');
    await f.submit();
    await until(async () => {
      if (reviewCalls) return true;
      const interactions = await f.store.listInteractions({
        expectedStoreId: f.base.expectedStoreId,
        sessionId: 's',
        state: 'pending',
      });
      if (interactions.interactions.length)
        throw Error(`unexpected review fallback ${JSON.stringify(interactions.interactions[0])}`);
      return null;
    });
    await f.setMode('full');
    await until(async () => (f.effects() === 1 ? true : null));
    held.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(1);
    expect(reviewCalls).toBe(1);
    expect(
      (
        await f.store.listInteractions({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions,
    ).toHaveLength(0);
  } finally {
    held.release();
    await f.close();
  }
});

test('an approved but undispatched action cannot use its old grant after a mode revision changes', async () => {
  const f = await fixture({ holdDispatch: true });
  try {
    await f.setMode('accept_edits');
    await f.submit();
    const original = await f.pending();
    await f.approve(original);
    await f.held.entered;
    await f.setMode('full');
    await f.setMode('accept_edits');
    f.held.release();
    const current = await f.pending();
    expect(current.id).not.toBe(original.id);
    expect(f.effects()).toBe(0);
    await f.approve(original, 'late-duplicate').catch(() => {});
    expect(f.effects()).toBe(0);
    await f.approve(current, 'approve-current');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(1);
    expect(
      (await f.store.listExecutions('s')).filter((execution) => execution.kind === 'tool'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('resource waiting wakes and releases its old policy before the held resource becomes available', async () => {
  const f = await fixture({ holdResource: true });
  try {
    await f.setMode('full');
    await f.submit();
    await f.resource.entered;
    await f.setMode('accept_edits');
    const card = await f.pending();
    expect(f.effects()).toBe(0);
    expect(f.resourceAborts()).toBe(1);
    await f.setMode('full');
    await until(async () =>
      (
        await f.store.getInteraction({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: 's',
          interactionId: card.id,
        })
      )?.state === 'cancelled'
        ? true
        : null,
    );
    f.resource.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(1);
  } finally {
    await f.close();
  }
});

test('three levels of trusted injected children follow one root mode in their original active Runs', async () => {
  const f = await fixture({ childDepth: 3 });
  try {
    await f.setMode('accept_edits');
    await f.submit();
    const card = await f.pending();
    expect(card.ancestry).toHaveLength(4);
    expect(card.sessionId).not.toBe('s');
    const child = await f.store.getSession(card.sessionId);
    expect(child?.rootSessionId).toBe('s');
    expect(f.effects()).toBe(0);
    await f.setMode('full');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(1);
    expect(
      (
        await f.store.getInteraction({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: card.sessionId,
          interactionId: card.id,
        })
      )?.state,
    ).toBe('cancelled');
  } finally {
    await f.close();
  }
});

for (const childDepth of [0, 3]) {
  test(`tightening preserves the dispatched action and gates the next tool in the same active Run at child depth ${childDepth}`, async () => {
    const f = await fixture({ childDepth, holdEffect: true, sameRunNextTool: true });
    try {
      await f.setMode('full');
      await f.submit();
      await f.effectRunning.entered;
      const first = (await f.store.getExecution(f.effectStarts[0]!.executionId))!;
      expect(f.effects()).toBe(1);
      expect(first.status).toBe('dispatching');
      expect(first.authorization?.dispatched).toBe(true);
      await f.setMode('accept_edits');
      const strict = await f.store.readHostControl({
        ...f.base,
        kind: 'permission.mode',
        scope: 'session:s',
      });
      expect(f.effectStarts[0]!.signal.aborted).toBe(false);
      expect((await f.store.getExecution(first.id))?.cancelRequestedAt).toBeNull();
      f.effectRunning.release();
      const next = await f.pending();
      expect(next.runId).toBe(first.runId);
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.executionId).not.toBe(first.id);
      expect(next.ancestry).toHaveLength(childDepth + 1);
      expect((await f.store.getSession(next.sessionId))?.rootSessionId).toBe('s');
      expect((await f.store.getExecution(first.id))?.status).toBe('succeeded');
      expect((await f.store.getExecution(next.executionId))?.status).toBe('planned');
      expect(f.effects()).toBe(1);
      expect(f.effectStarts).toHaveLength(1);
      expect(f.dispatches.some((input) => input.executionId === next.executionId)).toBe(false);
      await f.approve(next, `approve-same-run-${childDepth}`);
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(f.effects()).toBe(2);
      expect(f.effectStarts.map((start) => start.executionId)).toEqual([
        first.id,
        next.executionId,
      ]);
      expect(
        f.dispatches.find((input) => input.executionId === next.executionId)?.authorization,
      ).toMatchObject({
        allowed: true,
        controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: strict.revision }],
      });
      const tools = (await f.store.listExecutions(first.sessionId)).filter(
        (execution) => execution.kind === 'tool',
      );
      expect(tools).toHaveLength(2);
      expect(tools.every((execution) => execution.runId === first.runId)).toBe(true);
    } finally {
      await f.close();
    }
  });
}

test('third-level child releases its stale resource wait and invalidates the fresh card when root mode relaxes', async () => {
  const f = await fixture({ childDepth: 3, holdResource: true });
  try {
    await f.setMode('full');
    await f.submit();
    await f.resource.entered;
    await f.setMode('accept_edits');
    const card = await f.pending();
    expect(card.ancestry).toHaveLength(4);
    expect((await f.store.getSession(card.sessionId))?.rootSessionId).toBe('s');
    expect((await f.store.getExecution(card.executionId))?.status).toBe('planned');
    expect(f.effects()).toBe(0);
    expect(f.resourceAborts()).toBe(1);
    expect(f.dispatches.some((input) => input.executionId === card.executionId)).toBe(false);
    await f.setMode('full');
    await until(async () =>
      (
        await f.store.getInteraction({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: card.sessionId,
          interactionId: card.id,
        })
      )?.state === 'cancelled'
        ? true
        : null,
    );
    await f.approve(card, 'late-child-resource-answer').catch(() => {});
    expect(f.effects()).toBe(0);
    f.resource.release();
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(1);
    expect(f.effectStarts.map((start) => start.executionId)).toEqual([card.executionId]);
    expect(f.dispatches.filter((input) => input.executionId === card.executionId)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('third-level child discards a late Auto approval after tightening to a fresh manual request', async () => {
  const held = barrier();
  const reviewReturned = barrier();
  let reviewCalls = 0;
  const f = await fixture({
    childDepth: 3,
    reviewer: {
      async *stream() {
        reviewCalls++;
        held.arrive();
        try {
          await held.waiting;
          yield {
            type: 'text_delta',
            text: '{"decision":"approve_once","reason":"stale reviewer approval"}',
          };
          yield finish;
        } finally {
          reviewReturned.arrive();
        }
      },
    },
  });
  try {
    await f.setMode('auto');
    await f.submit();
    await held.entered;
    expect(reviewCalls).toBe(1);
    expect(f.effects()).toBe(0);
    await f.setMode('accept_edits');
    const fresh = await f.pending();
    expect(fresh.ancestry).toHaveLength(4);
    expect((await f.store.getSession(fresh.sessionId))?.rootSessionId).toBe('s');
    const review = (await f.store.listExecutions(fresh.sessionId)).find(
      (execution) => execution.parentExecutionId === fresh.executionId && execution.childSessionId,
    )!;
    expect(review).toBeDefined();
    held.release();
    await reviewReturned.entered;
    await f.runtime.waitForCommand(review.originCommandId, { timeoutMs: 5000 });
    expect(f.effects()).toBe(0);
    expect((await f.store.getExecution(fresh.executionId))?.status).toBe('planned');
    expect(f.dispatches.some((input) => input.executionId === fresh.executionId)).toBe(false);
    expect(
      (
        await f.store.getInteraction({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: fresh.sessionId,
          interactionId: fresh.id,
        })
      )?.state,
    ).toBe('pending');
    await f.approve(fresh, 'approve-after-stale-auto');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(f.effects()).toBe(1);
    expect(reviewCalls).toBe(1);
    expect(f.effectStarts.map((start) => start.executionId)).toEqual([fresh.executionId]);
  } finally {
    held.release();
    await f.close();
  }
});
