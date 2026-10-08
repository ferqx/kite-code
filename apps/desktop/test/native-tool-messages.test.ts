import { expect, test } from 'bun:test';
import type { AgentClient, Execution, Message, Run } from '@kite-ai/client';
import { decodeNativeRequest } from '../electron/native-ipc';
import { NativeToolMessages } from '../electron/tool-messages';
import type { NativeToolMessageScope } from '../src/tool-messages-bridge';

function fixture() {
  let scope: NativeToolMessageScope = {
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
  };
  const messages = new Map<string, Message>(),
    executions = new Map<string, Execution>(),
    reads: string[] = [];
  const client = {
    verifyConnection: async () => {},
    getExecution: async (id: string) => {
      reads.push(id);
      return executions.get(id)!;
    },
  } as unknown as AgentClient;
  const manager = new NativeToolMessages(
    client,
    () => scope,
    () => messages,
  );
  const add = (
    id: string,
    status: Execution['status'],
    run = id,
    definitionId = 'shell.launch',
  ) => {
    messages.set(`call-${id}`, {
      id: `call-${id}`,
      seq: String(messages.size + 1),
      sessionId: 's',
      runId: run,
      role: 'assistant',
      status: 'complete',
      content: '',
      toolCalls: [
        {
          id: 'repeated',
          name: definitionId,
          arguments: JSON.stringify({ command: `${id} 雪🙂`, path: `${id}.txt` }),
        },
      ],
    });
    const message: Message = {
      id,
      seq: String(messages.size + 1),
      sessionId: 's',
      runId: run,
      role: 'tool',
      status: 'complete',
      content: `original-${id}`,
      toolCallId: 'repeated',
      sourceIds: [`execution-${id}`],
    };
    messages.set(id, message);
    executions.set(`execution-${id}`, {
      id: `execution-${id}`,
      originStoreId: 'store',
      sessionId: 's',
      runId: run,
      kind: 'tool',
      definitionId,
      definitionVersion: '1',
      status,
      result: { outcome: status, content: message.content },
      resultRevision: '1',
      cancelRequestedAt: null,
    });
  };
  const list = (messageIds: string[]) =>
    manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: scope.viewSelection,
      historyEpoch: scope.historyEpoch,
      readId: crypto.randomUUID(),
      messageIds,
    });
  return {
    client,
    messages,
    executions,
    reads,
    manager,
    add,
    list,
    get scope() {
      return scope;
    },
    set scope(value) {
      scope = value;
    },
  };
}

