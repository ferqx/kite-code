import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { type ChildAgentConfiguration, createRuntime, type RuntimeOptions } from '../../../src';
import type {
  Extension,
  JobEvent,
  OperationRef,
  Permissions,
  ToolDefinition,
} from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];
const allow: Permissions = {
  async authorize() {
    return { allowed: true, revision: 'full' };
  },
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fact<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= end) throw new Error('missing_child_binding_fact');
    await Bun.sleep(5);
  }
}
const tool = (id: string, execute: ToolDefinition['execute'], version = '1'): ToolDefinition => ({
  id,
  version,
  description: `exact ${id} ${version}`,
  inputSchema: { type: 'object', additionalProperties: false },
  execute,
});
const module = (tools: ToolDefinition[], version = '1'): Extension => ({
  id: 'extra',
  version,
  apiMajor: 1,
  tools,
  records: [
    { contentType: 'fixture.child', contentVersion: 1, schema: { type: 'object' } },
    { contentType: 'fixture.v2', contentVersion: 1, schema: { type: 'object' } },
  ],
});
async function fixture(
  child: ChildAgentConfiguration,
  extra: Extension,
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-binding-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const refs: OperationRef[] = [];
  const parent = createFixedModel([
    call('fixture.delegate'),
    [finish],
    call('fixture.delegate'),
    [finish],
  ]);
  const delegate = tool('fixture.delegate', async (_input, context) => {
    let ref: OperationRef;
    try {
      ref = await context.operations.ensure({
        key: `child-${context.executionId}`,
        request: { kind: 'agent', configurationId: 'child', input: { content: 'bounded child' } },
      });
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'child_tool_scope_exceeds_parent')
        throw error;
      return { outcome: 'failed', content: error.code };
    }
    const same = await context.operations.ensure({
      key: `child-${context.executionId}`,
      request: { kind: 'agent', configurationId: 'child', input: { content: 'bounded child' } },
    });
    expect(same).toEqual(ref);
    refs.push(ref);
    const result = await context.operations.wait(ref, { signal: context.signal, timeoutMs: 5000 });
    return { outcome: 'succeeded', content: JSON.stringify(result.result) };
  });
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 1,
    permissions: allow,
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [delegate] }],
    resolveRunConfiguration: async () => ({
      model: parent,
      modelId: 'parent',
      extensions: [extra],
      snapshot: { selected: extra.version },
    }),
    childConfigurations: [child],
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: `file://${root}` });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 's',
  });
  return {
    store,
    runtime,
    refs,
    expectedStoreId,
    parent,
    submit: () =>
      runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'delegate' },
      }),
    done: () => runtime.waitForCommand('work', { timeoutMs: 7000 }),
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function configuration(
  model: ModelAdapter,
  extra: Extension,
  additions: Partial<ChildAgentConfiguration> = {},
): ChildAgentConfiguration {
  return {
    id: 'child',
    version: '1',
    model,
    modelId: 'child',
    extensions: [extra],
    toolIds: extra.tools!.map((t) => t.id),
    snapshot: { child: true },
    ...additions,
  };
}

test('additional-only child modules and sources persist their own namespace; static lease survives successive children until close', async () => {
  let writes = 0,
    disposals = 0,
    captures = 0;
  const extra = module([
    tool('extra.write', async (_input, context) => {
      await context.records.write({
        key: 'child',
        contentType: 'fixture.child',
        contentVersion: 1,
        value: { actual: ++writes },
        expectedRevision: null,
      });
      return { outcome: 'succeeded', content: 'actual child record' };
    }),
  ]);
  const child = createFixedModel([call('extra.write'), [finish], call('extra.write'), [finish]]);
  const configured = configuration(child, extra, {
    async dispose() {
      disposals++;
    },
    sources: {
      async capture(request) {
        captures++;
        return [
          {
            id: 'child-source',
            kind: 'fixture',
            scope: request.sessionId,
            digest: 'fixed',
            content: 'child-only source',
          },
        ];
      },
    },
  });
  const f = await fixture(configured, extra);
  configured.sources!.capture = async () => [];
  try {
    await f.submit();
    await f.done();
    expect(writes).toBe(1);
    expect(disposals).toBe(0);
    const ref = f.refs[0]!;
    expect(
      (
        await f.store.getExtensionRecord({
          sessionId: ref.childSessionId!,
          extensionId: 'extra',
          key: 'child',
        })
      )?.value,
    ).toEqual({ actual: 1 });
    expect(
      await f.store.getExtensionRecord({ sessionId: 's', extensionId: 'extra', key: 'child' }),
    ).toBeNull();
    expect(child.requests[0]!.messages.some((m) => m.content === 'child-only source')).toBe(true);
    expect(
      f.parent.requests.every((r) => r.messages.every((m) => m.content !== 'child-only source')),
    ).toBe(true);
    const before = captures;
    await f.runtime.getView(ref.childSessionId!);
    expect(captures).toBe(before);
    await f.runtime.submitCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'again',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'second child' },
    });
    await f.runtime.waitForCommand('again', { timeoutMs: 5000 });
    expect(writes).toBe(2);
    expect(f.refs).toHaveLength(2);
    expect(disposals).toBe(0);
  } finally {
    await f.close();
  }
  expect(disposals).toBe(1);
});

