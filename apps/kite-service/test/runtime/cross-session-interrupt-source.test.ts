import { expect, test } from 'bun:test';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import type { AgentMailboxInvocationScope } from '@kite-ai/builtin-runtime/subagent';
import {
  type CrossSessionQueueMailPort,
  createCrossSessionRootMailboxPort,
} from '#kite-service/bootstrap/runtime/agent-mailbox-port';
import type { RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';

function fixture(status: 'active' | 'queued' | 'idle' | 'unavailable' = 'active') {
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
        interrupt: {
          toolCallId: 'interrupt',
          name: 'interrupt_agent',
          modelMessageId: 'assistant',
          args: { agent_id: 'child' },
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
          toolCalls: [{ id: 'interrupt', name: 'interrupt_agent', args: { agent_id: 'child' } }],
        },
      ],
    },
  } as RuntimeState;
  const accepted: Parameters<
    NonNullable<CrossSessionQueueMailPort['acceptInterruptCommand']>
  >[0][] = [];
  const scheduled: string[] = [];
  let replay = false;
  let currentRun = 'run';
  const storage = {
    readActiveChildGrant: () => null,
    readTarget: () => null,
    nextSourceSequence: () => 1,
    lookupOutbox: () => null,
    acceptQueueMailCommand: async () => undefined,
    deliverQueueMail: async () => undefined,
    readInterruptTarget: (_source: string, target: string) =>
      target === 'child'
        ? {
            targetSessionId: 'child',
            status,
            targetRunId: status === 'active' ? 'child-run' : null,
            targetTaskId: status === 'active' || status === 'queued' ? 'child-task' : null,
            targetOwnerGeneration: status === 'active' ? 2 : null,
            targetRevision: status === 'queued' ? 0 : 5,
            ...(status === 'queued' ? { queuedIntentEventId: 'queued-event' } : {}),
          }
        : null,
    lookupInterruptReceipt: ({
      commandId,
      requestDigest,
    }: {
      commandId: string;
      requestDigest: string;
    }) =>
      replay
        ? {
            status: 'replay' as const,
            receipt: { targetSessionId: 'parent', requestDigest, commandId },
          }
        : { status: 'missing' as const },
    readInterruptIntent: (_source: string, commandId: string) => {
      const prior = accepted.find((value) => value.intent.commandId === commandId);
      return prior
        ? {
            targetSessionId: prior.intent.targetSessionId,
            requestDigest: prior.intent.requestDigest,
            targetRunId: prior.intent.targetRunId,
            targetTaskId: prior.intent.targetTaskId,
            status: 'pending' as const,
          }
        : null;
    },
    acceptInterruptCommand: async (
      value: Parameters<NonNullable<CrossSessionQueueMailPort['acceptInterruptCommand']>>[0],
    ) => {
      accepted.push(value);
    },
  } as CrossSessionQueueMailPort;
  const abort = new AbortController();
  const port = createCrossSessionRootMailboxPort({
    getState: () => state,
    currentRunId: () => currentRun,
    storage,
    toolCallId: 'interrupt',
    signal: abort.signal,
    scheduleInterrupt: async (target, source, command) => {
      scheduled.push(`${target}:${source}:${command}`);
    },
  });
  if (!port) throw new Error('fixture Port missing');
  const scope: AgentMailboxInvocationScope = {
    ...port.caller,
    toolCallId: 'interrupt',
    effectAttemptId: 'attempt-1',
  };
  return {
    port,
    scope,
    signal: abort.signal,
    accepted,
    scheduled,
    setReplay: () => {
      replay = true;
    },
    setRun: (run: string) => {
      currentRun = run;
    },
  };
}

test('interrupt_agent accepts one exact active child stop intent and replays its receipt', async () => {
  const f = fixture();
  const result = await f.port.interruptAgent({
    scope: f.scope,
    agentId: 'child',
    signal: f.signal,
  });
  expect(result).toMatchObject({
    ok: true,
    agent_id: 'child',
    status: 'interrupt_requested',
    current_task_id: 'child-task',
    cancel_requested: true,
    cleanup_confirmed: false,
  });
  expect(f.accepted).toHaveLength(1);
  expect(f.accepted[0]?.event).toMatchObject({
    type: 'background_execution.stop_requested',
    executionId: 'child-task',
    ownerGeneration: 'child:2',
  });
  expect(f.accepted[0]?.intent).toMatchObject({
    sourceRunId: 'run',
    targetRunId: 'child-run',
    targetTaskId: 'child-task',
    sourceToolCallId: 'interrupt',
    sourceEffectAttemptId: 'attempt-1',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.scheduled).toHaveLength(1);
  f.setReplay();
  const replay = await f.port.interruptAgent({
    scope: f.scope,
    agentId: 'child',
    signal: f.signal,
  });
  expect(replay).toMatchObject({ ok: true, agent_id: 'child', status: 'pending' });
  expect(f.accepted).toHaveLength(1);
});

test('idle and wrong lineage never persist a false stop; stale source Run fails closed', async () => {
  const idle = fixture('idle');
  expect(
    await idle.port.interruptAgent({ scope: idle.scope, agentId: 'child', signal: idle.signal }),
  ).toMatchObject({ ok: true, status: 'idle', cancel_requested: false });
  expect(idle.accepted).toHaveLength(0);
  const active = fixture();
  expect(
    await active.port.interruptAgent({
      scope: active.scope,
      agentId: 'sibling',
      signal: active.signal,
    }),
  ).toMatchObject({ ok: false, code: 'agent_not_found' });
  active.setRun('other-run');
  expect(
    await active.port.interruptAgent({
      scope: active.scope,
      agentId: 'child',
      signal: active.signal,
    }),
  ).toMatchObject({ ok: false, code: 'invalid_source' });
  expect(active.accepted).toHaveLength(0);
});

test('queued child interrupt uses the parent accepted intent without inventing a child Run', async () => {
  const f = fixture('queued');
  const result = await f.port.interruptAgent({
    scope: f.scope,
    agentId: 'child',
    signal: f.signal,
  });
  expect(result).toMatchObject({
    ok: true,
    status: 'interrupt_requested',
    current_task_id: 'child-task',
  });
  expect(f.accepted).toHaveLength(1);
  expect(f.accepted[0]?.event.ownerGeneration).toBe('accepted:queued-event');
  expect(f.accepted[0]?.intent).toMatchObject({
    targetRunId: null,
    targetOwnerGeneration: null,
    targetRevision: 0,
    queuedIntentEventId: 'queued-event',
  });
});
