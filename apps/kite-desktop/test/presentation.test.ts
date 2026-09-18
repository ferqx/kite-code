import { expect, test } from 'bun:test';
import {
  mapRuntimeClientEventToProtocol,
  RUNTIME_PROTOCOL_EVENT_SCHEMA_,
} from '@kite-ai/runtime-protocol';
import type { RuntimeEvent } from '../../kite-service/src/bootstrap/runtime/state-runtime';
import { projectRuntimeClientEvent } from '../../kite-service/src/runtime-client/event-projector';
import { projectEvent, projectEventWithIdentity } from '../src/presentation';

test('failed model run is visible without an assistant reply and replay does not duplicate it', () => {
  const user = projectEventWithIdentity(
    [],
    { type: 'user.message', messageId: 'm1', kind: 'task', text: '你好' },
    { turnId: 't1' },
  );
  const failed = {
    type: 'run.terminal',
    runId: 't1',
    status: 'failed',
    outcome: {
      status: 'blocked',
      reasonCode: 'provider_auth_required',
      safeRetry: false,
      recoveryEntry: 'operator_action',
    },
  } as const;
  const withFailure = projectEventWithIdentity(user, failed, { turnId: 't1' });
  expect(withFailure).toHaveLength(2);
  expect(withFailure[1]).toMatchObject({
    role: 'system',
    turnId: 't1',
    status: 'failed',
    settled: true,
  });
  expect(withFailure[1]?.text).toContain('凭据');
  expect(projectEventWithIdentity(withFailure, failed)).toEqual(withFailure);
  expect(
    projectEventWithIdentity(withFailure, {
      type: 'turn.terminal',
      turnId: 't1',
      status: 'failed',
    }),
  ).toEqual(withFailure);
});

