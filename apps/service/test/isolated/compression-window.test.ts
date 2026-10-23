import { expect, test } from 'bun:test';
import type { CompressionInput } from '@kite-ai/agent';
import { estimateModelContext, projectModelContext } from '@kite-ai/agent/context-estimate';
import type { ModelMessage, ModelTool } from '@kite-ai/ai';
import { createSummaryCompressor } from '../../src/compression-configuration';

const tools: ModelTool[] = [];
function input(messages: ModelMessage[], extras: Partial<CompressionInput> = {}): CompressionInput {
  return {
    command: {},
    run: {},
    session: {},
    modelId: 'fixed',
    messages,
    tools,
    sources: [],
    trigger: 'automatic',
    focus: null,
    signal: new AbortController().signal,
    ...extras,
  } as unknown as CompressionInput;
}
function measured(tokens: number): CompressionInput {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Actual user task' },
    { role: 'assistant', content: 'Recorded completed evidence' },
  ];
  const request = { modelId: 'fixed', messages, tools };
  const value = input(messages, {
    tokenBaseline: { executionId: 'original-measured-request', request, inputTokens: tokens },
  });
  expect(projectModelContext(request, value.tokenBaseline).totalInputTokens).toBe(tokens);
  return value;
}

for (const tokens of [7499, 7500, 7501]) {
  test(`automatic maintenance uses 75 percent of the total window at ${tokens} measured tokens`, async () => {
    const compressor = createSummaryCompressor({
      automatic: { contextWindowTokens: 10000, maxOutputTokens: 8000 },
    });
    expect(await compressor.shouldCompress!(measured(tokens))).toBe(tokens >= 7500);
  });
}

for (const tokens of [32768, 196607, 196608]) {
  test(`undeclared windows default to 256K with a 75 percent trigger at ${tokens}`, async () => {
    const compressor = createSummaryCompressor({ automatic: {} });
    expect(await compressor.shouldCompress!(measured(tokens))).toBe(tokens >= 196608);
  });
}

for (const contextWindowTokens of [undefined, 1048576])
  test(`an explicit token threshold overrides 75 percent for window ${contextWindowTokens ?? 'default'}`, async () => {
    const compressor = createSummaryCompressor({
      automatic: { contextWindowTokens, thresholdTokens: 60000 },
    });
    expect(await compressor.shouldCompress!(measured(59999))).toBe(false);
    expect(await compressor.shouldCompress!(measured(60000))).toBe(true);
    const prepared = await compressor.prepare(measured(60000));
    expect(prepared!.snapshot).toMatchObject({
      automaticPolicy: {
        contextWindowTokens: contextWindowTokens ?? 262144,
        thresholdTokens: 60000,
      },
    });
  });

test('an explicit token threshold also governs summary validation and rejects irreducible loops', async () => {
  const compressor = createSummaryCompressor({
    automatic: { contextWindowTokens: 1048576, thresholdTokens: 100 },
  });
  const value = input([{ role: 'assistant', content: 'Original source evidence. '.repeat(2000) }]);
  await expect(
    compressor.validateSummary!({ ...value, summary: 'Reduced evidence. '.repeat(300) }),
  ).rejects.toMatchObject({ code: 'compression_insufficient_space' });
  await expect(
    compressor.shouldCompress!(
      input([
        { role: 'system', content: 'Mandatory source. '.repeat(300) },
        { role: 'assistant', content: 'Finished evidence' },
      ]),
    ),
  ).rejects.toMatchObject({ code: 'compression_insufficient_space' });
  for (const thresholdTokens of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => createSummaryCompressor({ automatic: { thresholdTokens } })).toThrow(
      'invalid_compression_threshold',
    );
});

