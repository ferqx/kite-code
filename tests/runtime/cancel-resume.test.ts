import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import type { SupportedChatModel } from '@kite/builtin-runtime/model';
import { aiMessage } from '@kite/builtin-runtime/model';
import {
  createRuntimeHostState26InitialStateV1,
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
  type RuntimeState,
} from '@kite/runtime-host';
import { resolveContextProjectionEnvironment } from '#app/bootstrap/runtime/model-effect';
import type { AuthorizedExecutionControlV1 } from '#app/bootstrap/runtime/RuntimeSessionCoordinator';
import { eventsForRunCancellation } from '#app/bootstrap/runtime/state26-actions';
import { runState26RuntimeLoopV1 } from '#app/bootstrap/runtime/state26-runner';
import {
  State26HostSessionHarnessV1 as AgentKernel,
  restoreState26HostSessionHarnessV1 as restoreState26KernelCoordinatorV1,
} from '../../scripts/support/runtime-host-state26';
import { openState26Store5ForTestV1 } from '../../scripts/support/runtime-storage';
import { runTestRuntimeAgentV1, testBuiltinToolCatalogV1 } from '../helpers/runtime-model';
import { createMockModel } from '../mock-model';

describe('bounded Runtime cancellation', () => {
  test(
    'persists and exposes cancellation when the public AbortSignal fires during a model call',
    async () => {
      const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-external-abort-'));
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
          for await (const event of runTestRuntimeAgentV1(
            {
              task: 'wait for external cancellation',
              threadId,
              userId: 'test',
              workspace,
              openState26SessionStorage: () => openState26Store5ForTestV1(storePath),
              model: model as unknown as import('@kite/builtin-runtime/model').SupportedChatModel,
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
        const store = openState26Store5ForTestV1(storePath);
        expect(store.loadSnapshot<RuntimeState>(threadId)?.turn).toMatchObject({
          status: 'aborted',
          abortReason: 'Cancelled by integration test.',
        });
        store.close();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 10_000 },
  );

  test('reopens an aborted turn for the next user prompt', async () => {
    const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-cancel-successor-'));
    const storePath = join(workspace, 'runtime.db');
    const threadId = 'cancel-successor';
    const kernelControl: {
      current: AuthorizedExecutionControlV1 | null;
    } = {
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
      sandbox: { enabled: true },
    };

    try {
      const firstPromise = (async () => {
        const events: RuntimeEvent[] = [];
        for await (const event of runTestRuntimeAgentV1(
          {
            task: '测试 shell 取消',
            threadId,
            userId: 'test',
            workspace,
            openState26SessionStorage: () => openState26Store5ForTestV1(storePath),
            model: model as unknown as SupportedChatModel,
            config,
            sandboxBackend: 'seatbelt',
            onTestExecutionControl: (control) => {
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
                processCleanup: {
                  confirmedExited: true,
                  gracefulRequested: true,
                  forced: false,
                  unconfirmedDescendantCount: 0,
                },
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
      const cancelledStore = openState26Store5ForTestV1(storePath);
      expect(cancelledStore.loadSnapshot<RuntimeState>(threadId)?.turn.status).toBe('aborted');
      cancelledStore.close();

      const secondEvents: RuntimeEvent[] = [];
      for await (const event of runTestRuntimeAgentV1(
        {
          task: '继续测试',
          threadId,
          userId: 'test',
          workspace,
          openState26SessionStorage: () => openState26Store5ForTestV1(storePath),
          model: model as unknown as import('@kite/builtin-runtime/model').SupportedChatModel,
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

  test('settles a persisted orphan task call before accepting the next user turn', async () => {
    const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-orphan-successor-'));
    const storePath = join(workspace, 'runtime.db');
    const threadId = 'orphan-successor';
    const config = {
      providerName: 'test',
      providerType: 'openai-compatible' as const,
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: false },
    };

    try {
      const stale = restoreState26KernelCoordinatorV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'test',
        workspace,
        store: openState26Store5ForTestV1(storePath),
        interactionMode: 'accept_edits',
      });
      stale.processEventBatch([
        { type: 'user.message_appended', messageId: 'user-old', content: '旧任务' },
        { type: 'turn.started', turnId: 'turn-old' },
        {
          type: 'model.responded',
          messageId: 'model-old',
          toolCalls: [
            { id: 'task-orphan', name: 'task', args: { subagent_type: 'review', task: 'review' } },
          ],
        },
        {
          type: 'tool.queued',
          toolCallId: 'task-orphan',
          modelMessageId: 'model-old',
          ordinal: 0,
          name: 'task',
          args: { subagent_type: 'review', task: 'review' },
        },
        { type: 'tool.started', toolCallId: 'task-orphan' },
        {
          type: 'turn.aborted',
          turnId: 'turn-old',
          reason: 'Legacy run ended without settling its child.',
          cause: 'error',
        },
      ]);
      stale.close();

      const model = createMockModel([{ message: aiMessage({ content: '新消息已正常完成。' }) }]);
      const events: RuntimeEvent[] = [];
      for await (const event of runTestRuntimeAgentV1(
        {
          task: '继续发送消息',
          threadId,
          userId: 'test',
          workspace,
          openState26SessionStorage: () => openState26Store5ForTestV1(storePath),
          model: model as unknown as import('@kite/builtin-runtime/model').SupportedChatModel,
          config,
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      )) {
        events.push(event);
      }

      const cancellationIndex = events.findIndex(
        (event) => event.type === 'tool.cancelled' && event.toolCallId === 'task-orphan',
      );
      const userMessageIndex = events.findIndex(
        (event) => event.type === 'user.message_appended' && event.content === '继续发送消息',
      );
      expect(cancellationIndex).toBeGreaterThanOrEqual(0);
      expect(userMessageIndex).toBeGreaterThan(cancellationIndex);
      expect(events.some((event) => event.type === 'completion.blocked')).toBe(false);
      expect(events.at(-1)?.type).toBe('turn.completed');

      const restored = restoreState26KernelCoordinatorV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'test',
        workspace,
        store: openState26Store5ForTestV1(storePath),
        interactionMode: 'accept_edits',
      });
      expect(restored.getState().tools.calls['task-orphan']?.status).toBe('cancelled');
      expect(restored.getState().turn.status).toBe('completed');
      restored.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('recovers cross-Task control residue before a successor message', async () => {
    const workspace = mkdtempSync(join(process.cwd(), '.kite-runtime-cross-task-successor-'));
    const storePath = join(workspace, 'runtime.db');
    const threadId = 'cross-task-successor';
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'test',
      workspace,
    });
    state.activeTaskId = 'current-task';
    state.tasks = {
      'older-task': {
        taskId: 'older-task',
        userGoal: 'old',
        status: 'cancelled',
        startedAtTurnId: 'older-turn',
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' },
        planHistory: [],
      },
      'current-task': {
        taskId: 'current-task',
        userGoal: 'current',
        status: 'active',
        startedAtTurnId: state.turn.turnId,
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' },
        planHistory: [],
      },
    };
    state.tools.calls.old = {
      toolCallId: 'old',
      taskId: 'older-task',
      modelMessageId: 'older-model',
      name: 'task',
      args: {},
      status: 'awaiting_approval',
      createdAtTurnId: 'older-turn',
    };
    state.transcript.messages = [
      ...state.transcript.messages,
      {
        kind: 'assistant',
        messageId: 'older-model',
        turnId: 'older-turn',
        ordinal: 0,
        createdAt: '2026-08-18T00:00:00.000Z',
        toolCalls: [{ id: 'old', name: 'task', args: {} }],
      },
    ];
    state.tools.queue = [...state.tools.queue, 'old'];
    state.suspendedSubagents.old = {
      storage: 'private_artifact_v1',
      subagentId: 'old-child',
      role: 'code',
      continuationId: `continuation-${'a'.repeat(64)}`,
      modelInvocationOrdinal: 0,
      continuationArtifact: {
        artifactId: `pa_${'b'.repeat(64)}`,
        kind: 'subagent_continuation',
        integrityIdentifier: `hmac-sha256:${'c'.repeat(64)}`,
        byteLength: 1,
      },
      parentInvocationId: 'parent-old',
      parentAttempt: 1,
      blockedTool: {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'old-child-shell',
        toolName: 'shell_execute',
      },
    };
    state.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'old-interaction',
      toolCallId: 'old',
      approval: {} as never,
    };
    state.skills.frames.old = {
      activationId: 'old',
      skillId: 'old-skill',
      skillRevision: '1',
      taskId: 'older-task',
      input: {},
      contextMode: 'inline',
      agent: 'main',
      capabilityCeiling: [],
      verificationMode: 'not_required',
      requestedBy: 'user',
      activatedAt: '2026-08-14T00:00:00.000Z',
      status: 'active',
    };
    state.terminalOutcome = {
      version: 1,
      status: 'unknown',
      reasonCode: 'cancel_incomplete',
      knownExternalEffects: 'unknown',
      safeRetry: false,
      recoveryEntry: 'reconcile',
      pendingVerification: false,
    };
    const store = openState26Store5ForTestV1(storePath);
    store.saveSnapshot(threadId, state);
    store.close();
    const model = createMockModel([{ message: aiMessage({ content: 'successor completed' }) }]);
    const config = {
      providerName: 'test',
      providerType: 'openai-compatible' as const,
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: false },
    };

    try {
      const events: RuntimeEvent[] = [];
      for await (const event of runTestRuntimeAgentV1(
        {
          task: 'successor message',
          threadId,
          userId: 'test',
          workspace,
          openState26SessionStorage: () => openState26Store5ForTestV1(storePath),
          model: model as unknown as import('@kite/builtin-runtime/model').SupportedChatModel,
          config,
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      )) {
        events.push(event);
      }

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'tool.cancelled', toolCallId: 'old' }),
      );
      expect(events.some((event) => event.type === 'completion.blocked')).toBe(false);
      expect(events.filter((event) => event.type === 'run.error')).toEqual([]);
      expect(events.at(-1)?.type).toBe('turn.completed');
      const restored = restoreState26KernelCoordinatorV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'test',
        workspace,
        store: openState26Store5ForTestV1(storePath),
      });
      expect(restored.getState()).toMatchObject({
        interactions: { kind: 'idle' },
        tools: { calls: { old: { status: 'cancelled' } } },
        terminalOutcome: { status: 'completed' },
      });
      restored.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  test('withholds writer, shell, and child capabilities until bounded cancellation is enabled', () => {
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      builtinToolCatalog: testBuiltinToolCatalogV1(),
    });
    const disclosed = environment.serializedTools.map((tool) => tool.name);

    expect(disclosed).not.toContain('task');
    expect(disclosed).not.toContain('shell_execute');
    expect(disclosed).not.toContain('write_file');
    expect(disclosed).not.toContain('edit_file');
  });

  test('persists a structured unknown terminal when recovery is blocked', async () => {
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'blocked-recovery',
      userId: 'u',
      workspace: '/',
    });
    state.recoveryState = { kind: 'incompatible', schemaVersion: 999, formatEpoch: null };
    const store = openState26Store5ForTestV1(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const events = [];

    for await (const event of runState26RuntimeLoopV1(kernel, async () => [], {
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
    expect(store.loadEventsStrict('blocked-recovery').map((event) => event.event.type)).toEqual([
      'turn.aborted',
      'run.error',
    ]);
    kernel.close();
  });

  test('interrupts a concurrency wait and cannot dispatch a new tool afterward', async () => {
    const now = Date.now();
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
    state.tools.queue = [...state.tools.queue, 'queued-tool'];
    const kernel = new AgentKernel({
      store: openState26Store5ForTestV1(':memory:'),
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
    for await (const event of runState26RuntimeLoopV1(
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
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'non-cooperative-cancel',
      userId: 'u',
      workspace: '/',
    });
    const kernel = new AgentKernel({
      store: openState26Store5ForTestV1(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const controller = new AbortController();
    let executorCalls = 0;
    const startedAt = Date.now();
    setTimeout(() => controller.abort('Cancellation requested.'), 10);

    for await (const _event of runState26RuntimeLoopV1(
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
    const directory = mkdtempSync(join(process.cwd(), '.openpx-cancel-restart-'));
    const storePath = join(directory, 'runtime.db');
    const threadId = 'cancel-restart';
    try {
      const kernel = restoreState26KernelCoordinatorV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'u',
        workspace: directory,
        store: openState26Store5ForTestV1(storePath),
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

      const restored = restoreState26KernelCoordinatorV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'u',
        workspace: directory,
        store: openState26Store5ForTestV1(storePath),
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
