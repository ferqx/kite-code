import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContextProjectionEnvironment } from '@/core/controllers/model-controller';
import { eventsForRunCancellation } from '@/core/runtime/actions';
import { runRuntimeAgent } from '@/core/runtime/agent';
import type { RuntimeEvent } from '@/core/runtime/events';
import { AgentKernel, createAgentKernel } from '@/core/runtime/kernel';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '@/core/runtime/resource-budget';
import { runRuntimeLoop } from '@/core/runtime/runner';
import { createInitialRuntimeState, type RuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { aiMessage } from '../../src/core/messages';
import { createMockModel } from '../mock-model';

describe('bounded Runtime cancellation', () => {
  test('persists and exposes cancellation when the public AbortSignal fires during a model call', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-external-abort-'));
    const storePath = join(workspace, 'runtime.db');
    const threadId = 'external-abort';
    const controller = new AbortController();
    let markModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const model = createMockModel([]);
    const rawModel = model.model as unknown as {
      doGenerate: (options: { abortSignal?: AbortSignal }) => Promise<unknown>;
    };
    rawModel.doGenerate = async () => {
      markModelStarted();
      return new Promise<never>(() => {});
    };
    const config = {
      providerName: 'test',
      providerType: 'openai-compatible' as const,
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: false },
    };

    try {
      const run = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of runRuntimeAgent(
          {
            task: 'wait for external cancellation',
            threadId,
            userId: 'test',
            workspace,
            runtimeStorePath: storePath,
            model: model as unknown as import('@/core/model/factory').SupportedChatModel,
            config,
            signal: controller.signal,
          },
          { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
        )) {
          events.push(event);
        }
        return events;
      })();

      await modelStarted;
      controller.abort('Cancelled by integration test.');
      const events = await run;

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.aborted',
          cause: 'user',
          reason: 'Cancelled by integration test.',
        }),
      );
      const store = createRuntimeStore(storePath);
      expect(store.loadSnapshot<RuntimeState>(threadId)?.turn).toMatchObject({
        status: 'aborted',
        abortReason: 'Cancelled by integration test.',
      });
      store.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('reopens an aborted turn for the next user prompt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-cancel-successor-'));
    const storePath = join(workspace, 'runtime.db');
    const threadId = 'cancel-successor';
    const kernelControl: { current: import('@/core/runtime/agent').RuntimeKernelControl | null } = {
      current: null,
    };
    let reportShellStarted!: () => void;
    const shellStarted = new Promise<void>((resolve) => {
      reportShellStarted = resolve;
    });
    const model = createMockModel([
      {
        message: aiMessage({
          content: '',
          tool_calls: [
            { id: 'cancel-shell', name: 'shell_execute', args: { command: 'wait-for-cancel' } },
          ],
        }),
      },
      { message: aiMessage({ content: '继续测试已完成。' }) },
    ]);
    const config = {
      providerName: 'test',
      providerType: 'openai-compatible' as const,
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: false },
    };

    try {
      const firstPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of runRuntimeAgent(
          {
            task: '测试 shell 取消',
            threadId,
            userId: 'test',
            workspace,
            runtimeStorePath: storePath,
            model: model as any,
            config,
            onKernelControl: (control) => {
              kernelControl.current = control;
            },
            shellExecutor: async (input) => {
              reportShellStarted();
              await new Promise<void>((resolve) => {
                const finish = () => resolve();
                if (input.signal?.aborted) finish();
                else input.signal?.addEventListener('abort', finish, { once: true });
              });
              return {
                ok: false,
                command: input.command,
                exitCode: 130,
                stdout: '',
                stderr: 'cancelled',
              };
            },
          },
          {
            requestAction: async (effect) => ({
              type: 'approve',
              interactionId: effect.interactionId,
              grant: 'approve_once',
            }),
          },
        )) {
          events.push(event);
        }
        return events;
      })();

      await shellStarted;
      if (!kernelControl.current) throw new Error('Expected live kernel control');
      kernelControl.current.cancelRun('cancelled by test');
      const firstEvents = await firstPromise;
      expect(firstEvents.map((event) => event.type)).toContain('tool.started');
      const cancelledStore = createRuntimeStore(storePath);
      expect(cancelledStore.loadSnapshot<RuntimeState>(threadId)?.turn.status).toBe('aborted');
      cancelledStore.close();

      const secondEvents: RuntimeEvent[] = [];
      for await (const event of runRuntimeAgent(
        {
          task: '继续测试',
          threadId,
          userId: 'test',
          workspace,
          runtimeStorePath: storePath,
          model: model as any,
          config,
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      )) {
        secondEvents.push(event);
      }

      expect(model.callCount.count).toBe(2);
      expect(secondEvents).toContainEqual(
        expect.objectContaining({ type: 'user.message_appended', content: '继续测试' }),
      );
      expect(secondEvents).toContainEqual(
        expect.objectContaining({ type: 'model.responded', text: '继续测试已完成。' }),
      );
      expect(secondEvents.at(-1)?.type).toBe('turn.completed');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
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

  test('bounds cleanup when an in-flight executor ignores AbortSignal', async () => {
    const state = createInitialRuntimeState({
      threadId: 'non-cooperative-cancel',
      userId: 'u',
      workspace: '/',
    });
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const controller = new AbortController();
    let executorCalls = 0;
    const startedAt = Date.now();
    setTimeout(() => controller.abort('Cancellation requested.'), 10);

    for await (const _event of runRuntimeLoop(
      kernel,
      async () => {
        executorCalls += 1;
        return new Promise<never>(() => {});
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      10_000,
      undefined,
      controller.signal,
    )) {
      // This executor deliberately emits nothing.
    }

    expect(executorCalls).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
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
