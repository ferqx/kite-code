import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { childThreadIdForToolAttempt, createInitialAgentState } from '@kite-ai/agent-kernel';
import {
  assertChildBudgetWithinDelegation,
  assertPreDispatchChildFailureProof,
  childSessionAcceptanceEffectId,
  childTerminalReceiptDigest,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
  reconciliationEventsForReservations,
  reduceResourceBudgetState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { sealChildGrantPayload } from '@kite-ai/runtime-host/storage';

const startedAt = '2026-09-23T00:00:00.000Z';
const deadlineAt = '2026-09-23T00:01:00.000Z';

describe('independent child funding', () => {
  test('duration-only budget requires an exact marked child allotment', () => {
    const upper = createZeroResourceUsage('versioned_upper_bound', 'child-duration-v1');
    upper.durationOnlyChildRun = true;
    upper.independentChildTurnDeadline = true;
    upper.unboundedToolInvocations = true;
    upper.gauges.elapsedRunMs = 30 * 60 * 1000;
    upper.gauges.activeSubagents = 1;
    const reservation = {
      version: 1 as const,
      reservationId: 'child-allotment:duration',
      runId: 'parent-run',
      invocationId: 'child-allotment:duration',
      resourceKind: 'subagent' as const,
      executableUpperBound: upper,
      state: 'reserved' as const,
    };
    const budget = {
      ...INTERNAL_RESOURCE_BUDGET_,
      maxRunDurationMs: 30 * 60 * 1000,
      maxTurns: 0,
      maxModelRequests: 0,
      maxToolInvocations: 0,
      maxRunInputTokens: 0,
      maxRunOutputTokens: 0,
      maxArtifactBytes: 0,
      unboundedToolInvocations: true as const,
      durationOnlyChildRun: true as const,
      maxConcurrentSubagents: 0,
      maxConcurrentWriters: 0,
    };
    const input = {
      reservation,
      childBudget: budget,
      childStartedAt: '2026-09-23T00:00:30.000Z',
      childDeadlineAt: '2026-09-23T00:30:30.000Z',
      fundingDeadlineAt: '2026-09-23T00:01:00.000Z',
      childMaySpawn: false,
      childMayWrite: false,
    };
    expect(() => assertChildBudgetWithinDelegation(input)).not.toThrow();
    expect(() =>
      assertChildBudgetWithinDelegation({
        ...input,
        reservation: {
          ...reservation,
          executableUpperBound: { ...upper, durationOnlyChildRun: undefined },
        },
      }),
    ).toThrow('exceeds its parent delegation');
    expect(() =>
      assertChildBudgetWithinDelegation({
        ...input,
        reservation: {
          ...reservation,
          reservationId: 'forged',
        },
      }),
    ).toThrow('exceeds its parent delegation');
  });
  test('new child turn may have 30 minutes from activation while legacy deadlines stay inherited', () => {
    const upper = createZeroResourceUsage('versioned_upper_bound', 'child-turn-v1');
    upper.counters.turns = 1;
    upper.counters.modelRequests = 1;
    upper.counters.inputTokens = 1;
    upper.counters.outputTokens = 1;
    upper.counters.artifactBytes = 1;
    upper.gauges.elapsedRunMs = 30 * 60 * 1000;
    upper.gauges.activeSubagents = 1;
    upper.gauges.activeToolInvocations = 1;
    upper.gauges.activeShellInvocations = 1;
    const reservation = {
      version: 1 as const,
      reservationId: 'child-allotment:child',
      runId: 'parent-run',
      invocationId: 'child-allotment:child',
      resourceKind: 'subagent' as const,
      executableUpperBound: {
        ...upper,
        unboundedToolInvocations: true as const,
        independentChildTurnDeadline: true as const,
      },
      state: 'reserved' as const,
    };
    const budget = {
      ...INTERNAL_RESOURCE_BUDGET_,
      maxRunDurationMs: 30 * 60 * 1000,
      maxTurns: 1,
      maxModelRequests: 1,
      maxToolInvocations: 0,
      unboundedToolInvocations: true as const,
      maxRunInputTokens: 1,
      maxRunOutputTokens: 1,
      maxArtifactBytes: 1,
      maxConcurrentSubagents: 1,
      maxConcurrentWriters: 1,
      maxConcurrentToolInvocations: 1,
      maxConcurrentShellInvocations: 1,
    };
    const input = {
      reservation,
      childBudget: budget,
      childStartedAt: '2026-09-23T00:00:30.000Z',
      childDeadlineAt: '2026-09-23T00:30:30.000Z',
      fundingDeadlineAt: '2026-09-23T00:01:00.000Z',
      childMaySpawn: false,
      childMayWrite: false,
    };
    expect(() => assertChildBudgetWithinDelegation(input)).not.toThrow();
    expect(() =>
      assertChildBudgetWithinDelegation({
        ...input,
        reservation: {
          ...reservation,
          executableUpperBound: {
            ...reservation.executableUpperBound,
            gauges: {
              ...reservation.executableUpperBound.gauges,
              activeToolInvocations: 0,
              activeShellInvocations: 0,
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertChildBudgetWithinDelegation({
        ...input,
        reservation: { ...reservation, executableUpperBound: upper },
      }),
    ).toThrow('exceeds its parent delegation');
    expect(() =>
      assertChildBudgetWithinDelegation({
        ...input,
        childDeadlineAt: '2026-09-23T00:30:30.001Z',
      }),
    ).toThrow('exceeds its parent delegation');
    expect(() =>
      assertChildBudgetWithinDelegation({
        ...input,
        reservation: {
          ...reservation,
          executableUpperBound: { ...upper, independentChildTurnDeadline: true as const },
        },
      }),
    ).toThrow('exceeds its parent delegation');
  });
  test('unknown terminal receipt is distinct from a clean terminal receipt', () => {
    const identity = {
      childThreadId: `child_${'a'.repeat(64)}`,
      terminalRevision: 9,
      terminalReceiptId: 'recovery-terminal',
      resultIntegrityIdentifier: `sha256:${'b'.repeat(64)}`,
    };
    expect(childTerminalReceiptDigest({ ...identity, unknownRecovery: true })).not.toBe(
      childTerminalReceiptDigest(identity),
    );
  });
  test('seals one bounded canonical private grant without hidden or computed fields', () => {
    const payload = sealChildGrantPayload({
      role: 'explore',
      parentInvocationId: 'parent',
      grantId: 'g',
    });
    expect(payload.sealedGrantJson).toBe(
      '{"grantId":"g","parentInvocationId":"parent","role":"explore"}',
    );
    expect(payload.sealedGrantByteLength).toBe(Buffer.byteLength(payload.sealedGrantJson));
    expect(payload.sealedGrantDigest).toBe(
      `sha256:${createHash('sha256').update(payload.sealedGrantJson).digest('hex')}`,
    );
    expect(() =>
      sealChildGrantPayload({
        grantId: 'g',
        get role() {
          return 'explore';
        },
      }),
    ).toThrow();
    expect(() => sealChildGrantPayload({ body: 'x'.repeat(128 * 1024) })).toThrow();
  });
  test('pre-dispatch abandonment requires the exact released child revision', () => {
    expect(() =>
      assertPreDispatchChildFailureProof('absent_child', 'child', () => {
        throw new Error('Absent child must not be read.');
      }),
    ).not.toThrow();
    expect(() =>
      assertPreDispatchChildFailureProof('created_unactivated', 'child', () => ({
        childRevision: 0,
        ownerStatus: 'idle',
        cleanupConfirmed: true,
      })),
    ).not.toThrow();
    expect(() =>
      assertPreDispatchChildFailureProof('activated_no_ack', 'child', () => ({
        childRevision: 5,
        ownerStatus: 'idle',
        cleanupConfirmed: true,
      })),
    ).not.toThrow();
    expect(() =>
      assertPreDispatchChildFailureProof('activated_no_ack', 'child', () => ({
        childRevision: 0,
        ownerStatus: 'idle',
        cleanupConfirmed: true,
      })),
    ).toThrow('not safely abandoned');
    for (const proof of [
      { childRevision: 1, ownerStatus: 'idle' as const, cleanupConfirmed: true },
      { childRevision: 0, ownerStatus: 'active' as const, cleanupConfirmed: true },
      { childRevision: 0, ownerStatus: 'idle' as const, cleanupConfirmed: false },
    ]) {
      expect(() =>
        assertPreDispatchChildFailureProof('created_unactivated', 'child', () => proof),
      ).toThrow('not safely abandoned');
    }
  });
  test('three sibling receipts use distinct Store leases and fit only after transient reconciliation', () => {
    let ledger = reduceResourceBudgetState(
      { status: 'unconfigured', reservations: {} },
      {
        type: 'resource_budget.configured',
        runId: 'parent-run',
        startedAt,
        deadlineAt,
        budget: INTERNAL_RESOURCE_BUDGET_,
      },
    );
    const effectIds = new Set<string>();
    const transientIds: string[] = [];
    for (let index = 1; index <= 3; index++) {
      const childThreadId = childThreadIdForToolAttempt({
        parentSessionId: 'parent',
        parentInvocationId: `invocation-${index}`,
        parentToolCallId: `tool-${index}`,
        attempt: 1,
      });
      effectIds.add(childSessionAcceptanceEffectId(childThreadId));
      const transientId = `transient-${index}`;
      transientIds.push(transientId);
      const transientUpper = createZeroResourceUsage('versioned_upper_bound', 'test-tool-v1');
      transientUpper.counters.toolInvocations = 1;
      transientUpper.gauges.activeSubagents = 1;
      ledger = reduceResourceBudgetState(ledger, {
        type: 'resource_budget.reserved',
        reservation: {
          version: 1,
          reservationId: transientId,
          runId: 'parent-run',
          invocationId: `tool:tool-${index}`,
          resourceKind: 'subagent',
          executableUpperBound: transientUpper,
          state: 'reserved',
        },
      });
      ledger = reduceResourceBudgetState(ledger, {
        type: 'resource_budget.dispatch_started',
        reservationId: transientId,
      });
      const actual = createZeroResourceUsage();
      actual.counters.toolInvocations = 1;
      ledger = reduceResourceBudgetState(ledger, {
        type: 'resource_budget.reconciled',
        reservationId: transientId,
        actual,
      });
      const childUpper = createZeroResourceUsage('versioned_upper_bound', 'test-child-v1');
      childUpper.counters.turns = 1;
      childUpper.counters.modelRequests = 2;
      childUpper.counters.toolInvocations = 1;
      childUpper.counters.inputTokens = 1_000;
      childUpper.counters.outputTokens = 500;
      childUpper.counters.artifactBytes = 1;
      childUpper.gauges.activeSubagents = 1;
      childUpper.gauges.activeToolInvocations = 1;
      childUpper.gauges.activeShellInvocations = 1;
      const allotment = {
        version: 1 as const,
        reservationId: `delegated-${index}`,
        runId: 'parent-run',
        invocationId: `child-allotment:${childThreadId}`,
        resourceKind: 'subagent' as const,
        executableUpperBound: childUpper,
        state: 'reserved' as const,
      };
      expect(() =>
        assertChildBudgetWithinDelegation({
          reservation: allotment,
          childBudget: {
            ...INTERNAL_RESOURCE_BUDGET_,
            maxRunDurationMs: 60_000,
            maxTurns: 1,
            maxModelRequests: 2,
            maxToolInvocations: 1,
            maxRunInputTokens: 1_000,
            maxRunOutputTokens: 500,
            maxConcurrentSubagents: 1,
            maxConcurrentWriters: 1,
            maxConcurrentToolInvocations: 1,
            maxConcurrentShellInvocations: 1,
            maxArtifactBytes: 1,
          },
          childStartedAt: startedAt,
          childDeadlineAt: deadlineAt,
          fundingDeadlineAt: deadlineAt,
          childMaySpawn: false,
          childMayWrite: false,
        }),
      ).not.toThrow();
      ledger = reduceResourceBudgetState(ledger, {
        type: 'resource_budget.reserved',
        reservation: allotment,
      });
    }
    expect(effectIds.size).toBe(3);
    if (ledger.status !== 'active') throw new Error('Parent ledger is inactive.');
    expect(
      Object.values(ledger.reservations).filter(
        (item) => item.invocationId.startsWith('child-allotment:') && item.state === 'reserved',
      ),
    ).toHaveLength(3);
    const state = {
      ...createInitialAgentState({
        threadId: 'parent',
        userId: 'user',
        workspace: '/workspace',
        turnId: 'turn',
        recoveryIdentityKey: '0'.repeat(64),
      }),
      resourceBudget: ledger,
    };
    expect(reconciliationEventsForReservations(state, transientIds)).toEqual([]);
  });
});
