import { expect, test } from 'bun:test';
import type { Message, Run } from '@kite-ai/client';
import { completeRunReplies } from '../src/run-reply-copy';

const run: Run = {
  id: 'run',
  sessionId: 'session',
  originCommandId: 'command',
  originStoreId: 'store',
  status: 'completed',
  isActive: false,
  createdAt: 1,
  finishedAt: 2,
  reason: null,
};
const message = (
  id: string,
  seq: string,
  content: string,
  extra: Partial<Message> = {},
): Message => ({
  id,
  seq,
  content,
  sessionId: 'session',
  runId: 'run',
  role: 'assistant',
  status: 'complete',
  ...extra,
});
const replies = (
  messages: Message[],
  runs: Run[] = [run],
  fullContent?: (message: Message) => string | undefined,
) => completeRunReplies({ messages, runs, sessionId: 'session', fullContent });
const body = (
  content: string,
  extra: Partial<NonNullable<Message['outputBody']>> = {},
): NonNullable<Message['outputBody']> => ({
  kind: 'model_output',
  executionId: 'model',
  complete: true,
  contentBytes: String(Buffer.byteLength(content)),
  reasoningBytes: '0',
  toolCallCount: 0,
  ...extra,
});

test('complete original Run reply orders all plain assistant segments by exact sequence and excludes tool parameters and other ownership', () => {
  const messages = [
    message('final', '9007199254740995', '最终正文 中文🙂'),
    message('user', '9007199254740991', 'USER_TEXT', { role: 'user' }),
    message('first', '9007199254740992', '第一段 **原始 Markdown**', {
      toolCalls: [{ id: 'call', name: 'shell', arguments: 'SECRET_TOOL_ARGUMENTS' }],
    }),
    message('tool', '9007199254740993', 'TOOL_OUTPUT', { role: 'tool' }),
    message('child', '9007199254740994', 'CHILD_BODY', { sessionId: 'child-session' }),
    message('other-run', '9007199254740996', 'OTHER_RUN', { runId: 'other' }),
  ];
  const original = structuredClone(messages);
  expect([...replies(messages)]).toEqual([
    ['final', { runId: 'run', text: '第一段 **原始 Markdown**\n\n最终正文 中文🙂' }],
  ]);
  expect(messages).toEqual(original);
  expect(
    completeRunReplies({ messages, runs: [run], sessionId: 'session', copyScope: 'final' }).get(
      'final',
    ),
  ).toEqual({ runId: 'run', text: '最终正文 中文🙂' });
});

test('body-backed segments require current full content without preview fallback; reasoning-only zero content requires no read', () => {
  const first = message('first', '1', 'SHORT PREVIEW', { outputBody: body('完整第一段') });
  const reasoningOnly = message('reasoning-only', '2', '', {
    outputBody: body('', { reasoningBytes: '2048' }),
  });
  const final = message('final', '3', 'FINAL PREVIEW', { outputBody: body('完整最终段') });
  const reads: string[] = [];
  const result = replies([first, reasoningOnly, final], [run], (item) => {
    reads.push(item.id);
    return item.id === 'first' ? '完整第一段' : '完整最终段';
  });
  expect(result.get('final')).toEqual({ runId: 'run', text: '完整第一段\n\n完整最终段' });
  expect(reads).toEqual(['first', 'final']);
  expect(replies([first, final]).get('final')?.text).toBeUndefined();
  expect(
    replies([first, final], [run], (item) => (item.id === 'final' ? '完整最终段' : undefined)).get(
      'final',
    )?.text,
  ).toBeUndefined();
});

test('only an exact completed inactive original Run with a plain complete final assistant can qualify', () => {
  const final = message('final', '2', 'final');
  expect(replies([final], []).size).toBe(0);
  expect(replies([final], [{ ...run, sessionId: 'foreign' }]).size).toBe(0);
  expect(replies([final], [{ ...run, isActive: true }]).size).toBe(0);
  expect(replies([final], [{ ...run, status: 'failed' }]).size).toBe(0);
  for (const invalid of [
    { status: 'incomplete' as const },
    { contentFormat: 'unsupported' as const },
    { toolCalls: [{ id: 'call', name: 'shell', arguments: '{}' }] },
    { outputBody: body('final', { complete: false }) },
    { outputBody: body('final', { toolCallCount: 1 }) },
    { outputBody: body('final', { readAvailability: 'unsupported' }) },
    {
      originMessage: {
        storeId: 'store',
        sessionId: 'session',
        runId: 'run',
        messageId: 'original',
      },
    },
    { sessionId: 'foreign' },
  ])
    expect(replies([{ ...final, ...invalid }]).get('final')?.text).toBeUndefined();
  expect(replies([final, message('later-tool', '3', 'tool', { role: 'tool' })]).size).toBe(0);
});

test('earlier incomplete or future format assistant body prevents whole reply copying while restored terminal provenance remains readable', () => {
  const final = message('final', '2', 'final');
  for (const first of [
    message('first', '1', 'prefix', { status: 'incomplete' }),
    message('first', '1', 'future', { contentFormat: 'unsupported' }),
    message('first', '1', 'preview', { outputBody: body('full', { complete: false }) }),
  ])
    expect(replies([first, final], [run], () => 'full').get('final')?.text).toBeUndefined();
  expect(
    replies(
      [message('first', '1', 'first'), final],
      [{ ...run, originStoreId: 'restored-original-store' }],
    ).get('final')?.text,
  ).toBe('first\n\nfinal');
  expect(replies([message('empty', '1', '')]).get('empty')?.text).toBeUndefined();
});

test('compression summaries in every phase never become final or copied assistant prose', () => {
  for (const status of ['running', 'completed', 'failed', 'cancelled', 'unpublished'] as const) {
    const summary = message('summary', '2', 'PRIVATE COMPRESSION SUMMARY', {
      compression: { id: 'compression', trigger: 'automatic', status },
    });
    expect([...replies([summary])]).toEqual([]);
    expect([...replies([summary, message('answer', '3', 'actual answer')])]).toEqual([
      ['answer', { runId: 'run', text: 'actual answer' }],
    ]);
  }
});
