import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createProfileBackup, restoreProfileBackup } from '@kite-ai/agent/maintenance';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { NativeInteractionHistoryReads } from '../../../apps/desktop/electron/interaction-history-reads';
import { startService } from '../../../apps/service/src';
import { createClient, interactionAttachment } from '../../../packages/client/src';
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
async function fixture(options: { artifacts?: boolean; sealed?: boolean } = {}) {
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
  if (options.sealed)
    await store.forkSession({
      expectedStoreId,
      subjectId: 'owner',
      sourceSessionId: 'root',
      expectedContextSelectionId: (await store.getView('root')).session.contextSelectionId,
      newSessionId: 'sealed',
      commandId: 'seal',
      title: 'sealed before later interactions',
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
  const artifacts = options.artifacts
    ? createArtifactStore({ profile: selected, store })
    : undefined;
  const runtime = createRuntime({
    store,
    artifacts,
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
    root,
    selected,
    profile,
    artifacts,
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
test('restored public history preserves questions, plans, child approvals, cancellation and complete attachments without restoring answer authority', async () => {
  const f = await fixture({ artifacts: true, sealed: true });
  try {
    const answers = { reply: '  原问题回答\r\n雪🙂é  ' };
    const feedback = '  原计划修改反馈\r\n雪🙂é  ';
    for (const [id, kind] of [
      ['question', 'question'],
      ['plan', 'plan_review'],
    ] as const) {
      await f.plan(`${id}-tool`);
      await f.store.markDispatching({
        ...f.write,
        executionId: `${id}-tool`,
        authorization: {
          allowed: true,
          revision: 'policy-1',
          definitionVersion: '1',
          inputDigest: f.inputDigest,
        },
        requirements: [],
        freshness: { checked: true, source: f.source },
      });
      await f.store.requestInteraction({
        ...f.write,
        interactionId: `${id}-card`,
        executionId: `${id}-tool`,
        attempt: 1,
        kind,
        definitionId: 'fixture.tool',
        definitionVersion: '1',
        inputDigest: f.inputDigest,
        policyRevision: 'policy-1',
        requiredRefs: [],
        source: f.source,
        request:
          kind === 'question'
            ? {
                title: '原问题',
                schema: {
                  type: 'object',
                  properties: { reply: { type: 'string' } },
                  required: ['reply'],
                  additionalProperties: false,
                },
              }
            : {
                planId: 'original-plan',
                version: '1',
                digest: 'original-digest',
                content: '原完整计划',
                allowedModes: ['auto'],
              },
      });
      await f.client.answerInteraction('root', `${id}-card`, {
        expectedStoreId: f.expectedStoreId,
        commandId: `answer-${id}`,
        expectedRevision: '1',
        answer: kind === 'question' ? { kind, answers } : { kind, decision: 'revise', feedback },
      });
    }
    for (const [id, executionId] of [
      ['plan-card', 'plan-tool'],
      ['child-card', 'child-tool'],
    ]) {
      if (id === 'child-card')
        await f.client.answerInteraction('root', id, {
          expectedStoreId: f.expectedStoreId,
          commandId: 'answer-child',
          expectedRevision: '1',
          answer: { kind: 'approval', decision: 'approve' },
        });
      await f.store.acceptInteractionDecision({
        ...f.write,
        interactionId: id!,
        executionId: executionId!,
        attempt: 1,
        decisionRevision: '2',
        definitionId: 'fixture.tool',
        definitionVersion: '1',
        inputDigest: f.inputDigest,
        policyRevision: 'policy-1',
        requirements: [],
        freshness: { checked: true, source: f.source },
      });
    }
    await f.plan('large-tool');
    const text = JSON.stringify({ originalInput: '完整审批末尾雪🙂\r\n'.repeat(6000) });
    const reference = await f.artifacts!.publish({
      expectedStoreId: f.expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      refId: 'original-review',
      scope: { kind: 'execution', id: 'large-tool' },
      mediaType: 'application/json',
      content: new TextEncoder().encode(text),
    });
    await f.store.requestInteraction({
      ...f.write,
      interactionId: 'large-card',
      executionId: 'large-tool',
      attempt: 1,
      kind: 'approval',
      definitionId: 'fixture.tool',
      definitionVersion: '1',
      inputDigest: f.inputDigest,
      policyRevision: 'policy-1',
      requiredRefs: [],
      source: f.source,
      request: {
        policy: {
          review: {
            kind: 'artifact',
            complete: true,
            reference: { ...reference, scope: { ...reference.scope } },
          },
        },
      },
    });
    await f.client.cancelExecution('root', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-large',
      kind: 'execution.cancel',
      executionId: 'large-tool',
    });
    await f.client.answerInteraction('root', 'large-card', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'late-denial',
      expectedRevision: '1',
      answer: { kind: 'approval', decision: 'deny' },
    });
    const published = (await f.client.listInteractions('root', { storeId: f.expectedStoreId }))
      .interactions;
    f.client.disposeNetwork();
    await f.service.close();
    const beforeRestore = await openSqliteStore({ ...f.selected, mode: 'readonly' });
    let original: Awaited<ReturnType<typeof f.client.listInteractions>>['interactions'];
    try {
      original = (
        await beforeRestore.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 'root',
        })
      ).interactions;
      expect(original).toHaveLength(5);
      expect(original.find((card) => card.id === 'question-card')!.answer).toEqual({
        kind: 'question',
        answers,
      });
      expect(
        original.find((card) => card.id === 'question-card')!.acceptedDecisionRevision,
      ).toBeNull();
      expect(original.find((card) => card.id === 'plan-card')!.answer).toEqual({
        kind: 'plan_review',
        decision: 'revise',
        feedback,
      });
      expect(original.find((card) => card.id === 'plan-card')!.acceptedDecisionRevision).toBe('2');
      expect(original.find((card) => card.id === 'large-card')!.state).toBe('cancelled');
      expect(original.find((card) => card.id === 'root-card')!.state).toBe('pending');
    } finally {
      await beforeRestore.close();
    }
    const backup = await createProfileBackup({
      profile: f.selected,
      destinationRoot: join(f.root, 'backup'),
    });
    const restored = await restoreProfileBackup({
      profile: f.selected,
      expectedStoreId: f.expectedStoreId,
      backup,
      intent: 'replace_with_selected_backup',
    });
    expect(restored.storeId).not.toBe(f.expectedStoreId);
    // Maintenance cancels old pending work; it preserves the original request and saved decision.
    const expectedHistory = published.map((card) =>
      card.state === 'pending' ? { ...card, state: 'cancelled' as const } : card,
    );
    for (const cold of [false, true]) {
      const store = await openSqliteStore({
        ...f.selected,
        ...(cold ? { mode: 'readonly' as const } : {}),
      });
      const model = createFixedModel([]);
      const runtime = createRuntime({
        store,
        artifacts: createArtifactStore({
          profile: f.selected,
          store,
          ...(cold ? { mode: 'readonly' as const } : {}),
        }),
        model,
        permissions: {
          async authorize() {
            throw Error('history must not request permission');
          },
        },
      });
      const service = await startService({
        runtime,
        profile: f.profile,
        buildId: 'restored-interaction-history',
        subjectId: 'owner',
      });
      const client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        bootstrap: service.bootstrap,
        expected: { profile: f.profile, apiMajor: 1, requiredCapabilities: ['interactions'] },
      });
      const scope = {
        generation: 1,
        viewSelection: 1,
        historyEpoch: 0,
        storeId: restored.storeId,
        sessionId: 'root',
        workspaceId: 'w',
      };
      const history = new NativeInteractionHistoryReads(client, () => scope);
      try {
        await client.connect();
        const before = (await store.getMetadata()).lastChangeCursor;
        expect(
          (await client.listInteractions('root', { storeId: restored.storeId })).interactions,
        ).toEqual([]);
        expect(
          (await client.listInteractions('root', { storeId: restored.storeId, state: 'pending' }))
            .interactions,
        ).toEqual([]);
        await code(
          client.getInteraction('root', 'question-card', { storeId: restored.storeId }),
          'interaction_not_found',
        );
        const rows: typeof original = [];
        let afterId: string | undefined;
        let cursor: string | undefined;
        do {
          const page = await client.listInteractions('root', {
            storeId: restored.storeId,
            origin: 'all',
            limit: 2,
            ...(afterId ? { afterId } : {}),
          });
          expect(page.snapshotCursor).toBe(cursor ?? page.snapshotCursor);
          cursor = page.snapshotCursor;
          rows.push(...page.interactions);
          afterId = page.nextAfterId ?? undefined;
        } while (afterId);
        expect(rows).toEqual(expectedHistory);
        expect(rows.every((card) => !('subjectId' in card) && !('source' in card))).toBe(true);
        expect(
          await client.getInteraction(f.child.session.id, 'child-card', {
            storeId: restored.storeId,
            origin: 'all',
          }),
        ).toEqual(expectedHistory.find((card) => card.id === 'child-card')!);
        expect(
          (await client.listInteractions('sealed', { storeId: restored.storeId, origin: 'all' }))
            .interactions,
        ).toEqual([]);
        await code(
          client.getInteraction('sealed', 'question-card', {
            storeId: restored.storeId,
            origin: 'all',
          }),
          'interaction_not_found',
        );
        await code(
          client.listInteractions('root', { storeId: f.expectedStoreId, origin: 'all' }),
          'store_identity_mismatch',
        );
        const page = await history.open({
          readId: 'restored-history',
          viewSelection: 1,
          historyEpoch: 0,
        });
        expect(page.page.interactions).toEqual(expectedHistory);
        const card = rows.find((value) => value.id === 'large-card')!;
        const attachment = interactionAttachment(card)!;
        const opened = await history.attachments.open({
          readId: 'original-body',
          key: attachment.key,
        });
        expect(opened.reference.hash).toBe(createHash('sha256').update(text).digest('hex'));
        const chunks: Buffer[] = [];
        let offset = 0;
        for (;;) {
          const chunk = history.attachments.read({ readId: 'original-body', offset, limit: 65536 });
          chunks.push(Buffer.from(chunk.data, 'base64'));
          offset = chunk.nextOffset;
          if (chunk.eof) break;
        }
        expect(Buffer.concat(chunks).toString()).toBe(text);
        expect((await client.readInteractionAttachment(card)).reference.storeId).toBe(
          f.expectedStoreId,
        );
        await code(
          client.readInteractionAttachment({ ...card, originStoreId: 'wrong-origin' }),
          'artifact_metadata_mismatch',
        );
        if (!cold)
          await code(
            client.answerInteraction('root', 'root-card', {
              expectedStoreId: restored.storeId,
              commandId: 'must-not-answer-restored',
              expectedRevision: '1',
              answer: { kind: 'approval', decision: 'approve' },
            }),
            'interaction_not_found',
          );
        expect((await store.getMetadata()).lastChangeCursor).toBe(before);
        expect(model.requests).toHaveLength(0);
        expect(f.model.requests).toHaveLength(0);
      } finally {
        history.release();
        client.disposeNetwork();
        await service.close();
      }
    }
  } finally {
    await f.close();
  }
}, 15000);

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
    const history = new NativeInteractionHistoryReads(f.client, () => ({
      generation: 1,
      viewSelection: 1,
      historyEpoch: 0,
      storeId: f.expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
    }));
    try {
      const page = await history.open({
        readId: 'root-history',
        viewSelection: 1,
        historyEpoch: 0,
      });
      const source = page.page.interactions.find((card) => card.id === child.id)!;
      expect(source.sessionId).toBe(f.child.session.id);
      expect(source.ancestry[0]).toBe(f.child.session.id);
      expect(source.ancestry.at(-1)).toBe('root');
      expect(source.answer).toEqual(intent.answer);
      expect(source.acceptedDecisionRevision).toBeNull();
      expect(f.model.requests).toHaveLength(0);
    } finally {
      history.close('root-history');
    }
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
    const beforeHistory = (await client.getView('s')).snapshotCursor;
    const history = new NativeInteractionHistoryReads(client, () => ({
      generation: 1,
      viewSelection: 1,
      historyEpoch: 0,
      storeId: expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
    }));
    try {
      const original = await history.open({
        readId: 'original-history',
        viewSelection: 1,
        historyEpoch: 0,
      });
      expect(original.page.nextAfterId).toBeNull();
      expect(original.page.interactions).toHaveLength(2);
      const saved = original.page.interactions.find((card) => card.id === question.id)!;
      expect(saved.definitionId).toBe('fixture.question');
      expect(saved.request).toEqual(question.request);
      expect(saved.answer).toEqual({ kind: 'question', answers: { reply: 'chosen response' } });
      expect(saved.acceptedDecisionRevision).toBe(saved.revision);
      expect((await client.getView('s')).snapshotCursor).toBe(beforeHistory);
      expect(model.requests).toHaveLength(2);
      expect(effects).toBe(1);
    } finally {
      history.close('original-history');
    }
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
