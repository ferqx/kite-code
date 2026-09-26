import { expect, test } from 'bun:test';
import {
  assertAgentStateInvariants,
  createInitialAgentState,
  type KernelEvent,
  type ResourceUsage,
  reduceAgentState,
} from '../src';

const emptyUpper = (): ResourceUsage => ({
  source: 'versioned_upper_bound',
  estimatorVersion: 'queued-followup-test-v1',
  counters: {
    turns: 0,
    modelRequests: 0,
    toolInvocations: 0,
    inputTokens: 0,
    outputTokens: 0,
    artifactBytes: 0,
  },
  gauges: {
    elapsedRunMs: 0,
    activeSubagents: 0,
    activeWriters: 0,
    activeToolInvocations: 0,
    activeShellInvocations: 0,
  },
});

test('queued TriggerTurn backup locks counters and needs an exact free slot before acquisition', () => {
  let state = createInitialAgentState({
    threadId: 'source',
    userId: 'user',
    workspace: '/workspace',
    turnId: 'turn',
    recoveryIdentityKey: '0'.repeat(64),
  });
  const apply = (event: KernelEvent) => {
    state = reduceAgentState(state, event);
  };
  apply({
    type: 'resource_budget.configured',
    runId: 'funding-run',
    startedAt: '2026-09-26T00:00:00.000Z',
    deadlineAt: '2026-09-26T00:01:00.000Z',
    budget: {
      version: 1,
      maxRunDurationMs: 60_000,
      maxTurns: 2,
      maxModelRequests: 2,
      maxToolInvocations: 1,
      maxRunInputTokens: 1_000,
      maxRunOutputTokens: 1_000,
      maxConcurrentSubagents: 1,
      maxConcurrentWriters: 1,
      maxConcurrentToolInvocations: 1,
      maxConcurrentShellInvocations: 1,
      maxConcurrencyWaitMs: 1_000,
      maxArtifactBytes: 100,
    },
  });
  const occupied: ResourceUsage = {
    ...emptyUpper(),
    gauges: { ...emptyUpper().gauges, activeSubagents: 1 },
  };
  apply({
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId: 'occupied',
      runId: 'funding-run',
      invocationId: 'occupied',
      resourceKind: 'subagent',
      executableUpperBound: occupied,
      state: 'reserved',
    },
  });
  const backupId = `backup_${'a'.repeat(64)}`;
  const backup: ResourceUsage = {
    ...emptyUpper(),
    counters: {
      ...emptyUpper().counters,
      turns: 1,
      modelRequests: 1,
      inputTokens: 50,
      outputTokens: 50,
    },
    gauges: { ...emptyUpper().gauges, activeSubagents: 1 },
  };
  apply({
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId: backupId,
      runId: 'funding-run',
      invocationId: 'submission',
      resourceKind: 'subagent',
      executableUpperBound: backup,
      state: 'queued',
    },
  });
  expect(state.resourceBudget.reservations[backupId]?.state).toBe('queued');
  expect(() => assertAgentStateInvariants(state)).not.toThrow();
  expect(() =>
    reduceAgentState(state, {
      type: 'resource_budget.child_slot_acquired',
      reservationId: backupId,
    }),
  ).toThrow('unavailable');
  apply({ type: 'resource_budget.released', reservationId: 'occupied' });
  apply({ type: 'resource_budget.child_slot_acquired', reservationId: backupId });
  expect(state.resourceBudget.reservations[backupId]?.state).toBe('reserved');
  expect(() => assertAgentStateInvariants(state)).not.toThrow();
});
