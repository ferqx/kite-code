import { expect, test } from 'bun:test';
import { projectEvent } from '../src/presentation';

test('cumulative text and a late delta cannot duplicate or overwrite durable output', () => {
  let messages = projectEvent([], { type: 'model.text_delta', requestId: 'r1', text: 'Hello' });
  messages = projectEvent(messages, {
    type: 'model.text_delta',
    requestId: 'r1',
    text: 'Hello world',
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toBe('Hello world');
  messages = projectEvent(messages, {
    type: 'model.responded',
    requestId: 'r1',
    messageId: 'm1',
    toolCallCount: 0,
    summary: 'Final answer',
  });
  messages = projectEvent(messages, {
    type: 'model.text_delta',
    requestId: 'r1',
    text: 'Hello world!',
  });
  expect(messages[0]).toMatchObject({ text: 'Final answer', settled: true });
});

test('cancelled and rejected tools remain terminal after late progress or history replay', () => {
  for (const terminal of [
    { type: 'tool.cancelled', toolId: 'tool-1', presentation: 'standalone' },
    { type: 'tool.rejected', toolId: 'tool-1', presentation: 'standalone', summary: '用户已拒绝' },
  ] as const) {
    let messages = projectEvent([], { type: 'tool.started', toolId: 'tool-1', summary: 'Running' });
    messages = projectEvent(messages, terminal);
    messages = projectEvent(messages, {
      type: 'tool.progress',
      toolId: 'tool-1',
      summary: 'Late progress',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.settled).toBe(true);
    expect(messages[0]?.text).toBe(
      terminal.type === 'tool.cancelled' ? '工具已取消' : '用户已拒绝',
    );
    expect(projectEvent([], terminal)).toEqual(messages);
  }
});
