import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentKernel } from '@/core/runtime/kernel';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import { createInitialRuntimeState, RUNTIME_STATE_SCHEMA_VERSION } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

const paths: string[] = [];

function databasePath(): string {
  const path = join(tmpdir(), `kite-resource-budget-${crypto.randomUUID()}.db`);
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

describe('resource budget recovery', () => {
  test('round-trips durable reservation state through RuntimeStore', () => {
    const storePath = databasePath();
    const kernel = createAgentKernel({
      threadId: 'budget-recovery',
      userId: 'u',
      workspace: '/',
      storePath,
    });
    kernel.processEvent({
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const upper = createZeroResourceUsageV1('versioned_upper_bound', 'test-v1');
    upper.counters.toolInvocations = 1;
    upper.gauges.activeToolInvocations = 1;
    kernel.processEvent({
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'reservation-1',
        runId: 'run-1',
        invocationId: 'invocation-1',
        resourceKind: 'tool',
        executableUpperBound: upper,
        state: 'reserved',
      },
    });
    kernel.processEvent({
      type: 'resource_budget.dispatch_started',
      reservationId: 'reservation-1',
    });
    kernel.close();

    const recovered = createAgentKernel({
      threadId: 'budget-recovery',
      userId: 'u',
      workspace: '/',
      storePath,
    });
    expect(recovered.getState().resourceBudget).toMatchObject({
      status: 'active',
      runId: 'run-1',
      reservations: { 'reservation-1': { state: 'unknown' } },
    });
    recovered.close();
  });

  test('migrates v17 snapshots to a fail-closed legacy ledger marker', () => {
    const storePath = databasePath();
    const state = createInitialRuntimeState({
      threadId: 'legacy-budget',
      userId: 'u',
      workspace: '/',
    });
    const { resourceBudget: _budget, ...withoutBudget } = state;
    const store = createRuntimeStore(storePath);
    store.saveSnapshot('legacy-budget', { ...withoutBudget, schemaVersion: 17 });
    store.close();

    const kernel = createAgentKernel({
      threadId: 'legacy-budget',
      userId: 'u',
      workspace: '/',
      storePath,
    });
    expect(kernel.getState()).toMatchObject({
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      resourceBudget: { status: 'legacy_unconfigured', migratedFromSchemaVersion: 17 },
    });
    expect(() =>
      kernel.processEvent({
        type: 'resource_budget.configured',
        runId: 'legacy-hot-migration',
        startedAt: '2026-07-30T00:00:00Z',
        deadlineAt: '2026-07-30T00:30:00Z',
        budget: LIMITED_RESOURCE_BUDGET_V1,
      }),
    ).toThrow('cannot be hot-migrated');
    kernel.close();
  });
});
