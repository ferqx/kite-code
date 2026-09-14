import { expect, test } from 'bun:test';
import { projectEvent, projectEventWithIdentity } from '../src/presentation';

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
  let messages = projectEventWithIdentity(
    [],
    { type: 'model.text_delta', requestId: 'r1', text: 'Hello' },
    { turnId: 'turn-1' },
  );
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
  expect(messages[0]).toMatchObject({
    text: 'Final answer',
    settled: true,
    turnId: 'turn-1',
    finalReply: true,
  });
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
  expect(messages[0]).toMatchObject({
    status: 'queued',
    presentation: 'standalone',
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
    presentation: 'standalone',
    arguments: { command: 'bun test' },
    settled: true,
  });
  expect(messages[0]?.text).toContain('one failed');
  expect(messages[0]?.text).toContain('failure detail');
});

test('tool progress preserves separate cumulative stdout and stderr streams', () => {
  let messages = projectEvent([], {
    type: 'tool.queued',
    toolId: 'shell-stream',
    toolName: 'shell_execute',
    presentation: 'standalone',
    arguments: { command: 'build' },
    summary: 'Queued.',
  });
  messages = projectEvent(messages, {
    type: 'tool.progress',
    toolId: 'shell-stream',
    stream: 'stdout',
    summary: 'compiled 4 files',
    lineCount: 1,
  });
  messages = projectEvent(messages, {
    type: 'tool.progress',
    toolId: 'shell-stream',
    stream: 'stderr',
    summary: 'warning: slow',
    lineCount: 1,
  });
  expect(messages[0]).toMatchObject({
    status: 'running',
    toolProgress: {
      stdout: 'compiled 4 files',
      stderr: 'warning: slow',
      stdoutLines: 1,
      stderrLines: 1,
    },
  });
});

test('reasoning and plan activity retain stable identities and terminal state', () => {
  let messages = projectEvent([], {
    type: 'reasoning.activity',
    requestId: 'request-1',
    segmentId: 'segment-1',
    state: 'streaming',
    text: '检查边界',
  });
  messages = projectEvent(messages, {
    type: 'reasoning.activity',
    requestId: 'request-1',
    segmentId: 'segment-1',
    state: 'completed',
    text: '检查边界完成',
  });
  messages = projectEvent(messages, {
    type: 'plan.progress',
    planId: 'plan-1',
    version: 1,
    structuralDigest: 'digest',
    status: 'in_progress',
    summary: '执行第 1 步',
  });
  messages = projectEvent(messages, {
    type: 'plan.completed',
    planId: 'plan-1',
    version: 1,
    structuralDigest: 'digest',
    summary: '计划全部完成',
  });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({
    id: 'thinking:request-1:segment-1',
    role: 'thinking',
    text: '检查边界完成',
    settled: true,
  });
  expect(messages[1]).toMatchObject({
    id: 'plan:plan-1',
    role: 'system',
    title: '计划已完成',
    text: '计划全部完成',
    status: 'completed',
    settled: true,
  });
});

test('subagents keep explicit parent identity, stable steps, and terminal results over late progress', () => {
  let messages = projectEvent([], {
    type: 'subagent.started',
    subagentId: 'child',
    role: 'review',
    name: '测试检查',
    parentToolCallId: 'parent',
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
  expect(messages[0]).not.toHaveProperty('delivery');
});

test('owned hidden child tools never duplicate at top level while legacy failures remain visible', () => {
  let messages = projectEvent([], {
    type: 'tool.queued',
    toolId: 'runtime-child-read',
    toolName: 'read_file',
    presentation: 'hidden',
    presentationOwner: { subagentId: 'child', parentToolCallId: 'parent' },
    arguments: { path: 'missing' },
    summary: 'Queued.',
  });
  messages = projectEvent(messages, {
    type: 'tool.finished',
    toolId: 'runtime-child-read',
    toolName: 'read_file',
    presentation: 'hidden',
    result: { ok: false, stdout: '', stderr: 'not found', exitCode: -1 },
    summary: 'Failed.',
  });
  expect(messages[0]).toMatchObject({
    presentationOwner: { subagentId: 'child', parentToolCallId: 'parent' },
    status: 'failed',
  });

  messages = projectEvent(messages, {
    type: 'tool.failed',
    toolId: 'terminal-only-child-failure',
    presentation: 'hidden',
    presentationOwner: { subagentId: 'child', parentToolCallId: 'parent' },
    summary: 'Terminal-only child failure.',
  });
  expect(
    messages.find((message) => message.id === 'tool:terminal-only-child-failure'),
  ).toMatchObject({
    presentationOwner: { subagentId: 'child', parentToolCallId: 'parent' },
    status: 'failed',
  });

  messages = projectEvent(messages, {
    type: 'tool.failed',
    toolId: 'legacy-hidden-failure',
    presentation: 'hidden',
    summary: 'Historical failure.',
  });
  expect(
    messages.find((message) => message.id === 'tool:legacy-hidden-failure'),
  ).not.toHaveProperty('presentationOwner');
});

test('parallel child completion preserves all parent task results without message delivery state', () => {
  let messages: ReturnType<typeof projectEvent> = [];
  for (const id of ['a', 'b', 'c']) {
    messages = projectEvent(messages, {
      type: 'tool.queued',
      toolId: id,
      toolName: 'task',
      presentation: 'standalone',
      arguments: { name: id },
      summary: 'Queued.',
    });
    messages = projectEvent(messages, {
      type: 'subagent.started',
      subagentId: `child-${id}`,
      role: 'explore',
      name: id,
    });
  }
  for (const id of ['c', 'b', 'a']) {
    messages = projectEvent(messages, {
      type: 'subagent.completed',
      subagentId: `child-${id}`,
      summary: `result-${id}`,
      toolCallCount: 1,
      durationMs: 100,
    });
    messages = projectEvent(messages, {
      type: 'tool.finished',
      toolId: id,
      toolName: 'task',
      presentation: 'standalone',
      result: { ok: true, stdout: `result-${id}`, stderr: '', exitCode: 0 },
      summary: 'Completed.',
    });
  }
  expect(messages.filter((message) => message.role === 'tool')).toHaveLength(3);
  for (const id of ['a', 'b', 'c']) {
    expect(messages.find((message) => message.id === `tool:${id}`)).toMatchObject({
      arguments: { name: id },
      status: 'completed',
      toolResult: { stdout: `result-${id}` },
    });
  }
  expect(messages.every((message) => message.delivery === undefined)).toBe(true);
  expect(projectEvent(messages, { type: 'model.requested', requestId: 'next' })).toBe(messages);
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
