import { expect, test } from 'bun:test';
import type {
  AgentClient,
  AnswerInteractionRequest,
  Command,
  Interaction,
  SessionView,
} from '@kite-ai/client';
import { answerRequestDigest, NativeAnswerJournal } from '../electron/answer-journal';
import { createDesktopController } from '../src/controller';
import { memoryPrivateData } from './private-data.fixture';

const card: Interaction = {
  id: 'approval-original',
  originStoreId: 'store',
  sessionId: 's',
  presentationSessionId: 's',
  executionId: 'execution',
  runId: 'run',
  attempt: 1,
  ancestry: ['s'],
  kind: 'approval',
  definitionId: 'fixture',
  definitionVersion: '1',
  inputDigest: 'digest',
  policyRevision: 'policy',
  requiredRefs: [],
  request: {},
  answer: null,
  revision: '9007199254740993',
  acceptedDecisionRevision: null,
  state: 'pending',
};
const view = {
  storeId: 'store',
  snapshotCursor: '10',
  session: {
    id: 's',
    workspaceId: 'w',
    parentSessionId: null,
    deletedAt: null,
    contextSelectionId: 'selection',
  },
  messages: [],
  runs: [],
  executions: [],
} as unknown as SessionView;
function fixture() {
  const data = memoryPrivateData();
  let posts = 0,
    gets = 0;
  let response: Command | undefined;
  const client = {
    serverInfo: {
      storeId: 'store',
      subjectId: 'owner',
      capabilities: ['interactions', 'commands'],
    },
    getView: async () => view,
    listInteractions: async () => ({
      interactions: [card],
      nextAfterId: null,
      snapshotCursor: '10',
    }),
    answerInteraction: async (_s: string, _id: string, input: AnswerInteractionRequest) => {
      posts++;
      expect(data.answers()[0]!.intent.request).toEqual(input);
      throw Error('lost');
    },
    getCommand: async () => {
      gets++;
      if (!response) throw Error('missing');
      return response;
    },
    disposeNetwork() {},
  } as unknown as AgentClient;
  const journal = new NativeAnswerJournal(client, data);
  const controller = () =>
    createDesktopController({
      admittedClient: client,
      onSnapshot() {},
      readContextOnSelect: false,
      interactionAnswerJournal: {
        prepare: (row, v) => journal.prepare(row, v),
        finish: (row) => journal.finish(row),
        lookup: (row) => journal.lookup(row.intent.commandId),
      },
    });
  const correct = () => {
    const row = data.answers()[0]!;
    return {
      id: row.intent.request.commandId,
      originStoreId: 'store',
      sessionId: 's',
      subjectId: 'owner',
      kind: 'interaction.answer',
      status: 'applied',
      requestDigest: row.intent.requestDigest,
      receipt: {
        interactionId: card.id,
        decisionRevision: '9007199254740994',
        outcome: 'answer_saved',
        cancelled: false,
      },
    } as unknown as Command;
  };
  return {
    data,
    client,
    journal,
    controller,
    correct,
    posts: () => posts,
    gets: () => gets,
    respond: (command: Command) => {
      response = command;
    },
  };
}
test('save failure issues zero POST; successful prepare persists exact original answer before transport and retains it after loss', async () => {
  const f = fixture(),
    c = f.controller();
  await c.selectSession('s');
  const begin = f.data.beginAnswer;
  f.data.beginAnswer = () => {
    throw Error('owned_disk_full');
  };
  await expect(
    c.answerInteraction(card, { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('owned_disk_full');
  expect(f.posts()).toBe(0);
  expect(f.data.answers()).toEqual([]);
  f.data.beginAnswer = begin;
  const hot = f.controller();
  await hot.selectSession('s');
  await expect(
    hot.answerInteraction(card, { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('lost');
  expect(f.posts()).toBe(1);
  const row = f.data.answers()[0]!;
  expect(row.phase).toBe('unknown');
  expect(row.intent.request.expectedRevision).toBe(card.revision);
  expect(row.intent.requestDigest).toBe(answerRequestDigest(card.id, row.intent.request));
  const cold = f.controller();
  await cold.selectSession('s');
  await expect(
    cold.answerInteraction(card, { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('interaction_answer_already_saved');
  expect(f.posts()).toBe(1);
  expect(f.data.answers()).toEqual([row]);
});
test('cold lookup verifies original applied answer receipt; accepted and wrong kind/target/revision/outcome/subject/digest remain unknown without POST', async () => {
  const f = fixture(),
    c = f.controller();
  await c.selectSession('s');
  await expect(c.answerInteraction(card, { kind: 'approval', decision: 'deny' })).rejects.toThrow(
    'lost',
  );
  const original = f.data.answers()[0]!.intent,
    right = f.correct();
  const receipt = right.receipt as Record<string, unknown>;
  const wrong = [
    { ...right, status: 'accepted' },
    { ...right, kind: 'run.start' },
    { ...right, receipt: { ...receipt, interactionId: 'other' } },
    { ...right, receipt: { ...receipt, decisionRevision: '9007199254740993' } },
    { ...right, receipt: { ...receipt, outcome: 'accepted' } },
    { ...right, subjectId: 'other' },
    { ...right, requestDigest: '0'.repeat(64) },
  ] as unknown as Command[];
  for (const value of wrong) {
    f.respond(value);
    await expect(f.journal.lookup(original.request.commandId)).rejects.toThrow();
    expect(f.data.answers()[0]!.phase).toBe('unknown');
    expect(f.data.answers()[0]!.intent).toEqual(original);
  }
  expect(f.gets()).toBe(7);
  expect(f.posts()).toBe(1);
  f.respond(right);
  await f.journal.lookup(original.request.commandId);
  expect(f.data.answers()[0]!.phase).toBe('accepted');
  expect(f.gets()).toBe(8);
  expect(f.posts()).toBe(1);
});
test('another Store or subject cannot query or rebind the saved command; cold rows restore no complete attachment proof', async () => {
  const f = fixture(),
    c = f.controller();
  await c.selectSession('s');
  await expect(
    c.answerInteraction(card, { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('lost');
  const row = f.data.answers()[0]!;
  f.client.serverInfo!.storeId = 'different';
  await expect(f.journal.lookup(row.intent.request.commandId)).rejects.toThrow(
    'answer_origin_unavailable',
  );
  f.client.serverInfo!.storeId = 'store';
  f.client.serverInfo!.subjectId = 'different';
  await expect(f.journal.lookup(row.intent.request.commandId)).rejects.toThrow(
    'answer_origin_unavailable',
  );
  expect(f.gets()).toBe(0);
  expect(f.posts()).toBe(1);
  expect(f.data.answers()[0]!.intent).toEqual(row.intent);
  f.client.serverInfo!.subjectId = 'owner';
  const attached = {
    ...card,
    request: {
      policy: {
        review: {
          kind: 'artifact',
          complete: true,
          reference: {
            id: 'body',
            mediaType: 'text/plain',
            size: '17000000',
            scope: { kind: 'execution', id: card.executionId },
          },
        },
      },
    },
  } as Interaction;
  f.client.listInteractions = async () => ({
    interactions: [attached],
    nextAfterId: null,
    snapshotCursor: '10',
  });
  const cold = f.controller();
  await cold.selectSession('s');
  await expect(
    cold.answerInteraction(attached, { kind: 'approval', decision: 'approve' }),
  ).rejects.toThrow('attachment_not_loaded');
  expect(f.posts()).toBe(1);
});

test('submit accepts only the exact applied saved decision; imprecise replies retain unknown original intent', async () => {
  for (const field of [
    'status',
    'kind',
    'interaction',
    'revision',
    'outcome',
    'subject',
    'digest',
    'correct',
  ]) {
    const f = fixture(),
      c = f.controller();
    let calls = 0;
    f.client.answerInteraction = async () => {
      calls++;
      const command = f.correct();
      const receipt = command.receipt as Record<string, unknown>;
      if (field === 'status') command.status = 'accepted';
      if (field === 'kind') command.kind = 'run.start';
      if (field === 'interaction') receipt.interactionId = 'another';
      if (field === 'revision') receipt.decisionRevision = card.revision;
      if (field === 'outcome') receipt.outcome = 'accepted';
      if (field === 'subject') command.subjectId = 'other';
      if (field === 'digest') command.requestDigest = '0'.repeat(64);
      return command;
    };
    await c.selectSession('s');
    if (field === 'correct')
      await c.answerInteraction(card, { kind: 'approval', decision: 'approve' });
    else
      await expect(
        c.answerInteraction(card, { kind: 'approval', decision: 'approve' }),
      ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(f.data.answers()[0]!.phase).toBe(field === 'correct' ? 'accepted' : 'unknown');
    expect(c.interactionSubmissions[0]!.phase).toBe(field === 'correct' ? 'accepted' : 'unknown');
    expect(f.data.answers()[0]!.intent.request.answer).toEqual({
      kind: 'approval',
      decision: 'approve',
    });
  }
});

test('saved answer association becomes unavailable when the same Session context selection changes', async () => {
  const f = fixture(),
    c = f.controller();
  await c.selectSession('s');
  await expect(c.answerInteraction(card, { kind: 'approval', decision: 'deny' })).rejects.toThrow(
    'lost',
  );
  expect(f.journal.metadata(view)[0]!.association).toBe('current');
  expect(
    f.journal.metadata({
      ...view,
      session: { ...view.session, contextSelectionId: 'other-selection' },
    })[0]!.association,
  ).toBe('unavailable');
  expect(f.posts()).toBe(1);
  expect(f.gets()).toBe(0);
});
