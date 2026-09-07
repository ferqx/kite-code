import { expect, test } from 'bun:test';
import { projectEvent } from '../src/presentation';

test('confirmed file changes retain the matching durable diff regardless of event arrival order', () => {
  const changed = {
    type: 'tool.file_changed',
    toolId: 'edit-1',
    change: 'modified',
    path: 'src/app.ts',
  } as const;
  const finished = {
    type: 'tool.finished',
    toolId: 'edit-1',
    presentation: 'standalone',
    summary: 'edited',
    result: { ok: true, exitCode: 0, stdout: ' 1 -old\n 1 +new', stderr: '' },
  } as const;
  for (const events of [
    [changed, finished],
    [finished, changed],
  ]) {
    let messages = events.reduce(
      (current, event) => projectEvent(current, event),
      [] as ReturnType<typeof projectEvent>,
    );
    messages = projectEvent(messages, { type: 'tool.progress', toolId: 'edit-1', summary: 'late' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      settled: true,
      changedFile: 'src/app.ts',
      changeConfirmed: true,
      toolResult: finished.result,
    });
  }
  const rejected = projectEvent([], {
    type: 'tool.rejected',
    toolId: 'edit-2',
    presentation: 'standalone',
    summary: 'rejected',
  });
  expect(rejected[0]?.changeConfirmed).toBeUndefined();
});

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
