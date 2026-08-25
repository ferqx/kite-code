import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import { restoreStateHostSessionHarness as restoreStateKernelCoordinator } from '../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../scripts/support/runtime-storage';

const paths: string[] = [];

function databasePath(): string {
  const path = join(process.cwd(), `.kite-resource-budget-${crypto.randomUUID()}.db`);
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
  test('round-trips durable reservation state through StateRuntimeStorage', () => {
    const storePath = databasePath();
    const kernel = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'budget-recovery',
      userId: 'u',
      workspace: '/',
      store: openStateStoreForTest(storePath),
    });
    kernel.processEvent({
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: LIMITED_RESOURCE_BUDGET_,
    });
    const upper = createZeroResourceUsage('versioned_upper_bound', 'test-v1');
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

    const recovered = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'budget-recovery',
      userId: 'u',
      workspace: '/',
      store: openStateStoreForTest(storePath),
    });
    expect(recovered.getState().resourceBudget).toMatchObject({
      status: 'active',
      runId: 'run-1',
      reservations: { 'reservation-1': { state: 'unknown' } },
    });
    recovered.close();
  });
});