test('cache samples use immutable original Model receipts beyond the View, retain sealed origins and reject invented token pairs', async () => {
  const f = fixture();
  const add = (id: string, usage: unknown = { inputTokens: 100, cachedInputTokens: 40 }) => {
    const message: Message = {
      id,
      seq: String(f.messages.size + 1),
      sessionId: 's',
      runId: `run-${id}`,
      role: 'assistant',
      status: 'complete',
      content: `original-${id}`,
      sourceIds: [`model-${id}`],
    };
    f.messages.set(id, message);
    f.executions.set(`model-${id}`, {
      id: `model-${id}`,
      originStoreId: 'store',
      sessionId: 's',
      runId: message.runId,
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      status: 'succeeded',
      result: { content: message.content, usage },
      resultRevision: '1',
      cancelRequestedAt: null,
    } as Execution);
    return message;
  };
  const read = (messageIds: string[]) =>
    f.manager.usage({
      method: 'toolMessages.usage',
      generation: 1,
      viewSelection: f.scope.viewSelection,
      historyEpoch: f.scope.historyEpoch,
      readId: crypto.randomUUID(),
      messageIds,
    });
  try {
    for (let i = 0; i < 241; i++) add(`usage-${i}`);
    expect((await read(['usage-240'])).entries).toEqual([
      {
        messageId: 'usage-240',
        executionId: 'model-usage-240',
        originStoreId: 'store',
        cacheHitTokens: 40,
        cacheMissTokens: 60,
      },
    ]);
    add('no-cache-field', { inputTokens: 100 });
    add('zero-input', { inputTokens: 0, cachedInputTokens: 0 });
    add('observed-zero', { inputTokens: 100, cachedInputTokens: 0 });
    expect((await read(['no-cache-field', 'zero-input', 'observed-zero'])).entries).toMatchObject([
      { messageId: 'observed-zero', cacheHitTokens: 0, cacheMissTokens: 100 },
    ]);
    const original = f.messages.get('usage-240')!;
    f.messages.set('copied-usage', {
      ...original,
      id: 'copied-usage',
      runId: null,
      originMessage: {
        storeId: 'store',
        sessionId: 's',
        messageId: original.id,
        runId: original.runId ?? null,
      },
    });
    expect((await read(['copied-usage'])).entries).toMatchObject([
      { messageId: 'copied-usage', executionId: 'model-usage-240', cacheHitTokens: 40 },
    ]);
    const restored = add('restored');
    f.executions.get('model-restored')!.originStoreId = 'old-store';
    f.client.getRun = async () =>
      ({
        id: restored.runId,
        sessionId: 's',
        originStoreId: 'old-store',
        status: 'interrupted',
        isActive: false,
      }) as Run;
    expect((await read(['restored'])).entries[0]?.originStoreId).toBe('old-store');
    f.client.getRun = async () =>
      ({
        id: restored.runId,
        sessionId: 's',
        originStoreId: 'old-store',
        status: 'running',
        isActive: true,
      }) as Run;
    await expect(read(['restored'])).rejects.toMatchObject({
      code: 'model_usage_identity_mismatch',
    });
    for (const usage of [
      { inputTokens: null, cachedInputTokens: 1 },
      { inputTokens: 10, cachedInputTokens: 11 },
      { inputTokens: 10, cachedInputTokens: -1 },
      { inputTokens: 10.5, cachedInputTokens: 1 },
    ]) {
      add('invalid', usage);
      await expect(read(['invalid'])).rejects.toMatchObject({ code: 'model_usage_unavailable' });
    }
    add('wrong-source');
    f.executions.get('model-wrong-source')!.sessionId = 'other';
    await expect(read(['wrong-source'])).rejects.toMatchObject({
      code: 'model_usage_identity_mismatch',
    });
    expect(() =>
      decodeNativeRequest({
        method: 'toolMessages.usage',
        generation: 1,
        viewSelection: 2,
        historyEpoch: 0,
        readId: 'r',
        messageIds: ['usage-0'],
        executionId: 'unchecked',
      }),
    ).toThrow('invalid_native_request');
  } finally {
    f.manager.release();
  }
});

test('late cache metadata is confined to its original observed message and read scope', async () => {
  const f = fixture();
  const message: Message = {
    id: 'm',
    seq: '1',
    sessionId: 's',
    runId: 'r',
    role: 'assistant',
    status: 'complete',
    content: 'original',
    sourceIds: ['model'],
  };
  f.messages.set(message.id, message);
  let entered!: () => void, release!: (value: Execution) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.client.getExecution = async () => {
    entered();
    return new Promise<Execution>((resolve) => {
      release = resolve;
    });
  };
  const execution = {
    id: 'model',
    originStoreId: 'store',
    sessionId: 's',
    runId: 'r',
    kind: 'model',
    definitionId: 'fixed',
    definitionVersion: '1',
    status: 'succeeded',
    result: { content: 'original', usage: { inputTokens: 10, cachedInputTokens: 5 } },
    resultRevision: '1',
    cancelRequestedAt: null,
  } as Execution;
  const read = f.manager.usage({
    method: 'toolMessages.usage',
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'late-usage',
    messageIds: ['m'],
  });
  await started;
  f.scope = { ...f.scope, sessionId: 'other', viewSelection: 3 };
  release(execution);
  await expect(read).rejects.toMatchObject({ code: 'native_selection_changed' });
  f.scope = { ...f.scope, sessionId: 's', viewSelection: 2 };
  f.client.getExecution = async () => execution;
  let verified = 0;
  const verifyConnection = f.client.verifyConnection.bind(f.client);
  f.client.verifyConnection = async () => {
    if (++verified === 2) f.messages.set('m', { ...message, content: 'later body' });
    return verifyConnection();
  };
  await expect(
    f.manager.usage({
      method: 'toolMessages.usage',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'changed-usage',
      messageIds: ['m'],
    }),
  ).rejects.toMatchObject({ code: 'native_selection_changed' });
  f.manager.release();
});

