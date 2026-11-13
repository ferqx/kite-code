import { expect, test } from '#kite-test';
import { canonicalJson } from '../../../src/json';
import type { SqliteOperations } from '../../../src/storage/sqlite/operations';
import { trajectoryOutputPresence } from '../../../src/storage/sqlite/trajectory-output-presence';
import type { Json } from '../../../src/storage/types';
import {
  messageTrajectoryDisplay,
  modelTrajectoryDisplay,
  sealedModelTrajectoryDisplay,
  toolTrajectoryDisplay,
} from '../../../src/trajectory/display';
import { toolResultPresentation } from '../../../src/trajectory/tool-result-presentation';

test('message snippets copy only verified inline public content and never reconstruct private message siblings', () => {
  const body = {
    content: '  用户\n公开问题🙂  ',
    reasoning: 'PRIVATE_REASONING',
    images: [{ data: 'PRIVATE_BASE64' }],
    checkpoint: { content: 'PRIVATE_CHECKPOINT' },
    source: { token: 'PRIVATE_SOURCE' },
  };
  expect(messageTrajectoryDisplay('user', body)).toEqual({
    kind: 'message',
    title: '用户提示词',
    summary: '用户 公开问题🙂',
  });
  const long = messageTrajectoryDisplay('assistant', { ...body, content: '🙂'.repeat(200) });
  expect(long.title).toBe('Agent 回复');
  expect(long.summary!.length).toBeLessThanOrEqual(160);
  expect(long.summary).toEndWith('…');
  expect(long.summary).not.toContain('\ufffd');
  const absent = messageTrajectoryDisplay('assistant', {
    checkpoint: body.checkpoint,
    reasoning: body.reasoning,
    images: body.images,
  });
  expect(absent).not.toHaveProperty('summary');
  expect(JSON.stringify([messageTrajectoryDisplay('user', body), long, absent])).not.toContain(
    'PRIVATE_',
  );
});

test('index displays only owner-defined targets, never Shell commands, prompts, credentials or arbitrary results', () => {
  const shell = {
    definitionId: 'shell.execute',
    definitionVersion: '1',
    extensionId: 'builtin.shell',
    input: {
      command: 'curl --password PRIVATE',
      description: '  运行\n测试  ',
      environment: { TOKEN: 'PRIVATE' },
    },
  };
  expect(toolTrajectoryDisplay(shell)).toEqual({
    kind: 'shell',
    operation: 'execute',
    title: '执行 Shell 命令',
    summary: '运行 测试',
  });
  expect(toolTrajectoryDisplay({ ...shell, extensionId: 'custom' })).toBeUndefined();
  expect(toolTrajectoryDisplay({ ...shell, definitionVersion: '2' })).toBeUndefined();
  expect(
    toolTrajectoryDisplay({ ...shell, input: { command: 'curl --password PRIVATE' } }),
  ).not.toHaveProperty('summary');
  expect(
    toolTrajectoryDisplay({
      ...shell,
      input: { command: 'PRIVATE', description: '检'.repeat(321) },
    })?.summary,
  ).toHaveLength(320);
  expect(
    toolTrajectoryDisplay({
      ...shell,
      definitionId: 'shell.wait',
      input: { description: 'PRIVATE' },
    }),
  ).not.toHaveProperty('summary');
  expect(
    toolTrajectoryDisplay({
      definitionId: 'web_fetch',
      definitionVersion: '1',
      extensionId: 'builtin.web',
      input: { url: 'https://user:PRIVATE@example.com/docs?token=PRIVATE#PRIVATE' },
    }),
  ).toMatchObject({ summary: 'https://example.com/docs' });
  expect(
    toolTrajectoryDisplay({
      definitionId: 'files.read',
      definitionVersion: '5',
      extensionId: 'builtin.files',
      input: { path: 'src/guard.ts' },
    }),
  ).toMatchObject({ title: '读取文件', summary: 'src/guard.ts' });
  expect(
    toolTrajectoryDisplay({
      definitionId: 'files.read',
      definitionVersion: '5',
      extensionId: 'builtin.files',
      input: { path: 'a\nPRIVATE' },
    }),
  ).not.toHaveProperty('summary');
});

test('model display uses the frozen actual provider model and counts, without copying message content or guessing large body counts', () => {
  const metadata = {
    adapter: {
      provider: { availability: 'available', modelId: 'provider-model' },
      PRIVATE: 'PRIVATE',
    },
    context: { toolSurface: [{ id: 'visible' }] },
  };
  expect(
    modelTrajectoryDisplay(
      {
        modelId: 'alias',
        messages: [
          { role: 'system', content: 'PRIVATE' },
          { role: 'user', content: 'PRIVATE' },
          { role: 'assistant', content: 'PRIVATE' },
        ],
        tools: [{ id: 'internal' }, { id: 'hidden' }],
      },
      metadata,
    ),
  ).toEqual({
    kind: 'model',
    operation: 'request',
    title: '模型请求',
    modelName: 'provider-model',
    requestContext: { systemMessages: 1, historyMessages: 2, tools: 1 },
  });
  expect(
    modelTrajectoryDisplay({ kind: 'model_body', reference: { PRIVATE: 'PRIVATE' } }, metadata),
  ).not.toHaveProperty('requestContext');
  expect(
    modelTrajectoryDisplay({ modelId: 'alias' }, { adapter: { availability: 'unavailable' } }),
  ).not.toHaveProperty('modelName');
});

