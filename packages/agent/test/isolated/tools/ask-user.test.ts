import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAskUserExtension } from '@kite-ai/agent/ask-user';
import type { Json, ToolContext, ToolResult } from '@kite-ai/agent/extensions';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError, type InteractionRecord } from '../../../src/storage/types';

const question: { question: string; options: Record<string, Json>[] } = {
  question: '  Which approach?  ',
  options: [
    { label: '  First  ', description: '  First explanation  ' },
    { label: 'Second', description: 'Second explanation', recommended: true },
  ],
};
const input = { questions: [question] };
const tool = createAskUserExtension().tools![0]!;
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error('timed_out');
    await Bun.sleep(10);
  }
}
async function fixture(arguments_: Json = input) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-ask-user-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'ask-call',
        name: 'ask_user',
        arguments: JSON.stringify(arguments_),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    processConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [createAskUserExtension()],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'test',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 's',
    subjectId: 'owner',
  });
  await runtime.submitCommand({
    expectedStoreId,
    commandId: 'work',
    sessionId: 's',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'ask' },
  });
  const interactions = () => runtime.listInteractions({ expectedStoreId, sessionId: 's' });
  return {
    root,
    runtime,
    store,
    model,
    expectedStoreId,
    interactions,
    pending: () =>
      eventually(
        async () =>
          (await interactions()).interactions.find((record) => record.state === 'pending') ?? null,
      ),
    answer: (record: InteractionRecord, answers: Json, commandId = 'answer') =>
      runtime.answerInteraction({
        expectedStoreId,
        commandId,
        presentationSessionId: record.presentationSessionId,
        interactionId: record.id,
        expectedRevision: record.revision,
        subjectId: 'owner',
        answer: { kind: 'question', answers },
      }),
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('pure ordinary leaf publishes only builtin.ask-user@1 and ask_user@1', () => {
  expect(createAskUserExtension()).toMatchObject({
    id: 'builtin.ask-user',
    version: '1',
    apiMajor: 1,
  });
  expect(createAskUserExtension().tools?.map((item) => [item.id, item.version])).toEqual([
    ['ask_user', '1'],
  ]);
  expect(createAskUserExtension().jobs).toBeUndefined();
});

test('canonical parser rejects removed fields, invalid cardinality, whitespace, duplicate recommendation and inherited required values before asking', async () => {
  let calls = 0;
  const context = {
    async requestInput() {
      calls++;
      return {};
    },
  } as unknown as ToolContext;
  const invalid: Json[] = [
    { questions: [] },
    { questions: [question, question, question, question] },
    { question: 'old', options: question.options },
    { questions: [question], id: 'old' },
    { questions: [{ ...question, id: 'q' }] },
    {
      questions: [
        {
          ...question,
          options: [
            question.options[0]!,
            question.options[1]!,
            question.options[0]!,
            question.options[1]!,
          ],
        },
      ],
    },
    {
      questions: [
        {
          ...question,
          options: [{ label: 'A', description: 'a', id: 'old' }, question.options[1]!],
        },
      ],
    },
    { questions: [{ ...question, allowFreeText: true }] },
    { questions: [{ ...question, question: '  ' }] },
    { questions: [{ ...question, options: [question.options[0]!] }] },
    {
      questions: [
        { ...question, options: [{ label: 'A', description: ' ' }, question.options[1]!] },
      ],
    },
    {
      questions: [
        {
          ...question,
          options: question.options.map((option) => ({ ...option, recommended: true })),
        },
      ],
    },
    Object.create({ questions: [question] }) as Json,
  ];
  for (const value of invalid)
    expect(await tool.execute(value, context)).toEqual({
      outcome: 'failed',
      content: 'invalid_ask_user_arguments',
    });
  expect(calls).toBe(0);
});

test('accepted answer validation reads only own exact keys and preserves free text rather than treating it as an option ID', async () => {
  for (const answers of [
    {},
    { q1: 'unknown' },
    { q1: 'q1-o1', q2: 'q2-o1' },
    { q1: { text: ' ' } },
    { q1: { text: 'answer', extra: true } },
    Object.create({ q1: 'q1-o1' }) as Json,
    { q1: Object.create({ text: 'answer' }) } as Json,
  ]) {
    await expect(
      tool.execute(input, { requestInput: async () => answers } as unknown as ToolContext),
    ).rejects.toThrow();
  }
  const text = '  q1-o1\n雪\r\n  ';
  expect(
    (
      await tool.execute(input, {
        requestInput: async () => ({ q1: { text } }),
      } as unknown as ToolContext)
    ).details,
  ).toEqual({ answer: text, answers: { q1: text } });
});

test('real Core/SQLite asks all questions in one original interaction and returns semantic labels plus full free text', async () => {
  const f = await fixture({
    questions: [
      question,
      { ...question, question: 'Other decision?' },
      { ...question, question: 'Third?' },
    ],
  });
  try {
    const record = await f.pending();
    expect(record.kind).toBe('question');
    expect(record.request).toMatchObject({
      schema: {
        oneOf: [
          {
            required: ['q1', 'q2', 'q3'],
            additionalProperties: false,
            properties: {
              q1: {
                title: 'Which approach?',
                anyOf: [
                  { const: 'q1-o1', title: 'First', description: 'First explanation' },
                  {
                    const: 'q1-o2',
                    title: 'Second (Recommended)',
                    description: 'Second explanation',
                  },
                  {
                    type: 'object',
                    properties: { text: { type: 'string', minLength: 1, pattern: '\\S' } },
                    required: ['text'],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          { const: null, title: 'Cancel answering' },
        ],
      },
    });
    for (const [index, answers] of (
      [
        { q1: 'unknown', q2: 'q2-o1', q3: 'q3-o1' },
        { q1: 'q1-o1' },
        { q1: 'q1-o1', q2: 'q2-o1', q3: 'q3-o1', extra: 'no' },
        { q1: { text: 'value', extra: true }, q2: 'q2-o1', q3: 'q3-o1' },
        { q1: { text: ' \t\r\n ' }, q2: 'q2-o1', q3: 'q3-o1' },
      ] as Json[]
    ).entries()) {
      let error: unknown;
      try {
        await f.answer(record, answers, `invalid-${index}`);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'interaction_answer_invalid' });
      const pending = await f.runtime.getInteraction({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        interactionId: record.id,
      });
      expect(pending?.state).toBe('pending');
      expect(pending?.revision).toBe(record.revision);
      expect(pending?.answer).toBeNull();
    }
    const free = '  q1-o1\n雪\r\n  ';
    await f.answer(record, { q1: 'q1-o2', q2: { text: free }, q3: 'q3-o1' });
    await f.runtime.waitForCommand('work');
    const result = (await f.store.getExecution(record.executionId))
      ?.result as unknown as ToolResult;
    expect(result).toMatchObject({
      outcome: 'succeeded',
      details: {
        answer: `Which approach?: Second\nOther decision?: ${free}\nThird?: First`,
        answers: { q1: 'Second', q2: free, q3: 'First' },
      },
    });
    expect(JSON.parse(result!.content)).toEqual(result!.details);
    expect((await f.interactions()).interactions).toHaveLength(1);
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 10000);

test('cancelling only the original questionnaire saves null and lets the same Run continue to the next Model response', async () => {
  const f = await fixture();
  try {
    const card = await f.pending();
    const receipt = await f.answer(card, null);
    expect(receipt.status).toBe('applied');
    expect(receipt.receipt).toMatchObject({
      outcome: 'answer_saved',
      interactionId: card.id,
      cancelled: false,
    });
    await f.runtime.waitForCommand('work');
    const result = (await f.store.getExecution(card.executionId))?.result as unknown as ToolResult;
    expect(result).toEqual({
      outcome: 'succeeded',
      content: '{"cancelled":true}',
      details: { cancelled: true },
    });
    const original = (await f.interactions()).interactions;
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({
      id: card.id,
      runId: card.runId,
      state: 'answered',
      acceptedDecisionRevision: '2',
      answer: { kind: 'question', answers: null },
    });
    expect((await f.store.getRun(card.runId!))?.status).toBe('completed');
    expect(f.model.requests).toHaveLength(2);
    expect(
      f.model.requests[1]!.messages.filter((message) => message.role === 'tool').map(
        (message) => message.content,
      ),
    ).toContain('{"cancelled":true}');
    expect(
      (await f.store.listExecutions('s'))
        .filter((execution) => execution.kind === 'model')
        .every((execution) => execution.runId === card.runId),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 10000);

test('real ordinary Tool cancellation produces no successful answer and does not ask again', async () => {
  const f = await fixture();
  try {
    const record = await f.pending();
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      subjectId: 'owner',
      targetCommandId: 'work',
    });
    await f.runtime.waitForCommand('work');
    const execution = await f.store.getExecution(record.executionId);
    expect(execution?.status).toBe('cancelled');
    expect((execution?.result as unknown as ToolResult)?.outcome).toBe('cancelled');
    expect(execution?.result).toEqual({ outcome: 'cancelled', content: 'cancel_requested' });
    expect((await f.interactions()).interactions[0]?.state).toBe('cancelled');
    expect((await f.interactions()).interactions).toHaveLength(1);
    expect(f.model.requests).toHaveLength(1);
    await f.runtime.close();
    const cold = await openSqliteStore({ dataRoot: join(f.root, 'data'), profile: 'new' });
    try {
      expect((await cold.getExecution(record.executionId))?.result).toEqual({
        outcome: 'cancelled',
        content: 'cancel_requested',
      });
      expect(
        (
          await cold.getInteraction({
            expectedStoreId: f.expectedStoreId,
            sessionId: 's',
            interactionId: record.id,
          })
        )?.state,
      ).toBe('cancelled');
      expect(f.model.requests).toHaveLength(1);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
}, 10000);

test('real canonical-invalid zero questions are rejected before any original question is registered', async () => {
  const f = await fixture({ questions: [] });
  try {
    await f.runtime.waitForCommand('work');
    expect((await f.interactions()).interactions).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 10000);

test('no explicit recommendation marks only the first option without selecting a default or answering for the user', async () => {
  let request: Json | undefined;
  const response = await tool.execute(
    {
      questions: [
        {
          question: 'Choice?',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    },
    {
      async requestInput(value: Json) {
        request = value;
        return { q1: 'q1-o2' };
      },
    } as unknown as ToolContext,
  );
  expect(request).toEqual({
    schema: {
      oneOf: [
        {
          type: 'object',
          properties: {
            q1: {
              title: 'Choice?',
              anyOf: [
                { const: 'q1-o1', title: 'A (Recommended)', description: 'a' },
                { const: 'q1-o2', title: 'B', description: 'b' },
                {
                  type: 'object',
                  properties: { text: { type: 'string', minLength: 1, pattern: '\\S' } },
                  required: ['text'],
                  additionalProperties: false,
                },
              ],
            },
          },
          required: ['q1'],
          additionalProperties: false,
        },
        {
          const: null,
          title: 'Cancel answering',
          description: 'Leave these questions unanswered and continue the current task.',
        },
      ],
    },
  });
  expect(response.details).toEqual({ answer: 'B', answers: { q1: 'B' } });
});

test('only the exact original cancel_requested exception becomes a cancelled result; unrelated aborts still throw', async () => {
  const controller = new AbortController();
  const exact = new AgentError('cancel_requested');
  controller.abort(exact);
  const context = (error: unknown) =>
    ({
      signal: controller.signal,
      async requestInput() {
        throw error;
      },
    }) as unknown as ToolContext;
  expect(await tool.execute(input, context(exact))).toEqual({
    outcome: 'cancelled',
    content: 'cancel_requested',
  });
  for (const other of [
    new AgentError('cancel_requested'),
    new AgentError('service_shutdown'),
    new Error('unrelated'),
  ]) {
    let thrown: unknown;
    try {
      await tool.execute(input, context(other));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(other);
  }
});

test('real canonical duplicate recommendation is a known failure with zero questions and allows the next Model response', async () => {
  const f = await fixture({
    questions: [
      {
        ...question,
        options: question.options.map((option) => ({ ...option, recommended: true })),
      },
    ],
  });
  try {
    await f.runtime.waitForCommand('work');
    const execution = (await f.store.listExecutions('s')).find(
      (value) => value.definitionId === 'ask_user',
    );
    expect(execution?.status).toBe('failed');
    expect(execution?.result).toEqual({ outcome: 'failed', content: 'invalid_ask_user_arguments' });
    expect((await f.interactions()).interactions).toHaveLength(0);
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 10000);