for (const mode of [
  'deny',
  'ask',
  'dual_ask',
  'dual_review',
  'ask_review',
  'ask_review_fallback',
] as const) {
  test(`parent/child permission intersection ${mode} preserves both exact policies`, async () => {
    let effects = 0,
      held = 0;
    const extra = module([
      {
        ...tool('extra.effect', async () => {
          effects++;
          expect(held).toBe(1);
          return { outcome: 'succeeded', content: 'harmless effect' };
        }),
        resources: { slot: 'process', serial: { scope: 'workspace', key: 'exact-child' } },
      },
    ]);
    const child = createFixedModel([call('extra.effect'), [finish]]);
    const review = createFixedModel([
      [
        {
          type: 'text_delta',
          text: JSON.stringify({
            decision: mode === 'ask_review_fallback' ? 'ask_user' : 'approve_once',
            reason: 'both exact policies',
          }),
        },
        finish,
      ],
    ]);
    const decisions = (side: 'parent' | 'child'): Permissions => ({
      async authorize(request) {
        if (request.definitionId !== 'extra.effect')
          return { allowed: true, revision: `${side}-allow` };
        if (mode === 'deny' && side === 'parent')
          return { allowed: false, revision: 'parent-deny', reason: 'parent restricted' };
        if (
          mode === 'dual_ask' ||
          ((mode === 'ask' || mode === 'ask_review' || mode === 'ask_review_fallback') &&
            side === 'parent')
        )
          return {
            allowed: false,
            revision: 'parent-ask',
            approval: { request: { requires: `${side} human`, exact: request.input } },
          };
        if (
          mode === 'dual_review' ||
          ((mode === 'ask_review' || mode === 'ask_review_fallback') && side === 'child')
        )
          return {
            allowed: false,
            revision: `${side}-review`,
            review: { request: { requires: `${side} reviewer`, exact: request.input } },
          };
        return { allowed: true, revision: `${side}-full` };
      },
    });
    const f = await fixture(
      configuration(child, extra, {
        permissions: decisions('child'),
        authorizationReview: {
          id: 'child-reviewer',
          version: '1',
          modelId: 'review',
          model: review,
        },
      }),
      extra,
      {
        permissions: decisions('parent'),
        workspaceSerialLocks: {
          async acquire() {
            held++;
            let released = false;
            return () => {
              if (!released) {
                released = true;
                held--;
              }
            };
          },
        },
      },
    );
    let proofChecks = 0;
    if (mode === 'ask_review') {
      const dispatch = f.store.markDispatching.bind(f.store);
      f.store.markDispatching = async (input) => {
        if (input.authorization.reviewExecutionId && input.authorization.interactionId) {
          const before = (await f.store.getMetadata()).lastChangeCursor;
          const { reviewExecutionId: _review, ...onlyHuman } = input.authorization;
          await dispatch({ ...input, authorization: onlyHuman }).then(
            () => {
              throw new Error('missing review grant admitted');
            },
            (error) => {
              expect(error).toBeInstanceOf(AgentError);
            },
          );
          expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
          const {
            interactionId: _interaction,
            decisionRevision: _revision,
            ...onlyReview
          } = input.authorization;
          await dispatch({ ...input, authorization: onlyReview }).then(
            () => {
              throw new Error('missing human grant admitted');
            },
            (error) => {
              expect(error).toBeInstanceOf(AgentError);
            },
          );
          expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
          proofChecks++;
        }
        return dispatch(input);
      };
    }
    try {
      await f.submit();
      if (
        mode === 'ask' ||
        mode === 'dual_ask' ||
        mode === 'ask_review' ||
        mode === 'ask_review_fallback'
      ) {
        const card = await fact(
          async () =>
            (
              await f.runtime.listInteractions({
                expectedStoreId: f.expectedStoreId,
                sessionId: 's',
                state: 'pending',
              })
            ).interactions[0],
        );
        expect(effects).toBe(0);
        expect(held).toBe(0);
        expect(card.presentationSessionId).toBe('s');
        if (mode === 'dual_ask') {
          expect(JSON.stringify(card.request)).toContain('parent human');
          expect(JSON.stringify(card.request)).toContain('child human');
        }
        expect(review.requests).toHaveLength(
          mode === 'ask_review' || mode === 'ask_review_fallback' ? 1 : 0,
        );
        await f.runtime.answerInteraction({
          expectedStoreId: f.expectedStoreId,
          commandId: 'answer',
          presentationSessionId: 's',
          interactionId: card.id,
          expectedRevision: card.revision,
          subjectId: 'owner',
          answer: { kind: 'approval', decision: 'approve' },
        });
      }
      await f.done();
      expect(effects).toBe(mode === 'deny' ? 0 : 1);
      expect(held).toBe(0);
      expect(review.requests).toHaveLength(
        mode === 'dual_review' || mode === 'ask_review' || mode === 'ask_review_fallback' ? 1 : 0,
      );
      const childSession = f.refs[0]!.childSessionId!;
      const effect = (await f.store.listExecutions(childSession)).find(
        (e) => e.definitionId === 'extra.effect',
      )!;
      expect(effect.status).toBe(mode === 'deny' ? 'failed' : 'succeeded');
      if (mode === 'dual_review') {
        const body = JSON.stringify(review.requests[0]!.messages);
        expect(body).toContain('parent reviewer');
        expect(body).toContain('child reviewer');
      }
      if (mode === 'ask_review') {
        expect(proofChecks).toBe(1);
        expect(effect.interactionBinding).not.toBeNull();
        const reviewers = (await f.store.listExecutions(childSession)).filter(
          (e) => e.kind === 'job',
        );
        expect(reviewers).toHaveLength(1);
        expect(reviewers[0]!.status).toBe('succeeded');
      }
    } finally {
      await f.close();
    }
  }, 10000);
}

