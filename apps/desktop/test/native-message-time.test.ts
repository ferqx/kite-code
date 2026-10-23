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
