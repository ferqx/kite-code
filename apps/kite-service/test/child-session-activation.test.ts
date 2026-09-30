import { expect, test } from 'bun:test';
import { childDelegatedUpperBoundDigest } from '@kite-ai/agent-kernel';
import { createZeroResourceUsage } from '@kite-ai/runtime-host/kernel-adapter';
import { sealChildGrantPayload } from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import { activateAcceptedChildSession } from '../src/bootstrap/runtime/subagent/child-session-activation';

type Activation = Parameters<typeof activateAcceptedChildSession>[0];

function fixture(persistAck: boolean, independentTurnDeadline = false) {
  const calls: string[] = [];
  let childRunOrigin: { originSessionId?: string; originRunId?: string } | undefined;
  let configuredDeadlineAt: string | null | undefined;
  const now = Date.now();
  const childThreadId = `child_${'a'.repeat(64)}`;
  const parentSessionId = 'parent';
  const childRunId = 'child-run';
  const taskArtifact = {
    artifactId: 'task-artifact',
    kind: 'subagent_task',
    integrityIdentifier: `sha256:${'b'.repeat(64)}`,
    byteLength: 25,
  } as const;
  const grant = {
    purpose: 'start',
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'task-call',
    parentAttempt: 1,
    childInvocationId: 'child-invocation',
    role: 'review',
    taskArtifact,
    taskDigest: `sha256:${'c'.repeat(64)}`,
    expiresAtMs: now + 30_000,
  } as SubagentDelegationGrant;
  const sealed = sealChildGrantPayload(grant);
  const upper = createZeroResourceUsage('versioned_upper_bound', 'test');
  upper.counters.turns = 2;
  upper.counters.modelRequests = 2;
  upper.counters.toolInvocations = 2;
  upper.counters.inputTokens = 100;
  upper.counters.outputTokens = 100;
  upper.counters.artifactBytes = 100;
  upper.gauges.elapsedRunMs = 20_000;
  upper.gauges.activeSubagents = 1;
  upper.gauges.activeToolInvocations = 1;
  upper.gauges.activeShellInvocations = 1;
  if (independentTurnDeadline) {
    upper.counters.toolInvocations = 0;
    upper.gauges.elapsedRunMs = 30 * 60_000;
    upper.unboundedToolInvocations = true;
    upper.independentChildTurnDeadline = true;
  }
  const reservation = {
    version: 1,
    reservationId: `child-allotment:${childThreadId}`,
    runId: 'parent-run',
    invocationId: `child-allotment:${childThreadId}`,
    resourceKind: 'subagent',
    executableUpperBound: upper,
    state: 'reserved',
  } as const;
  const budget = {
    version: 1,
    maxRunDurationMs: 20_000,
    maxTurns: 2,
    maxModelRequests: 2,
    maxToolInvocations: 2,
    maxRunInputTokens: 100,
    maxRunOutputTokens: 100,
    maxConcurrentSubagents: 1,
    maxConcurrentWriters: 1,
    maxConcurrentToolInvocations: 1,
    maxConcurrentShellInvocations: 1,
    maxConcurrencyWaitMs: 10_000,
    maxArtifactBytes: 100,
  } as const;
  const intent = {
    childThreadId,
    parentSessionId,
    parentInvocationId: grant.parentInvocationId,
    originRunId: 'parent-run',
    originTurnId: 'parent-turn',
    originToolCallId: grant.parentToolCallId,
    attempt: grant.parentAttempt,
    childInvocationId: grant.childInvocationId,
    grantDigest: sealed.sealedGrantDigest,
    sealedGrantByteLength: sealed.sealedGrantByteLength,
    sealedGrantDigest: sealed.sealedGrantDigest,
    taskArtifactRef: taskArtifact,
    taskArtifactDigest: taskArtifact.integrityIdentifier,
    taskTextDigest: grant.taskDigest,
    disposition: 'required' as const,
    role: grant.role,
    fundingRunId: 'parent-run',
    delegatedReservationId: reservation.reservationId,
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    deadlineAt: new Date(now + 30_000).toISOString(),
    taskArtifactId: taskArtifact.artifactId,
    taskArtifactByteLength: taskArtifact.byteLength,
    toolEventId: 'accepted-tool',
    toolEventRevision: 1,
    delegatedUpperBoundJson: JSON.stringify(upper),
    childSessionCreated: false,
    failureReceiptDigest: null,
    failureMode: null,
    childBudgetActivatedRunId: null as string | null,
    childBudgetActivatedEventId: null,
    childBudgetActivatedRevision: null,
    dispatchAckEventId: null as string | null,
    dispatchAckRevision: null,
    parentClaimSettledEventId: null,
    parentClaimSettledRevision: null,
  };
  const creation = { childSessionIntent: intent } as unknown as Activation['creation'];
  const input: Activation = {
    owner: {
      readChildSessionIntent: () => ({ ...intent }),
      readChildSealedGrant: () => sealed,
      runWithSessionExecution: (_sessionId, operation) => operation(),
      createChildSession: () => {
        calls.push('create');
        intent.childSessionCreated = true;
        return {} as ReturnType<Activation['owner']['createChildSession']>;
      },
    },
    parent: {
      sessionId: parentSessionId,
      getState: () =>
        ({
          resourceBudget: {
            status: 'active',
            runId: 'parent-run',
            reservations: { [reservation.reservationId]: reservation },
          },
          retainedResourceBudgets: {},
        }) as ReturnType<Activation['parent']['getState']>,
      commitChildDispatchAck: () => {
        calls.push('ack');
        if (persistAck) intent.dispatchAckEventId = 'durable-ack';
        return [];
      },
    },
    ensureChild: () => ({
      sessionId: childThreadId,
      getState: () => ({}) as ReturnType<ReturnType<Activation['ensureChild']>['getState']>,
      commitChildBudgetActivation: (events, _mutation, evidence) => {
        calls.push('activate');
        childRunOrigin = evidence.runStart;
        configuredDeadlineAt = events.find(
          (event) => event.type === 'resource_budget.configured',
        )?.deadlineAt;
        intent.childBudgetActivatedRunId = childRunId;
        return {} as ReturnType<
          ReturnType<Activation['ensureChild']>['commitChildBudgetActivation']
        >;
      },
    }),
    creation,
    childBudget: independentTurnDeadline
      ? {
          ...budget,
          maxRunDurationMs: 30 * 60_000,
          maxToolInvocations: 0,
          unboundedToolInvocations: true,
        }
      : budget,
    childDeadlineAt: new Date(now + 20_000).toISOString(),
    childRunId,
    evidence: {
      scopeSessionId: childThreadId,
      commandId: 'child-activation',
      requestDigest: 'd'.repeat(64),
      targetSessionId: childThreadId,
      committedAt: now,
    },
    inspectGrant: (value) => {
      calls.push('inspect');
      return value as SubagentDelegationGrant;
    },
    startedAt: now + (independentTurnDeadline ? 25_000 : 0),
  };
  return {
    input,
    calls,
    grant,
    intent,
    childRunOrigin: () => childRunOrigin,
    configuredDeadlineAt: () => configuredDeadlineAt,
  };
}

