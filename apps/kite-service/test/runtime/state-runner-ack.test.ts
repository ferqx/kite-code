import { describe, expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import {
  type RuntimeStateSessionPort,
  runStateRuntimeLoop,
} from '#kite-service/bootstrap/runtime/state-runner';
import type { RuntimeEvent, RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';

const RECOVERY_KEY = 'a'.repeat(64);

function initialState(): RuntimeState {
  return createRuntimeHostStateInitialState({
    recoveryIdentityKey: RECOVERY_KEY,
    threadId: 'state-runner-ack-test',
    userId: 'user-1',
    workspace: '/workspace',
  });
}

describe('State runner effect acknowledgements', () => {
  test('continues to the model when a background Shell advances durable State without returned events', async () => {
    let state = initialState();
    const shell1 = {
      toolCallId: 'shell-1',
      modelMessageId: 'model-1',
      name: 'shell_execute',
      args: { command: 'first' },
      status: 'approved',
      approvalGrant: 'approve_once',
      effectClass: 'unknown',
      sideEffect: true,
      createdAtTurnId: state.turn.turnId,
    } as const;
    const shell2 = {
      toolCallId: 'shell-2',
      modelMessageId: 'model-1',
      name: 'shell_execute',
      args: { command: 'second' },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    } as const;
    state = {
      ...state,
      tools: {
        ...state.tools,
        calls: { ...state.tools.calls, 'shell-1': shell1, 'shell-2': shell2 },
        queue: ['shell-1', 'shell-2'],
      },
    };

    let phase: 'tool' | 'model' | 'stop' = 'tool';
    let modelCalls = 0;
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => [],
      selectPendingEffects: () =>
        phase === 'tool'
          ? [{ type: 'run_tools', toolCallIds: ['shell-1'] }]
          : phase === 'model'
            ? [{ type: 'call_model' }]
            : [{ type: 'stop' }],
      acquireRunner: () => 'runner-durable-background-shell',
      releaseRunner: () => undefined,
      beginEffect: (effect) => ({
        effectId: `effect-${phase}`,
        expectedRevision: state.revision,
        turnId: state.turn.turnId,
        effect,
      }),
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => false,
      applyEffectResult: () => false,
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
    };
    const sharedShellTraits = {
      resourceScopes: [{ kind: 'process' as const, key: 'model-1' }],
      access: 'read' as const,
      conflictKeys: [],
      isolation: 'shared' as const,
      causalGroup: 'model-1',
      interactionBarrier: false,
      leaseFenceRequired: false,
      concurrencyGroup: 'parallel-read',
    };

    for await (const _event of runStateRuntimeLoop(
      kernel,
      async (effect) => {
        if (effect.type === 'run_tools') {
          // Production durable executors can commit through their storage boundary and return
          // no duplicate terminal array to the runner.
          state = {
            ...state,
            revision: state.revision + 1,
            tools: {
              ...state.tools,
              calls: {
                ...state.tools.calls,
                'shell-1': { ...state.tools.calls['shell-1']!, status: 'succeeded' },
              },
              queue: state.tools.queue.filter((toolCallId) => toolCallId !== 'shell-1'),
            },
          };
          phase = 'model';
          return [];
        }
        if (effect.type === 'call_model') {
          modelCalls += 1;
          phase = 'stop';
        }
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      10,
      undefined,
      undefined,
      () => ({
        traits: { 'shell-1': sharedShellTraits, 'shell-2': sharedShellTraits },
        approval: {
          'shell-1': { allowed: true, requiresApproval: false },
          'shell-2': { allowed: true, requiresApproval: false },
        },
      }),
    )) {
      // This regression is about continuation, not presentation events.
    }

    expect(modelCalls).toBe(1);
  });

  test('waits for a progressing sibling before accepting a background no-progress stop', async () => {
    let state = initialState();
    const calls = { ...state.tools.calls };
    for (const toolCallId of ['shell-1', 'shell-2']) {
      calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'model-1',
        name: 'shell_execute',
        args: { command: toolCallId },
        status: toolCallId === 'shell-1' ? 'approved' : 'queued',
        ...(toolCallId === 'shell-1' ? { approvalGrant: 'approve_once' as const } : {}),
        effectClass: 'read_only',
        sideEffect: false,
        createdAtTurnId: state.turn.turnId,
      } as (typeof calls)[string];
    }
    state = {
      ...state,
      tools: { ...state.tools, calls, queue: ['shell-1', 'shell-2'] },
    };

    let phase: 'first' | 'second' | 'waiting' | 'model' | 'stop' = 'first';
    let lastApplied: RuntimeEvent[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let modelCalls = 0;
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => lastApplied,
      selectPendingEffects: () =>
        phase === 'first'
          ? [{ type: 'run_tools', toolCallIds: ['shell-1'] }]
          : phase === 'second'
            ? [{ type: 'run_tools', toolCallIds: ['shell-2'] }]
            : phase === 'model' || phase === 'waiting'
              ? [{ type: 'call_model' }]
              : [{ type: 'stop' }],
      acquireRunner: () => 'runner-background-no-progress-race',
      releaseRunner: () => undefined,
      beginEffect: (effect) => ({
        effectId: effect.type === 'run_tools' ? `effect-${effect.toolCallIds[0]}` : 'effect-model',
        expectedRevision: state.revision,
        turnId: state.turn.turnId,
        effect,
      }),
      isEffectEventCurrent: () => true,
      applyEffectEvent: (_lease, event) => {
        lastApplied = [event];
        state = { ...state, revision: state.revision + 1 };
        phase = 'second';
        return true;
      },
      applyEffectResult: (_lease, events) => {
        lastApplied = [...events];
        state = { ...state, revision: state.revision + events.length };
        phase = 'model';
        return true;
      },
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
    };
    const traits = {
      resourceScopes: [{ kind: 'process' as const, key: 'model-1' }],
      access: 'read' as const,
      conflictKeys: [],
      isolation: 'shared' as const,
      causalGroup: 'model-1',
      interactionBarrier: false,
      leaseFenceRequired: false,
      concurrencyGroup: 'parallel-read',
    };

    for await (const _event of runStateRuntimeLoop(
      kernel,
      async (effect, _state, emit) => {
        if (effect.type === 'run_tools' && effect.toolCallIds[0] === 'shell-1') {
          emit?.({ type: 'user.message_appended', messageId: 'first-started', content: 'started' });
          await firstCanFinish;
          return [
            { type: 'user.message_appended', messageId: 'first-finished', content: 'finished' },
          ];
        }
        if (effect.type === 'run_tools') {
          phase = 'waiting';
          setTimeout(releaseFirst, 5);
          return [];
        }
        if (effect.type === 'call_model') {
          modelCalls += 1;
          phase = 'stop';
        }
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      10,
      undefined,
      undefined,
      () => ({
        traits: { 'shell-1': traits, 'shell-2': traits },
        approval: {
          'shell-1': { allowed: true, requiresApproval: false },
          'shell-2': { allowed: true, requiresApproval: false },
        },
      }),
    )) {
      // The first sibling's durable completion must invalidate the second sibling's
      // earlier no-progress candidate and allow model continuation.
    }

    expect(modelCalls).toBe(1);
    expect(state.revision).toBe(2);
  });

  test('stops a background Shell executor that returns without events or durable progress', async () => {
    let state = initialState();
    const calls = { ...state.tools.calls };
    for (const toolCallId of ['shell-1', 'shell-2']) {
      calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'model-1',
        name: 'shell_execute',
        args: { command: toolCallId },
        status: toolCallId === 'shell-1' ? 'approved' : 'queued',
        ...(toolCallId === 'shell-1' ? { approvalGrant: 'approve_once' as const } : {}),
        effectClass: 'read_only',
        sideEffect: false,
        createdAtTurnId: state.turn.turnId,
      } as (typeof calls)[string];
    }
    state = {
      ...state,
      tools: { ...state.tools, calls, queue: ['shell-1', 'shell-2'] },
    };
    let executions = 0;
    const effect = { type: 'run_tools' as const, toolCallIds: ['shell-1'] };
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => [],
      selectPendingEffects: () => [effect],
      acquireRunner: () => 'runner-no-progress-background-shell',
      releaseRunner: () => undefined,
      beginEffect: () => ({
        effectId: 'effect-no-progress',
        expectedRevision: state.revision,
        turnId: state.turn.turnId,
        effect,
      }),
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => false,
      applyEffectResult: () => false,
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
    };
    const traits = {
      resourceScopes: [{ kind: 'process' as const, key: 'model-1' }],
      access: 'read' as const,
      conflictKeys: [],
      isolation: 'shared' as const,
      causalGroup: 'model-1',
      interactionBarrier: false,
      leaseFenceRequired: false,
      concurrencyGroup: 'parallel-read',
    };

    for await (const _event of runStateRuntimeLoop(
      kernel,
      async () => {
        executions += 1;
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      10,
      undefined,
      undefined,
      () => ({
        traits: { 'shell-1': traits, 'shell-2': traits },
        approval: {
          'shell-1': { allowed: true, requiresApproval: false },
          'shell-2': { allowed: true, requiresApproval: false },
        },
      }),
    )) {
      // A no-progress executor must not create presentation output or a busy loop.
    }

    expect(executions).toBe(1);
    expect(state.revision).toBe(0);
  });

  test('routes explicit attempt and terminal recovery batches in queue order', async () => {
    const state = initialState();
    let pending = true;
    let lastApplied: RuntimeEvent[] = [];
    const acknowledgements: string[] = [];
    const lease = {
      effectId: 'effect-1',
      expectedRevision: state.revision,
      turnId: state.turn.turnId,
      effect: { type: 'call_model' as const },
    };
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => lastApplied,
      selectPendingEffects: () => (pending ? [lease.effect] : []),
      acquireRunner: () => 'runner-1',
      releaseRunner: () => undefined,
      beginEffect: () => lease,
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => false,
      applyEffectResult: () => false,
      applyEffectEvents: (_lease, events, acknowledgement) => {
        acknowledgements.push(acknowledgement);
        lastApplied = [...events];
        pending = false;
        return true;
      },
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
    };

    const emitted: RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async (_effect, _state, _emit, context) => {
        expect(context?.persistAttemptStartEvents).toBeFunction();
        expect(context?.persistTerminalRecoveryEvents).toBeFunction();
        await context!.persistAttemptStartEvents!([
          { type: 'user.message_appended', messageId: 'attempt', content: 'attempt' },
        ]);
        await context!.persistTerminalRecoveryEvents!([
          { type: 'user.message_appended', messageId: 'recovery', content: 'recovery' },
        ]);
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      emitted.push(event);
    }

    expect(acknowledgements).toEqual(['attempt_start', 'terminal_recovery']);
    expect(emitted.map((event) => event.type)).toEqual([
      'user.message_appended',
      'user.message_appended',
    ]);
    expect(state.revision).toBe(0);
  });

  test('fails closed without a new acknowledgement port and never uses receipt fallback', async () => {
    const state = initialState();
    let pending = true;
    const lastApplied: RuntimeEvent[] = [];
    let legacyApplyEventCalls = 0;
    let legacyApplyResultCalls = 0;
    const lease = {
      effectId: 'effect-legacy-port',
      expectedRevision: state.revision,
      turnId: state.turn.turnId,
      effect: { type: 'call_model' as const },
    };
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => lastApplied,
      selectPendingEffects: () => (pending ? [lease.effect] : []),
      acquireRunner: () => 'runner-legacy-port',
      releaseRunner: () => undefined,
      beginEffect: () => lease,
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => {
        legacyApplyEventCalls += 1;
        return false;
      },
      applyEffectResult: () => {
        legacyApplyResultCalls += 1;
        return false;
      },
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
    };

    const accepted: boolean[] = [];
    const emitted: RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async (_effect, _state, _emit, context) => {
        accepted.push(
          await context!.persistAttemptStartEvents!([
            { type: 'user.message_appended', messageId: 'attempt', content: 'attempt' },
          ]),
        );
        accepted.push(
          await context!.persistTerminalRecoveryEvents!([
            { type: 'user.message_appended', messageId: 'recovery', content: 'recovery' },
          ]),
        );
        pending = false;
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      emitted.push(event);
    }

    expect(accepted).toEqual([false, false]);
    expect(legacyApplyEventCalls).toBe(0);
    expect(legacyApplyResultCalls).toBe(0);
    expect(lastApplied).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

test('reschedules a stale stop after background shell finishes during preparation', async () => {
  let state = initialState();
  const call = {
    toolCallId: 'shell-1',
    modelMessageId: 'model-1',
    name: 'shell_execute',
    args: { command: 'first' },
    status: 'queued',
    effectClass: 'read_only',
    sideEffect: false,
    createdAtTurnId: state.turn.turnId,
  } as const;
  state = {
    ...state,
    tools: {
      ...state.tools,
      calls: { 'shell-1': call, 'shell-2': { ...call, toolCallId: 'shell-2' } },
      queue: ['shell-1', 'shell-2'],
    },
  };
  let phase: 'tool' | 'waiting' | 'model' | 'done' = 'tool';
  let lastEvents: RuntimeEvent[] = [];
  let releaseShell!: () => void;
  const shellMayFinish = new Promise<void>((resolve) => {
    releaseShell = resolve;
  });
  let released!: () => void;
  const shellReleased = new Promise<void>((resolve) => {
    released = resolve;
  });
  let modelCalls = 0;
  const kernel: RuntimeStateSessionPort = {
    getState: () => state,
    processEvent: () => ({ status: 'applied', eventId: 'unused' }),
    processEventBatch: () => [],
    getLastAppliedEvents: () => lastEvents,
    selectPendingEffects: () =>
      phase === 'tool'
        ? [{ type: 'run_tools', toolCallIds: ['shell-1'] }]
        : phase === 'model'
          ? [{ type: 'call_model' }]
          : [{ type: 'stop' }],
    acquireRunner: () => 'runner',
    releaseRunner: () => {},
    beginEffect: (effect) => ({
      effectId: `effect-${phase}`,
      effect,
      expectedRevision: state.revision,
      turnId: state.turn.turnId,
    }),
    releaseEffect: () => released(),
    isEffectEventCurrent: () => true,
    applyEffectEvent: (_lease, event) => {
      state = { ...state, revision: state.revision + 1 };
      lastEvents = [event];
      return true;
    },
    applyEffectResult: () => true,
    applyLateResourceReconciliation: () => false,
    applyAction: () => ({
      status: 'stale',
      reason: 'unused',
      telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
    }),
  };
  const traits = {
    resourceScopes: [{ kind: 'process' as const, key: 'model-1' }],
    access: 'read' as const,
    conflictKeys: [],
    isolation: 'shared' as const,
    causalGroup: 'model-1',
    interactionBarrier: false,
    leaseFenceRequired: false,
    concurrencyGroup: 'parallel-read',
  };
  for await (const _event of runStateRuntimeLoop(
    kernel,
    async (effect, _state, emit) => {
      if (effect.type === 'run_tools') {
        phase = 'waiting';
        emit?.({
          type: 'tool.started',
          toolCallId: 'shell-1',
          createdAt: new Date().toISOString(),
        });
        await shellMayFinish;
        state = { ...state, revision: state.revision + 1 };
        phase = 'model';
        return [];
      }
      if (effect.type === 'call_model') {
        modelCalls++;
        phase = 'done';
      }
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    10,
    async (effect) => {
      if (effect.type === 'stop' && phase === 'waiting') {
        releaseShell();
        await shellReleased;
      }
      return effect;
    },
    undefined,
    () => ({
      traits: { 'shell-1': traits, 'shell-2': traits },
      approval: {
        'shell-1': { allowed: true, requiresApproval: false },
        'shell-2': { allowed: true, requiresApproval: false },
      },
    }),
  )) {
  }
  expect(modelCalls).toBe(1);
}, 2000);

test('concurrent shell publication retains transaction order across multi-event batches', async () => {
  let state = initialState();
  const call = {
    toolCallId: 'shell-1',
    modelMessageId: 'model-1',
    name: 'shell_execute',
    args: { command: 'fixture' },
    status: 'queued',
    effectClass: 'read_only',
    sideEffect: false,
    createdAtTurnId: state.turn.turnId,
  } as const;
  state = {
    ...state,
    tools: {
      ...state.tools,
      calls: { 'shell-1': call, 'shell-2': { ...call, toolCallId: 'shell-2' } },
      queue: ['shell-1', 'shell-2'],
    },
  };
  const pending = new Set(['shell-1', 'shell-2']);
  const completed = new Set<string>();
  let modelCalls = 0;
  const revisions = new WeakMap<RuntimeEvent, number>();
  let last: readonly RuntimeEvent[] = [];
  let secondCommitted!: () => void;
  const secondBatch = new Promise<void>((resolve) => {
    secondCommitted = resolve;
  });
  const apply = (events: RuntimeEvent[]) => {
    for (const event of events) {
      state = { ...state, revision: state.revision + 1 };
      revisions.set(event, state.revision);
      if (event.type === 'tool.finished') completed.add(event.toolCallId);
    }
    last = events;
    if (events.some((event) => event.type === 'tool.finished' && event.toolCallId === 'shell-2'))
      secondCommitted();
    return true;
  };
  const kernel: RuntimeStateSessionPort = {
    getState: () => state,
    processEvent: () => ({ status: 'applied', eventId: 'unused' }),
    processEventBatch: () => [],
    getLastAppliedEvents: () => last,
    selectPendingEffects: () =>
      pending.size
        ? [{ type: 'run_tools', toolCallIds: [[...pending][0]!] }]
        : completed.size === 2 && modelCalls === 0
          ? [{ type: 'call_model' }]
          : [{ type: 'stop' }],
    acquireRunner: () => 'runner',
    releaseRunner: () => {},
    beginEffect: (effect) => {
      if (effect.type === 'run_tools') pending.delete(effect.toolCallIds[0]!);
      return {
        effectId: crypto.randomUUID(),
        effect,
        expectedRevision: state.revision,
        turnId: state.turn.turnId,
      };
    },
    isEffectEventCurrent: () => true,
    applyEffectEvent: (_lease, event) => apply([event]),
    applyEffectResult: (_lease, events) => apply(events),
    applyLateResourceReconciliation: () => false,
    applyAction: () => ({
      status: 'stale',
      reason: 'unused',
      telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
    }),
  };
  const traits = {
    resourceScopes: [{ kind: 'process' as const, key: 'model-1' }],
    access: 'read' as const,
    conflictKeys: [],
    isolation: 'shared' as const,
    causalGroup: 'model-1',
    interactionBarrier: false,
    leaseFenceRequired: false,
    concurrencyGroup: 'parallel-read',
  };
  const finished = (toolCallId: string): RuntimeEvent => ({
    type: 'tool.finished',
    toolCallId,
    name: 'shell_execute',
    result: { ok: true, command: 'fixture', exitCode: 0, stdout: '', stderr: '' },
  });
  const seen: number[] = [];
  for await (const event of runStateRuntimeLoop(
    kernel,
    async (effect, _state, _emit, context) => {
      if (effect.type === 'call_model') {
        modelCalls++;
        return [];
      }
      if (effect.type !== 'run_tools') return [];
      const id = effect.toolCallIds[0]!;
      if (id === 'shell-1') {
        await context!.persistEvents([{ type: 'tool.started', toolCallId: id }]);
        await secondBatch;
        await context!.persistEvents([finished(id)]);
      } else {
        await context!.persistEvents([{ type: 'tool.started', toolCallId: id }, finished(id)]);
      }
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    10,
    undefined,
    undefined,
    () => ({
      traits: { 'shell-1': traits, 'shell-2': traits },
      approval: {
        'shell-1': { allowed: true, requiresApproval: false },
        'shell-2': { allowed: true, requiresApproval: false },
      },
    }),
  )) {
    seen.push(revisions.get(event)!);
    await Bun.sleep(0);
  }
  expect(seen).toEqual([1, 2, 3, 4]);
  expect(modelCalls).toBe(1);
}, 2000);
