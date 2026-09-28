import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { childDelegatedUpperBoundDigest } from '@kite-ai/agent-kernel';
import {
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeChildSessionIntentMutation } from '@kite-ai/runtime-host/storage';
import type { RuntimeState } from '../src/bootstrap/runtime/state-runtime';
import { recoverChildDelegatedBudget } from '../src/bootstrap/runtime/subagent/child-budget-recovery';
import { buildChildSessionCreation } from '../src/bootstrap/runtime/subagent/child-session-creation';

const NOW = Date.parse('2026-09-24T00:00:00.000Z');
const DEADLINE = new Date(NOW + 120_000).toISOString();

function fixture() {
  const sealedGrantJson = '{"grant":"private"}';
  const grantDigest =
    `sha256:${createHash('sha256').update(sealedGrantJson).digest('hex')}` as const;
  const upper = createZeroResourceUsage('versioned_upper_bound', 'child-create-test');
  upper.counters.turns = 2;
  upper.counters.modelRequests = 2;
  upper.counters.toolInvocations = 2;
  upper.counters.inputTokens = 100;
  upper.counters.outputTokens = 100;
  upper.counters.artifactBytes = 100;
  upper.gauges.elapsedRunMs = 120_000;
  upper.gauges.activeSubagents = 1;
  upper.gauges.activeToolInvocations = 1;
  upper.gauges.activeShellInvocations = 1;
  const intent: RuntimeChildSessionIntentMutation = {
    childThreadId: 'child_123456',
    parentSessionId: 'parent-123',
    parentInvocationId: 'parent-invocation',
    originRunId: 'parent-run',
    originTurnId: 'parent-turn',
    originToolCallId: 'task-tool',
    attempt: 1,
    childInvocationId: 'child-invocation',
    grantDigest,
    sealedGrantJson,
    sealedGrantByteLength: Buffer.byteLength(sealedGrantJson),
    sealedGrantDigest: grantDigest,
    taskArtifactRef: {
      artifactId: 'task-artifact',
      kind: 'subagent_task',
      integrityIdentifier: `sha256:${'a'.repeat(64)}`,
      byteLength: 42,
    },
    taskArtifactDigest: `sha256:${'a'.repeat(64)}`,
    taskTextDigest: `sha256:${'b'.repeat(64)}`,
    disposition: 'required',
    role: 'review',
    fundingRunId: 'parent-run',
    delegatedReservationId: 'delegated-reservation',
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    deadlineAt: DEADLINE,
  };
  const initial = createRuntimeHostStateInitialState({
    threadId: intent.parentSessionId,
    userId: 'user-123',
    workspace: '/admitted/workspace',
    projectId: 'project-123',
    canonicalWorkspaceDigest: `sha256:${'c'.repeat(64)}`,
    recoveryIdentityKey: 'd'.repeat(64),
  });
  const parentState: RuntimeState = {
    ...initial,
    resourceBudget: {
      status: 'active',
      runId: intent.fundingRunId,
      startedAt: new Date(NOW).toISOString(),
      deadlineAt: DEADLINE,
      budget: INTERNAL_RESOURCE_BUDGET_,
      reconciledUsage: createZeroResourceUsage(),
      reservations: {
        [intent.delegatedReservationId]: {
          version: 1,
          reservationId: intent.delegatedReservationId,
          runId: intent.fundingRunId,
          invocationId: `child-allotment:${intent.childThreadId}`,
          resourceKind: 'subagent',
          executableUpperBound: upper,
          state: 'reserved',
        },
      },
      waiters: {},
      nextWaiterSequence: 0,
    },
  };
  return {
    intent,
    upper,
    parentState,
    admittedWorkspace: '/admitted/workspace',
    parentModelRoute: { provider: 'fixture', name: 'flash' },
    workerInstanceId: 'host-123',
    executionClientId: 'parent-host-123',
    executionConnectionGeneration: 1,
    nowMs: NOW + 1_000,
  };
}

