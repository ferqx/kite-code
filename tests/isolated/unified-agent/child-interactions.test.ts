import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import type { OperationRef } from '@kite-ai/agent/extensions';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter, type ModelRequest } from '@kite-ai/ai';
import { startService } from '../../../apps/service/src';
import { createClient, type Interaction } from '../../../packages/client/src';

async function until<T>(read: () => Promise<T>, valid: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (valid(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Child interaction deadline: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}
async function code(work: Promise<unknown>, expected: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(expected);
}
async function fixture(count = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-interactions-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const peerStore = await openSqliteStore(selected);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const operations: OperationRef[] = [];
  const requests: ModelRequest[] = [];
  const effects: string[] = [];
  let sourceVersion = 'one';
  const child: ModelAdapter = {
    async *stream(request, { signal }) {
      signal.throwIfAborted();
      requests.push(structuredClone(request));
      if (!request.messages.some((message) => message.role === 'tool')) {
        const label = request.messages.some(
          (message) => message.role === 'user' && message.content.includes('child-a'),
        )
          ? 'a'
          : 'b';
        yield {
          type: 'tool_call',
          id: crypto.randomUUID(),
          name: 'fixture.effect',
          arguments: JSON.stringify({ label }),
        };
        yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
      } else yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'parent',
    modelConcurrency: 1,
    maxConcurrentSubagents: 2,
    permissions: {
      async authorize(request) {
        return request.definitionId === 'fixture.effect'
          ? {
              allowed: false,
              revision: 'policy-1',
              approval: { request: { title: 'approve exact child', input: request.input } },
            }
          : { allowed: true, revision: 'policy-1' };
      },
    },
    sources: {
      async capture() {
        return [
          {
            id: 'workspace:instructions',
            kind: 'instruction',
            scope: 'workspace',
            digest: sourceVersion,
            content: sourceVersion,
          },
        ];
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.delegate',
            version: '1',
            description: 'Explicit independent children',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              for (const label of ['a', 'b'].slice(0, count))
                operations.push(
                  await context.operations.ensure({
                    key: label,
                    cancellation: 'detached',
                    request: {
                      kind: 'agent',
                      configurationId: 'child',
                      input: { content: `child-${label}` },
                    },
                  }),
                );
              return { outcome: 'succeeded', content: 'delegated' };
            },
          },
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Harmless counted child effect',
            inputSchema: {
              type: 'object',
              required: ['label'],
              properties: { label: { type: 'string' } },
              additionalProperties: false,
            },
            async execute(input) {
              effects.push((input as { label: string }).label);
              return { outcome: 'succeeded', content: 'counted original child' };
            },
          },
        ],
      },
    ],
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: ['fixture.effect'],
        snapshot: {},
        maxConcurrentSubagents: 2,
      },
    ],
  });
  const observerModel = createFixedModel([]);
  const observer = createRuntime({
    store: peerStore,
    model: observerModel,
    modelId: 'observer',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const ownerService = await startService({
    runtime,
    profile,
    buildId: 'owner',
    subjectId: 'owner',
  });
  const peerService = await startService({
    runtime: observer,
    profile,
    buildId: 'observer',
    subjectId: 'owner',
  });
  const clients = [ownerService, peerService].map((service) =>
    createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['interactions', 'commands'] },
      bootstrap: service.bootstrap,
    }),
  );
  const client = clients[0]!;
  const peer = clients[1]!;
  async function close() {
    for (const item of clients) item.disposeNetwork();
    try {
      await peerService.close();
    } finally {
      try {
        await ownerService.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  try {
    await Promise.all(clients.map((item) => item.connect()));
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: `file://${root}`,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      commandId: 'create',
      title: 'root',
    });
    await client.startRun('root', {
      expectedStoreId,
      commandId: 'original',
      kind: 'run.start',
      content: 'delegate original children',
    });
    const cards = await until(
      () => peer.listInteractions('root', { storeId: expectedStoreId, state: 'pending' }),
      (page) => page.interactions.length === count,
    );
    await runtime.waitForCommand('original', { timeoutMs: 5000 });
    return {
      root,
      store,
      runtime,
      client,
      peer,
      model,
      observerModel,
      requests,
      effects,
      expectedStoreId,
      operations,
      cards: cards.interactions,
      set sourceVersion(value: string) {
        sourceVersion = value;
      },
      card(label: string) {
        return cards.interactions.find(
          (card) => (card.request as { input: { label: string } }).input.label === label,
        )!;
      },
      answer(
        card: Interaction,
        decision: 'approve' | 'deny' = 'approve',
        commandId = `answer-${card.id}`,
      ) {
        return peer.answerInteraction('root', card.id, {
          expectedStoreId,
          commandId,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision },
        });
      },
      settled(label: string) {
        const card = cards.interactions.find(
          (item) => (item.request as { input: { label: string } }).input.label === label,
        )!;
        const ref = operations.find((item) => item.childSessionId === card.sessionId)!;
        return until(
          () => client.getExecution(ref.executionId!),
          (execution) =>
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status),
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
test('two actual detached child approvals share root presentation; observer Service answers only one original execution', async () => {
  const f = await fixture();
  try {
    const a = f.card('a');
    const b = f.card('b');
    expect(a.id).not.toBe(b.id);
    expect(a.executionId).not.toBe(b.executionId);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect((await f.client.getView('root')).runs[0]?.status).toBe('completed');
    expect(f.requests).toHaveLength(2);
    expect(f.effects).toHaveLength(0);
    for (const card of [a, b]) {
      expect(card.presentationSessionId).toBe('root');
      expect(card.ancestry).toContain('root');
      expect((await f.client.getView(card.sessionId)).session.parentSessionId).toBe('root');
      expect(
        await f.peer.getInteraction(card.sessionId, card.id, { storeId: f.expectedStoreId }),
      ).toEqual(card);
      const before = (await f.client.getView('root')).snapshotCursor;
      await code(
        f.peer.answerInteraction(card.sessionId, card.id, {
          expectedStoreId: f.expectedStoreId,
          commandId: `child-direct-${card.id}`,
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve' },
        }),
        'interaction_scope_denied',
      );
      expect((await f.client.getView('root')).snapshotCursor).toBe(before);
    }
    await code(
      f.peer.answerInteraction('root', a.id, {
        expectedStoreId: 'wrong-store',
        commandId: 'wrong-store',
        expectedRevision: a.revision,
        answer: { kind: 'approval', decision: 'approve' },
      }),
      'store_identity_mismatch',
    );
    await code(
      f.peer.answerInteraction('root', a.id, {
        expectedStoreId: f.expectedStoreId,
        commandId: 'stale-revision',
        expectedRevision: '0',
        answer: { kind: 'approval', decision: 'approve' },
      }),
      'interaction_revision_conflict',
    );
    const receipt = await f.answer(b);
    await f.settled('b');
    expect(f.effects).toEqual(['b']);
    expect((await f.peer.getInteraction('root', a.id, { storeId: f.expectedStoreId })).state).toBe(
      'pending',
    );
    expect((await f.client.getExecution(a.executionId)).status).toBe('planned');
    expect((await f.client.getExecution(b.executionId)).status).toBe('succeeded');
    expect(await f.answer(b)).toEqual(receipt);
    expect(f.effects).toEqual(['b']);
    await f.answer(a);
    await f.settled('a');
    expect(f.effects).toEqual(['b', 'a']);
    expect(f.observerModel.requests).toHaveLength(0);
    expect(f.requests).toHaveLength(4);
    expect(f.model.requests).toHaveLength(2);
    for (const card of [a, b])
      expect(
        (await f.peer.getInteraction('root', card.id, { storeId: f.expectedStoreId }))
          .acceptedDecisionRevision,
      ).toBe('2');
  } finally {
    await f.close();
  }
}, 15000);

for (const domain of ['child', 'root'] as const)
  test(`actual ${domain} cancellation wins pending approval; late root answer grants no child dispatch`, async () => {
    const f = await fixture();
    try {
      const a = f.card('a');
      const b = f.card('b');
      if (domain === 'child')
        await f.peer.cancelExecution('root', {
          expectedStoreId: f.expectedStoreId,
          commandId: 'cancel-one',
          kind: 'execution.cancel',
          executionId: f.operations.find((operation) => operation.childSessionId === a.sessionId)!
            .executionId!,
        });
      else
        await f.peer.cancelSession('root', {
          expectedStoreId: f.expectedStoreId,
          commandId: 'cancel-root',
          kind: 'session.cancel',
          includeBackground: true,
        });
      await f.answer(a);
      await f.settled('a');
      expect(f.effects).toHaveLength(0);
      expect(
        (await f.client.getInteraction('root', a.id, { storeId: f.expectedStoreId })).state,
      ).toBe('cancelled');
      expect(
        (await f.client.getInteraction('root', a.id, { storeId: f.expectedStoreId }))
          .acceptedDecisionRevision,
      ).toBeNull();
      if (domain === 'child') {
        await f.answer(b);
        await f.settled('b');
        expect(f.effects).toEqual(['b']);
        expect((await f.client.getExecution(b.executionId)).status).toBe('succeeded');
        expect(f.requests).toHaveLength(3);
      } else {
        await f.answer(b);
        await f.settled('b');
        expect(f.effects).toHaveLength(0);
        expect(f.requests).toHaveLength(2);
      }
      expect(f.observerModel.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 15000);

test('denying one actual child ends its original round without cancelling a queued new parent Run or detached sibling', async () => {
  const f = await fixture();
  try {
    const a = f.card('a');
    const b = f.card('b');
    await f.peer.startRun('root', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'new-explicit',
      kind: 'run.start',
      content: 'independent later user intent',
    });
    await f.answer(a, 'deny');
    await f.settled('a');
    expect((await f.client.getExecution(a.executionId)).status).toBe('failed');
    expect((await f.client.getView(a.sessionId)).runs[0]?.status).toBe('cancelled');
    expect((await f.client.getCommand('new-explicit')).cancelRequestedAt).toBeNull();
    expect((await f.client.getCommand('original')).cancelRequestedAt).toBeNull();
    expect(f.effects).toHaveLength(0);
    await f.answer(b);
    await f.settled('b');
    await f.runtime.waitForCommand('new-explicit', { timeoutMs: 5000 });
    expect(f.effects).toEqual(['b']);
    expect(
      (await f.client.getView('root')).runs.find((run) => run.originCommandId === 'new-explicit')
        ?.status,
    ).toBe('completed');
    expect(f.model.requests).toHaveLength(3);
    expect(f.observerModel.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);

test('source changed while child approval waited invalidates old effect and enters the next actual child Model body', async () => {
  const f = await fixture(1);
  try {
    const a = f.card('a');
    f.sourceVersion = 'two';
    await f.answer(a);
    await f.settled('a');
    expect(f.effects).toHaveLength(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]?.messages).toContainEqual({
      role: 'system',
      content: 'one',
      sourceIds: ['workspace:instructions'],
    });
    expect(f.requests[1]?.messages).toContainEqual({
      role: 'system',
      content: 'two',
      sourceIds: ['workspace:instructions'],
    });
    expect(
      (await f.peer.getInteraction('root', a.id, { storeId: f.expectedStoreId }))
        .acceptedDecisionRevision,
    ).toBeNull();
    expect((await f.client.getExecution(a.executionId)).result).toMatchObject({
      content: 'context_refresh_required',
      details: { adapterAttempted: false },
    });
    expect(f.observerModel.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);
