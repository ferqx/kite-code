import { expect, test } from 'bun:test';
import type {
  AgentClient,
  AnswerInteractionRequest,
  Command,
  Interaction,
  SessionView,
} from '@kite-ai/client';
import { answerRequestDigest, NativeAnswerJournal } from '../electron/answer-journal';
import { callerDigest } from '../electron/caller-journal';
import { decodeNativeRequest } from '../electron/native-ipc';
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
test('Native answer IPC accepts only an explicit frozen option ID or a plain deny', () => {
  const request = {
    method: 'interaction.answer' as const,
    generation: 1,
    interactionId: card.id,
    revision: card.revision,
  } as const;
  for (const answer of [
    { kind: 'approval', decision: 'approve', optionId: 'original-opaque-option' },
    { kind: 'approval', decision: 'deny' },
  ] as const)
    expect(decodeNativeRequest({ ...request, answer })).toEqual({ ...request, answer });
  for (const answer of [
    { kind: 'approval', decision: 'approve' },
    { kind: 'approval', decision: 'approve', grant: 'same_command' },
    { kind: 'approval', decision: 'approve', optionId: 'once', scope: {} },
    { kind: 'approval', decision: 'deny', optionId: 'once' },
  ])
    expect(() => decodeNativeRequest({ ...request, answer })).toThrow('invalid_native_request');
});
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

test('Native plan answer IPC accepts explicit business decisions and rejects permission modes', () => {
  const request = {
    method: 'interaction.answer' as const,
    generation: 1,
    interactionId: card.id,
    revision: card.revision,
  };
  for (const decision of ['approve', 'deny', 'revise'] as const) {
    const answer = { kind: 'plan_review' as const, decision, feedback: 'original feedback' };
    expect(decodeNativeRequest({ ...request, answer })).toEqual({ ...request, answer });
    for (const mode of ['auto', 'accept_edits', 'full'])
      expect(() => decodeNativeRequest({ ...request, answer: { ...answer, mode } })).toThrow(
        'invalid_native_request',
      );
  }
});

test('a saved current plan answer remains byte-exact and can only query its original Command', async () => {
  const f = fixture();
  const interaction = { ...card, kind: 'plan_review' as const };
  const request = {
    expectedStoreId: 'store',
    commandId: 'old-plan-answer',
    expectedRevision: card.revision,
    answer: {
      kind: 'plan_review' as const,
      decision: 'approve' as const,
      feedback: 'original',
    },
  };
  const {
    id,
    sessionId,
    executionId,
    runId,
    revision,
    kind,
    attempt,
    definitionId,
    definitionVersion,
    inputDigest,
    policyRevision,
  } = interaction;
  f.data.beginAnswer({
    intent: {
      scope: {
        storeId: 'store',
        sessionId: 's',
        workspaceId: 'w',
        contextSelectionId: 'selection',
      },
      subjectId: 'owner',
      interaction: {
        id,
        sessionId,
        executionId,
        runId,
        revision,
        kind,
        attempt,
        definitionId,
        definitionVersion,
        inputDigest,
        policyRevision,
      },
      observationDigest: callerDigest(interaction),
      request,
      bodyDigest: callerDigest(request),
      requestDigest: answerRequestDigest(card.id, request),
    },
    phase: 'submitting',
  });
  f.data.finishAnswer(request.commandId, 'unknown');
  const original = JSON.stringify(f.data.answers()[0]!.intent);
  f.respond(f.correct());
  await f.journal.lookup(request.commandId);
  expect(f.gets()).toBe(1);
  expect(f.posts()).toBe(0);
  expect(f.data.answers()[0]!.phase).toBe('accepted');
  expect(JSON.stringify(f.data.answers()[0]!.intent)).toBe(original);
});

test('a new journal submission cannot save or strip an old plan permission mode', async () => {
  const f = fixture();
  await expect(
    f.journal.prepare(
      {
        interaction: { ...card, kind: 'plan_review' },
        phase: 'saved',
        intent: {
          expectedStoreId: 'store',
          commandId: 'new-plan-answer',
          expectedRevision: card.revision,
          answer: { kind: 'plan_review', decision: 'approve', mode: 'auto' },
        },
      } as unknown as import('../src/controller').InteractionAnswerSubmission,
      view,
    ),
  ).rejects.toThrow('interaction_answer_invalid');
  expect(f.data.answers()).toEqual([]);
  expect(f.posts()).toBe(0);
});
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
    c.answerInteraction(card, { kind: 'approval', decision: 'approve', optionId: 'once' }),
  ).rejects.toThrow('owned_disk_full');
  expect(f.posts()).toBe(0);
  expect(f.data.answers()).toEqual([]);
  f.data.beginAnswer = begin;
  const hot = f.controller();
  await hot.selectSession('s');
  await expect(
    hot.answerInteraction(card, { kind: 'approval', decision: 'approve', optionId: 'once' }),
  ).rejects.toThrow('lost');
  expect(f.posts()).toBe(1);
  const row = f.data.answers()[0]!;
  expect(row.phase).toBe('unknown');
  expect(row.intent.request.expectedRevision).toBe(card.revision);
  expect(row.intent.requestDigest).toBe(answerRequestDigest(card.id, row.intent.request));
  const cold = f.controller();
  await cold.selectSession('s');
  await expect(
    cold.answerInteraction(card, { kind: 'approval', decision: 'approve', optionId: 'once' }),
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
    c.answerInteraction(card, { kind: 'approval', decision: 'approve', optionId: 'once' }),
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
    cold.answerInteraction(attached, { kind: 'approval', decision: 'approve', optionId: 'once' }),
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
      await c.answerInteraction(card, { kind: 'approval', decision: 'approve', optionId: 'once' });
    else
      await expect(
        c.answerInteraction(card, { kind: 'approval', decision: 'approve', optionId: 'once' }),
      ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(f.data.answers()[0]!.phase).toBe(field === 'correct' ? 'accepted' : 'unknown');
    expect(c.interactionSubmissions[0]!.phase).toBe(field === 'correct' ? 'accepted' : 'unknown');
    expect(f.data.answers()[0]!.intent.request.answer).toEqual({
      kind: 'approval',
      decision: 'approve',
      optionId: 'once',
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
