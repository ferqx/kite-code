import { expect, test } from 'bun:test';
import type { StateRuntimeEvent } from '@kite-ai/runtime-host';
import type { RuntimeAgentMailboxMutation } from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import {
  prepareBackgroundAgentTerminalReply,
  recordSubagentDispatchIntent,
} from '../src/bootstrap/runtime/subagent/task-tool';

test('child dispatch helper binds exact Agent facts and reuses the acknowledged intent on retry', async () => {
  const grant = {
    purpose: 'start',
    grantId: 'grant-1',
    parentInvocationId: 'parent-invocation-1',
    parentToolCallId: 'parent-tool-1',
    parentAttempt: 1,
    childInvocationId: 'child-agent-1',
    taskArtifact: { artifactId: 'task-artifact-1' },
    taskDigest: 'sha256:task',
    role: 'review',
  } as unknown as SubagentDelegationGrant;
  const state = {
    session: { threadId: 'session-1' },
    capabilities: {
      invocations: {
        [grant.parentInvocationId]: {
          subagentProviderLifecycle: undefined as
            | { dispatchIntentDigest: string; status: 'intent_recorded' }
            | undefined,
        },
      },
    },
  };
  const committed: Array<{
    events: readonly StateRuntimeEvent[];
    mutations: readonly RuntimeAgentMailboxMutation[];
  }> = [];
  let legacyPersistCalls = 0;
  let generationReads = 0;
  const deps = {
    subagentLifecyclePersistence: {
      getState: () =>
        state as unknown as import('@kite-ai/runtime-host/kernel-adapter').RuntimeState,
      persistEvents: async () => {
        legacyPersistCalls += 1;
        return true;
      },
    },
    currentExecutionGeneration: () => {
      generationReads += 1;
      return '7';
    },
    commitAgentMailboxFacts: async (input: {
      readonly events: readonly StateRuntimeEvent[];
      readonly mutations: readonly RuntimeAgentMailboxMutation[];
    }) => {
      committed.push(input);
      const intent = input.events.find(
        (event) => event.type === 'capability.subagent_dispatch_intent_recorded',
      );
      if (intent?.type !== 'capability.subagent_dispatch_intent_recorded')
        throw new Error('Dispatch intent is missing.');
      state.capabilities.invocations[grant.parentInvocationId]!.subagentProviderLifecycle = {
        dispatchIntentDigest: intent.dispatchIntentDigest,
        status: 'intent_recorded',
      };
      return input.events;
    },
  };
  const digest = await recordSubagentDispatchIntent(deps, grant, {
    name: 'Registered child',
    role: 'review',
  });
  expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(committed).toHaveLength(1);
  expect(legacyPersistCalls).toBe(0);
  expect(generationReads).toBe(1);
  expect(committed[0]!.events.map((event) => event.type)).toEqual([
    'capability.subagent_dispatch_intent_recorded',
    'subagent.started',
    'agent.created',
    'agent.turn_started',
  ]);
  expect(committed[0]!.events.find((event) => event.type === 'agent.created')).toMatchObject({
    agentId: grant.childInvocationId,
    parentAgentId: 'session-1',
    initialTaskId: grant.childInvocationId,
  });
  expect(committed[0]!.events.find((event) => event.type === 'agent.turn_started')).toMatchObject({
    agentId: grant.childInvocationId,
    taskId: grant.childInvocationId,
    turnOrdinal: 1,
    ownerGeneration: '7',
    grantDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
  });
  expect(committed[0]!.mutations).toEqual([
    expect.objectContaining({
      kind: 'create_agent',
      agentId: grant.childInvocationId,
      parentAgentId: 'session-1',
      initialTaskId: grant.childInvocationId,
    }),
    {
      kind: 'turn_started',
      agentId: grant.childInvocationId,
      taskId: grant.childInvocationId,
      turnOrdinal: 1,
    },
  ]);
  expect(
    await recordSubagentDispatchIntent(deps, grant, {
      name: 'Registered child',
      role: 'review',
    }),
  ).toBe(digest);
  expect(committed).toHaveLength(1);
  expect(legacyPersistCalls).toBe(0);
  expect(generationReads).toBe(1);
});

test('terminal-derived reply is deterministic, status-only, private, and exact to the child source', () => {
  const notification = {
    notificationId: `subagent:child-agent-1:sha256:${'a'.repeat(64)}`,
    source: 'subagent' as const,
    modelRole: 'user' as const,
    ownerKey: 'owner-1',
    taskId: 'child-agent-1',
    originRunId: 'run-1',
    originTurnId: 'turn-1',
    originToolCallId: 'tool-1',
    attempt: 2,
    status: 'completed' as const,
    shortReport: 'PRIVATE_RESULT_BODY_MUST_NOT_APPEAR',
    resultArtifact: {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'subagent_task' as const,
      integrityIdentifier: `sha256:${'a'.repeat(64)}`,
      byteLength: 100,
    },
    cancelRequested: false,
  };
  const input = {
    sessionId: 'session-1',
    notification,
    parentModelInvocationId: 'model-1',
    parentCapabilityInvocationId: 'capability-1',
    sequence: 3,
    acceptedAtMs: 1_700_000_000_000,
  };
  const first = prepareBackgroundAgentTerminalReply(input);
  const replay = prepareBackgroundAgentTerminalReply({
    ...input,
    acceptedAtMs: input.acceptedAtMs + 1,
  });
  expect(first.event).toEqual(replay.event);
  expect(first.event).toMatchObject({
    type: 'agent.mail_accepted',
    mode: 'reply',
    senderAgentId: notification.taskId,
    targetAgentId: 'session-1',
    sequence: 3,
    source: {
      runId: 'run-1',
      turnId: 'turn-1',
      modelInvocationId: 'model-1',
      toolCallId: 'tool-1',
      effectAttemptId: 'capability-1:attempt:2',
      sourceTaskId: notification.taskId,
    },
  });
  expect(first.event.bodyRef).toMatchObject({
    kind: 'agent_mail',
    integrityIdentifier: first.event.bodyDigest,
  });
  expect(first.mutation.bodyText).toContain('completed');
  expect(first.mutation.bodyText).toContain('task_read');
  expect(first.mutation.bodyText).not.toContain(notification.shortReport);
  expect(JSON.stringify(first.event)).not.toContain(notification.shortReport);
  expect(Buffer.byteLength(first.mutation.bodyText, 'utf8')).toBeLessThanOrEqual(4_096);
  expect(first.mutation.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(() =>
    prepareBackgroundAgentTerminalReply({
      ...input,
      notification: { ...notification, status: 'running' },
    }),
  ).toThrow('Background Agent reply source is invalid.');
});
