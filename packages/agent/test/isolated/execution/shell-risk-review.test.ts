import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent, type ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension } from '../../../src/extensions';
import { createPermissionPolicy } from '../../../src/permissions';
import { openSqliteStore } from '../../../src/sqlite';
import { fixtureReviewBinding, fixtureRiskBehavior } from '../../fixtures/review-behavior';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function fixture(
  options: {
    risk?: 'ordinary' | 'high' | 'critical';
    invalid?: boolean;
    changed?: boolean;
    reusable?: boolean;
    hangPreparation?: boolean;
    preparationFails?: boolean;
    delayedEnsure?: boolean;
    reviewBudgetMs?: number;
    calls?: number;
    mode?: 'auto' | 'accept_edits' | 'full';
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-risk-loop-')));
  const profile = { dataRoot: root, profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  if (options.delayedEnsure) {
    const ensure = store.ensureAuthorizationCheck.bind(store);
    store.ensureAuthorizationCheck = async (input) => {
      await sleepTimer(80);
      return ensure(input);
    };
  }
  let effects = 0,
    contexts = 0,
    preparations = 0,
    revision = 0;
  const requests: ModelRequest[] = [];
  const reviewedExecutions: boolean[] = [];
  let releasePreparation!: () => void;
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const model = createFixedModel([
    ...Array.from({ length: options.calls ?? 2 }, (_, i): ModelEvent[] => [
      {
        type: 'tool_call',
        id: `call-${i}`,
        name: 'fixture.effect',
        arguments: '{"command":"bounded fixture"}',
      },
      { ...finish, reason: 'tool_calls' },
    ]),
    [{ type: 'text_delta', text: 'Continued using the actual result.' }, finish],
  ]);
  const policy = createPermissionPolicy({
    readPolicy: () => ({
      mode: options.mode ?? 'auto',
      workspaceTrust: true,
      revision: 'current',
      allowed: [
        { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
        { kind: 'tool', definitionId: 'fixture.effect', definitionVersion: '1' },
      ],
    }),
    describeCapability: (request) => ({
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      revision: 'registered',
      hardAllowed: true,
      safeRead: false,
      effects: ['unknown'],
      ...(request.kind === 'tool'
        ? { autoReview: 'check' as const, reviewBehavior: fixtureReviewBinding(behaviors, request) }
        : {}),
    }),
    readCheckContext: () => {
      contexts++;
      return {
        reviewInput: 'task_authorization',
        task: 'PRIVATE-TASK',
        plan: 'PRIVATE-PLAN',
        rejectionReasons: [],
      };
    },
  });
  const prepareRiskReview = async () => {
    preparations++;
    if (options.hangPreparation) await preparationGate;
    if (options.preparationFails) throw new Error('private preparation body');
    return {
      material: { command: 'bounded fixture', cwd: root, revision },
      fingerprint: createHash('sha256').update(String(revision)).digest('hex'),
      reusable: options.reusable ?? true,
    };
  };
  const extensions: Extension[] = [
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.effect',
          version: '1',
          description: 'Governed fixture',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            effects++;
            reviewedExecutions.push(context.dispatchAuthorization?.materialReviewed === true);
            if (options.changed) revision++;
            return { outcome: 'succeeded', content: 'Effect confirmed.' };
          },
        },
      ],
    },
  ];
  const behaviors = [fixtureRiskBehavior(extensions[0]!.tools![0]!, 'tool', prepareRiskReview)];
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    permissions: policy,
    authorizationCheck: {
      id: 'risk',
      version: 'fixture-risk',
      modelId: 'reviewer',
      timeoutMs:
        options.reviewBudgetMs ?? (options.hangPreparation || options.delayedEnsure ? 30 : 5000),
      model: {
        async *stream(input) {
          requests.push(structuredClone(input));
          const user = input.messages.find((message) => message.role === 'user')!.content;
          const payload = JSON.parse(user);
          expect(payload.purpose).toBe('shell_risk');
          expect(payload.operation).toMatchObject({ kind: 'tool', definitionId: 'fixture.effect' });
          expect(payload.material.command).toBe('bounded fixture');
          expect(user).not.toContain('PRIVATE-TASK');
          expect(user).not.toContain('PRIVATE-PLAN');
          expect(user).not.toContain('BUSINESS-SECRET');
          expect(payload.authorizationContext).toBeUndefined();
          expect(payload.decisionContext).toBeUndefined();
          yield {
            type: 'text_delta',
            text: JSON.stringify(
              options.invalid
                ? { decision: 'approve_once', reason: 'Wrong output contract.' }
                : { risk: options.risk ?? 'ordinary', reason: 'Exact bounded fixture effect.' },
            ),
          };
          yield finish;
        },
      },
    },
    extensions,
    toolBehaviors: behaviors,
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'fixture',
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Risk',
  });
  return {
    runtime,
    store,
    model,
    requests,
    expectedStoreId,
    reviewedExecutions,
    counts: () => ({ effects, contexts, preparations, reviews: requests.length }),
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'BUSINESS-SECRET' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
      return (await store.getView('s')).runs[0]!;
    },
    async close() {
      releasePreparation();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('risk-only Loop seals original risk, derives approval, and omits business materials', async () => {
  const f = await fixture();
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toMatchObject({ effects: 2, contexts: 0, reviews: 1 });
    expect(f.reviewedExecutions).toEqual([true, true]);
    const check = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'reviewer')!;
    expect(check.result).toMatchObject({
      content: '{"risk":"ordinary","reason":"Exact bounded fixture effect."}',
      authorizationCheckOutput: {
        version: 1,
        answer: { decision: 'approve_once' },
        evidence: { risk: 'ordinary' },
      },
    });
    expect(f.model.requests.at(-1)!.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('changed reviewed content and incomplete dependencies prevent cross-call approval reuse', async () => {
  for (const options of [{ changed: true }, { reusable: false }]) {
    const f = await fixture(options);
    try {
      expect((await f.run()).status).toBe('completed');
      expect(f.counts()).toMatchObject({ effects: 2, contexts: 0, reviews: 2 });
    } finally {
      await f.close();
    }
  }
});

test('critical classification is a readable refusal and the business Loop continues', async () => {
  const f = await fixture({ risk: 'critical', calls: 1 });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toMatchObject({ effects: 0, reviews: 1 });
    const result = f.model.requests.at(-1)!.messages.find((m) => m.role === 'tool')!;
    expect(result.content).toContain('Exact bounded fixture effect.');
  } finally {
    await f.close();
  }
});

test('new risk contract rejects decision-shaped output as a technical failure with no effects', async () => {
  const f = await fixture({ invalid: true, calls: 1 });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toMatchObject({ effects: 0, reviews: 1 });
    expect(f.model.requests.at(-1)!.messages.find((m) => m.role === 'tool')!.content).toContain(
      'approval model returned an invalid decision',
    );
    expect(
      (
        await f.runtime.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('hung fact preparation times out without a model call or waiting for the read to finish', async () => {
  const f = await fixture({ hangPreparation: true, calls: 1 });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toMatchObject({ effects: 1, reviews: 0, contexts: 0 });
    const check = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'reviewer')!;
    expect(check.result).toMatchObject({ code: 'authorization_check_timeout' });
    expect(f.reviewedExecutions).toEqual([false]);
  } finally {
    await f.close();
  }
});

for (const mode of ['auto', 'accept_edits'] as const)
  test(`${mode} human approval retains its original exact call and does not add a second review`, async () => {
    const f = await fixture({ risk: 'high', mode, calls: 1 });
    try {
      const work = f.run();
      void work.catch(() => {});
      let card:
        | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
        | undefined;
      const deadline = Date.now() + 5000;
      while (!card && Date.now() < deadline) {
        card = (
          await f.runtime.listInteractions({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            state: 'pending',
          })
        ).interactions[0];
        if (!card) await sleepTimer(10);
      }
      expect(card).toBeDefined();
      expect(f.counts().effects).toBe(0);
      await f.runtime.answerInteraction({
        expectedStoreId: f.expectedStoreId,
        commandId: 'answer',
        presentationSessionId: card!.presentationSessionId,
        interactionId: card!.id,
        expectedRevision: card!.revision,
        subjectId: 'owner',
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
      expect((await work).status).toBe('completed');
      expect(f.counts()).toMatchObject({ effects: 1, reviews: mode === 'auto' ? 1 : 0 });
      expect(f.reviewedExecutions).toEqual([mode === 'auto']);
    } finally {
      await f.close();
    }
  });

test('preparation failures remain readable technical failures rather than approval or refusal', async () => {
  const f = await fixture({ preparationFails: true, calls: 1 });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toMatchObject({ effects: 0, reviews: 0 });
    const text = f.model.requests.at(-1)!.messages.find((m) => m.role === 'tool')!.content;
    expect(text).toContain('preparing the trusted review materials failed');
    expect(text).not.toContain('private preparation body');
  } finally {
    await f.close();
  }
});

test('a preparation failure does not become timeout approval while its check is being persisted', async () => {
  const f = await fixture({ preparationFails: true, delayedEnsure: true, calls: 1 });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toMatchObject({ effects: 0, reviews: 0 });
    const check = (await f.store.listExecutions('s')).find((e) => e.definitionId === 'reviewer')!;
    expect(check.result).toMatchObject({ code: 'authorization_check_preparation_failed' });
    expect(f.model.requests.at(-1)!.messages.find((m) => m.role === 'tool')!.content).toContain(
      'preparing the trusted review materials failed',
    );
  } finally {
    await f.close();
  }
});

test('user cancellation during fact preparation never becomes timeout continuation', async () => {
  const f = await fixture({ hangPreparation: true, reviewBudgetMs: 5000, calls: 1 });
  try {
    const work = f.run();
    void work.catch(() => {});
    const deadline = Date.now() + 3000;
    while (!f.counts().preparations && Date.now() < deadline) await sleepTimer(5);
    expect(f.counts().preparations).toBe(1);
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      subjectId: 'owner',
      targetCommandId: 'work',
    });
    expect((await work).status).toBe('cancelled');
    expect(f.counts()).toMatchObject({ effects: 0, reviews: 0 });
  } finally {
    await f.close();
  }
});

test('Full bypasses the semantic reviewer and fact preparation under the original policy', async () => {
  const f = await fixture({ mode: 'full', calls: 1 });
  try {
    expect((await f.run()).status).toBe('completed');
    expect(f.counts()).toEqual({ effects: 1, contexts: 0, preparations: 0, reviews: 0 });
  } finally {
    await f.close();
  }
});