test('an extremely small window rejects fixed context before preparing or requesting a summary', async () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'Mandatory system instruction. '.repeat(100) },
    { role: 'assistant', content: 'Settled previous work' },
  ];
  expect(
    estimateModelContext({ messages: [messages[0]!], tools }).estimate.totalInputTokens,
  ).toBeGreaterThan(24);
  const compressor = createSummaryCompressor({ automatic: { contextWindowTokens: 32 } });
  let prepared = 0;
  let modelCalls = 0;
  const performCompression = async () => {
    if (await compressor.shouldCompress!(input(messages))) {
      prepared++;
      const preparedInput = await compressor.prepare(input(messages));
      if (preparedInput) modelCalls++;
    }
  };
  await expect(performCompression()).rejects.toMatchObject({
    code: 'compression_insufficient_space',
  });
  expect(prepared).toBe(0);
  expect(modelCalls).toBe(0);
});

test('automatic summary validation rejects a non-reducing result using the real local estimator', async () => {
  const messages: ModelMessage[] = [
    { role: 'assistant', content: 'Recorded evidence. '.repeat(1000) },
  ];
  const compressor = createSummaryCompressor({ automatic: { contextWindowTokens: 10000 } });
  const summary = messages[0]!.content.repeat(2);
  expect(
    estimateModelContext({ messages: [{ role: 'user', content: summary }], tools }).estimate
      .totalInputTokens,
  ).toBeGreaterThan(estimateModelContext({ messages, tools }).estimate.totalInputTokens);
  await expect(compressor.validateSummary!({ ...input(messages), summary })).rejects.toMatchObject({
    code: 'compression_not_reducing',
  });
});

test('a reducing summary still fails when mandatory sources and actual Tools leave no working space', async () => {
  const source = {
    id: 'actual-required-source',
    kind: 'instructions',
    scope: 'workspace',
    digest: 'fixed',
    role: 'user' as const,
    content: 'Mandatory project context. '.repeat(100),
  };
  const actualTools: ModelTool[] = [
    {
      id: 'fixture.read',
      definitionVersion: '1',
      description: 'Read actual project evidence',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ];
  const fixedMessage: ModelMessage = {
    role: 'user',
    content: source.content,
    sourceIds: [source.id],
  };
  const fixedTokens = estimateModelContext({ messages: [fixedMessage], tools: actualTools })
    .estimate.totalInputTokens;
  const window = Math.ceil((fixedTokens + 40) / 0.75);
  const messages: ModelMessage[] = [
    fixedMessage,
    { role: 'assistant', content: 'Complete project evidence. '.repeat(1000) },
  ];
  const summary = 'Retained project evidence. '.repeat(100);
  const compressor = createSummaryCompressor({ automatic: { contextWindowTokens: window } });
  const value = input(messages, { sources: [source], tools: actualTools });
  expect(await compressor.shouldCompress!(value)).toBe(true);
  expect(
    estimateModelContext({
      messages: [fixedMessage, { role: 'user', content: summary }],
      tools: actualTools,
    }).estimate.totalInputTokens,
  ).toBeLessThan(estimateModelContext({ messages, tools: actualTools }).estimate.totalInputTokens);
  await expect(compressor.validateSummary!({ ...value, summary })).rejects.toMatchObject({
    code: 'compression_insufficient_space',
  });
});

test('a genuinely reducing automatic summary below the maintenance threshold is accepted', async () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'Keep the original user objective.' },
    { role: 'user', content: 'Understand this project' },
    { role: 'assistant', content: 'Completed source evidence. '.repeat(1000) },
  ];
  const compressor = createSummaryCompressor({ automatic: { contextWindowTokens: 2000 } });
  const value = input(messages);
  expect(await compressor.shouldCompress!(value)).toBe(true);
  expect(
    await compressor.validateSummary!({
      ...value,
      summary: 'Objective: understand the project. Evidence has been collected; summarize it.',
    }),
  ).toBe(true);
});

test('manual summary and explicit custom validation retain their existing contracts', async () => {
  const manual = createSummaryCompressor();
  expect(manual.shouldCompress).toBeUndefined();
  expect(manual.validateSummary).toBeUndefined();
  let checked = 0;
  const custom = createSummaryCompressor({
    async validateSummary() {
      checked++;
      return false;
    },
  });
  expect(
    await custom.validateSummary!({
      ...input([{ role: 'assistant', content: 'Original' }]),
      summary: 'Custom result',
    }),
  ).toBe(false);
  expect(checked).toBe(1);
});