test('fresh trusted child configuration may use parent actual Step v2, while its declared v1 cannot expand that captured catalogue', async () => {
  let writes = 0,
    resolves = 0,
    disposals = 0;
  const v1 = module([
    tool('extra.write', async () => ({ outcome: 'succeeded', content: 'old must not execute' })),
  ]);
  const v2 = module(
    [
      tool(
        'extra.write',
        async (_input, context) => {
          await context.records.write({
            key: 'v2',
            contentType: 'fixture.v2',
            contentVersion: 1,
            expectedRevision: null,
            value: { version: '2' },
          });
          writes++;
          return { outcome: 'succeeded', content: 'v2' };
        },
        '2',
      ),
    ],
    '2',
  );
  const child = createFixedModel([call('extra.write'), [finish]]);
  const dynamicParent = createFixedModel([call('fixture.delegate'), [finish]]);
  const f = await fixture(configuration(child, v1), v1, {
    resolveRunConfiguration: async () => ({
      model: dynamicParent,
      modelId: 'parent',
      extensions: [v1],
      snapshot: {},
      readStepCapabilities: async () => ({ extensions: [v2], snapshot: { catalogue: '2' } }),
    }),
    async resolveChildRunConfiguration(input) {
      resolves++;
      expect(Object.isFrozen(input.parentExecution)).toBe(true);
      expect(Object.isFrozen(input.workspace)).toBe(true);
      expect(input.workspace.id).toBe(input.parentSession.workspaceId);
      expect(input.workspace.rootUri).toStartWith('file://');
      expect(['dispatching', 'running']).toContain(input.parentExecution.status);
      return {
        model: child,
        modelId: 'child',
        extensions: [v2],
        toolIds: ['extra.write'],
        snapshot: { fresh: '2' },
        async dispose() {
          disposals++;
        },
      };
    },
  });
  try {
    await f.submit();
    await f.done();
    expect(writes).toBe(1);
    expect(resolves).toBe(1);
    expect(disposals).toBe(1);
    const models = (await f.store.listExecutions(f.refs[0]!.childSessionId!)).filter(
      (e) => e.kind === 'model',
    );
    expect(models[0]!.decisionSource).toMatchObject({
      toolBindings: [{ id: 'extra.write', version: '2', extensionId: 'extra' }],
    });
  } finally {
    await f.close();
  }
  const denied = await fixture(
    configuration(createFixedModel([call('extra.write'), [finish]]), v1),
    v2,
  );
  try {
    await denied.submit();
    await denied.done();
    expect(denied.refs).toHaveLength(0);
    expect(
      (await denied.store.listExecutions('s')).find((e) => e.definitionId === 'fixture.delegate')!
        .result,
    ).toMatchObject({ outcome: 'failed', content: 'child_tool_scope_exceeds_parent' });
  } finally {
    await denied.close();
  }
});