test('child creation input prebinds exact origin, unconfigured budget and private receipts', () => {
  const creation = buildChildSessionCreation(fixture());
  const child = creation.runtime.snapshot;
  const receipt = creation.runtime.commandReceipt;
  const recoveryIdentity = creation.recoveryIdentity;
  if (!receipt || !recoveryIdentity) throw new Error('Child creation omitted private credentials.');
  expect(child.revision).toBe(0);
  expect(child.session.threadId).toBe('child_123456');
  expect(child.session.projectId).toBe('project-123');
  expect(child.resourceBudget.status).toBe('unconfigured');
  expect(child.childSessionOrigin?.taskInputAdmitted).toBeUndefined();
  expect(child.childSessionOrigin?.childInvocationId).toBe('child-invocation');
  expect(child.transcript.messages).toHaveLength(0);
  expect(creation.runtime.sessionModelRoute).toEqual({ provider: 'fixture', name: 'flash' });
  expect(receipt.commandId).toBe('create-child:child_123456');
  expect(creation.controller.requestId).toBe('create-child:child_123456:controller');
  expect(creation.controller.requestDigest).toBe(receipt.requestDigest);
  expect(recoveryIdentity).toMatch(/^[a-f0-9]{64}$/);
  expect(child.toolRecovery.identityKey).toBe(recoveryIdentity);
  expect(Buffer.from(creation.controller.resumeSecret, 'base64url')).toHaveLength(32);
  expect(JSON.stringify(child)).not.toContain('private');
  expect(buildChildSessionCreation(fixture()).runtime.commandReceipt?.requestDigest).toBe(
    receipt.requestDigest,
  );
});

test('recovery derives a bounded child budget from the persisted parent allotment', () => {
  const base = fixture();
  const intent = {
    ...base.intent,
    delegatedUpperBoundJson: JSON.stringify(base.upper),
  };
  const recovered = recoverChildDelegatedBudget({
    intent,
    parentState: base.parentState,
    grantIssuedAtMs: NOW,
    nowMs: NOW + 30_000,
  });
  expect(recovered.childDeadlineAt).toBe(DEADLINE);
  expect(recovered.childBudget.maxRunDurationMs).toBe(90_000);
  expect(recovered.childBudget.maxTurns).toBeLessThanOrEqual(base.upper.counters.turns);
  expect(recovered.childBudget.maxModelRequests).toBeLessThanOrEqual(
    base.upper.counters.modelRequests,
  );
  expect(recovered.childBudget.maxConcurrentToolInvocations).toBeLessThanOrEqual(
    base.upper.gauges.activeToolInvocations,
  );
  expect(() =>
    recoverChildDelegatedBudget({
      intent,
      parentState: base.parentState,
      grantIssuedAtMs: NOW,
      nowMs: NOW + 120_000,
    }),
  ).toThrow();
});

test('recovery rejects a changed persisted ceiling and never extends its duration', () => {
  const base = fixture();
  const upper = { ...base.upper, gauges: { ...base.upper.gauges, elapsedRunMs: 40_000 } };
  const parentState: RuntimeState = {
    ...base.parentState,
    resourceBudget: {
      ...base.parentState.resourceBudget,
      reservations: {
        [base.intent.delegatedReservationId]: {
          ...base.parentState.resourceBudget.reservations[base.intent.delegatedReservationId]!,
          executableUpperBound: upper,
        },
      },
    } as RuntimeState['resourceBudget'],
  };
  const intent = {
    ...base.intent,
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    delegatedUpperBoundJson: JSON.stringify(upper),
  };
  const result = recoverChildDelegatedBudget({
    intent,
    parentState,
    grantIssuedAtMs: NOW,
    nowMs: NOW + 10_000,
  });
  expect(result.childDeadlineAt).toBe(new Date(NOW + 40_000).toISOString());
  expect(result.childBudget.maxRunDurationMs).toBe(30_000);
  expect(() =>
    recoverChildDelegatedBudget({
      intent: { ...intent, delegatedUpperBoundJson: JSON.stringify(base.upper) },
      parentState,
      grantIssuedAtMs: NOW,
      nowMs: NOW + 10_000,
    }),
  ).toThrow();
});

