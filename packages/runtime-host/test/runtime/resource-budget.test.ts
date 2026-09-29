import { describe, expect, test } from 'bun:test';
import {
  type BudgetReservation,
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
  LIMITED_RESOURCE_BUDGET_,
  type ResourceUsage,
  reduceResourceBudgetState,
  tightenResourceBudget,
} from '@kite-ai/runtime-host/kernel-adapter';

function usage(input?: {
  toolInvocations?: number;
  inputTokens?: number;
  outputTokens?: number;
  activeTools?: number;
}): ResourceUsage {
  const value = createZeroResourceUsage('versioned_upper_bound', 'test-estimator-v1');
  value.counters.toolInvocations = input?.toolInvocations ?? 0;
  value.counters.inputTokens = input?.inputTokens ?? 0;
  value.counters.outputTokens = input?.outputTokens ?? 0;
  value.gauges.activeToolInvocations = input?.activeTools ?? 0;
  return value;
}

function actual(input?: { toolInvocations?: number; inputTokens?: number }): ResourceUsage {
  const value = createZeroResourceUsage();
  value.counters.toolInvocations = input?.toolInvocations ?? 0;
  value.counters.inputTokens = input?.inputTokens ?? 0;
  return value;
}

function reservation(
  reservationId: string,
  invocationId: string,
  upper = usage({ toolInvocations: 1, activeTools: 1 }),
  parentReservationId?: string,
): BudgetReservation {
  return {
    version: 1,
    reservationId,
    runId: 'run-1',
    invocationId,
    ...(parentReservationId ? { parentReservationId } : {}),
    resourceKind: 'tool',
    executableUpperBound: upper,
    state: 'reserved',
  };
}

function configured() {
  return reduceResourceBudgetState(
    createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'budget',
      userId: 'u',
      workspace: '/',
    }).resourceBudget,
    {
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: LIMITED_RESOURCE_BUDGET_,
    },
  );
}

