import { expect, test } from 'bun:test';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import { estimateModelContext } from '../../src/context-estimate';

test('request estimate counts exact Unicode content, Tool calls and schemas with original framing', () => {
  const messages = [
    { role: 'system' as const, content: '系统🙂 exact' },
    {
      role: 'assistant' as const,
      content: '回答',
      toolCalls: [{ id: 'call', name: 'files.read', arguments: '{"path":"中文.ts"}' }],
    },
    { role: 'tool' as const, content: '完整输出', toolCallId: 'call' },
  ];
  const tools = [
    {
      id: 'files.read',
      definitionVersion: '1',
      description: '只读文件',
      inputSchema: { type: 'object' },
    },
  ];
  const result = estimateModelContext(
    { messages, tools },
    { contextWindowTokens: 10000, maxOutputTokens: 2000 },
  );
  const system = countTokens(messages[0]!.content);
  const transcript =
    countTokens(messages[1]!.content) +
    countTokens(JSON.stringify(messages[1]!.toolCalls)) +
    countTokens(messages[2]!.content) +
    countTokens('call');
  const schema = countTokens(
    JSON.stringify({
      name: tools[0]!.id,
      description: tools[0]!.description,
      inputSchema: tools[0]!.inputSchema,
    }),
  );
  expect(result.estimate).toEqual({
    systemTokens: system,
    transcriptTokens: transcript,
    toolSchemaTokens: schema,
    framingTokens: 20,
    totalInputTokens: system + transcript + schema + 20,
  });
  expect(result.usableInputTokens).toBe(6976);
  expect(result.utilization).toBe(result.estimate.totalInputTokens / 6976);
  expect(estimateModelContext({ messages, tools }, { contextWindowTokens: 10000 })).toMatchObject({
    estimate: result.estimate,
    providerSafetyMarginTokens: 0,
  });
  expect(
    estimateModelContext({ messages, tools }, { contextWindowTokens: 10000 }).utilization,
  ).toBeUndefined();
  expect(estimateModelContext({ messages, tools }, {}, 400).contextWindowTokens).toBeUndefined();
  expect(
    estimateModelContext(
      { messages, tools },
      { contextWindowTokens: 10000, maxOutputTokens: 2000 },
      1000,
    ).usableInputTokens,
  ).toBe(7976);
});
