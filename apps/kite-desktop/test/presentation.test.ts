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

test('tool details retain structured arguments and explicit failure without losing output', () => {
  let messages = projectEvent([], {
    type: 'tool.queued',
    toolId: 'shell',
    toolName: 'shell_execute',
    presentation: 'standalone',
    arguments: { command: 'bun test' },
    summary: '运行测试',
  });
  messages = projectEvent(messages, {
    type: 'tool.finished',
    toolId: 'shell',
    presentation: 'standalone',
    summary: '测试未通过',
    result: { ok: false, exitCode: 1, stdout: 'one failed', stderr: 'failure detail' },
  });
  expect(messages[0]).toMatchObject({
    status: 'failed',
    toolName: 'shell_execute',
    arguments: { command: 'bun test' },
    settled: true,
  });
  expect(messages[0]?.text).toContain('one failed');
  expect(messages[0]?.text).toContain('failure detail');
});

test('subagents keep explicit parent identity, stable steps, and terminal results over late progress', () => {
  let messages = projectEvent([], {
    type: 'subagent.started',
    subagentId: 'child',
    role: 'review',
    name: '测试检查',
  });
  messages = projectEvent(messages, {
    type: 'subagent.phase',
    subagentId: 'child',
    parentToolCallId: 'parent',
    status: 'running',
  });
  for (const status of ['started', 'completed', 'started'] as const)
    messages = projectEvent(messages, {
      type: 'subagent.step',
      subagentId: 'child',
      stepId: 'step',
      toolCallId: 'child-tool',
      toolName: 'shell_execute',
      status,
      summary: '检查边界',
    });
  expect(messages[0]?.steps).toEqual([{ id: 'step', text: '检查边界', status: 'completed' }]);
  messages = projectEvent(messages, {
    type: 'subagent.completed',
    subagentId: 'child',
    summary: '检查已通过',
    toolCallCount: 1,
    durationMs: 100,
  });
  const terminal = messages;
  messages = projectEvent(messages, {
    type: 'subagent.phase',
    subagentId: 'child',
    parentToolCallId: 'parent',
    status: 'suspended',
  });
  expect(messages).toBe(terminal);
  expect(messages[0]).toMatchObject({
    title: '测试检查',
    parentToolCallId: 'parent',
    text: '检查已通过',
    status: 'completed',
    settled: true,
  });
});

test('approval receipt is distinct from tool success and repeated availability cannot reopen it', () => {
  const interaction = {
    kind: 'approval',
    interactionId: 'approve',
    sessionRevision: 1,
    generation: 1,
    grants: ['approve_once'],
    command: 'git push',
    owner: { kind: 'root_tool', toolCallId: 'tool' },
  } as const;
  let messages = projectEvent([], { type: 'interaction.available', interaction });
  messages = projectEvent(messages, {
    type: 'approval.granted',
    interactionId: 'approve',
    generation: 1,
    owner: interaction.owner,
  });
  messages = projectEvent(messages, {
    type: 'interaction.settled',
    interactionId: 'approve',
    sessionRevision: 2,
    outcome: 'completed',
  });
  messages = projectEvent(messages, { type: 'interaction.available', interaction });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ text: 'git push', settled: true });
  expect(messages[0]?.title).toBe('已批准本次命令，执行结果以工具记录为准');
});