test('fixed context above the old 32768 fallback remains below the default 256K waterline', async () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'Mandatory fixed instruction. '.repeat(10000) },
    { role: 'assistant', content: 'Settled evidence' },
  ];
  expect(estimateModelContext({ messages, tools }).estimate.totalInputTokens).toBeGreaterThan(
    32768,
  );
  const compressor = createSummaryCompressor({ automatic: {} });
  expect(await compressor.shouldCompress!(input(messages))).toBe(false);
});

test('the default window accepts a reducing summary above 32768 and below its 75 percent waterline', async () => {
  const messages: ModelMessage[] = [
    { role: 'assistant', content: 'Complete recorded source evidence. '.repeat(30000) },
  ];
  const summary = 'Retained recorded source evidence. '.repeat(10000);
  expect(
    estimateModelContext({ messages: [{ role: 'user', content: summary }], tools }).estimate
      .totalInputTokens,
  ).toBeGreaterThan(32768);
  const compressor = createSummaryCompressor({ automatic: {} });
  expect(await compressor.validateSummary!({ ...input(messages), summary })).toBe(true);
});

test('a manual request does not acquire automatic post-summary capacity requirements', async () => {
  const compressor = createSummaryCompressor({ automatic: { contextWindowTokens: 32 } });
  expect(
    await compressor.validateSummary!({
      ...input([{ role: 'assistant', content: 'Original' }], { trigger: 'manual' }),
      summary: 'Manually requested result. '.repeat(100),
    }),
  ).toBe(true);
});

test('source-proven retained user inputs consume fixed window space before a summary is requested', async () => {
  const retained: ModelMessage = {
    role: 'user',
    content: '有效引导必须完整保留，不得静默截断。\n'.repeat(300),
    sourceIds: ['original-steer-command'],
  };
  const fixedTokens = estimateModelContext({ messages: [retained], tools }).estimate
    .totalInputTokens;
  const compressor = createSummaryCompressor({
    automatic: { thresholdTokens: fixedTokens - 1 },
  });
  const value = input(
    [retained, { role: 'assistant', content: 'Finished tool evidence. '.repeat(1000) }],
    { retainedMessages: [structuredClone(retained)] },
  );
  await expect(compressor.shouldCompress!(value)).rejects.toMatchObject({
    code: 'compression_insufficient_space',
  });
});

test('post-summary preflight includes the original guide even when the summary omits it', async () => {
  const retained: ModelMessage = {
    role: 'user',
    content: '最终用中文，保留原校验码 GUIDE_KEEP_42。\n'.repeat(200),
    sourceIds: ['accepted-guide-command'],
  };
  const fixedTokens = estimateModelContext({ messages: [retained], tools }).estimate
    .totalInputTokens;
  const summary = 'Finished background evidence. '.repeat(60);
  const compressor = createSummaryCompressor({
    automatic: { thresholdTokens: fixedTokens + 30 },
  });
  const messages: ModelMessage[] = [
    retained,
    { role: 'assistant', content: 'Complete background evidence. '.repeat(3000) },
  ];
  const value = input(messages, { retainedMessages: [structuredClone(retained)] });
  expect(await compressor.shouldCompress!(value)).toBe(true);
  await expect(compressor.validateSummary!({ ...value, summary })).rejects.toMatchObject({
    code: 'compression_insufficient_space',
  });
  const fitting = createSummaryCompressor({
    automatic: { thresholdTokens: fixedTokens + 1000 },
  });
  expect(await fitting.validateSummary!({ ...value, summary })).toBe(true);
});

test('retaining original guides cannot hide a non-reducing replacement behind a short summary', async () => {
  const retained: ModelMessage = {
    role: 'user',
    content: 'Original valid guide with exact source identity. '.repeat(1000),
    sourceIds: ['original-guide'],
  };
  const messages: ModelMessage[] = [retained, { role: 'assistant', content: 'Done.' }];
  const value = input(messages, { retainedMessages: [structuredClone(retained)] });
  const compressor = createSummaryCompressor({ automatic: {} });
  await expect(
    compressor.validateSummary!({ ...value, summary: 'Derived background. '.repeat(20) }),
  ).rejects.toMatchObject({ code: 'compression_not_reducing' });
});