for (const lease of ['static', 'fresh'] as const) {
  test(`background ordinary child Job retains its ${lease} binding through parent completion`, async () => {
    const started = gate(),
      terminal = gate();
    let disposed = 0,
      starts = 0;
    let jobRef: OperationRef | undefined;
    const launch = tool('extra.launch', async (_input, context) => {
      jobRef = await context.operations.ensure({
        key: 'background',
        cancellation: 'detached',
        request: { kind: 'job', definitionId: 'extra.job', definitionVersion: '1', input: {} },
      });
      return { outcome: 'succeeded', content: 'launched' };
    });
    const extra: Extension = {
      ...module([launch]),
      jobs: [
        {
          id: 'extra.job',
          version: '1',
          description: 'bounded background',
          inputSchema: { type: 'object' },
          async start() {
            starts++;
            started.release();
            return { reference: { actual: true } };
          },
          async *observe(): AsyncIterable<JobEvent> {
            await terminal.promise;
            yield {
              type: 'terminal',
              result: { outcome: 'succeeded', content: 'job actual terminal' },
              supervision: 'ended',
            };
          },
          async cancel() {
            terminal.release();
            return { status: 'stopped' };
          },
          async dispose() {},
        },
      ],
    };
    const child = createFixedModel([call('extra.launch'), [finish]]);
    const dispose = async () => {
      disposed++;
    };
    const f = await fixture(
      configuration(child, extra, lease === 'static' ? { dispose } : {}),
      extra,
      lease === 'fresh'
        ? { resolveChildRunConfiguration: async () => configuration(child, extra, { dispose }) }
        : {},
    );
    try {
      await f.submit();
      await started.promise;
      await f.done();
      expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
      expect((await f.store.getView(f.refs[0]!.childSessionId!)).runs[0]!.status).toBe('completed');
      expect((await f.store.getExecution(f.refs[0]!.executionId!))!.status).toBe('succeeded');
      expect(disposed).toBe(0);
      expect(starts).toBe(1);
      expect((await f.store.getExecution(jobRef!.executionId!))?.status).toBe('running');
      terminal.release();
      await fact(async () =>
        (await f.store.getExecution(jobRef!.executionId!))?.status === 'succeeded'
          ? true
          : undefined,
      );
      if (lease === 'fresh') await fact(async () => (disposed === 1 ? true : undefined));
      expect(disposed).toBe(lease === 'fresh' ? 1 : 0);
    } finally {
      terminal.release();
      await f.close();
    }
    expect(disposed).toBe(1);
  }, 10000);
}

