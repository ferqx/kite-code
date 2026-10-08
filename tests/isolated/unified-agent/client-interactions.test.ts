import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { startService } from '../../../apps/service/src';
import { createClient } from '../../../packages/client/src';
import { decodeResponse } from '../../../packages/client/src/decode';

async function code(work: Promise<unknown>, expected: string) {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string })?.code).toBe(expected);
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-client-interactions-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 'root',
    workspaceId: 'w',
    subjectId: 'owner',
    commandId: 'create-root',
    title: 'root',
  });
  await store.acceptCommand({
    expectedStoreId,
    sessionId: 'root',
    subjectId: 'owner',
    commandId: 'work',
    request: { kind: 'run.start', content: 'manual public binding setup' },
  });
  const owner = (await store.acquireSessionOwner('root', 'fixture-host'))!;
  const write = { expectedStoreId, owner };
  const configuration = {
    modelId: 'fixture',
    tools: [{ id: 'fixture.tool', version: '1', extensionId: 'fixture' }],
  };
  const run = await store.startRun({ ...write, commandId: 'work', configuration });
  const source = {
    kind: 'model_decision',
    modelExecutionId: 'fixture-source',
    privateSource: 'not public',
  };
  const input = {};
  const inputDigest = createHash('sha256').update('{}').digest('hex');
  const plan = (executionId: string, sessionId = 'root', runId = run.id, commandId = 'work') =>
    store.planExecution({
      ...write,
      executionId,
      sessionId,
      runId,
      originCommandId: commandId,
      kind: 'tool',
      definitionId: 'fixture.tool',
      definitionVersion: '1',
      stepId: executionId,
      callId: executionId,
      input,
      decisionSource: source,
    });
  await plan('parent-tool');
  await store.markDispatching({
    ...write,
    executionId: 'parent-tool',
    authorization: { allowed: true, revision: 'policy-1', definitionVersion: '1', inputDigest },
    requirements: [],
    freshness: { checked: true, source },
  });
  const operation = await store.ensureOperation({
    ...write,
    sessionId: 'root',
    extensionId: 'fixture',
    originCommandId: 'work',
    parentExecutionId: 'parent-tool',
    operationKey: 'child',
    cancellation: 'detached',
    request: { kind: 'agent', configurationId: 'child', input: { content: 'review' } },
    childConfiguration: { id: 'child', version: '1', snapshot: configuration },
  });
  await store.markDispatching({
    ...write,
    executionId: operation.executionId!,
    authorization: {
      allowed: true,
      revision: 'policy-1',
      definitionVersion: '1',
      inputDigest: createHash('sha256').update('{"content":"review"}').digest('hex'),
    },
    requirements: [],
    freshness: { checked: true, source },
  });
  const child = await store.activateChildRun({
    ...write,
    executionId: operation.executionId!,
    configuration,
    requirementEvaluations: [],
    freshness: { checked: true, source },
  });
  await plan('child-tool', child.session.id, child.run.id, child.command.id);
  const request = async (
    id: string,
    executionId: string,
    kind: 'approval' | 'question' = 'approval',
  ) =>
    store.requestInteraction({
      ...write,
      interactionId: id,
      executionId,
      attempt: 1,
      kind,
      definitionId: 'fixture.tool',
      definitionVersion: '1',
      inputDigest,
      policyRevision: 'policy-1',
      requiredRefs: [],
      source,
      request: {
        title: 'exact review',
        input,
        ...(kind === 'question'
          ? {
              schema: {
                type: 'object',
                required: ['reply'],
                properties: { reply: { type: 'string' } },
                additionalProperties: false,
              },
            }
          : {}),
      },
    });
  await request('child-card', 'child-tool');
  await plan('root-tool');
  await request('root-card', 'root-tool');
  const model = createFixedModel([]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixture',
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
  const service = await startService({
    runtime,
    profile,
    buildId: 'interactions-fixture',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['interactions'] },
    bootstrap: service.bootstrap,
  });
  await client.connect();
  return {
    store,
    runtime,
    service,
    client,
    model,
    expectedStoreId,
    operation,
    child,
    request,
    plan,
    write,
    source,
    inputDigest,
    async close() {
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('paired HTTP projects one child Interaction and answers only the root binding with durable identity/revision receipts', async () => {
  const f = await fixture();
  try {
    const root = await f.client.listInteractions('root', { storeId: f.expectedStoreId, limit: 1 });
    expect(root.interactions).toHaveLength(1);
    expect(root.nextAfterId).toBe('child-card');
    const next = await f.client.listInteractions('root', {
      storeId: f.expectedStoreId,
      afterId: root.nextAfterId!,
      limit: 1,
    });
    expect(next.interactions[0]?.id).toBe('root-card');
    const child = await f.client.getInteraction(f.child.session.id, 'child-card', {
      storeId: f.expectedStoreId,
    });
    expect(child).toEqual(
      await f.client.getInteraction('root', 'child-card', { storeId: f.expectedStoreId }),
    );
    expect(child.presentationSessionId).toBe('root');
    expect(child.sessionId).toBe(f.child.session.id);
    expect(child.ancestry).toContain('root');
    expect(child.executionId).toBe('child-tool');
    expect(child.definitionId).toBe('fixture.tool');
    expect(child.inputDigest).toHaveLength(64);
    const observed = (await f.client.getExecution('child-tool')).authorization;
    expect(observed).toMatchObject({
      dispatched: false,
      human: { interactionId: child.id, state: 'pending', accepted: false, decision: null },
    });
    expect(JSON.stringify(observed)).not.toContain('privateSource');
    expect(JSON.stringify(observed)).not.toContain('subjectId');
    expect(child.policyRevision).toBe('policy-1');
    expect(Object.keys(child)).not.toContain('subjectId');
    expect(Object.keys(child)).not.toContain('source');
    expect(Object.keys(child)).not.toContain('ownerGeneration');
    const additive = { ...child, futureBinding: { detail: 'kept' } };
    expect(decodeResponse('Interaction', additive)).toEqual(additive);
    expect(
      decodeResponse('Interaction', { ...child, definitionId: 'agent/child' }).definitionId,
    ).toBe('agent/child');
    const intent = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'answer-child',
      expectedRevision: '1',
      answer: { kind: 'approval' as const, decision: 'approve' as const },
    };
    await code(
      f.client.answerInteraction(f.child.session.id, child.id, intent),
      'interaction_scope_denied',
    );
    await code(
      f.client.answerInteraction('root', child.id, { ...intent, expectedStoreId: 'wrong-store' }),
      'store_identity_mismatch',
    );
    await code(
      f.client.answerInteraction('root', child.id, { ...intent, expectedRevision: '0' }),
      'interaction_revision_conflict',
    );
    const receipt = await f.client.answerInteraction('root', child.id, intent);
    expect(receipt.id).toBe(intent.commandId);
    expect(receipt.receipt).toMatchObject({ outcome: 'answer_saved' });
    expect(await f.client.answerInteraction('root', child.id, intent)).toEqual(receipt);
    await code(
      f.client.answerInteraction('root', child.id, {
        ...intent,
        answer: { kind: 'approval', decision: 'deny' },
      }),
      'command_conflict',
    );
    await code(
      f.client.answerInteraction('root', child.id, {
        ...intent,
        commandId: 'different-answer',
        answer: { kind: 'approval', decision: 'deny' },
      }),
      'interaction_answer_conflict',
    );
    const answered = await f.client.getInteraction('root', child.id, {
      storeId: f.expectedStoreId,
    });
    expect(answered.state).toBe('answered');
    expect(answered.revision).toBe('2');
    expect(answered.acceptedDecisionRevision).toBeNull();
    expect((await f.store.getExecution('child-tool'))?.status).toBe('planned');
    expect(f.model.requests).toHaveLength(0);
    const response = await fetch(
      `${f.service.endpoint}/v1/sessions/root/interactions/child-card/answer`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.service.bootstrap.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...intent, subjectId: 'intruder', acceptedDecisionRevision: '2' }),
      },
    );
    expect(response.status).toBe(400);
    const forbidden = await fetch(
      `${f.service.endpoint}/v1/sessions/root/interactions/child-card/accept`,
      { method: 'POST', headers: { authorization: `Bearer ${f.service.bootstrap.token}` } },
    );
    expect(forbidden.status).toBe(404);
    await code(
      f.client.listInteractions('root', { storeId: 'wrong-store' }),
      'store_identity_mismatch',
    );
    await code(
      Promise.resolve().then(() =>
        f.client.listInteractions('root', { storeId: f.expectedStoreId, limit: 101 }),
      ),
      'invalid_request',
    );
    expect(f.model.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 10000);
test('paired cancellation precedes a late answer; question schema is enforced and no answer receipt dispatches execution', async () => {
  const f = await fixture();
  try {
    await f.client.cancelExecution(f.child.session.id, {
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-child',
      kind: 'execution.cancel',
      executionId: 'child-tool',
    });
    const late = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'late-answer',
      expectedRevision: '1',
      answer: { kind: 'approval' as const, decision: 'approve' as const },
    };
    const receipt = await f.client.answerInteraction('root', 'child-card', late);
    expect(receipt.receipt).toMatchObject({ outcome: 'answer_saved' });
    const card = await f.client.getInteraction('root', 'child-card', {
      storeId: f.expectedStoreId,
    });
    expect(card.state).toBe('cancelled');
    expect(card.answer).toEqual(late.answer);
    expect(card.acceptedDecisionRevision).toBeNull();
    expect((await f.client.getExecution('child-tool')).authorization).toMatchObject({
      dispatched: false,
      human: {
        interactionId: 'child-card',
        state: 'cancelled',
        decision: 'approve',
        accepted: false,
      },
    });
    expect(await f.client.answerInteraction('root', 'child-card', late)).toEqual(receipt);
    expect((await f.store.getExecution('child-tool'))?.cancelRequestedAt).not.toBeNull();
    expect((await f.store.getExecution('child-tool'))?.status).toBe('planned');
    await f.plan('question-tool');
    // Informational requests originate inside a dispatched Tool, unlike pre-dispatch approval.
    await f.store.markDispatching({
      ...f.write,
      executionId: 'question-tool',
      authorization: {
        allowed: true,
        revision: 'policy-1',
        definitionVersion: '1',
        inputDigest: f.inputDigest,
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const beforeAnswer = await f.store.getExecution('question-tool');
    expect(beforeAnswer?.status).toBe('dispatching');
    await f.request('question-card', 'question-tool', 'question');
    await code(
      f.client.answerInteraction('root', 'question-card', {
        ...late,
        commandId: 'bad-question',
        answer: { kind: 'question', answers: { reply: 4 } },
      }),
      'interaction_answer_invalid',
    );
    const answer = await f.client.answerInteraction('root', 'question-card', {
      ...late,
      commandId: 'answer-question',
      answer: { kind: 'question', answers: { reply: 'exact response' } },
    });
    expect(answer.receipt).toMatchObject({ outcome: 'answer_saved' });
    const answeredCard = await f.client.getInteraction('root', 'question-card', {
      storeId: f.expectedStoreId,
    });
    expect(answeredCard.state).toBe('answered');
    expect(answeredCard.acceptedDecisionRevision).toBeNull();
    expect(answeredCard.answer).toEqual({ kind: 'question', answers: { reply: 'exact response' } });
    expect(await f.store.getExecution('question-tool')).toEqual(beforeAnswer);
    expect(f.model.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 10000);

test('actual Core approval and Tool question wait for HTTP answers before the ordinary Loop completes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-client-core-interaction-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let effects = 0;
  let answered: unknown;
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'call',
        name: 'fixture.question',
        arguments: '{"value":"exact input"}',
      },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize(request) {
        return request.kind === 'tool'
          ? {
              allowed: false,
              revision: 'policy-1',
              approval: { request: { title: 'approve original parameters', input: request.input } },
            }
          : { allowed: true, revision: 'policy-1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.question',
            version: '1',
            description: 'Explicit local question',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              effects++;
              answered = await context.requestInput({
                title: 'exact question',
                schema: {
                  type: 'object',
                  required: ['reply'],
                  properties: { reply: { type: 'string' } },
                  additionalProperties: false,
                },
              });
              return { outcome: 'succeeded', content: 'question answered' };
            },
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'actual-core-interaction',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['interactions', 'commands'] },
    bootstrap: service.bootstrap,
  });
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: `file://${root}`,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'actual Core',
    });
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'run',
      kind: 'run.start',
      content: 'explicit question fixture',
    });
    const pending = async (kind: 'approval' | 'question') => {
      const deadline = Date.now() + 5000;
      while (true) {
        const page = await client.listInteractions('s', {
          storeId: expectedStoreId,
          state: 'pending',
        });
        const card = page.interactions.find((item) => item.kind === kind);
        if (card) return card;
        if (Date.now() > deadline)
          throw new Error(`No pending ${kind}; ${JSON.stringify(await client.getView('s'))}`);
        await Bun.sleep(10);
      }
    };
    const approval = await pending('approval');
    expect(effects).toBe(0);
    expect((await client.getView('s')).runs[0]?.status).toBe('waiting_interaction');
    expect(approval.request).toMatchObject({ input: { value: 'exact input' } });
    await client.answerInteraction('s', approval.id, {
      expectedStoreId,
      commandId: 'approve',
      expectedRevision: approval.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    const question = await pending('question');
    expect(effects).toBe(1);
    expect(answered).toBeUndefined();
    expect(question.executionId).toBe(approval.executionId);
    await client.answerInteraction('s', question.id, {
      expectedStoreId,
      commandId: 'reply',
      expectedRevision: question.revision,
      answer: { kind: 'question', answers: { reply: 'chosen response' } },
    });
    await runtime.waitForCommand('run', { timeoutMs: 5000 });
    expect(answered).toEqual({ reply: 'chosen response' });
    expect(effects).toBe(1);
    expect(model.requests).toHaveLength(2);
    expect((await client.getView('s')).runs[0]?.status).toBe('completed');
    expect((await client.getExecution(approval.executionId)).status).toBe('succeeded');
    expect(
      (await client.getInteraction('s', approval.id, { storeId: expectedStoreId }))
        .acceptedDecisionRevision,
    ).toBe('2');
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
