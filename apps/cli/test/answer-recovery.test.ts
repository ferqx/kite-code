import { expect, test } from 'bun:test';
import type { AgentClient, AnswerInteractionRequest, Command, Interaction } from '@kite-ai/client';
import { observeCommand, run } from '../src';

const intent = {
  kind: 'run.start' as const,
  expectedStoreId: 'store',
  commandId: 'work',
  content: 'question',
};
const card = {
  id: 'question',
  originStoreId: 'store',
  sessionId: 's',
  presentationSessionId: 's',
  runId: 'run',
  revision: '1',
  kind: 'question',
  state: 'pending',
  request: { schema: { type: 'object' } },
} as unknown as Interaction;
const work = {
  id: 'work',
  kind: 'run.start',
  sessionId: 's',
  originStoreId: 'store',
  status: 'applied',
  receipt: { runId: 'run' },
  cancelRequestedAt: null,
} as Command;
function fixture() {
  let posts = 0,
    prompts = 0,
    answerReads = 0,
    ended = false;
  let original: AnswerInteractionRequest | undefined;
  const client = {
    serverInfo: { capabilities: ['interactions'] },
    async startRun() {
      return work;
    },
    async getCommand(id: string) {
      if (id === 'work') return work;
      answerReads++;
      if (answerReads === 1) throw Error('GET lost');
      ended = true;
      return {
        ...work,
        id,
        kind: 'interaction.answer',
        receipt: { outcome: 'answer_saved', interactionId: 'question', decisionRevision: '2' },
      };
    },
    async getRun() {
      return {
        id: 'run',
        originCommandId: 'work',
        originStoreId: 'store',
        sessionId: 's',
        isActive: !ended,
        status: ended ? 'completed' : 'waiting_interaction',
      };
    },
    async listInteractions() {
      return {
        interactions: [card],
        nextAfterId: null,
        snapshotCursor: '1',
      } satisfies Awaited<ReturnType<AgentClient['listInteractions']>>;
    },
    async answerInteraction(_session: string, _card: string, request: AnswerInteractionRequest) {
      posts++;
      original = structuredClone(request);
      throw Error('POST reply lost');
    },
  } as unknown as AgentClient;
  const options = {
    client,
    write() {},
    pollIntervalMs: 0,
    async answerInteraction() {
      prompts++;
      return {
        kind: 'question' as const,
        answers: { decision: 'replan', detail: 'original reason' },
      };
    },
  };
  return {
    client,
    options,
    counts: () => ({ posts, prompts, answerReads }),
    original: () => original,
  };
}
test('two lost answer receipts freeze original intent; observe only GETs original answer before terminal work', async () => {
  const f = fixture();
  const first = await run('s', intent, f.options);
  expect(first.status).toBe('waiting_interaction');
  expect(first.answerIntent?.phase).toBe('unknown');
  expect(first.answerIntent?.request).toEqual(f.original());
  const recovered = await observeCommand('s', intent, {
    ...f.options,
    answerIntent: first.answerIntent,
  });
  expect(recovered.status).toBe('succeeded');
  expect(recovered.answerIntent?.phase).toBe('accepted');
  expect(recovered.answerIntent?.request).toEqual(f.original());
  expect(f.counts()).toEqual({ posts: 1, prompts: 1, answerReads: 2 });
});
for (const field of [
  'kind',
  'sessionId',
  'originStoreId',
  'interactionId',
  'decisionRevision',
] as const)
  test(`wrong original answer ${field} cannot unlock unknown or prompt again`, async () => {
    const f = fixture();
    const first = await run('s', intent, f.options);
    const originalGet = f.client.getCommand.bind(f.client);
    f.client.getCommand = async (id, options) => {
      const value = await originalGet(id, options);
      return field === 'interactionId' || field === 'decisionRevision'
        ? {
            ...value,
            receipt: {
              outcome: 'answer_saved',
              interactionId: 'question',
              decisionRevision: '2',
              [field]: 'other',
            },
          }
        : { ...value, [field]: 'other' };
    };
    const result = await observeCommand('s', intent, {
      ...f.options,
      answerIntent: first.answerIntent,
    });
    expect(result.status).toBe('outcome_unknown');
    expect(result.answerIntent?.phase).toBe('unknown');
    expect(f.counts().posts).toBe(1);
    expect(f.counts().prompts).toBe(1);
  });
test('saved answer cannot cross work or presentation scope and is never looked up there', async () => {
  const f = fixture();
  const first = await run('s', intent, f.options);
  const result = await observeCommand('other', intent, {
    ...f.options,
    answerIntent: first.answerIntent,
  });
  expect(result.status).toBe('outcome_unknown');
  expect(f.counts()).toEqual({ posts: 1, prompts: 1, answerReads: 1 });
});

test('submit cannot mutate the sealed original answer request through its argument alias', async () => {
  const f = fixture(),
    post = f.client.answerInteraction.bind(f.client);
  f.client.answerInteraction = async (session, id, request, options) => {
    const result = post(session, id, request, options);
    request.answer = { kind: 'question', answers: { decision: 'waive', detail: 'changed alias' } };
    return result;
  };
  const first = await run('s', intent, f.options);
  expect(first.answerIntent?.request.answer).toEqual({
    kind: 'question',
    answers: { decision: 'replan', detail: 'original reason' },
  });
  const recovered = await observeCommand('s', intent, {
    ...f.options,
    answerIntent: first.answerIntent,
  });
  expect(recovered.status).toBe('succeeded');
  expect(recovered.answerIntent?.request.answer).toEqual(first.answerIntent?.request.answer);
  expect(f.counts().posts).toBe(1);
});

test('known invalid answer is rejected without locking unknown recovery or querying an uncreated answer command', async () => {
  const { ClientError } = await import('@kite-ai/client');
  const f = fixture();
  f.client.answerInteraction = async () => {
    throw new ClientError('invalid_request');
  };
  const result = await run('s', intent, f.options);
  expect(result.status).toBe('waiting_interaction');
  expect(result.answerIntent?.phase).toBe('rejected');
  expect(f.counts().answerReads).toBe(0);
});

test('Ctrl+C while original answer remains unknown still cancels the original work once, without answering again', async () => {
  const f = fixture();
  const first = await run('s', intent, f.options);
  let cancellations = 0;
  f.client.getCommand = async () => {
    throw Error('still lost');
  };
  f.client.cancelCommand = async (session, request) => {
    cancellations++;
    expect(session).toBe('s');
    expect(request.targetCommandId).toBe('work');
    expect(request.expectedStoreId).toBe('store');
    return { ...work, id: request.commandId, kind: 'command.cancel' };
  };
  const signal = new AbortController();
  signal.abort();
  const result = await observeCommand('s', intent, {
    ...f.options,
    signal: signal.signal,
    answerIntent: first.answerIntent,
  });
  expect(result.status).toBe('outcome_unknown');
  expect(result.cancellationAttempted).toBe(true);
  expect(cancellations).toBe(1);
  expect(f.counts().posts).toBe(1);
  expect(f.counts().prompts).toBe(1);
});
