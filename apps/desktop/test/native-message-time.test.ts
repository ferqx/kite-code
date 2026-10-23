import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { desktopConversationMessages, desktopMessages } from '../src/native-presentation';

const message = (id: string, createdAt?: number): Message => ({
  id,
  sessionId: 'session',
  runId: 'run',
  seq: '1',
  role: 'user',
  status: 'complete',
  content: id,
  ...(createdAt === undefined ? {} : { createdAt }),
});

test('desktop carries recorded message time without inventing a timestamp for unknown history', () => {
  expect(
    desktopMessages([message('known', 123), message('unknown')]).map((row) => row.createdAtMs),
  ).toEqual([123, undefined]);
});

test('Agent mail and result presentation preserve recorded time and keep unknown time absent', () => {
  const mail: Message = {
    ...message('mail', 456),
    role: 'system',
    agentMessage: {
      messageId: 'mail-command',
      sourceSessionId: 'child',
      sourceExecutionId: 'sender',
      name: 'Worker',
      contentComplete: true,
    },
  };
  const result: Message = {
    ...message('result', 789),
    role: 'system',
    agentResult: {
      sourceId: 'source',
      executionId: 'carrier',
      resultRevision: '1',
      childSessionId: 'child',
      childRunId: null,
      name: 'Worker',
      outcome: 'succeeded',
      contentComplete: true,
    },
  };
  expect(
    desktopMessages([mail, result, { ...mail, id: 'unknown', createdAt: undefined }]).map((row) => [
      row.systemKind,
      row.createdAtMs,
    ]),
  ).toEqual([
    ['agent_message', 456],
    ['agent_result', 789],
    ['agent_message', undefined],
  ]);
});

test('business input takeover preserves the original input time without changing independent duplicate text', () => {
  const raw = {
    ...message('raw', 100),
    humanInput: { inputCommandId: 'input', duplicateOfMessageId: 'saved' },
  };
  const saved = { ...message('saved', 900), humanInput: { inputCommandId: 'input' } };
  const separate = { ...message('separate', 1000), content: saved.content };
  const result = desktopConversationMessages([raw, saved, separate]);
  expect(result.map((row) => [row.id, row.createdAt])).toEqual([
    ['saved', 100],
    ['separate', 1000],
  ]);
  expect(saved.createdAt).toBe(900);
  expect(
    desktopConversationMessages([{ ...raw, createdAt: undefined }, saved])[0]?.createdAt,
  ).toBeUndefined();
});
