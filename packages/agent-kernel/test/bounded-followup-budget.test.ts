import { describe, expect, test } from 'bun:test';
import { reduceLeaseState } from '../src/core/lease/reducer';
import type { KernelEvent } from '../src/events';
import {
  createInitialAgentState,
  type ResourceReservation,
  type ResourceUsage,
} from '../src/state';
import { decodeCurrentAgentStateJson, encodeCurrentAgentStateJson } from '../src/state-codec';

const startedAt = '2026-09-23T00:00:00.000Z';
const deadlineAt = '2026-09-23T00:01:00.000Z';

function usage(): ResourceUsage {
  return {
    counters: {
      turns: 1,
      modelRequests: 1,
      toolInvocations: 0,
      inputTokens: 100,
      outputTokens: 50,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents: 1,
      activeWriters: 0,
      activeToolInvocations: 0,
      activeShellInvocations: 0,
    },
    source: 'versioned_upper_bound',
    estimatorVersion: 'test-v1',
  };
}

function reservation(id: string, kind: 'subagent' | 'model', bound = usage()): ResourceReservation {
  return {
    version: 1,
    reservationId: id,
    runId: 'funding-run',
    invocationId: id,
    ...(id === 'backup' ? {} : { replacesReservationId: 'backup' }),
    ...(kind === 'model' ? { parentReservationId: 'child-turn' } : {}),
    resourceKind: kind,
    executableUpperBound: bound,
    state: 'reserved',
  };
}

function turnReservation(): ResourceReservation {
  const upper = usage();
  return reservation('child-turn', 'subagent', {
    ...upper,
    counters: { ...upper.counters, modelRequests: 0, inputTokens: 0, outputTokens: 0 },
  });
}

function modelReservation(bound?: ResourceUsage): ResourceReservation {
  const upper = bound ?? usage();
  return reservation('first-model', 'model', {
    ...upper,
    counters: { ...upper.counters, turns: 0 },
    gauges: { ...upper.gauges, activeSubagents: 0 },
  });
}