test('runless ordinary operation Tool retains the actual parent Step restriction instead of falling back to global grants', async () => {
  let blocked = 0,
    childCalls = 0;
  const secret = tool('extra.secret', async () => {
    childCalls++;
    return { outcome: 'succeeded', content: 'must not run' };
  });
  const relay = tool('extra.relay', async (_input, context) => {
    const current = await context.getExecution(context.executionId);
    if (current?.runId === null) {
      try {
        await context.operations.ensure({
          key: 'forbidden-child',
          request: { kind: 'agent', configurationId: 'child', input: { content: 'cannot expand' } },
        });
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'child_tool_scope_exceeds_parent')
          throw error;
        blocked++;
        return { outcome: 'failed', content: error.code };
      }
      return { outcome: 'succeeded', content: 'unexpected child' };
    }
    const ref = await context.operations.ensure({
      key: 'runless-relay',
      request: { kind: 'tool', definitionId: 'extra.relay', definitionVersion: '1', input: {} },
    });
    const result = await context.operations.wait(ref, { signal: context.signal, timeoutMs: 4000 });
    expect(result.result).toMatchObject({
      outcome: 'failed',
      content: 'child_tool_scope_exceeds_parent',
    });
    return { outcome: 'succeeded', content: 'runless restriction observed' };
  });
  const extra = module([relay, secret]);
  const parent = createFixedModel([call('extra.relay'), [finish]]);
  const child = createFixedModel([call('extra.secret'), [finish]]);
  const f = await fixture(configuration(child, extra, { toolIds: ['extra.secret'] }), extra, {
    resolveRunConfiguration: async () => ({
      model: parent,
      modelId: 'parent',
      extensions: [extra],
      toolIds: ['extra.relay'],
      snapshot: { restricted: true },
    }),
  });
  try {
    await f.submit();
    await f.done();
    expect(blocked).toBe(1);
    expect(childCalls).toBe(0);
    expect(child.requests).toHaveLength(0);
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
    const runless = (await f.store.listExecutions('s')).find(
      (e) => e.kind === 'tool' && e.runId === null,
    )!;
    expect(runless.result).toMatchObject({
      outcome: 'failed',
      content: 'child_tool_scope_exceeds_parent',
    });
    expect(await f.store.listSessions()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('concurrent identical child ensure creates one carrier and releases the losing fresh binding without replay', async () => {
  const bothResolved = gate();
  let resolves = 0,
    disposals = 0,
    effects = 0;
  const extra = module([
    tool('extra.ensure', async (_input, context) => {
      const ensure = () =>
        context.operations.ensure({
          key: 'same',
          request: { kind: 'agent', configurationId: 'child', input: { content: 'one child' } },
        });
      const [first, second] = await Promise.all([ensure(), ensure()]);
      expect(first).toEqual(second);
      await context.operations.wait(first!, { signal: context.signal, timeoutMs: 5000 });
      expect(disposals).toBe(2);
      return { outcome: 'succeeded', content: 'one actual child' };
    }),
    tool('extra.effect', async () => {
      effects++;
      return { outcome: 'succeeded', content: 'one effect' };
    }),
  ]);
  const child = createFixedModel([call('extra.effect'), [finish]]),
    parent = createFixedModel([call('extra.ensure'), [finish]]);
  const f = await fixture(configuration(child, extra, { toolIds: ['extra.effect'] }), extra, {
    resolveRunConfiguration: async () => ({
      model: parent,
      modelId: 'parent',
      extensions: [extra],
      snapshot: {},
    }),
    async resolveChildRunConfiguration() {
      if (++resolves === 2) bothResolved.release();
      await bothResolved.promise;
      return configuration(child, extra, {
        toolIds: ['extra.effect'],
        async dispose() {
          disposals++;
        },
      });
    },
  });
  try {
    await f.submit();
    await f.done();
    expect(resolves).toBe(2);
    expect(disposals).toBe(2);
    expect(effects).toBe(1);
    expect(child.requests).toHaveLength(2);
    expect((await f.store.listExecutions('s')).filter((e) => e.kind === 'job')).toHaveLength(1);
    const carrier = (await f.store.listExecutions('s')).find((e) => e.kind === 'job')!;
    expect((await f.store.getSession(carrier.childSessionId!))!.parentSessionId).toBe('s');
    expect((await f.store.getView('s')).runs[0]!.status).toBe('completed');
  } finally {
    bothResolved.release();
    await f.close();
  }
  expect(disposals).toBe(2);
});