test('turn and run terminal failures share one notice and remain scoped to their turn', () => {
  let messages = projectEventWithIdentity([], {
    type: 'turn.terminal',
    turnId: 't1',
    status: 'failed',
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toContain('失败');
  messages = projectEventWithIdentity(messages, {
    type: 'run.terminal',
    runId: 't1',
    status: 'failed',
    outcome: {
      status: 'unknown',
      reasonCode: 'provider_auth_required',
      safeRetry: false,
      recoveryEntry: 'operator_action',
    },
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]?.text).toContain('凭据');
  messages = projectEventWithIdentity(
    messages,
    { type: 'user.message', messageId: 'm2', kind: 'task', text: '再试一次' },
    { turnId: 't2' },
  );
  messages = projectEventWithIdentity(messages, {
    type: 'turn.terminal',
    turnId: 't2',
    status: 'completed',
  });
  expect(messages).toHaveLength(2);
  expect(messages[0]?.turnId).toBe('t1');
  expect(messages[1]?.turnId).toBe('t2');
  expect(
    projectEventWithIdentity(messages, { type: 'run.terminal', runId: 't1', status: 'failed' }),
  ).toEqual(messages);
});

test('cancelled turns and runs do not show failure notices', () => {
  let messages = projectEventWithIdentity([], {
    type: 'turn.terminal',
    turnId: 't1',
    status: 'cancelled',
  });
  messages = projectEventWithIdentity(messages, {
    type: 'run.terminal',
    runId: 't1',
    status: 'cancelled',
  });
  expect(messages).toEqual([]);
});

test('run terminal uses its projected turn identity and leaves another turn thinking', () => {
  const oldThinking = projectEventWithIdentity(
    [],
    {
      type: 'reasoning.activity',
      requestId: 'old',
      segmentId: 's',
      text: '旧轮',
      state: 'streaming',
    },
    { turnId: 'old-turn', observedAt: 100 },
  );
  const messages = projectEventWithIdentity(
    oldThinking,
    {
      type: 'reasoning.activity',
      requestId: 'new',
      segmentId: 's',
      text: '新轮',
      state: 'streaming',
    },
    { turnId: 'new-turn', observedAt: 200 },
  );
  const lateFailure = projectEventWithIdentity(
    messages,
    { type: 'run.terminal', runId: 'run-old', status: 'failed' },
    { turnId: 'old-turn', observedAt: 300 },
  );
  expect(lateFailure[0]).toMatchObject({ settled: true, thinkingEndedAt: 300 });
  expect(lateFailure[1]).toMatchObject({ settled: false, turnId: 'new-turn' });
  expect(lateFailure[2]).toMatchObject({ id: 'failure:old-turn', turnId: 'old-turn' });
  const paired = projectEventWithIdentity(lateFailure, {
    type: 'turn.terminal',
    turnId: 'old-turn',
    status: 'failed',
  });
  expect(paired).toEqual(lateFailure);
  expect(paired[1]?.settled).toBe(false);
});

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
  expect(messages[0]?.steps).toEqual([
    {
      id: 'step',
      toolCallId: 'child-tool',
      toolName: 'shell_execute',
      text: 'shell_execute',
      summary: '检查边界',
      status: 'completed',
    },
  ]);
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

test('subagent lifecycle keeps review waiting distinct from terminal outcomes', () => {
  let messages = projectEvent([], {
    type: 'subagent.started',
    subagentId: 'child-lifecycle',
    role: 'review',
    name: 'Review',
    status: 'creating',
  });
  expect(messages[0]?.status).toBe('creating');
  messages = projectEvent(messages, {
    type: 'subagent.started',
    subagentId: 'child-lifecycle',
    role: 'review',
    name: 'Review',
    status: 'running',
  });
  expect(messages[0]?.status).toBe('running');
  messages = projectEvent(messages, {
    type: 'subagent.review',
    subagentId: 'child-lifecycle',
    parentToolCallId: 'parent',
    reviewId: 'review',
    toolCallId: 'tool',
    status: 'queued',
  });
  expect(messages[0]?.status).toBe('waiting');
  messages = projectEvent(messages, {
    type: 'subagent.review',
    subagentId: 'child-lifecycle',
    parentToolCallId: 'parent',
    reviewId: 'review',
    toolCallId: 'tool',
    status: 'reviewing',
  });
  expect(messages[0]?.status).toBe('auto_reviewing');
  messages = projectEvent(messages, {
    type: 'subagent.review',
    subagentId: 'child-lifecycle',
    parentToolCallId: 'parent',
    reviewId: 'review',
    toolCallId: 'tool',
    status: 'approved',
  });
  expect(messages[0]?.status).toBe('waiting');
  messages = projectEvent(messages, {
    type: 'subagent.failed',
    subagentId: 'child-lifecycle',
    status: 'interrupted',
    summary: 'Process exited',
    toolCallCount: 0,
    durationMs: 1,
  });
  expect(messages[0]).toMatchObject({ status: 'interrupted', settled: true });
  const terminal = messages;
  messages = projectEvent(messages, {
    type: 'subagent.started',
    subagentId: 'child-lifecycle',
    role: 'review',
    name: 'Review',
    status: 'running',
  });
  expect(messages).toBe(terminal);
});

test('Service lifecycle facts survive the protocol codec before Desktop projection', () => {
  const owner = {
    kind: 'subagent_tool' as const,
    subagentId: 'wire-child',
    parentToolCallId: 'parent',
    toolCallId: 'internal',
  };
  const events: RuntimeEvent[] = [
    {
      type: 'subagent.started',
      subagent: {
        id: 'wire-child',
        role: 'review',
        name: 'Review',
        parentToolCallId: 'parent',
        status: 'creating',
      },
    },
    {
      type: 'subagent.started',
      subagent: {
        id: 'wire-child',
        role: 'review',
        name: 'Review',
        parentToolCallId: 'parent',
        status: 'running',
      },
    },
    {
      type: 'auto_review.started',
      reviewId: 'review',
      toolCallId: 'parent',
      owner,
    } as RuntimeEvent,
    {
      type: 'subagent.failed',
      subagent: { id: 'wire-child', error: 'Process exited', status: 'interrupted' },
    },
  ];
  let messages: ReturnType<typeof projectEvent> = [];
  for (const fact of events) {
    const projected = projectRuntimeClientEvent(fact, { sessionRevision: 1 });
    expect(projected).toBeDefined();
    const wire = mapRuntimeClientEventToProtocol(projected!);
    const decoded = RUNTIME_PROTOCOL_EVENT_SCHEMA_.parse(JSON.parse(JSON.stringify(wire)));
    messages = projectEvent(messages, decoded);
  }
  expect(messages[0]).toMatchObject({ status: 'interrupted', settled: true });
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
  expect(messages[0]).toMatchObject({
    id: 'tool:tool',
    settled: false,
    status: 'queued',
    approval: { state: 'approved', source: 'user' },
  });
});

test('auto review stays on the tool and manual grant survives stop and late review', () => {
  let messages = projectEvent([], {
    type: 'tool.queued',
    toolId: 'test',
    toolName: 'shell_execute',
    arguments: { command: 'pnpm test' },
    summary: 'Queued',
    presentation: 'standalone',
  });
  messages = projectEvent(messages, {
    type: 'tool.review',
    toolId: 'test',
    reviewId: 'review',
    status: 'reviewing',
  });
  expect(messages[0]).toMatchObject({
    status: 'waiting',
    approval: { state: 'reviewing', source: 'auto' },
  });
  messages = projectEvent(messages, {
    type: 'tool.review',
    toolId: 'test',
    reviewId: 'review',
    status: 'awaiting_user',
    summary: '需人工确认',
  });
  messages = projectEvent(messages, {
    type: 'approval.granted',
    interactionId: 'human',
    generation: 1,
    owner: { kind: 'root_tool', toolCallId: 'test' },
    grant: 'same_command',
  });
  messages = projectEvent(messages, {
    type: 'tool.progress',
    toolId: 'test',
    stream: 'stdout',
    summary: 'tests started',
  });
  messages = projectEvent(messages, {
    type: 'tool.cancelled',
    toolId: 'test',
    presentation: 'standalone',
    summary: '用户停止',
  });
  messages = projectEvent(messages, {
    type: 'tool.review',
    toolId: 'test',
    reviewId: 'review',
    status: 'approved',
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    status: 'cancelled',
    settled: true,
    approval: { source: 'user', state: 'approved', grant: 'same_command' },
    toolProgress: { stdout: 'tests started' },
  });
});

test('each compaction keeps a single marker from requested through terminal result', () => {
  let messages = projectEvent([], { type: 'context.compaction', status: 'requested' });
  const id = messages[0]?.id;
  messages = projectEvent(messages, {
    type: 'context.compaction',
    status: 'failed',
    summary: '请求超时',
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    id,
    systemKind: 'compaction',
    settled: true,
    status: 'failed',
    text: '请求超时',
  });
  messages = projectEvent(messages, { type: 'context.compaction', status: 'requested' });
  messages = projectEvent(messages, { type: 'context.compaction', status: 'completed' });
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({ title: '上下文已自动压缩', status: 'completed' });
});

test('Ask history retains exact tool ownership and pairs option labels with each question', () => {
  const requested = {
    type: 'input.requested',
    interaction: {
      kind: 'input',
      interactionId: 'ask-1',
      toolCallId: 'tool-ask-1',
      sessionRevision: 1,
      question: 'Next?',
      allowFreeText: true,
      questions: [
        {
          id: 'q1',
          question: 'Next?',
          allowFreeText: true,
          options: [{ id: 'stop', label: '先不动，到此为止' }],
        },
        { id: 'q2', question: '范围？', allowFreeText: true },
      ],
    },
  } as const;
  let messages = projectEvent([], requested);
  messages = projectEvent(messages, {
    type: 'input.answered',
    interactionId: 'ask-1',
    summary: '回答摘要',
    answers: { q1: 'stop', q2: '当前会话' },
  });
  expect(messages[0]?.ask).toMatchObject({
    toolCallId: 'tool-ask-1',
    answers: { q1: '先不动，到此为止', q2: '当前会话' },
  });
  messages = projectEvent(messages, requested);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.ask?.answers?.q1).toBe('先不动，到此为止');
});

test('completed turns identify their final assistant reply for copying', () => {
  let messages = projectEventWithIdentity(
    [],
    {
      type: 'model.responded',
      requestId: 'r',
      messageId: 'm',
      summary: '最终答复',
      toolCallCount: 1,
    },
    { turnId: 't' },
  );
  expect(messages[0]).toMatchObject({ settled: true, finalReply: false });
  messages = projectEventWithIdentity(messages, {
    type: 'turn.terminal',
    turnId: 't',
    status: 'completed',
  });
  expect(messages[0]).toMatchObject({ settled: true, finalReply: true });
  const withTool = projectEventWithIdentity(
    [
      { id: 'model:r', role: 'assistant', turnId: 'other', text: '另一轮', settled: true },
      {
        id: 'model:t',
        role: 'assistant',
        turnId: 't',
        text: '工具前说明',
        settled: true,
        finalReply: true,
      },
      { id: 'tool:x', role: 'tool', turnId: 't', text: '', settled: true },
    ],
    { type: 'turn.terminal', turnId: 't', status: 'completed' },
  );
  expect(withTool[1]?.finalReply).toBe(false);
  expect(withTool[0]?.finalReply).toBeUndefined();
  expect(
    projectEventWithIdentity(messages, { type: 'turn.terminal', turnId: 't', status: 'failed' })[0]
      ?.finalReply,
  ).toBe(false);
});

test('reasoning timing retains its first observation and freezes on completion or cancellation', () => {
  const event = {
    type: 'reasoning.activity',
    requestId: 'r',
    segmentId: 's',
    text: '检查',
    state: 'streaming',
  } as const;
  const first = projectEventWithIdentity([], event, { turnId: 't', observedAt: 1000 });
  const updated = projectEventWithIdentity(first, event, { turnId: 't', observedAt: 3000 });
  expect(updated[0]?.thinkingStartedAt).toBe(1000);
  const completed = projectEventWithIdentity(
    updated,
    { ...event, state: 'completed' },
    { observedAt: 5500 },
  );
  expect(completed[0]).toMatchObject({
    settled: true,
    thinkingStartedAt: 1000,
    thinkingEndedAt: 5500,
  });
  const cancelled = projectEventWithIdentity(
    updated,
    { type: 'turn.terminal', turnId: 't', status: 'cancelled' },
    { observedAt: 4000 },
  );
  expect(cancelled[0]).toMatchObject({ settled: true, thinkingEndedAt: 4000 });
  expect(
    projectEventWithIdentity([], { ...event, state: 'completed' })[0]?.thinkingStartedAt,
  ).toBeUndefined();
});

test('interrupted reasoning is settled once and late streaming cannot restart its clock', () => {
  const event = {
    type: 'reasoning.activity',
    requestId: 'r',
    segmentId: 's',
    text: '检查',
    state: 'streaming',
  } as const;
  for (const status of ['cancelled', 'failed', 'aborted'] as const) {
    const first = projectEventWithIdentity([], event, { turnId: 't', observedAt: 1000 });
    const stopped = projectEventWithIdentity(
      first,
      { type: 'turn.terminal', turnId: 't', status },
      { observedAt: 4600 },
    );
    expect(stopped[0]).toMatchObject({
      settled: true,
      thinkingStartedAt: 1000,
      thinkingEndedAt: 4600,
    });
    const late = projectEventWithIdentity(stopped, event, { observedAt: 6000 });
    expect(late).toEqual(stopped);
    const completed = projectEventWithIdentity(
      late,
      { ...event, state: 'completed' },
      { observedAt: 8000 },
    );
    expect(completed[0]?.thinkingEndedAt).toBe(4600);
  }
});