describe('ResourceBudget', () => {
  test('duration-only child records usage beyond legacy counters while rejecting forged authority', () => {
    const childBudget = {
      ...LIMITED_RESOURCE_BUDGET_,
      maxTurns: 0,
      maxModelRequests: 0,
      maxToolInvocations: 0,
      maxRunInputTokens: 0,
      maxRunOutputTokens: 0,
      maxArtifactBytes: 0,
      durationOnlyChildRun: true as const,
    };
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'duration-child',
      userId: 'u',
      workspace: '/',
    });
    let state = reduceResourceBudgetState(initial.resourceBudget, {
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: childBudget,
    });
    const large = createZeroResourceUsage('versioned_upper_bound', 'large-model-v1');
    large.counters.modelRequests = 1;
    large.counters.inputTokens = LIMITED_RESOURCE_BUDGET_.maxRunInputTokens + 1;
    large.counters.outputTokens = LIMITED_RESOURCE_BUDGET_.maxRunOutputTokens + 1;
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: { ...reservation('large', 'large', large), resourceKind: 'model' },
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'large',
    });
    const measured = createZeroResourceUsage();
    measured.counters.modelRequests = 1;
    measured.counters.inputTokens = large.counters.inputTokens;
    measured.counters.outputTokens = large.counters.outputTokens;
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'large',
      actual: measured,
    });
    expect(state.status === 'active' && state.reconciledUsage.counters.inputTokens).toBe(
      large.counters.inputTokens,
    );
    const unboundedModel = createZeroResourceUsage('versioned_upper_bound', 'child-model-v1');
    unboundedModel.counters.modelRequests = 1;
    unboundedModel.unboundedModelTokens = true;
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: {
        ...reservation('later-model', 'later-model', unboundedModel),
        resourceKind: 'model',
      },
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'later-model',
    });
    const providerMeasured = createZeroResourceUsage();
    providerMeasured.counters.modelRequests = 1;
    providerMeasured.counters.inputTokens = 10_000_000;
    providerMeasured.counters.outputTokens = 100_000;
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'later-model',
      actual: providerMeasured,
    });
    expect(state.status === 'active' && state.reconciledUsage.counters.inputTokens).toBe(
      large.counters.inputTokens + providerMeasured.counters.inputTokens,
    );
    const writeUpper = createZeroResourceUsage('versioned_upper_bound', 'child-write-v1');
    writeUpper.counters.toolInvocations = 1;
    writeUpper.unboundedArtifactBytes = true;
    for (const id of ['write-a', 'write-b'])
      state = reduceResourceBudgetState(state, {
        type: 'resource_budget.reserved',
        reservation: reservation(id, id, writeUpper),
      });
    for (const [id, bytes] of [
      ['write-a', 300_000_000],
      ['write-b', 400_000_000],
    ] as const) {
      state = reduceResourceBudgetState(state, {
        type: 'resource_budget.dispatch_started',
        reservationId: id,
      });
      const toolActual = createZeroResourceUsage();
      toolActual.counters.toolInvocations = 1;
      toolActual.counters.artifactBytes = bytes;
      state = reduceResourceBudgetState(state, {
        type: 'resource_budget.reconciled',
        reservationId: id,
        actual: toolActual,
      });
    }
    expect(state.status === 'active' && state.reconciledUsage.counters.artifactBytes).toBe(
      700_000_000,
    );
    expect(() =>
      reduceResourceBudgetState(configured(), {
        type: 'resource_budget.reserved',
        reservation: reservation('forged-artifact', 'forged-artifact', writeUpper),
      }),
    ).toThrow('duration-only child Run');
    expect(() =>
      reduceResourceBudgetState(configured(), {
        type: 'resource_budget.reserved',
        reservation: {
          ...reservation('forged-model', 'forged-model', unboundedModel),
          resourceKind: 'model',
        },
      }),
    ).toThrow('duration-only child Run');
    expect(() =>
      reduceResourceBudgetState(configured(), {
        type: 'resource_budget.reserved',
        reservation: {
          ...reservation('forged', 'forged'),
          executableUpperBound: {
            ...usage(),
            durationOnlyChildRun: true,
          },
        },
      }),
    ).toThrow('Duration-only authority');
  });
  test('persists required child wait as active-time deadline suspension', () => {
    const started = {
      type: 'resource_budget.required_child_wait_started' as const,
      runId: 'run-1',
      at: '2026-07-30T00:00:10Z',
      taskIds: ['child-1'],
    };
    const ended = {
      type: 'resource_budget.required_child_wait_ended' as const,
      runId: 'run-1',
      at: '2026-07-30T00:05:10Z',
      taskIds: ['child-1'],
    };
    const suspended = reduceResourceBudgetState(configured(), started);
    expect(suspended.status === 'active' && suspended.requiredChildWait?.startedAt).toBe(
      started.at,
    );
    expect(reduceResourceBudgetState(suspended, started)).toBe(suspended);
    expect(() =>
      reduceResourceBudgetState(suspended, {
        type: 'resource_budget.reserved',
        reservation: reservation('parent-tool', 'parent-tool'),
      }),
    ).toThrow('suspended');
    expect(() =>
      reduceResourceBudgetState(suspended, { ...ended, taskIds: ['other-child'] }),
    ).toThrow('no matching start');
    const resumed = reduceResourceBudgetState(suspended, ended);
    expect(resumed.status === 'active' && resumed.deadlineAt).toBe('2026-07-30T00:35:00.000Z');
    expect(resumed.status === 'active' && resumed.totalRequiredChildWaitMs).toBe(300_000);
    expect(reduceResourceBudgetState(resumed, ended)).toBe(resumed);
  });
  test('new unbounded Tool authority counts completed calls without imposing a total', () => {
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'unbounded-child',
      userId: 'u',
      workspace: '/',
    });
    let active = reduceResourceBudgetState(initial.resourceBudget, {
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:01:00Z',
      budget: {
        ...LIMITED_RESOURCE_BUDGET_,
        maxToolInvocations: 0,
        unboundedToolInvocations: true,
      },
    });
    for (const id of ['first', 'second']) {
      active = reduceResourceBudgetState(active, {
        type: 'resource_budget.reserved',
        reservation: reservation(id, id),
      });
      active = reduceResourceBudgetState(active, {
        type: 'resource_budget.dispatch_started',
        reservationId: id,
      });
      active = reduceResourceBudgetState(active, {
        type: 'resource_budget.reconciled',
        reservationId: id,
        actual: actual({ toolInvocations: 1 }),
      });
    }
    const childUpper: ResourceUsage = {
      ...usage(),
      unboundedToolInvocations: true,
      gauges: { ...usage().gauges, activeSubagents: 1 },
    };
    const childReservation: BudgetReservation = {
      ...reservation('child-allotment:child', 'child-allotment:child', childUpper),
      resourceKind: 'subagent',
    };
    active = reduceResourceBudgetState(active, {
      type: 'resource_budget.reserved',
      reservation: childReservation,
    });
    active = reduceResourceBudgetState(active, {
      type: 'resource_budget.dispatch_started',
      reservationId: childReservation.reservationId,
    });
    active = reduceResourceBudgetState(active, {
      type: 'resource_budget.reconciled',
      reservationId: childReservation.reservationId,
      actual: actual({ toolInvocations: 3 }),
    });
    expect(active.status === 'active' && active.reconciledUsage.counters.toolInvocations).toBe(5);
    // Parent spends only its one Task Tool receipt; child Tool count belongs to
    // the independent child ledger and does not reserve a speculative parent total.
    expect(() =>
      reduceResourceBudgetState(configured(), {
        type: 'resource_budget.reserved',
        reservation: childReservation,
      }),
    ).not.toThrow();
    expect(() =>
      reduceResourceBudgetState(configured(), {
        type: 'resource_budget.reserved',
        reservation: reservation('over', 'over', usage({ toolInvocations: 251 })),
      }),
    ).toThrow('Resource budget exhausted');
    const denied = reduceResourceBudgetState(initial.resourceBudget, {
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:01:00Z',
      budget: {
        ...LIMITED_RESOURCE_BUDGET_,
        maxToolInvocations: 0,
        unboundedToolInvocations: undefined,
      },
    });
    expect(() =>
      reduceResourceBudgetState(denied, {
        type: 'resource_budget.reserved',
        reservation: reservation('denied', 'denied'),
      }),
    ).toThrow('Resource budget exhausted');
  });
  test('audits delegated child Tool calls without spending the parent Tool count', () => {
    const childUpper: ResourceUsage = {
      ...usage(),
      unboundedToolInvocations: true,
      gauges: { ...usage().gauges, activeSubagents: 1 },
    };
    const child = {
      ...reservation('child-allotment:many-tools', 'child-allotment:many-tools', childUpper),
      resourceKind: 'subagent' as const,
    };
    let parent = reduceResourceBudgetState(configured(), {
      type: 'resource_budget.reserved',
      reservation: child,
    });
    parent = reduceResourceBudgetState(parent, {
      type: 'resource_budget.dispatch_started',
      reservationId: child.reservationId,
    });
    parent = reduceResourceBudgetState(parent, {
      type: 'resource_budget.reconciled',
      reservationId: child.reservationId,
      actual: actual({ toolInvocations: 300 }),
    });
    expect(parent.status === 'active' && parent.reconciledUsage.counters.toolInvocations).toBe(300);
    expect(
      parent.status === 'active' &&
        parent.reservations[child.reservationId]?.actual?.counters.toolInvocations,
    ).toBe(300);
    parent = reduceResourceBudgetState(parent, {
      type: 'resource_budget.reserved',
      reservation: reservation('parent-own', 'parent-own', usage({ toolInvocations: 250 })),
    });
    expect(() =>
      reduceResourceBudgetState(parent, {
        type: 'resource_budget.reserved',
        reservation: reservation('parent-excess', 'parent-excess'),
      }),
    ).toThrow('Resource budget exhausted');
  });
  test('admits a one-model zero-capability child ceiling and rejects Tool, Shell, writer, and child reservations', () => {
    const childBudget = {
      ...LIMITED_RESOURCE_BUDGET_,
      maxTurns: 1,
      maxModelRequests: 1,
      maxToolInvocations: 0,
      maxArtifactBytes: 0,
      maxConcurrentSubagents: 0,
      maxConcurrentWriters: 0,
      maxConcurrentToolInvocations: 0,
      maxConcurrentShellInvocations: 0,
    };
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'restricted-child',
      userId: 'u',
      workspace: '/',
    });
    const active = reduceResourceBudgetState(initial.resourceBudget, {
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:01:00Z',
      budget: childBudget,
    });
    const modelBase = usage({ inputTokens: 1 });
    const modelUpper: ResourceUsage = {
      ...modelBase,
      counters: { ...modelBase.counters, modelRequests: 1 },
    };
    expect(() =>
      reduceResourceBudgetState(active, {
        type: 'resource_budget.reserved',
        reservation: {
          ...reservation('model-1', 'model-invocation:model-1', modelUpper),
          resourceKind: 'model',
        },
      }),
    ).not.toThrow();
    for (const [kind, field] of [
      ['tool', 'activeToolInvocations'],
      ['shell', 'activeShellInvocations'],
      ['writer', 'activeWriters'],
      ['subagent', 'activeSubagents'],
    ] as const) {
      const base = usage({ toolInvocations: 1 });
      const upper: ResourceUsage = {
        ...base,
        gauges: { ...base.gauges, [field]: 1 },
      };
      expect(() =>
        reduceResourceBudgetState(active, {
          type: 'resource_budget.reserved',
          reservation: {
            ...reservation(`${kind}-1`, `${kind}-invocation`, upper),
            resourceKind: kind === 'subagent' ? 'subagent' : 'tool',
          },
        }),
      ).toThrow('Resource budget exhausted');
    }
  });

  test('freezes the D-11 limited and internal ceilings and allows only tightening', () => {
    expect(LIMITED_RESOURCE_BUDGET_).toMatchObject({
      maxRunDurationMs: 1_800_000,
      maxTurns: 30,
      maxModelRequests: 120,
      maxToolInvocations: 250,
      maxRunInputTokens: 1_000_000,
      maxRunOutputTokens: 250_000,
      maxConcurrentSubagents: 3,
      maxConcurrentWriters: 1,
      maxConcurrentToolInvocations: 250,
      maxConcurrentShellInvocations: 250,
      maxConcurrencyWaitMs: 15_000,
      maxArtifactBytes: 256 * 1024 * 1024,
    });
    expect(INTERNAL_RESOURCE_BUDGET_.maxToolInvocations).toBe(500);
    expect(tightenResourceBudget(LIMITED_RESOURCE_BUDGET_, { maxTurns: 10 }).maxTurns).toBe(10);
    expect(() => tightenResourceBudget(LIMITED_RESOURCE_BUDGET_, { maxTurns: 31 })).toThrow(
      'can only be lowered',
    );
  });

  test('starts fail-closed and requires one immutable run ledger', () => {
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'budget',
      userId: 'u',
      workspace: '/',
    }).resourceBudget;
    expect(initial.status).toBe('unconfigured');
    const state = configured();
    expect(state).toMatchObject({ status: 'active', runId: 'run-1', reservations: {} });
    expect(() =>
      reduceResourceBudgetState(state, {
        type: 'resource_budget.configured',
        runId: 'run-2',
        startedAt: '2026-07-30T00:00:00Z',
        deadlineAt: '2026-07-30T00:30:00Z',
        budget: LIMITED_RESOURCE_BUDGET_,
      }),
    ).toThrow('cannot be replaced');
  });

  test('shares cumulative reservations across parent and child invocations', () => {
    let state = configured();
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('parent', 'parent-invocation'),
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('child', 'child-invocation', undefined, 'parent'),
    });
    expect(state.status === 'active' && Object.keys(state.reservations)).toEqual([
      'parent',
      'child',
    ]);
    expect(() =>
      reduceResourceBudgetState(state, {
        type: 'resource_budget.reserved',
        reservation: reservation(
          'overflow',
          'overflow-invocation',
          usage({ toolInvocations: 249, activeTools: 1 }),
        ),
      }),
    ).toThrow('exhausted');
  });

  test('persists dispatch, reconciliation, unknown and release semantics idempotently', () => {
    let state = configured();
    const reserved = reservation('r1', 'i1');
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: reserved,
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'r1',
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.unknown',
      reservationId: 'r1',
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'r1',
      actual: actual({ toolInvocations: 1 }),
    });
    const replayed = reduceResourceBudgetState(state, {
      type: 'resource_budget.reconciled',
      reservationId: 'r1',
      actual: actual({ toolInvocations: 1 }),
    });
    expect(replayed).toBe(state);
    expect(state.status === 'active' && state.reconciledUsage.counters.toolInvocations).toBe(1);

    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.reserved',
      reservation: reservation('r2', 'i2'),
    });
    state = reduceResourceBudgetState(state, {
      type: 'resource_budget.released',
      reservationId: 'r2',
    });
    expect(state.status === 'active' && state.reservations.r2?.state).toBe('released');
  });
});