test('recovery grants a new 30-minute child turn after the parent deadline only with the persisted marker', () => {
  const base = fixture();
  const upper = {
    ...base.upper,
    unboundedToolInvocations: true as const,
    independentChildTurnDeadline: true as const,
    counters: { ...base.upper.counters, toolInvocations: 0 },
    gauges: {
      ...base.upper.gauges,
      elapsedRunMs: 30 * 60_000,
      activeToolInvocations: 0,
      activeShellInvocations: 0,
    },
  };
  const reservationId = `child-allotment:${base.intent.childThreadId}`;
  const parentState: RuntimeState = {
    ...base.parentState,
    resourceBudget: {
      ...base.parentState.resourceBudget,
      budget: INTERNAL_RESOURCE_BUDGET_,
      reservations: {
        [reservationId]: {
          ...base.parentState.resourceBudget.reservations[base.intent.delegatedReservationId]!,
          reservationId,
          invocationId: reservationId,
          executableUpperBound: upper,
        },
      },
    } as RuntimeState['resourceBudget'],
  };
  const intent = {
    ...base.intent,
    delegatedReservationId: reservationId,
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    delegatedUpperBoundJson: JSON.stringify(upper),
  };
  const nowMs = NOW + 130_000;
  const result = recoverChildDelegatedBudget({
    intent,
    parentState,
    grantIssuedAtMs: NOW,
    nowMs,
  });
  expect(result.childDeadlineAt).toBe(new Date(nowMs + 30 * 60_000).toISOString());
  expect(result.childBudget.maxRunDurationMs).toBe(30 * 60_000);
  expect(result.childBudget.maxToolInvocations).toBe(0);
  expect(result.childBudget.maxConcurrentToolInvocations).toBe(1);
  expect(result.childBudget.unboundedToolInvocations).toBe(true);
  expect(() =>
    recoverChildDelegatedBudget({
      intent: { ...intent, delegatedUpperBoundJson: JSON.stringify(base.upper) },
      parentState,
      grantIssuedAtMs: NOW,
      nowMs,
    }),
  ).toThrow();
});

test('child creation rejects stale authority, workspace mismatch and altered grant', () => {
  const base = fixture();
  expect(() => buildChildSessionCreation({ ...base, admittedWorkspace: '/other' })).toThrow();
  expect(() => buildChildSessionCreation({ ...base, nowMs: NOW + 121_000 })).toThrow();
  expect(() =>
    buildChildSessionCreation({
      ...base,
      intent: { ...base.intent, sealedGrantJson: '{"grant":"altered"}' },
    }),
  ).toThrow();
  expect(() => buildChildSessionCreation({ ...base, parentModelRoute: null })).toThrow();
});

test('marked child creation can occur after the parent deadline with a fresh controller lease', () => {
  const base = fixture();
  const reservationId = `child-allotment:${base.intent.childThreadId}`;
  const upper = {
    ...base.upper,
    unboundedToolInvocations: true as const,
    independentChildTurnDeadline: true as const,
    counters: { ...base.upper.counters, toolInvocations: 0 },
    gauges: { ...base.upper.gauges, elapsedRunMs: 30 * 60_000 },
  };
  const parentState: RuntimeState = {
    ...base.parentState,
    resourceBudget: {
      ...base.parentState.resourceBudget,
      budget: INTERNAL_RESOURCE_BUDGET_,
      reservations: {
        [reservationId]: {
          ...base.parentState.resourceBudget.reservations[base.intent.delegatedReservationId]!,
          reservationId,
          invocationId: reservationId,
          executableUpperBound: upper,
        },
      },
    } as RuntimeState['resourceBudget'],
  };
  const nowMs = NOW + 130_000;
  const creation = buildChildSessionCreation({
    ...base,
    intent: {
      ...base.intent,
      delegatedReservationId: reservationId,
      delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    },
    parentState,
    nowMs,
  });
  expect(creation.controller.executionLeaseUntilMs).toBe(nowMs + 60_000);
  expect(creation.controller.resumeExpiresAtMs).toBe(nowMs + 60_000);
  expect(() => buildChildSessionCreation({ ...base, nowMs })).toThrow(
    'Child Session creation lacks exact admitted parent authority',
  );
});
