import { expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { projectCacheMetrics, projectHistory } from '../src/history-projection';
import { projectEventWithIdentity } from '../src/presentation';

const event = (index: number): RuntimeClientEvent => ({
  type: 'user.message',
  messageId: String(index),
  text: `message ${index}`,
  kind: 'task',
});
const record = (index: number) => ({
  sequence: index,
  events: [event(index)],
  identity: { turnId: `turn-${index}` },
});

test('unchanged calibration preserves array and changed calibration reuses identical messages', async () => {
  const signal = new AbortController().signal;
  const records = [record(1), record(2)];
  const original = records.reduce(
    (messages, item) => projectEventWithIdentity(messages, item.events[0]!, item.identity),
    [] as Parameters<typeof projectEventWithIdentity>[0],
  );
  expect(await projectHistory(records, original, signal)).toBe(original);
  const changed = await projectHistory([...records, record(3)], original, signal);
  expect(changed).toHaveLength(3);
  expect(changed[0]).toBe(original[0]);
  expect(changed[1]).toBe(original[1]);
  expect(await projectHistory([], [], signal)).toEqual([]);
});

test('large historical projection yields and superseding it stops before publication', async () => {
  const controller = new AbortController();
  let heartbeat = false;
  const timer = setTimeout(() => {
    heartbeat = true;
    controller.abort();
  }, 0);
  await expect(
    projectHistory(
      Array.from({ length: 5000 }, (_, index) => record(index)),
      [],
      controller.signal,
    ),
  ).rejects.toThrow();
  clearTimeout(timer);
  expect(heartbeat).toBe(true);
});

test('historical projection restores cumulative prompt cache metrics', () => {
  expect(
    projectCacheMetrics([
      {
        ...record(1),
        events: [
          event(1),
          { type: 'model.cache', inputTokens: 100, cacheHitTokens: 75, cacheMissTokens: 25 },
        ],
      },
      {
        ...record(2),
        events: [{ type: 'model.cache', inputTokens: 50, cacheHitTokens: 25, cacheMissTokens: 25 }],
      },
    ]),
  ).toEqual({ cacheHitTokens: 100, cacheMissTokens: 50 });
  expect(projectCacheMetrics([record(1)])).toBeUndefined();
});

test('mixed replay matches immutable live projection through late terminal events', async () => {
  const events: Array<{ event: RuntimeClientEvent; turnId?: string; observedAt: number }> = [];
  const add = (event: RuntimeClientEvent, turnId: string | undefined, observedAt: number) => {
    events.push({ event, turnId, observedAt });
  };
  for (let turn = 0; turn < 40; turn++) {
    const id = `turn-${turn}`;
    add(
      { type: 'user.message', messageId: id, kind: 'task', text: `Question ${turn}` },
      id,
      turn * 100,
    );
    add(
      {
        type: 'reasoning.activity',
        requestId: id,
        segmentId: 'one',
        state: 'streaming',
        text: 'Working',
      },
      id,
      turn * 100 + 1,
    );
    add({ type: 'model.text_delta', requestId: id, text: 'Answer' }, id, turn * 100 + 2);
    add(
      {
        type: 'model.responded',
        requestId: id,
        messageId: id,
        summary: `Answer ${turn}`,
        toolCallCount: 0,
      },
      id,
      turn * 100 + 3,
    );
    add({ type: 'turn.terminal', turnId: id, status: 'completed' }, id, turn * 100 + 4);
    add(
      {
        type: 'reasoning.activity',
        requestId: id,
        segmentId: 'one',
        state: 'streaming',
        text: 'Late',
      },
      id,
      turn * 100 + 5,
    );
  }
  add({ type: 'model.text_delta', requestId: 'superseded', text: 'Discard me' }, 'last', 4900);
  add(
    {
      type: 'tool.queued',
      toolId: 'after-removal',
      summary: 'queued',
      presentation: 'standalone',
      arguments: {},
    },
    'last',
    4901,
  );
  add(
    { type: 'model.response_superseded', requestId: 'superseded', messageId: 'superseded' },
    'last',
    4902,
  );
  add(
    { type: 'tool.progress', toolId: 'after-removal', stream: 'stdout', summary: 'still indexed' },
    'last',
    4903,
  );
  add(
    {
      type: 'reasoning.activity',
      requestId: 'unscoped',
      segmentId: 'one',
      state: 'streaming',
      text: 'Unscoped',
    },
    undefined,
    4904,
  );
  add(
    { type: 'turn.terminal', turnId: 'unscoped-turn', status: 'cancelled' },
    'unscoped-turn',
    4905,
  );
  add({ type: 'turn.terminal', turnId: 'failed-turn', status: 'failed' }, 'failed-turn', 4906);
  add(
    {
      type: 'run.terminal',
      runId: 'failed-run',
      status: 'failed',
      outcome: {
        status: 'blocked',
        reasonCode: 'provider_auth_required',
        safeRetry: false,
        recoveryEntry: 'operator_action',
      },
    },
    'failed-turn',
    4907,
  );
  add(
    {
      type: 'tool.queued',
      toolId: 'shell',
      summary: 'queued',
      presentation: 'standalone',
      arguments: {},
    },
    'last',
    5000,
  );
  add(
    { type: 'tool.progress', toolId: 'shell', stream: 'stdout', summary: 'output', lineCount: 1 },
    'last',
    5001,
  );
  add(
    {
      type: 'tool.finished',
      toolId: 'shell',
      summary: 'done',
      presentation: 'standalone',
      result: { ok: true, exitCode: 0, stdout: 'output', stderr: '' },
    },
    'last',
    5002,
  );
  add(
    { type: 'subagent.started', subagentId: 'child', role: 'review', name: 'Review' },
    'last',
    5003,
  );
  add({ type: 'subagent.completed', subagentId: 'child', summary: 'Reviewed' }, 'last', 5004);
  add(
    {
      type: 'agent.mail_status',
      status: 'accepted',
      targetAgentId: 'child',
      messageIds: ['mail'],
      submissionId: 'submission',
    },
    'last',
    5005,
  );
  add(
    {
      type: 'agent.mail_status',
      status: 'input_prepared',
      targetAgentId: 'child',
      messageIds: ['mail'],
    },
    'last',
    5006,
  );
  const approval = {
    kind: 'approval' as const,
    interactionId: 'approve',
    sessionRevision: 1,
    generation: 1,
    grants: ['approve_once' as const],
    command: 'git push',
    owner: { kind: 'root_tool' as const, toolCallId: 'shell' },
  };
  add({ type: 'interaction.available', interaction: approval }, 'last', 5007);
  add(
    { type: 'approval.granted', interactionId: 'approve', generation: 1, owner: approval.owner },
    'last',
    5008,
  );
  add(
    {
      type: 'interaction.settled',
      interactionId: 'approve',
      sessionRevision: 2,
      outcome: 'completed',
    },
    'last',
    5009,
  );
  add(
    {
      type: 'input.requested',
      interaction: {
        kind: 'input',
        interactionId: 'ask',
        toolCallId: 'ask-tool',
        sessionRevision: 3,
        question: 'Continue?',
        allowFreeText: true,
        questions: [
          {
            id: 'choice',
            question: 'Continue?',
            allowFreeText: true,
            options: [{ id: 'yes', label: 'Yes' }],
          },
        ],
      },
    },
    'last',
    5010,
  );
  add({ type: 'input.answered', interactionId: 'ask', answers: { choice: 'yes' } }, 'last', 5011);
  add({ type: 'context.compaction', status: 'requested' }, 'last', 5012);
  add({ type: 'context.compaction', status: 'completed' }, 'last', 5013);
  const records = events.map(({ event, turnId, observedAt }, index) => ({
    sequence: index + 1,
    events: [event],
    identity: { turnId, observedAt },
  }));
  const expected = records.reduce(
    (messages, item) => projectEventWithIdentity(messages, item.events[0]!, item.identity),
    [] as readonly import('../src/presentation').Message[],
  );
  const frozenPrevious = Object.freeze(expected.map((message) => Object.freeze({ ...message })));
  const before = structuredClone(frozenPrevious);
  const result = await projectHistory(records, frozenPrevious, new AbortController().signal);
  expect(result).toEqual(expected);
  expect(result).toBe(frozenPrevious);
  expect(frozenPrevious).toEqual(before);
  expect(result.filter((message) => message.finalReply)).toHaveLength(40);
  expect(result.find((message) => message.id === 'failure:failed-turn')?.text).toContain(
    '认证失败',
  );
  expect(result.find((message) => message.id === 'interaction:ask')?.ask?.answers?.choice).toBe(
    'Yes',
  );
  expect(result.find((message) => message.id === 'tool:after-removal')?.toolProgress?.stdout).toBe(
    'still indexed',
  );
  expect(result.find((message) => message.id === 'thinking:unscoped:one')).toMatchObject({
    settled: true,
    thinkingStartedAt: 4904,
    thinkingEndedAt: 4905,
  });
  expect(result.filter((message) => message.systemKind === 'compaction')).toHaveLength(1);
  expect(result.find((message) => message.id === 'thinking:turn-0:one')).toMatchObject({
    settled: true,
    thinkingStartedAt: 1,
    thinkingEndedAt: 4,
  });
  const extended = await projectHistory(
    [
      ...records,
      {
        sequence: records.length + 1,
        events: [{ type: 'user.message', messageId: 'new', kind: 'task', text: 'New' } as const],
        identity: { turnId: 'new', observedAt: 6000 },
      },
    ],
    frozenPrevious,
    new AbortController().signal,
  );
  expect(extended).not.toBe(frozenPrevious);
  expect(extended.at(-1)?.text).toBe('New');
  expect(frozenPrevious).toEqual(before);
});
