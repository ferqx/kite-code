import { describe, expect, test } from 'bun:test';
import { assertCurrentRuntimeEvent, createInitialAgentState } from '@kite-ai/agent-kernel';
import type { AgentMailboxInvocationScope } from '@kite-ai/builtin-runtime/subagent';
import {
  type CrossSessionQueueMailPort,
  createCrossSessionChildMailboxPort,
  createCrossSessionRootMailboxPort,
} from '#kite-service/bootstrap/runtime/agent-mailbox-port';
import type { RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';

function fixture() {
  const base = createInitialAgentState({
    threadId: 'parent',
    userId: 'user',
    workspace: '/workspace',
    turnId: 'turn',
    recoveryIdentityKey: 'a'.repeat(64),
  });
  const state = {
    ...base,
    tools: {
      ...base.tools,
      calls: {
        send: {
          toolCallId: 'send',
          name: 'send_message',
          modelMessageId: 'assistant',
          args: {},
          modelInvocationId: 'model',
          createdAtTurnId: 'turn',
          status: 'running' as const,
        },
      },
    },
    transcript: {
      messages: [
        {
          kind: 'assistant' as const,
          messageId: 'assistant',
          turnId: 'turn',
          ordinal: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          modelInvocationId: 'model',
          toolCalls: [{ id: 'send', name: 'send_message', args: {} }],
        },
      ],
    },
  } as RuntimeState;
  let currentState = state;
  const accepted: Parameters<CrossSessionQueueMailPort['acceptQueueMailCommand']>[0][] = [];
  const delivered: string[] = [];
  const deliveryFailures: string[] = [];
  let targetParent: string | null = 'parent';
  let runId = 'run';
  let throwDelivery = false;
  let deliveryGate: Promise<void> | null = null;
  let unreadCount = 0;
  let throughSequence = 0;
  let mailboxReads = 0;
  let releasedSubmission: string | null = null;
  let releaseCount = 0;
  let terminalOutcome: {
    submissionId: string;
    status: 'completed' | 'unknown' | 'pre_dispatch_released';
    taskId: string;
    sourceRevision: number;
  } | null = null;
  let terminalCount = 0;
  const storage: CrossSessionQueueMailPort = {
    listDirectChildren: (parentSessionId, currentRunId, limit) => {
      if (parentSessionId !== 'parent' || currentRunId !== runId || limit !== 63)
        throw new Error('Direct child list lost its source scope.');
      return [{ agentId: 'child', status: 'running', currentTaskId: 'task', unreadCount }];
    },
    readDirectChildInboxWatermark: (parentSessionId, currentRunId) => {
      if (parentSessionId !== 'parent' || currentRunId !== runId)
        throw new Error('Inbox read lost its source Run.');
      mailboxReads++;
      return { unreadCount, throughSequence };
    },
    readLastFollowupOutcomeForDirectChild: (_parent, _run, childId) =>
      childId === 'child'
        ? (terminalOutcome ??
          (releasedSubmission
            ? {
                submissionId: releasedSubmission,
                status: 'failed' as const,
                reason: 'authorization_changed' as const,
                sourceRevision: releaseCount,
              }
            : null))
        : null,
    readDirectChildFollowupOutcomeWatermark: (parentSessionId, currentRunId) => {
      if (parentSessionId !== 'parent' || currentRunId !== runId)
        throw new Error('Outcome watermark lost its source current Run.');
      return {
        count: releaseCount + terminalCount,
        throughRevision: Math.max(releaseCount, terminalOutcome?.sourceRevision ?? 0),
      };
    },
    readActiveChildGrant: () => null,
    readTarget: (_source, target) =>
      target === 'child'
        ? {
            sessionId: 'child',
            parentSessionId: targetParent,
            status: 'active',
          }
        : null,
    nextSourceSequence: () => 1,
    lookupOutbox: (_source, messageId) => {
      const prior = accepted.find((item) => item.event.messageId === messageId);
      return prior
        ? {
            targetSessionId: prior.intent.targetSessionId,
            requestDigest: prior.intent.requestDigest,
            deliveredTargetRevision: null,
          }
        : null;
    },
    async acceptQueueMailCommand(input) {
      accepted.push(input);
    },
    async deliverQueueMail(_source, messageId) {
      delivered.push(messageId);
      if (throwDelivery) throw new Error('target temporarily offline');
    },
  };
  const abort = new AbortController();
  const port = createCrossSessionRootMailboxPort({
    getState: () => currentState,
    currentRunId: () => runId,
    storage,
    toolCallId: 'send',
    signal: abort.signal,
    scheduleDelivery: async (sourceSessionId, messageId) => {
      if (deliveryGate) await deliveryGate;
      await storage.deliverQueueMail(sourceSessionId, messageId);
    },
    onDeliveryFailure: ({ messageId }) => deliveryFailures.push(messageId),
  });
  if (!port) throw new Error('Expected bound parent Tool call.');
  const scope: AgentMailboxInvocationScope = {
    ...port.caller,
    toolCallId: 'send',
    effectAttemptId: 'attempt',
  };
  return {
    port,
    scope,
    signal: abort.signal,
    accepted,
    delivered,
    deliveryFailures,
    get mailboxReads() {
      return mailboxReads;
    },
    setUnread(value: number, sequence: number) {
      unreadCount = value;
      throughSequence = sequence;
    },
    setRun(value: string) {
      runId = value;
    },
    steer() {
      currentState = {
        ...currentState,
        transcript: {
          ...currentState.transcript,
          messages: [
            ...currentState.transcript.messages,
            {
              kind: 'user',
              messageId: 'steer',
              turnId: 'turn',
              ordinal: 1,
              createdAt: '2026-01-01T00:00:01.000Z',
              content: 'New user direction',
            },
          ],
        },
      };
    },
    setTargetParent(value: string | null) {
      targetParent = value;
    },
    setDeliveryFailure(value: boolean) {
      throwDelivery = value;
    },
    setDeliveryGate(value: Promise<void> | null) {
      deliveryGate = value;
    },
    setFollowupOutcome(value: {
      submissionId: string;
      status: 'completed' | 'unknown' | 'pre_dispatch_released';
      taskId: string;
      sourceRevision: number;
    }) {
      terminalOutcome = value;
      terminalCount++;
    },
    setReleasedFollowup(submissionId: string) {
      releasedSubmission = submissionId;
      releaseCount++;
    },
  };
}

test('cross-Session list_agents reads direct children and unread metadata without consuming mail', async () => {
  const f = fixture();
  f.setUnread(2, 4);
  const before = f.mailboxReads;
  expect(await f.port.listAgents({ scope: f.scope, signal: f.signal })).toEqual({
    ok: true,
    agents: [
      { agent_id: 'parent', status: 'running', unread_count: 2 },
      {
        agent_id: 'child',
        parent_agent_id: 'parent',
        status: 'running',
        current_task_id: 'task',
        unread_count: 2,
      },
    ],
  });
  expect(f.mailboxReads).toBe(before + 1);
  expect(await f.port.waitAgent({ scope: f.scope, timeoutMs: 30_000, signal: f.signal })).toEqual({
    ok: true,
    timed_out: false,
    reason: 'mailbox_update',
  });
  expect(f.mailboxReads).toBe(before + 2);
});

test('cross-Session wait_agent safely repolls, times out, and returns user steering', async () => {
  const f = fixture();
  expect(await f.port.waitAgent({ scope: f.scope, timeoutMs: 0, signal: f.signal })).toEqual({
    ok: true,
    timed_out: true,
    reason: 'timeout',
  });
  setTimeout(() => f.setUnread(1, 1), 10);
  expect(await f.port.waitAgent({ scope: f.scope, timeoutMs: 500, signal: f.signal })).toEqual({
    ok: true,
    timed_out: false,
    reason: 'mailbox_update',
  });
  f.setUnread(0, 1);
  setTimeout(() => f.steer(), 10);
  expect(await f.port.waitAgent({ scope: f.scope, timeoutMs: 500, signal: f.signal })).toEqual({
    ok: true,
    timed_out: false,
    reason: 'user_input',
  });
});

test('a released TriggerTurn appears as a child update without changing its old status', async () => {
  const f = fixture();
  setTimeout(() => f.setReleasedFollowup('submission-1'), 10);
  expect(await f.port.waitAgent({ scope: f.scope, timeoutMs: 500, signal: f.signal })).toEqual({
    ok: true,
    timed_out: false,
    reason: 'agent_update',
  });
  const listed = await f.port.listAgents({ scope: f.scope, signal: f.signal });
  expect(listed.ok).toBe(true);
  expect(listed.agents?.[1]).toMatchObject({
    agent_id: 'child',
    status: 'running',
    last_followup_status: 'failed',
    last_followup_submission_id: 'submission-1',
    last_followup_reason: 'authorization_changed',
  });
});

test('child QueueOnly replies require the exact active task and sealed grant', async () => {
  const f = fixture();
  const childState = {
    ...createInitialAgentState({
      threadId: 'child',
      userId: 'user',
      workspace: '/workspace',
      turnId: 'turn',
      recoveryIdentityKey: 'a'.repeat(64),
    }),
    activeTaskId: 'task',
    tools: {
      ...createInitialAgentState({
        threadId: 'child',
        userId: 'user',
        workspace: '/workspace',
        turnId: 'turn',
        recoveryIdentityKey: 'a'.repeat(64),
      }).tools,
      calls: {
        send: {
          toolCallId: 'send',
          name: 'send_message',
          modelMessageId: 'assistant',
          args: {},
          modelInvocationId: 'model',
          createdAtTurnId: 'turn',
          taskId: 'task',
          status: 'running' as const,
        },
      },
    },
    transcript: {
      messages: [
        {
          kind: 'assistant' as const,
          messageId: 'assistant',
          turnId: 'turn',
          ordinal: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          modelInvocationId: 'model',
          toolCalls: [{ id: 'send', name: 'send_message', args: {} }],
        },
      ],
    },
  } as RuntimeState;
  let grantActive = true;
  const accepted: Parameters<CrossSessionQueueMailPort['acceptQueueMailCommand']>[0][] = [];
  const storage: CrossSessionQueueMailPort = {
    readActiveChildGrant: () =>
      grantActive ? { parentSessionId: 'parent', grantDigest: `sha256:${'b'.repeat(64)}` } : null,
    readTarget: (_source, target) =>
      target === 'parent'
        ? { sessionId: 'parent', parentSessionId: null, status: 'waiting' }
        : null,
    nextSourceSequence: () => 1,
    lookupOutbox: () => null,
    async acceptQueueMailCommand(input) {
      accepted.push(input);
    },
    async deliverQueueMail() {},
  };
  const port = createCrossSessionChildMailboxPort({
    getState: () => childState,
    currentRunId: () => 'child-run',
    storage,
    toolCallId: 'send',
    signal: f.signal,
    child: {
      parentSessionId: 'parent',
      taskId: 'task',
      grantId: 'grant',
      grantDigest: `sha256:${'b'.repeat(64)}`,
    },
  });
  if (!port) throw new Error('Expected bound child Tool call.');
  const scope = {
    ...port.caller,
    toolCallId: 'send',
    effectAttemptId: 'attempt',
  };
  expect(port.caller).toMatchObject({ sourceTaskId: 'task', childGrantId: 'grant' });
  const request = {
    scope,
    agentId: 'parent',
    message: 'reply',
    mode: 'queue_only' as const,
    signal: f.signal,
  };
  expect(await port.submitMessage(request)).toEqual({ ok: true });
  expect(accepted[0]!.event.source).toMatchObject({ sourceTaskId: 'task' });
  expect(accepted[0]!.event.source).not.toHaveProperty('childGrantId');
  expect(() => assertCurrentRuntimeEvent(accepted[0]!.event)).not.toThrow();
  expect(accepted[0]!.intent.targetSessionId).toBe('parent');
  expect(accepted[0]!.intent).toMatchObject({
    sourceGrantId: 'grant',
    sourceGrantDigest: `sha256:${'b'.repeat(64)}`,
  });
  grantActive = false;
  expect(await port.submitMessage(request)).toEqual({ ok: false, code: 'invalid_source' });
  expect(accepted).toHaveLength(1);
});

describe('cross-Session parent QueueOnly mailbox', () => {
  test('source Tool returns after durable acceptance while target delivery is blocked', async () => {
    const f = fixture();
    f.setDeliveryGate(new Promise<void>(() => undefined));
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child',
        message: 'queued',
        mode: 'queue_only',
        signal: f.signal,
      }),
    ).toEqual({ ok: true });
    expect(f.accepted).toHaveLength(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.delivered).toEqual([]);
  });

  test('persists only metadata in State, private body in Store intent, then delivers', async () => {
    const f = fixture();
    expect(
      await f.port.submitMessage({
        scope: f.scope,
        agentId: 'child',
        message: 'hello child',
        mode: 'queue_only',
        signal: f.signal,
      }),
    ).toEqual({ ok: true });
    expect(f.accepted).toHaveLength(1);
    const committed = f.accepted[0]!;
    expect(committed.receipt.targetSessionId).toBe('parent');
    expect(committed.event.targetAgentId).toBe('child');
    expect(committed.event.sequence).toBe(1);
    expect(JSON.stringify(committed.event)).not.toContain('hello child');
    expect(committed.intent.bodyText).toBe('hello child');
    expect(f.delivered).toEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.delivered).toEqual([committed.event.messageId]);
  });

  test('replay retries delivery; accepted source command survives target outage', async () => {
    const f = fixture();
    f.setDeliveryFailure(true);
    const request = {
      scope: f.scope,
      agentId: 'child',
      message: 'hello',
      mode: 'queue_only' as const,
      signal: f.signal,
    };
    expect(await f.port.submitMessage(request)).toEqual({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.setDeliveryFailure(false);
    expect(await f.port.submitMessage(request)).toEqual({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.accepted).toHaveLength(1);
    expect(f.delivered).toHaveLength(2);
    expect(f.deliveryFailures).toHaveLength(1);
  });

  test('rejects wrong lineage, stale Run, and TriggerTurn before accepting', async () => {
    const f = fixture();
    f.setTargetParent('other');
    const request = {
      scope: f.scope,
      agentId: 'child',
      message: 'hello',
      mode: 'queue_only' as const,
      signal: f.signal,
    };
    expect(await f.port.submitMessage(request)).toEqual({ ok: false, code: 'agent_not_found' });
    f.setTargetParent('parent');
    f.setRun('other-run');
    expect(await f.port.submitMessage(request)).toEqual({ ok: false, code: 'invalid_source' });
    f.setRun('run');
    expect(await f.port.submitMessage({ ...request, mode: 'trigger_turn' })).toEqual({
      ok: false,
      code: 'admission_unavailable',
    });
    expect(f.accepted).toHaveLength(0);
  });
});

test('list_agents projects a new-turn outcome separately and wait_agent wakes from its source ACK watermark', async () => {
  const f = fixture();
  setTimeout(
    () =>
      f.setFollowupOutcome({
        submissionId: 'submission-completed',
        status: 'completed',
        taskId: 'followup-task',
        sourceRevision: 7,
      }),
    10,
  );
  expect(await f.port.waitAgent({ scope: f.scope, timeoutMs: 500, signal: f.signal })).toEqual({
    ok: true,
    timed_out: false,
    reason: 'agent_update',
  });
  const listed = await f.port.listAgents({ scope: f.scope, signal: f.signal });
  expect(listed.ok).toBe(true);
  expect(listed.agents?.[1]).toMatchObject({
    agent_id: 'child',
    status: 'running',
    last_followup_submission_id: 'submission-completed',
    last_followup_status: 'completed',
    last_followup_task_id: 'followup-task',
  });
  expect(await f.port.waitAgent({ scope: f.scope, timeoutMs: 0, signal: f.signal })).toEqual({
    ok: true,
    timed_out: false,
    reason: 'agent_update',
  });
});

test('unknown followup ACK is visible without overwriting the child first-turn status', async () => {
  const f = fixture();
  f.setFollowupOutcome({
    submissionId: 'submission-unknown',
    status: 'unknown',
    taskId: 'unknown-task',
    sourceRevision: 9,
  });
  const listed = await f.port.listAgents({ scope: f.scope, signal: f.signal });
  expect(listed.agents?.[1]).toMatchObject({
    agent_id: 'child',
    status: 'running',
    last_followup_status: 'unknown',
    last_followup_task_id: 'unknown-task',
  });
  f.setRun('other-run');
  expect(await f.port.waitAgent({ scope: f.scope, timeoutMs: 0, signal: f.signal })).toMatchObject({
    ok: false,
    code: 'invalid_source',
  });
});