test('tool receipts outside the bounded View retain exact outcomes and only unique original call targets; repeated call IDs never establish execution identity', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 241; index++) f.add(`m${index}`, 'succeeded');
    f.add('failed', 'failed');
    f.add('cancelled', 'cancelled');
    f.add('unknown', 'outcome_unknown');
    f.executions.get('execution-m240')!.authorization = {
      dispatched: true,
      review: {
        executionId: 'original-review',
        status: 'succeeded',
        decision: 'approve_once',
        reason: '原批准原因 雪🙂',
        requireApproval: false,
      },
    };
    const page = await f.list(['m240', 'failed', 'cancelled', 'unknown']);
    expect(page.entries.map((entry) => entry.status)).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'outcome_unknown',
    ]);
    expect(page.entries.map((entry) => entry.target)).toEqual([
      'm240 雪🙂',
      'failed 雪🙂',
      'cancelled 雪🙂',
      'unknown 雪🙂',
    ]);
    expect(f.reads).toEqual([
      'execution-m240',
      'execution-failed',
      'execution-cancelled',
      'execution-unknown',
    ]);
    expect(page.scope).toEqual(f.scope);
    expect(page.entries[0]!.authorization).toEqual(
      f.executions.get('execution-m240')!.authorization,
    );
    f.add('first-same-run', 'succeeded', 'shared');
    f.add('second-same-run', 'failed', 'shared');
    expect((await f.list(['second-same-run'])).entries[0]).toMatchObject({
      executionId: 'execution-second-same-run',
      status: 'failed',
    });
    expect((await f.list(['second-same-run'])).entries[0]!.target).toBeUndefined();
    const execution = f.executions.get('execution-failed')!;
    execution.result = { outcome: 'succeeded', content: 'original-failed' };
    expect((await f.list(['failed'])).entries).toEqual([]);
    execution.result = { outcome: 'failed', content: 'later unrelated body' };
    expect((await f.list(['failed'])).entries).toEqual([]);
    execution.result = { outcome: 'failed', content: 'original-failed' };
    execution.runId = 'm240';
    await expect(f.list(['failed'])).rejects.toMatchObject({
      code: 'tool_message_identity_mismatch',
    });
    await expect(f.list(['unobserved'])).rejects.toMatchObject({
      code: 'tool_message_unavailable',
    });
  } finally {
    f.manager.release();
  }
});