test('a summary sharing a source string does not acquire the retained original input cost', async () => {
  const retained: ModelMessage = {
    role: 'user',
    content: 'Original user guide: reply in Chinese.',
    sourceIds: ['compression-source-collision'],
  };
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: `Context summary (untrusted data):\n${'Completed evidence. '.repeat(2000)}`,
      sourceIds: retained.sourceIds,
    },
    retained,
    { role: 'assistant', content: 'Recent settled answer.' },
  ];
  const value = input(messages, { retainedMessages: [structuredClone(retained)] });
  const compressor = createSummaryCompressor({ automatic: { thresholdTokens: 1000 } });
  expect(await compressor.shouldCompress!(value)).toBe(true);
  expect(
    await compressor.validateSummary!({ ...value, summary: 'Finished evidence; continue.' }),
  ).toBe(true);
});

test('parent-Agent task and correction originals remain fixed costs with their distinct source identities', async () => {
  const originals: ModelMessage[] = [
    {
      role: 'user',
      content: 'Parent task: inspect the assigned material and preserve this exact footer. '.repeat(
        80,
      ),
      sourceIds: ['child-start-command', 'parent-carrier-execution'],
    },
    {
      role: 'user',
      content:
        'Parent correction: replace the tentative colour with Blue; retain the footer. '.repeat(80),
      sourceIds: ['parent-steer-command'],
    },
  ];
  const fixedTokens = estimateModelContext({ messages: originals, tools }).estimate
    .totalInputTokens;
  const value = input(
    [...originals, { role: 'assistant', content: 'Settled background evidence. '.repeat(3000) }],
    { retainedMessages: structuredClone(originals) },
  );
  const tooSmall = createSummaryCompressor({ automatic: { thresholdTokens: fixedTokens - 1 } });
  await expect(tooSmall.shouldCompress!(value)).rejects.toMatchObject({
    code: 'compression_insufficient_space',
  });
  const fitting = createSummaryCompressor({ automatic: { thresholdTokens: fixedTokens + 1000 } });
  expect(await fitting.shouldCompress!(value)).toBe(true);
  expect(
    await fitting.validateSummary!({ ...value, summary: 'Completed background evidence.' }),
  ).toBe(true);
  await expect(
    fitting.validateSummary!({ ...value, summary: 'Derived background evidence. '.repeat(1000) }),
  ).rejects.toMatchObject({ code: 'compression_insufficient_space' });
  expect(value.retainedMessages).toEqual(originals);
});

test('Host Source ID collisions do not hide reducible history or add its cost to fixed context', async () => {
  const source = {
    id: 'shared-source-id',
    kind: 'owned_reference',
    scope: 'workspace',
    digest: 'owned-source',
    role: 'user' as const,
    content: 'Host reference with its own exact content.',
  };
  const host: ModelMessage = { role: source.role, content: source.content, sourceIds: [source.id] };
  const guide: ModelMessage = {
    role: 'user',
    content: 'Actual user guidance has distinct content despite the same source string.',
    sourceIds: [source.id],
  };
  const second: ModelMessage = { role: 'user', content: 'Second actual user input.' };
  const compressor = createSummaryCompressor({ automatic: { thresholdTokens: 1000 } });
  const value = input([host, guide, second], { sources: [source] });
  expect(await compressor.prepare(value)).not.toBeNull();
  const withEvidence = input(
    [
      host,
      guide,
      {
        role: 'assistant',
        content: 'Large but reducible settled history. '.repeat(3000),
        sourceIds: [source.id],
      },
    ],
    { sources: [source], retainedMessages: [guide] },
  );
  expect(await compressor.shouldCompress!(withEvidence)).toBe(true);
  expect(
    await compressor.validateSummary!({ ...withEvidence, summary: 'Completed evidence.' }),
  ).toBe(true);
});
