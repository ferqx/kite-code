import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { Permissions, ToolDefinition } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionAnswer, InteractionRecord } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name = 'fixture.effect', input: unknown = {}): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
async function eventually<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}
async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
const base = {
  id: 'fixture.effect',
  version: '1',
  description: 'Harmless explicit effect',
  inputSchema: { type: 'object' },
} as const;
function ask(): Permissions {
  return {
    async authorize(request) {
      return request.kind === 'model'
        ? { allowed: true, revision: 'policy-1' }
        : { allowed: false, revision: 'policy-1', approval: { request: { title: 'Exact call' } } };
    },
  };
}
async function fixture(
  tools: ToolDefinition[],
  responses: ModelEvent[][],
  permissions = ask(),
  options: Partial<RuntimeOptions> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-core-interactions-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const model = createFixedModel(responses);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    processConcurrency: 1,
    permissions,
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools }],
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  const session = (id = 's') =>
    runtime.createSession({
      expectedStoreId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId: 'w',
      title: id,
      subjectId: 'owner',
    });
  await session();
  const submit = (id = 'work', sessionId = 's') =>
    runtime.submitCommand({
      expectedStoreId,
      commandId: id,
      sessionId,
      subjectId: 'owner',
      request: { kind: 'run.start', content: id },
    });
  const pending = (sessionId = 's', excluded: string[] = []) =>
    eventually(async () => {
      const page = await runtime.listInteractions({ expectedStoreId, sessionId, state: 'pending' });
      return page.interactions.find((record) => !excluded.includes(record.id)) ?? null;
    }, 'pending interaction');
  const answer = (
    record: InteractionRecord,
    value: InteractionAnswer,
    commandId = `answer-${record.id}`,
  ) =>
    runtime.answerInteraction({
      expectedStoreId,
      commandId,
      presentationSessionId: record.presentationSessionId,
      interactionId: record.id,
      expectedRevision: record.revision,
      subjectId: 'owner',
      answer: value,
    });
  const read = (record: InteractionRecord) =>
    runtime.getInteraction({ expectedStoreId, sessionId: 's', interactionId: record.id });
  return {
    root,
    store,
    runtime,
    model,
    expectedStoreId,
    session,
    submit,
    pending,
    answer,
    read,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('waiting approval holds neither shared Model nor process permit; saved answer is accepted for exact parameters once', async () => {
  const effects: unknown[] = [];
  const f = await fixture(
    [
      {
        ...base,
        resources: { slot: 'process' },
        async execute(input) {
          effects.push(input);
          return { outcome: 'succeeded', content: 'done' };
        },
      },
      {
        ...base,
        id: 'fixture.other',
        resources: { slot: 'process' },
        async execute() {
          effects.push('unrelated');
          return { outcome: 'succeeded', content: 'other' };
        },
      },
    ],
    [
      call('fixture.effect', { path: 'exact', value: 'first' }),
      call('fixture.other'),
      [finish],
      [finish],
    ],
    {
      async authorize(request) {
        return request.definitionId === 'fixture.effect'
          ? { allowed: false, revision: 'policy-1', approval: { request: { title: 'Exact call' } } }
          : { allowed: true, revision: 'policy-1' };
      },
    },
  );
  try {
    await f.submit();
    const record = await f.pending();
    expect(record.request).toMatchObject({
      definitionId: base.id,
      definitionVersion: '1',
      input: { path: 'exact', value: 'first' },
    });
    expect(record.sessionId).toBe('s');
    expect((await f.store.getExecution(record.executionId))?.status).toBe('planned');
    expect((await f.store.getRun(record.runId!))?.status).toBe('waiting_interaction');
    expect(effects).toEqual([]);
    await f.session('other');
    await f.submit('other-work', 'other');
    await f.runtime.waitForCommand('other-work');
    expect(effects).toEqual(['unrelated']);
    expect(f.model.requests).toHaveLength(3);
    const receipt = await f.answer(record, { kind: 'approval', decision: 'approve' });
    expect(receipt.receipt).toMatchObject({ outcome: 'answer_saved', decisionRevision: '2' });
    expect(await f.answer(record, { kind: 'approval', decision: 'approve' })).toEqual(receipt);
    await f.runtime.waitForCommand('work');
    const accepted = await f.read(record);
    expect(accepted?.acceptedDecisionRevision).toBe('2');
    expect((await f.store.getExecution(record.executionId))?.interactionBinding).toEqual({
      interactionId: record.id,
      decisionRevision: '2',
    });
    expect((await f.store.getExecution(record.executionId))?.status).toBe('succeeded');
    expect(effects).toEqual(['unrelated', { path: 'exact', value: 'first' }]);
    expect(f.model.requests).toHaveLength(4);
    await f.submit();
    await f.runtime.waitForCommand('work');
    expect(effects).toHaveLength(2);
    expect(f.model.requests).toHaveLength(4);
  } finally {
    await f.close();
  }
}, 10000);

test('refusing one exact approval ends its original round before any adapter or later Model call', async () => {
  let effects = 0;
  const f = await fixture(
    [
      {
        ...base,
        async execute() {
          effects++;
          return { outcome: 'succeeded', content: 'done' };
        },
      },
    ],
    [call(), [finish]],
  );
  try {
    await f.submit();
    const record = await f.pending();
    await f.answer(record, { kind: 'approval', decision: 'deny' });
    await f.runtime.waitForCommand('work');
    expect(effects).toBe(0);
    expect(f.model.requests).toHaveLength(1);
    const execution = await f.store.getExecution(record.executionId);
    expect(execution?.status).toBe('failed');
    expect(execution?.result).toMatchObject({
      content: 'approval_denied',
      details: { adapterAttempted: false },
    });
    expect((await f.store.getRun(record.runId!))?.status).toBe('cancelled');
    expect((await f.runtime.getCommand('work'))?.cancelRequestedAt).not.toBeNull();
    expect((await f.read(record))?.answer).toEqual({ kind: 'approval', decision: 'deny' });
    await f.submit();
    expect(effects).toBe(0);
    expect(f.model.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 10000);

test('permission withdrawal or policy revision change while answering never accepts an old approval or dispatches', async () => {
  for (const withdrawal of [true, false]) {
    let revision = 'policy-1';
    let blocked = false;
    let effects = 0;
    const f = await fixture(
      [
        {
          ...base,
          async execute() {
            effects++;
            return { outcome: 'succeeded', content: 'done' };
          },
        },
      ],
      [call(), [finish]],
      {
        async authorize(request) {
          if (request.kind === 'model') return { allowed: true, revision };
          return {
            allowed: false,
            revision,
            ...(blocked ? {} : { approval: { request: { title: 'Exact' } } }),
          };
        },
      },
    );
    try {
      await f.submit();
      const record = await f.pending();
      if (withdrawal) blocked = true;
      else revision = 'policy-2';
      await f.answer(record, { kind: 'approval', decision: 'approve' });
      await f.runtime.waitForCommand('work');
      expect(effects).toBe(0);
      expect((await f.read(record))?.acceptedDecisionRevision).toBeNull();
      expect((await f.store.getExecution(record.executionId))?.status).toBe('failed');
      expect((await f.store.getExecution(record.executionId))?.result).toMatchObject({
        content: withdrawal ? 'permission_denied' : 'interaction_binding_changed',
      });
    } finally {
      await f.close();
    }
  }
}, 10000);

test('sources changed during approval invalidate the original call and enter the next actual Model request', async () => {
  let digest = 'one';
  let effects = 0;
  const f = await fixture(
    [
      {
        ...base,
        async execute() {
          effects++;
          return { outcome: 'succeeded', content: 'done' };
        },
      },
    ],
    [call(), [finish]],
    ask(),
    {
      sources: {
        async capture() {
          return [
            {
              id: 'workspace:instruction',
              kind: 'instruction',
              scope: 'workspace',
              digest,
              content: digest,
            },
          ];
        },
      },
    },
  );
  try {
    await f.submit();
    const record = await f.pending();
    digest = 'two';
    await f.answer(record, { kind: 'approval', decision: 'approve' });
    await f.runtime.waitForCommand('work');
    expect(effects).toBe(0);
    expect((await f.read(record))?.acceptedDecisionRevision).toBeNull();
    expect((await f.store.getExecution(record.executionId))?.result).toMatchObject({
      content: 'context_refresh_required',
      details: { adapterAttempted: false },
    });
    expect(f.model.requests).toHaveLength(2);
    expect(f.model.requests[0]?.messages).toContainEqual({
      role: 'system',
      content: 'one',
      sourceIds: ['workspace:instruction'],
    });
    expect(f.model.requests[1]?.messages).toContainEqual({
      role: 'system',
      content: 'two',
      sourceIds: ['workspace:instruction'],
    });
  } finally {
    await f.close();
  }
}, 10000);

test('two questions bind the dispatched Tool, validate answers and return information without granting another execution', async () => {
  const answers: unknown[] = [];
  const f = await fixture(
    [
      {
        ...base,
        async execute(_input, context) {
          for (const title of ['first', 'second'])
            answers.push(
              await context.requestInput({
                title,
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['choice'],
                  properties: { choice: { type: 'string', enum: ['a', 'b'] } },
                },
              }),
            );
          return { outcome: 'succeeded', content: JSON.stringify(answers) };
        },
      },
    ],
    [call(), [finish]],
    {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  );
  try {
    await f.submit();
    const first = await f.pending();
    expect(first.kind).toBe('question');
    expect((await f.store.getExecution(first.executionId))?.status).toBe('dispatching');
    expect((await f.store.getExecution(first.executionId))?.interactionBinding).toBeNull();
    await rejected(
      f.answer(first, { kind: 'question', answers: { choice: 'not-an-option' } }),
      'interaction_answer_invalid',
    );
    expect((await f.read(first))?.state).toBe('pending');
    await f.answer(first, { kind: 'question', answers: { choice: 'a' } });
    const second = await f.pending('s', [first.id]);
    expect(second.id).not.toBe(first.id);
    expect(second.executionId).toBe(first.executionId);
    expect((await f.read(first))?.acceptedDecisionRevision).toBe('2');
    expect((await f.store.getRun(first.runId!))?.status).toBe('waiting_interaction');
    expect(answers).toEqual([{ choice: 'a' }]);
    await f.answer(second, { kind: 'question', answers: { choice: 'b' } });
    await f.runtime.waitForCommand('work');
    expect(answers).toEqual([{ choice: 'a' }, { choice: 'b' }]);
    expect((await f.read(second))?.acceptedDecisionRevision).toBe('2');
    expect((await f.store.getExecution(first.executionId))?.interactionBinding).toBeNull();
    expect((await f.store.getRun(first.runId!))?.status).toBe('completed');
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 10000);

test('late approval after original Command cancellation stays history and cannot revive its Run', async () => {
  let effects = 0;
  const f = await fixture(
    [
      {
        ...base,
        async execute() {
          effects++;
          return { outcome: 'succeeded', content: 'done' };
        },
      },
    ],
    [call(), [finish]],
  );
  try {
    await f.submit();
    const record = await f.pending();
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-work',
      sessionId: 's',
      targetCommandId: 'work',
      subjectId: 'owner',
    });
    const saved = await f.answer(record, { kind: 'approval', decision: 'approve' });
    expect(saved.receipt).toMatchObject({ outcome: 'answer_saved', cancelled: true });
    await f.runtime.waitForCommand('work');
    expect((await f.read(record))?.state).toBe('cancelled');
    expect((await f.read(record))?.acceptedDecisionRevision).toBeNull();
    expect(effects).toBe(0);
    expect(f.model.requests).toHaveLength(1);
    expect((await f.store.getRun(record.runId!))?.status).toBe('cancelled');
  } finally {
    await f.close();
  }
}, 10000);