test('sealed Fork provenance is read-only, foreign or unsupported results cause no Execution GET, and close/selection change abort only the owned metadata read', async () => {
  const f = fixture();
  try {
    f.add('fork', 'failed');
    const message = f.messages.get('fork')!;
    message.originMessage = {
      storeId: 'store',
      sessionId: 'source',
      runId: 'source-run',
      messageId: 'original',
    };
    const execution = f.executions.get('execution-fork')!;
    execution.sessionId = 'source';
    execution.runId = 'source-run';
    execution.authorization = {
      dispatched: false,
      review: {
        executionId: 'later-review',
        status: 'succeeded',
        decision: 'reject',
        reason: 'later source state',
        requireApproval: false,
      },
    };
    expect((await f.list(['fork'])).entries[0]).toMatchObject({
      executionId: execution.id,
      status: 'failed',
    });
    expect((await f.list(['fork'])).entries[0]!.authorization).toBeUndefined();
    f.reads.length = 0;
    message.originMessage.storeId = 'old-store';
    expect((await f.list(['fork'])).entries).toEqual([]);
    expect(f.reads).toEqual([]);
    message.originMessage.storeId = 'store';
    message.originMessage.runId = null;
    expect((await f.list(['fork'])).entries).toEqual([]);
    expect(f.reads).toEqual([]);
    message.originMessage.runId = 'source-run';
    message.contentFormat = 'unsupported';
    expect((await f.list(['fork'])).entries).toEqual([]);
    expect(f.reads).toEqual([]);
    delete message.contentFormat;
    let release!: (value: Execution) => void, signal: AbortSignal | undefined;
    let started!: () => void;
    let ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.client.getExecution = (async (_id, options) => {
      signal = options?.signal;
      started();
      return new Promise<Execution>((resolve) => {
        release = resolve;
      });
    }) as AgentClient['getExecution'];
    const pending = f.manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'held',
      messageIds: ['fork'],
    });
    const rejection = pending.catch((error: unknown) => error);
    await ready;
    f.manager.close('held');
    expect(signal?.aborted).toBe(true);
    release(execution);
    expect(await rejection).toMatchObject({ code: 'native_selection_changed' });
    ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const next = f.manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'later',
      messageIds: ['fork'],
    });
    const changed = next.catch((error: unknown) => error);
    await ready;
    f.scope = { ...f.scope, historyEpoch: 1 };
    release(execution);
    expect(await changed).toMatchObject({ code: 'native_selection_changed' });
    expect(signal?.aborted).toBe(true);
  } finally {
    f.manager.release();
  }
});

test('tool metadata IPC has the same closed 32-message request and current reading scope', () => {
  const request = {
    method: 'toolMessages.list' as const,
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    readId: 'owned',
    messageIds: ['observed'],
  };
  expect(decodeNativeRequest(request)).toEqual(request);
  for (const change of [
    { executionId: 'arbitrary' },
    { messageIds: Array.from({ length: 33 }, (_, index) => `m${index}`) },
    { messageIds: ['same', 'same'] },
    { messageIds: ['../path'] },
    { viewSelection: 0 },
    { historyEpoch: -1 },
  ])
    expect(() => decodeNativeRequest({ ...request, ...change })).toThrow('invalid_native_request');
  expect(
    decodeNativeRequest({ method: 'toolMessages.close', generation: 1, readId: 'owned' }),
  ).toMatchObject({ method: 'toolMessages.close' });
});

test('observed Run history beyond the bounded View preserves restored terminal origins; sealed sources and foreign active Runs acquire no hot facts', async () => {
  const f = fixture(),
    reads: string[] = [];
  const run = (id: string): Run => ({
    id,
    originStoreId: 'store',
    originCommandId: `c-${id}`,
    sessionId: 's',
    status: 'completed',
    isActive: false,
    createdAt: 1000,
    finishedAt: 3000,
    reason: null,
  });
  f.client.getRun = async (id) => {
    reads.push(id);
    return run(id);
  };
  for (let index = 0; index < 241; index++)
    f.messages.set(`m-${index}`, {
      id: `m-${index}`,
      role: 'user',
      seq: String(index + 1),
      runId: `r-${index}`,
      sessionId: 's',
      status: 'complete',
      content: `exact ${index}`,
    });
  const request = (messageIds: string[], readId: string = crypto.randomUUID()) =>
    f.manager.runs({
      method: 'toolMessages.runs',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      messageIds,
      readId,
    });
  const page = await request(['m-240']);
  expect(page.runs).toEqual([
    {
      id: 'r-240',
      originStoreId: 'store',
      sessionId: 's',
      status: 'completed',
      isActive: false,
      createdAt: 1000,
      finishedAt: 3000,
      reason: null,
    },
  ]);
  expect('configuration' in page.runs[0]!).toBe(false);
  await expect(request(['never-observed'])).rejects.toMatchObject({
    code: 'tool_message_unavailable',
  });
  expect(reads).toEqual(['r-240']);
  const original = f.messages.get('m-240')!;
  f.messages.set('copied', {
    ...original,
    id: 'copied',
    originMessage: {
      storeId: 'store',
      sessionId: 's',
      messageId: original.id,
      runId: original.runId,
    },
  });
  expect((await request(['copied'])).runs).toEqual([]);
  expect(reads).toEqual(['r-240']);
  f.client.getRun = async (id) => ({ ...run(id), originStoreId: 'foreign' });
  expect((await request(['m-239'])).runs).toMatchObject([
    { id: 'r-239', originStoreId: 'foreign', sessionId: 's', status: 'completed', isActive: false },
  ]);
  f.client.getRun = async (id) => ({
    ...run(id),
    originStoreId: 'foreign',
    status: 'running',
    isActive: true,
    finishedAt: null,
  });
  expect((await request(['m-239'])).runs).toEqual([]);
  f.client.getRun = async (id) => ({ ...run(id), id: 'other' });
  await expect(request(['m-238'])).rejects.toMatchObject({
    code: 'tool_message_identity_mismatch',
  });
  expect(() =>
    decodeNativeRequest({
      method: 'toolMessages.runs',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'r',
      messageIds: Array.from({ length: 33 }, (_, i) => `m-${i}`),
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'toolMessages.runs',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'r',
      messageIds: ['m-1'],
      runId: 'unchecked',
    }),
  ).toThrow('invalid_native_request');
  let entered!: () => void, release!: (value: Run) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.client.getRun = async () => {
    entered();
    return new Promise<Run>((resolve) => {
      release = resolve;
    });
  };
  const pending = request(['m-237'], 'held').then(
    () => undefined,
    (cause: unknown) => cause,
  );
  await started;
  f.manager.close('held');
  release(run('r-237'));
  expect(await pending).toMatchObject({ code: 'native_selection_changed' });
});