test('child activation orders Store creation, Run activation and durable parent ACK before returning grant', () => {
  const { input, calls, grant, childRunOrigin } = fixture(true);
  expect(activateAcceptedChildSession(input)).toEqual(grant);
  expect(childRunOrigin()).toMatchObject({ originSessionId: 'parent', originRunId: 'parent-run' });
  calls.push('provider-start');
  expect(calls).toEqual(['inspect', 'create', 'activate', 'ack', 'provider-start']);
});

test('child activation with missing durable ACK never returns a Provider-start grant', () => {
  const { input, calls } = fixture(false);
  expect(() => activateAcceptedChildSession(input)).toThrow('ACK is not durable');
  expect(calls).toEqual(['inspect', 'create', 'activate', 'ack']);
});

test('recovery of a created and activated child skips both transactions and commits only missing ACK', () => {
  const { input, calls, grant, intent } = fixture(true);
  intent.childSessionCreated = true;
  intent.childBudgetActivatedRunId = input.childRunId;
  expect(activateAcceptedChildSession(input)).toEqual(grant);
  expect(calls).toEqual(['inspect', 'ack']);
});

test('new child grant configures 30 minutes from activation, beyond the parent funding deadline', () => {
  const { input, grant, configuredDeadlineAt } = fixture(true, true);
  expect(activateAcceptedChildSession(input)).toEqual(grant);
  expect(configuredDeadlineAt()).toBe(new Date(input.startedAt + 30 * 60_000).toISOString());
});