test('sealed model summaries are closed model-only counts and identity; old shells remain honestly incomplete', () => {
  const display = {
    kind: 'model' as const,
    operation: 'request' as const,
    title: '模型请求',
    modelName: 'actual-model',
    requestContext: { systemMessages: 1, historyMessages: 2, tools: 3 },
  };
  expect(sealedModelTrajectoryDisplay(display)).toEqual(display);
  expect(modelTrajectoryDisplay({ body: {} }, { version: 1, body: {}, display })).toEqual(display);
  for (const invalid of [
    { ...display, summary: 'PRIVATE' },
    { ...display, raw: 'PRIVATE' },
    { ...display, kind: 'shell' },
    { ...display, operation: 'execute' },
    { ...display, requestContext: { ...display.requestContext, prompt: 'PRIVATE' } },
    { ...display, requestContext: { ...display.requestContext, tools: -1 } },
  ])
    expect(sealedModelTrajectoryDisplay(invalid)).toBeUndefined();
  expect(
    modelTrajectoryDisplay({ modelId: 'opaque-adapter', body: {} }, { version: 1, body: {} }),
  ).toEqual({ kind: 'model', operation: 'request', title: '模型请求' });
});

test('the six current Task result operations keep their real admission observations and reject unrelated receipt text', () => {
  for (const operation of ['spawn', 'follow_up', 'message', 'events', 'list', 'interrupt']) {
    const details = {
      accepted: true,
      agent_id: 'child',
      state: 'queued',
      delivery: 'queued',
      private: 'PRIVATE',
    };
    const input = {
      definitionId: `task.${operation}`,
      definitionVersion: '1',
      extensionId: 'builtin.task',
      executionId: 'tool',
      input: {},
      result: { content: canonicalJson(details), details },
    };
    expect(toolResultPresentation(input)).toMatchObject({
      kind: 'task',
      operation,
      status: 'queued',
      accepted: true,
    });
    expect(JSON.stringify(toolResultPresentation(input))).not.toContain('PRIVATE');
    expect(
      toolResultPresentation({ ...input, result: { ...input.result, content: 'different' } }),
    ).toBeUndefined();
  }
});

test('inline output presence never guesses old missing fields and remains incomplete for non-success states', () => {
  const db = new Proxy(
    {},
    {
      get() {
        throw Error('inline_presence_must_not_query_or_read');
      },
    },
  ) as SqliteOperations;
  const reference = {
    kind: 'model_output' as const,
    evidenceId: 'exact-ref',
    contentVersion: 'exact-version',
    availability: 'available' as const,
    mediaType: 'application/json',
  };
  const model = { kind: 'model', state: 'succeeded' };
  const calls = [{ id: 'call', name: 'tool', arguments: '{}' }];
  const unknownOutputs: Json[] = [
    { content: '' },
    { toolCalls: calls },
    { content: '', toolCalls: [{}] },
    { content: '', toolCalls: [{ id: '', name: 'tool', arguments: '{}' }] },
    { content: '', toolCalls: [{ id: 'call', name: '', arguments: '{}' }] },
    { content: '', toolCalls: null },
    { content: '', modelOutput: { kind: 'unverified' }, toolCalls: calls },
  ];
  for (const value of unknownOutputs)
    expect(trajectoryOutputPresence(db, model, value, true, reference)).toBeUndefined();
  const source = {
    content: '',
    toolCalls: calls,
    get reasoning(): string {
      throw Error('private_reasoning_must_not_be_read');
    },
  };
  expect(trajectoryOutputPresence(db, model, source, true, reference)).toEqual({
    hasText: false,
    toolCallCount: 1,
    complete: true,
    evidenceId: 'exact-ref',
    contentVersion: 'exact-version',
  });
  expect(
    trajectoryOutputPresence(db, model, { content: ' ', toolCalls: calls }, true, reference)
      ?.hasText,
  ).toBe(true);
  expect(
    trajectoryOutputPresence(db, model, { content: '', toolCalls: [] }, true, reference),
  ).toMatchObject({ hasText: false, toolCallCount: 0, complete: true });
  for (const state of ['running', 'failed', 'cancelled', 'outcome_unknown']) {
    expect(
      trajectoryOutputPresence(
        db,
        { kind: 'model', state },
        { content: '', toolCalls: calls },
        false,
        reference,
      ),
    ).toMatchObject({ hasText: false, toolCallCount: 1, complete: false });
    expect(
      trajectoryOutputPresence(
        db,
        { kind: 'model', state },
        { content: '', toolCalls: calls },
        true,
        reference,
      ),
    ).toBeUndefined();
  }
});
