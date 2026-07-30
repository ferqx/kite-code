import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContextProjectionEnvironment } from '@/core/controllers/model-controller';
import { eventsForRunCancellation } from '@/core/runtime/actions';
import { AgentKernel, createAgentKernel } from '@/core/runtime/kernel';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import { runRuntimeLoop } from '@/core/runtime/runner';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { createMockModel } from '../mock-model';

describe('bounded Runtime cancellation', () => {
  test('withholds writer, shell, and child capabilities until bounded cancellation is enabled', () => {
    const state = createInitialRuntimeState({
      threadId: 'bounded-capabilities',
      userId: 'u',
      workspace: '/',
    });
    const environment = resolveContextProjectionEnvironment({
      state,
      config: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'bounded-model',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        features: {
          resourceBudgetV1: true,
          boundedCancellationV1: false,
        },
        sandbox: { enabled: false },
      },
      model: createMockModel([]),
    });
    const disclosed = environment.serializedTools.map((tool) => tool.name);

    expect(disclosed).not.toContain('task');
    expect(disclosed).not.toContain('shell_execute');
    expect(disclosed).not.toContain('write_file');
    expect(disclosed).not.toContain('edit_file');
  });

  test('persists a structured unknown terminal when recovery is blocked', async () => {
    const state = createInitialRuntimeState({
      threadId: 'blocked-recovery',
      userId: 'u',
      workspace: '/',
    });
    state.recoveryState = { kind: 'incompatible', schemaVersion: 999 };
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const events = [];

    for await (const event of runRuntimeLoop(kernel, async () => [], {
      requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'turn.aborted', cause: 'error' }),
      expect.objectContaining({
        type: 'run.error',
        failure: expect.objectContaining({ kind: 'unknown' }),
        outcome: expect.objectContaining({
          status: 'unknown',
          knownExternalEffects: 'unknown',
          recoveryEntry: 'reconcile',
        }),
      }),
    ]);
    expect(kernel.getState().turn.status).toBe('aborted');
    expect(store.loadEvents('blocked-recovery').map((event) => event.event.type)).toEqual([
      'turn.aborted',
      'run.error',
    ]);
    kernel.close();
  });

  test('interrupts a concurrency wait and cannot dispatch a new tool afterward', async () => {
    const now = Date.now();
    const state = createInitialRuntimeState({
      threadId: 'cancel-waiter',
      userId: 'u',
      workspace: '/',
    });
    state.tools.calls['queued-tool'] = {
      toolCallId: 'queued-tool',
      modelMessageId: 'model-1',
      name: 'read_file',
      args: { path: 'README.md' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('queued-tool');
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    kernel.processEvent({
      type: 'resource_budget.configured',
      runId: 'run-1',
      startedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 30_000).toISOString(),
      budget: { ...LIMITED_RESOURCE_BUDGET_V1, maxConcurrentToolInvocations: 1 },
    });
    const upper = createZeroResourceUsageV1('versioned_upper_bound', 'test-v1');
    upper.counters.toolInvocations = 1;
    upper.gauges.activeToolInvocations = 1;
    kernel.processEvent({
      type: 'resource_budget.reserved',
      reservation: {
        version: 1,
        reservationId: 'running-reservation',
        runId: 'run-1',
        invocationId: 'tool:already-running',
        resourceKind: 'tool',
        executableUpperBound: upper,
        state: 'reserved',
      },
    });
    kernel.processEvent({
      type: 'resource_budget.dispatch_started',
      reservationId: 'running-reservation',
    });

    const controller = new AbortController();
    let executorCalls = 0;
    const emitted: string[] = [];
    for await (const event of runRuntimeLoop(
      kernel,
      async () => {
        executorCalls += 1;
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      10_000,
      undefined,
      controller.signal,
    )) {
      emitted.push(event.type);
      if (event.type === 'resource_budget.waiter_enqueued') {
        kernel.processEventBatch(
          eventsForRunCancellation(kernel.getState(), 'Cancelled while waiting.', 'user'),
        );
        controller.abort();
      }
    }

    expect(emitted).toEqual(['resource_budget.waiter_enqueued']);
    expect(executorCalls).toBe(0);
    expect(kernel.getState()).toMatchObject({
      turn: { status: 'aborted' },
      resourceBudget: {
        status: 'active',
        waiters: { 'tool:queued-tool': { state: 'cancelled' } },
        reservations: { 'running-reservation': { state: 'unknown' } },
      },
      tools: { calls: { 'queued-tool': { status: 'cancelled' } } },
    });
    kernel.close();
  });

  test('restores cancelled waiters, unknown dispatches, and cancel-incomplete terminal facts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-cancel-restart-'));
    const storePath = join(directory, 'runtime.db');
    const threadId = 'cancel-restart';
    try {
      const kernel = createAgentKernel({
        threadId,
        userId: 'u',
        workspace: directory,
        storePath,
      });
      const now = Date.now();
      kernel.processEvent({
        type: 'resource_budget.configured',
        runId: 'run-restart',
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + 30_000).toISOString(),
        budget: LIMITED_RESOURCE_BUDGET_V1,
      });
      const upper = createZeroResourceUsageV1('versioned_upper_bound', 'restart-test-v1');
      upper.counters.toolInvocations = 1;
      upper.gauges.activeToolInvocations = 1;
      kernel.processEvent({
        type: 'resource_budget.reserved',
        reservation: {
          version: 1,
          reservationId: 'dispatched',
          runId: 'run-restart',
          invocationId: 'tool:dispatched',
          resourceKind: 'tool',
          executableUpperBound: upper,
          state: 'reserved',
        },
      });
      kernel.processEvent({
        type: 'resource_budget.dispatch_started',
        reservationId: 'dispatched',
      });
      kernel.processEvent({
        type: 'resource_budget.waiter_enqueued',
        waiter: {
          version: 1,
          runId: 'run-restart',
          invocationId: 'tool:waiting',
          requiredPermits: ['tool'],
          sequence: 0,
          enqueuedAt: new Date(now + 1).toISOString(),
          deadlineAt: new Date(now + 20_000).toISOString(),
          state: 'waiting',
        },
      });
      kernel.processEventBatch(
        eventsForRunCancellation(kernel.getState(), 'Deadline exceeded.', 'error'),
      );
      const failure = {
        kind: 'cancel_incomplete' as const,
        message: 'One descendant process could not be confirmed stopped.',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: true,
        terminatesTurn: true,
        journal: true,
      };
      kernel.processEvent({
        type: 'runtime.cancellation_diagnostic',
        toolCallId: 'dispatched-tool',
        failure,
        unconfirmedDescendantCount: 1,
      });
      kernel.processEvent({
        type: 'run.error',
        message: failure.message,
        recoverable: false,
        failure,
        outcome: {
          version: 1,
          status: 'unknown',
          reasonCode: 'cancel_incomplete',
          knownExternalEffects: 'unknown',
          safeRetry: false,
          recoveryEntry: 'reconcile',
          pendingVerification: false,
        },
      });
      kernel.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'u',
        workspace: directory,
        storePath,
      });
      expect(restored.getState()).toMatchObject({
        turn: { status: 'aborted' },
        terminalOutcome: {
          status: 'unknown',
          reasonCode: 'cancel_incomplete',
          knownExternalEffects: 'unknown',
        },
        resourceBudget: {
          reservations: { dispatched: { state: 'unknown' } },
          waiters: { 'tool:waiting': { state: 'cancelled' } },
        },
      });
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
