import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient, type Interaction, type Json } from '@kite-ai/client';
import { createDesktopController } from '@kite-ai/desktop';
import { startService } from '@kite-ai/service';
import { run } from '../src';

const plan = {
  planId: 'plan-original',
  version: 'v2',
  digest: 'original-plan-digest',
  content: 'Exact plan body\n1. inspect\n2. proposed edit',
  allowedModes: ['auto', 'accept_edits'],
};
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-plan-review-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const storeId = (await store.getMetadata()).storeId;
  const ledger = join(root, 'ledger');
  const responses: Json[] = [];
  const finish = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  } as const;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'plan-call', name: 'fixture.plan', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [
      { type: 'tool_call', id: 'extra-call', name: 'fixture.extra', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
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
              approval: { request: { title: 'Exact tool requires approval' } },
            }
          : { allowed: true, revision: 'policy-1' };
      },
    },
    extensions: [
      {
        id: 'fixture.plan',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.plan',
            version: '1',
            description: 'Request information without granting permissions',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              appendFileSync(ledger, 'plan-tool\n');
              for (let n = 0; n < 4; n++)
                responses.push(
                  await context.requestInteraction({
                    kind: 'plan_review',
                    request: { ...plan, reviewOrdinal: n },
                  }),
                );
              return { outcome: 'succeeded', content: 'review information recorded' };
            },
          },
          {
            id: 'fixture.extra',
            version: '1',
            description: 'Extra tool still needs distinct permission',
            inputSchema: { type: 'object' },
            async execute() {
              appendFileSync(ledger, 'extra-tool\n');
              return { outcome: 'succeeded', content: 'effect' };
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
    buildId: 'plan-review',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['interactions', 'commands'] },
    bootstrap: service.bootstrap,
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  await client.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'plan',
  });
  const pending = async (kind: Interaction['kind']) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const card = (
        await client.listInteractions('s', { storeId, state: 'pending' })
      ).interactions.find((value) => value.kind === kind);
      if (card) return card;
      await Bun.sleep(5);
    }
    throw new Error('missing plan interaction');
  };
  return {
    root,
    ledger,
    storeId,
    client,
    runtime,
    model,
    responses,
    pending,
    async close() {
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('real Core plan reviews return two explicit modes/deny/revise information without reauthorizing another Tool', async () => {
  const f = await fixture();
  try {
    const cards: Interaction[] = [];
    const lines: string[] = [];
    let review = 0;
    let approvals = 0;
    const result = await run(
      's',
      {
        expectedStoreId: f.storeId,
        commandId: 'work',
        kind: 'run.start',
        content: 'review exact plan',
      },
      {
        client: f.client,
        write: (line) => lines.push(line),
        pollIntervalMs: 5,
        answerInteraction: async (card) => {
          cards.push(structuredClone(card));
          if (card.kind === 'approval') {
            approvals++;
            if (approvals === 2) expect(readFileSync(f.ledger, 'utf8')).toBe('plan-tool\n');
            return { kind: 'approval', decision: 'approve' };
          }
          expect(card.kind).toBe('plan_review');
          expect(card.definitionId).toBe('fixture.plan');
          expect(card.attempt).toBe(1);
          expect(card.request).toMatchObject(plan);
          const answers = [
            { kind: 'plan_review', decision: 'approve', mode: 'auto', feedback: 'reviewed auto' },
            {
              kind: 'plan_review',
              decision: 'approve',
              mode: 'accept_edits',
              feedback: 'reviewed edits',
            },
            { kind: 'plan_review', decision: 'deny', feedback: 'do not use plan' },
            { kind: 'plan_review', decision: 'revise', feedback: 'change step two' },
          ] as const;
          return answers[review++]!;
        },
      },
    );
    expect(result.status).toBe('succeeded');
    expect(review).toBe(4);
    expect(approvals).toBe(2);
    expect(f.responses).toHaveLength(4);
    expect(f.responses).toEqual([
      { kind: 'plan_review', decision: 'approve', mode: 'auto', feedback: 'reviewed auto' },
      {
        kind: 'plan_review',
        decision: 'approve',
        mode: 'accept_edits',
        feedback: 'reviewed edits',
      },
      { kind: 'plan_review', decision: 'deny', feedback: 'do not use plan' },
      { kind: 'plan_review', decision: 'revise', feedback: 'change step two' },
    ]);
    expect(
      new Set(cards.filter((card) => card.kind === 'plan_review').map((card) => card.executionId))
        .size,
    ).toBe(1);
    expect(
      cards
        .filter((card) => card.kind === 'plan_review')
        .every((card) => card.executionId === cards[0]?.executionId),
    ).toBe(true);
    const saved = await f.client.listInteractions('s', { storeId: f.storeId });
    expect(saved.interactions).toHaveLength(6);
    expect(
      saved.interactions.every(
        (card) => card.state === 'answered' && card.acceptedDecisionRevision !== null,
      ),
    ).toBe(true);
    expect(lines.filter((line) => line.includes('tool permissions unchanged'))).toHaveLength(4);
    expect(readFileSync(f.ledger, 'utf8')).toBe('plan-tool\nextra-tool\n');
    expect(f.model.requests).toHaveLength(3);
    const originalExecution = await f.runtime.getExecution(cards[0]!.executionId);
    expect(originalExecution?.interactionBinding?.interactionId).toBe(cards[0]!.id);
    expect(originalExecution?.interactionBinding?.decisionRevision).not.toBeNull();
  } finally {
    await f.close();
  }
}, 15000);

test('Desktop plan answer duplicate binds original executed Tool; late answer after exact cancellation cannot revive work', async () => {
  const f = await fixture();
  try {
    await f.client.startRun('s', {
      expectedStoreId: f.storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'review',
    });
    const approval = await f.pending('approval');
    await f.client.answerInteraction('s', approval.id, {
      expectedStoreId: f.storeId,
      commandId: 'approve-tool',
      expectedRevision: approval.revision,
      answer: { kind: 'approval', decision: 'approve' },
    });
    const card = await f.pending('plan_review');
    const desktop = createDesktopController({ admittedClient: f.client, onSnapshot() {} });
    await desktop.selectSession('s');
    const answer = {
      kind: 'plan_review',
      decision: 'approve',
      mode: 'auto',
      feedback: 'exact original',
    } as const;
    const first = desktop.answerInteraction(card, answer);
    expect(desktop.answerInteraction(card, answer)).toBe(first);
    const receipt = await first;
    expect(receipt.receipt).toMatchObject({ outcome: 'answer_saved' });
    const next = await f.pending('plan_review');
    expect(next.id).not.toBe(card.id);
    expect(next.executionId).toBe(card.executionId);
    await f.client.cancelCommand('s', {
      expectedStoreId: f.storeId,
      commandId: 'cancel-original',
      kind: 'command.cancel',
      targetCommandId: 'work',
    });
    await f.runtime.waitForCommand('work');
    const late = await f.client.answerInteraction('s', next.id, {
      expectedStoreId: f.storeId,
      commandId: 'late-plan',
      expectedRevision: next.revision,
      answer: { kind: 'plan_review', decision: 'approve', mode: 'accept_edits' },
    });
    expect(late.receipt).toMatchObject({ outcome: 'answer_saved', cancelled: true });
    const history = await f.client.getInteraction('s', next.id, { storeId: f.storeId });
    expect(history.state).toBe('cancelled');
    expect(history.acceptedDecisionRevision).toBeNull();
    expect(f.model.requests).toHaveLength(1);
    expect(readFileSync(f.ledger, 'utf8')).toBe('plan-tool\n');
    expect((await f.client.getView('s')).runs[0]?.status).toBe('cancelled');
    expect(desktop.interactionSubmission(card)?.intent.answer).toEqual(answer);
    expect(desktop.interactionSubmission(card)?.intent.commandId).toBe(receipt.id);
  } finally {
    await f.close();
  }
}, 15000);