test('known ask_user receipts keep the actual human answer and information cancellation; an ambiguous request or future version cannot invent question ownership', async () => {
  const f = fixture();
  const questions = [
    {
      question: '选择主线 雪🙂',
      options: [
        { label: '保留原代码', description: '完整迁入' },
        { label: '继续阅读', description: '查看源码' },
      ],
    },
    {
      question: '补充约束',
      options: [
        { label: 'macOS', description: '宿主优先' },
        { label: '等待', description: '暂缓' },
      ],
    },
  ];
  const set = (id: string, value: unknown) => {
    f.add(id, 'succeeded', `run-${id}`, 'ask_user');
    f.messages.get(`call-${id}`)!.toolCalls![0]!.arguments = JSON.stringify({ questions });
    const content = JSON.stringify(value);
    f.messages.get(id)!.content = content;
    f.executions.get(`execution-${id}`)!.result = { outcome: 'succeeded', content };
  };
  set('answered', {
    answer: '选择主线 雪🙂: 保留原代码\n补充约束:  原文 雪🙂\r\n',
    answers: { q1: '保留原代码', q2: ' 原文 雪🙂\r\n' },
  });
  const answered = (await f.list(['answered'])).entries[0]!;
  expect(answered.ask?.questions).toEqual([
    { id: 'q1', question: questions[0]!.question },
    { id: 'q2', question: questions[1]!.question },
  ]);
  expect(answered.ask?.answers).toEqual({ q1: '保留原代码', q2: ' 原文 雪🙂\r\n' });
  expect(answered.status).toBe('succeeded');
  set('cancelled-info', { cancelled: true });
  const cancelled = (await f.list(['cancelled-info'])).entries[0]!;
  expect(cancelled.ask?.cancelled).toBe(true);
  expect(cancelled.status).toBe('succeeded');
  f.messages
    .get('call-answered')!
    .toolCalls!.push({ ...f.messages.get('call-answered')!.toolCalls![0]! });
  expect((await f.list(['answered'])).entries[0]!.ask?.questions).toEqual([]);
  expect((await f.list(['answered'])).entries[0]!.ask?.summary).toBe(answered.ask?.summary);
  f.executions.get('execution-answered')!.definitionVersion = 'future';
  expect((await f.list(['answered'])).entries[0]!.ask).toBeUndefined();
});
