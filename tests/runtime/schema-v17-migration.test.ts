import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentKernel } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { LIMITED_RESOURCE_BUDGET_V1 } from '@/core/runtime/resource-budget';
import { createInitialRuntimeState, RUNTIME_STATE_SCHEMA_VERSION } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

describe('runtime schema v17/v18 migration', () => {
  test('preserves the v18 ledger while adding v19 waiter and terminal fields', () => {
    const path = join(tmpdir(), `kite-v18-v19-${crypto.randomUUID()}.db`);
    paths.push(path);
    let state = createInitialRuntimeState({ threadId: 'v18', userId: 'u', workspace: '/' });
    state = reduceRuntimeState(state, {
      type: 'resource_budget.configured',
      runId: 'v18-run',
      startedAt: '2026-07-30T00:00:00Z',
      deadlineAt: '2026-07-30T00:30:00Z',
      budget: LIMITED_RESOURCE_BUDGET_V1,
    });
    const budget = state.resourceBudget;
    if (budget.status !== 'active') throw new Error('expected active test ledger');
    const { waiters: _waiters, nextWaiterSequence: _sequence, ...v18Budget } = budget;
    const store = createRuntimeStore(path);
    store.saveSnapshot('v18', { ...state, schemaVersion: 18, resourceBudget: v18Budget });
    store.close();

    const kernel = createAgentKernel({
      threadId: 'v18',
      userId: 'u',
      workspace: '/',
      storePath: path,
    });
    expect(kernel.getState()).toMatchObject({
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      resourceBudget: {
        status: 'active',
        runId: 'v18-run',
        waiters: {},
        nextWaiterSequence: 0,
      },
    });
    expect(kernel.getState().terminalOutcome).toBeUndefined();
    kernel.close();
  });
});