function configured(maxTurns = 1) {
  const initial = createInitialAgentState({
    threadId: 'session',
    userId: 'user',
    workspace: '/workspace',
    turnId: 'turn',
    recoveryIdentityKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  const configured = reduceLeaseState(initial, {
    type: 'resource_budget.configured',
    runId: 'funding-run',
    startedAt,
    deadlineAt,
    budget: {
      version: 1,
      maxRunDurationMs: 60_000,
      maxTurns,
      maxModelRequests: 2,
      maxToolInvocations: 1,
      maxRunInputTokens: 100,
      maxRunOutputTokens: 50,
      maxConcurrentSubagents: 1,
      maxConcurrentWriters: 1,
      maxConcurrentToolInvocations: 1,
      maxConcurrentShellInvocations: 1,
      maxConcurrencyWaitMs: 1_000,
      maxArtifactBytes: 1,
    },
  } as KernelEvent);
  return reduceLeaseState(configured, {
    type: 'resource_budget.reserved',
    reservation: reservation('backup', 'subagent'),
  });
}

describe('bounded followup replacement', () => {
  test('retains an old funding Run across a new Run and prunes it after exact settlement', () => {
    const old = configured();
    if (old.resourceBudget.status !== 'active') throw new Error('Fixture budget is inactive.');
    const nextRun = reduceLeaseState(old, {
      type: 'resource_budget.configured',
      runId: 'new-run',
      startedAt: '2026-09-23T00:02:00.000Z',
      deadlineAt: '2026-09-23T00:03:00.000Z',
      budget: old.resourceBudget.budget,
    });
    expect(nextRun.resourceBudget.status).toBe('active');
    expect(nextRun.retainedResourceBudgets['funding-run']?.reservations.backup?.state).toBe(
      'reserved',
    );
    const replaced = reduceLeaseState(nextRun, {
      type: 'resource_budget.bounded_replaced',
      reservationId: 'backup',
      turnReservation: turnReservation(),
      replacement: modelReservation(),
    });
    expect(
      replaced.retainedResourceBudgets['funding-run']?.reservations['first-model']?.state,
    ).toBe('reserved');
    expect(replaced.resourceBudget).toBe(nextRun.resourceBudget);
    const dispatched = reduceLeaseState(replaced, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'first-model',
    });
    const unknown = reduceLeaseState(dispatched, {
      type: 'resource_budget.unknown',
      reservationId: 'first-model',
    });
    expect(unknown.retainedResourceBudgets['funding-run']?.reservations['first-model']?.state).toBe(
      'unknown',
    );
    const reconciled = reduceLeaseState(unknown, {
      type: 'resource_budget.reconciled',
      reservationId: 'first-model',
      actual: {
        counters: modelReservation().executableUpperBound.counters,
        gauges: modelReservation().executableUpperBound.gauges,
        source: 'actual',
      },
    });
    const settled = reduceLeaseState(reconciled, {
      type: 'resource_budget.released',
      reservationId: 'child-turn',
    });
    expect(settled.retainedResourceBudgets['funding-run']).toBeUndefined();
    expect(settled.resourceBudget).toBe(nextRun.resourceBudget);
    expect(() =>
      reduceLeaseState(settled, {
        type: 'resource_budget.released',
        reservationId: 'first-model',
      }),
    ).toThrow(/Unknown reservation/u);
    expect(decodeCurrentAgentStateJson(encodeCurrentAgentStateJson(settled))).toEqual(settled);
  });

  test('normalizes pre-extension State27 reads while current writes require the retained map', () => {
    const state = configured();
    const legacy = JSON.parse(encodeCurrentAgentStateJson(state));
    delete legacy.retainedResourceBudgets;
    expect(decodeCurrentAgentStateJson(JSON.stringify(legacy)).retainedResourceBudgets).toEqual({});
    expect(() => encodeCurrentAgentStateJson(legacy)).toThrow();
  });

  test('rejects reservation ID reuse across current and retained funding Runs', () => {
    const old = configured();
    if (old.resourceBudget.status !== 'active') throw new Error('Fixture budget is inactive.');
    const fundingBudget = old.resourceBudget.budget;
    const rotated = reduceLeaseState(old, {
      type: 'resource_budget.configured',
      runId: 'new-run',
      startedAt: '2026-09-23T00:02:00.000Z',
      deadlineAt: '2026-09-23T00:03:00.000Z',
      budget: fundingBudget,
    });
    expect(() =>
      reduceLeaseState(rotated, {
        type: 'resource_budget.reserved',
        reservation: { ...reservation('backup', 'subagent'), runId: 'new-run' },
      }),
    ).toThrow(/already owned by another funding Run/u);
    expect(() =>
      reduceLeaseState(rotated, {
        type: 'resource_budget.configured',
        runId: 'funding-run',
        startedAt,
        deadlineAt,
        budget: fundingBudget,
      }),
    ).toThrow(/retained funding Run/u);
  });
  test('atomically exchanges a held backup and replays exactly once', () => {
    const before = configured();
    const event: KernelEvent = {
      type: 'resource_budget.bounded_replaced',
      reservationId: 'backup',
      turnReservation: turnReservation(),
      replacement: modelReservation(),
    };
    const after = reduceLeaseState(before, event);
    expect(before.resourceBudget.reservations.backup?.state).toBe('reserved');
    expect(after.resourceBudget.reservations.backup?.state).toBe('released');
    expect(after.resourceBudget.reservations['child-turn']?.state).toBe('reserved');
    expect(after.resourceBudget.reservations['first-model']?.state).toBe('reserved');
    expect(reduceLeaseState(after, event)).toBe(after);
    expect(() =>
      reduceLeaseState(after, {
        ...event,
        replacement: { ...modelReservation(), reservationId: 'other-model' },
      }),
    ).toThrow();
  });

  test('rejects any counter or gauge over the held bound without consuming it', () => {
    const before = configured();
    const fields = [
      ...Object.keys(usage().counters).map((field) => ['counters', field] as const),
      ...Object.keys(usage().gauges).map((field) => ['gauges', field] as const),
    ];
    for (const [group, field] of fields) {
      const upper = usage();
      const bound = {
        ...upper,
        [group]: { ...upper[group], [field]: upper[group][field as never] + 1 },
      };
      const turn = turnReservation();
      const replacement = modelReservation();
      const overTurn =
        (group === 'counters' && field === 'turns') ||
        (group === 'gauges' && field === 'activeSubagents');
      expect(() =>
        reduceLeaseState(before, {
          type: 'resource_budget.bounded_replaced',
          reservationId: 'backup',
          turnReservation: overTurn ? { ...turn, executableUpperBound: bound } : turn,
          replacement: overTurn
            ? replacement
            : {
                ...replacement,
                executableUpperBound: {
                  ...replacement.executableUpperBound,
                  [group]: {
                    ...replacement.executableUpperBound[group],
                    [field]: upper[group][field as never] + 1,
                  },
                },
              },
        }),
      ).toThrow(/held upper bound|held child-turn|first model request/u);
      expect(before.resourceBudget.reservations.backup?.state).toBe('reserved');
    }
  });

  test('rejects dispatched and unknown backups, cross-run replacements and divergent replay', () => {
    const before = configured();
    const event: KernelEvent = {
      type: 'resource_budget.bounded_replaced',
      reservationId: 'backup',
      turnReservation: turnReservation(),
      replacement: modelReservation(),
    };
    for (const state of ['dispatch_started', 'unknown'] as const) {
      const changed = reduceLeaseState(before, {
        type: `resource_budget.${state}`,
        reservationId: 'backup',
      } as KernelEvent);
      expect(() => reduceLeaseState(changed, event)).toThrow(/held|undispatched/u);
    }
    expect(() =>
      reduceLeaseState(before, {
        ...event,
        replacement: { ...modelReservation(), runId: 'another-run' },
      }),
    ).toThrow(/runId mismatch/u);
    const after = reduceLeaseState(before, event);
    expect(() =>
      reduceLeaseState(after, {
        ...event,
        replacement: modelReservation({
          ...usage(),
          counters: { ...usage().counters, inputTokens: 99 },
        }),
      }),
    ).toThrow(/replay conflicts/u);
  });

  test('retains the child concurrency lease after the first model reconciles', () => {
    const replaced = reduceLeaseState(configured(2), {
      type: 'resource_budget.bounded_replaced',
      reservationId: 'backup',
      turnReservation: turnReservation(),
      replacement: modelReservation(),
    });
    const turnStarted = reduceLeaseState(replaced, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'child-turn',
    });
    const modelStarted = reduceLeaseState(turnStarted, {
      type: 'resource_budget.dispatch_started',
      reservationId: 'first-model',
    });
    const modelActual: ResourceUsage = {
      ...usage(),
      source: 'actual',
      estimatorVersion: undefined,
      counters: { ...usage().counters, turns: 0, inputTokens: 40, outputTokens: 20 },
      gauges: { ...usage().gauges, activeSubagents: 0 },
    };
    const modelDone = reduceLeaseState(modelStarted, {
      type: 'resource_budget.reconciled',
      reservationId: 'first-model',
      actual: modelActual,
    });
    expect(modelDone.resourceBudget.reservations['child-turn']?.state).toBe('dispatch_started');
    expect(() =>
      reduceLeaseState(modelDone, {
        type: 'resource_budget.reserved',
        reservation: {
          ...reservation('another-child', 'subagent', turnReservation().executableUpperBound),
          invocationId: 'another-child',
          replacesReservationId: undefined,
        },
      }),
    ).toThrow(/budget exhausted/u);
    const turnActual: ResourceUsage = {
      ...usage(),
      source: 'actual',
      estimatorVersion: undefined,
      counters: { ...usage().counters, modelRequests: 0, inputTokens: 0, outputTokens: 0 },
      gauges: { ...usage().gauges, activeSubagents: 0 },
    };
    const settled = reduceLeaseState(modelDone, {
      type: 'resource_budget.reconciled',
      reservationId: 'child-turn',
      actual: turnActual,
    });
    expect(settled.resourceBudget.reservations['child-turn']?.state).toBe('reconciled');
  });
});
