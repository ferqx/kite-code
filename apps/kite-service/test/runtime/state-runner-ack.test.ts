import { describe, expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
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
  test('settles a durable mailbox callback when the publication consumer closes', async () => {
    let state = initialState();
    let callbackSettled = false;
    const created = {
      type: 'agent.created' as const,
      agentId: 'child-close',
      parentAgentId: state.session.threadId,
      initialTaskId: 'child-close',
    };
    const mutation = {
      kind: 'create_agent' as const,
      agentId: 'child-close',
      parentAgentId: state.session.threadId,
      initialTaskId: 'child-close',
      createdAtMs: 1,
    };
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => [],
      selectPendingEffects: () => [{ type: 'run_tools', toolCallIds: ['parent-tool'] }],
      acquireRunner: () => 'close-runner',
      releaseRunner: () => undefined,
      beginEffect: (effect) => ({
        effectId: 'close-effect',
        expectedRevision: state.revision,
        turnId: state.turn.turnId,
        effect,
      }),
      isEffectEventCurrent: () => true,
      applyEffectEvent: () => false,
      applyEffectResult: () => true,
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
      commitAgentMailboxFacts: (lease, input) => {
        state = { ...state, revision: state.revision + 1 };
        lease.expectedRevision = state.revision;
        return input.events;
      },
    };
    const stream = runStateRuntimeLoop(
      kernel,
      async (_effect, _state, _emit, context) => {
        await context!.commitAgentMailboxFacts!({ events: [created], mutations: [mutation] });
        callbackSettled = true;
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      1,
    );
    const first = await stream.next();
    expect(first.value).toMatchObject(created);
    await stream.return(undefined);
    expect(callbackSettled).toBe(true);
  });

  test('serializes three child registrations after an earlier queued Tool fact', async () => {
    let state = initialState();
    let phase: 'tool' | 'stop' = 'tool';
    let last: readonly RuntimeEvent[] = [];
    const preceding: RuntimeEvent = { type: 'runtime.action_ignored', reason: 'queued-first' };
    const children = ['child-1', 'child-2', 'child-3'].map((agentId) => ({
      event: {
        type: 'agent.created' as const,
        agentId,
        parentAgentId: state.session.threadId,
        initialTaskId: agentId,
      },
      mutation: {
        kind: 'create_agent' as const,
        agentId,
        parentAgentId: state.session.threadId,
        initialTaskId: agentId,
        createdAtMs: 1,
      },
    }));
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => last,
      selectPendingEffects: () =>
        phase === 'tool'
          ? [{ type: 'run_tools', toolCallIds: ['parent-tool'] }]
          : [{ type: 'stop' }],
      acquireRunner: () => 'registration-runner',
      releaseRunner: () => undefined,
      beginEffect: (effect) => ({
        effectId: 'tool-effect',
        expectedRevision: state.revision,
        turnId: state.turn.turnId,
        effect,
      }),
      isEffectEventCurrent: () => true,
      applyEffectEvent: (lease, event) => {
        expect(lease.expectedRevision).toBe(state.revision);
        state = { ...state, revision: state.revision + 1 };
        lease.expectedRevision = state.revision;
        last = [event];
        return true;
      },
      applyEffectResult: () => false,
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
      commitAgentMailboxFacts: (lease, input) => {
        expect(lease.expectedRevision).toBe(state.revision);
        expect(input.events).toHaveLength(1);
        state = { ...state, revision: state.revision + 1 };
        lease.expectedRevision = state.revision;
        return input.events;
      },
    };
    const yielded: RuntimeEvent['type'][] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async (effect, _state, _emit, context) => {
        if (effect.type === 'run_tools') {
          const first = context!.persistEvents([preceding]);
          const registrations = children.map(({ event, mutation }) =>
            context!.commitAgentMailboxFacts!({ events: [event], mutations: [mutation] }),
          );
          const [persisted, ...committed] = await Promise.all([first, ...registrations]);
          expect(persisted).toBe(true);
          expect(committed).toEqual(children.map(({ event }) => [event]));
          phase = 'stop';
        }
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      1,
    ))
      yielded.push(event.type);
    expect(yielded).toEqual([
      'runtime.action_ignored',
      'agent.created',
      'agent.created',
      'agent.created',
    ]);
    expect(state.revision).toBe(4);
  });

  test('scopes atomic Agent mailbox commit to one active Tool lease and yields the committed fact once', async () => {
    let state = initialState();
    let phase: 'tool' | 'model' | 'stop' = 'tool';
    let committed = 0;
    let seenOutsideTool = false;
    let lateCommit: NonNullable<
      Parameters<Parameters<typeof runStateRuntimeLoop>[1]>[3]
    >['commitAgentMailboxCommand'];
    let lateFacts: NonNullable<
      Parameters<Parameters<typeof runStateRuntimeLoop>[1]>[3]
    >['commitAgentMailboxFacts'];
    let lateModelAdmission: NonNullable<
      Parameters<Parameters<typeof runStateRuntimeLoop>[1]>[3]
    >['persistAgentMailModelAdmission'];
    const model = {
      type: 'model.invocation_prepared',
      invocationId: 'model-1',
    } as RuntimeEvent;
    const preparedMail = {
      type: 'agent.mail_input_prepared',
      targetAgentId: state.session.threadId,
      invocationId: 'model-1',
      modelAdmissionId: 'model-1',
      fromSequence: 0,
      throughSequence: 1,
      messageIds: ['mail-1'],
    } as RuntimeEvent;
    const preparedMutation = {
      kind: 'prepare_input' as const,
      targetAgentId: state.session.threadId,
      modelInvocationId: 'model-1',
      modelAdmissionId: 'model-1',
      fromSequence: 0,
      throughSequence: 1,
      messageIds: ['mail-1'],
    };
    const created = {
      type: 'agent.created' as const,
      agentId: 'child-1',
      parentAgentId: state.session.threadId,
      initialTaskId: 'child-1',
    };
    const createMutation = {
      kind: 'create_agent' as const,
      agentId: 'child-1',
      parentAgentId: state.session.threadId,
      initialTaskId: 'child-1',
      createdAtMs: 1,
    };
    const event = {
      type: 'agent.mail_accepted' as const,
      messageId: 'mail-1',
      senderAgentId: 'sender',
      targetAgentId: 'target',
      mode: 'queue_only' as const,
      source: {
        runId: 'run',
        turnId: state.turn.turnId,
        modelInvocationId: 'model',
        toolCallId: 'mail-tool',
        effectAttemptId: 'opaque-attempt',
      },
      bodyRef: {
        artifactId: `pa_${'1'.repeat(64)}`,
        kind: 'agent_mail' as const,
        integrityIdentifier: `sha256:${'2'.repeat(64)}`,
        byteLength: 4,
      },
      bodyDigest: `sha256:${'3'.repeat(64)}`,
      sequence: 1,
    };
    const mutation = {
      kind: 'accept_mail' as const,
      messageId: event.messageId,
      senderAgentId: event.senderAgentId,
      targetAgentId: event.targetAgentId,
      mode: event.mode,
      source: event.source,
      bodyRef: event.bodyRef,
      bodyDigest: event.bodyDigest,
      bodyText: 'mail',
      requestDigest: 'a'.repeat(64),
      sequence: 1,
      acceptedAtMs: 1,
    };
    const evidence = {
      scopeSessionId: state.session.threadId,
      commandId: event.messageId,
      requestDigest: mutation.requestDigest,
      targetSessionId: state.session.threadId,
      committedAt: 1,
    };
    const receipt = createRuntimeStoredCommandReceipt(evidence, 1);
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      currentRunId: () => 'persisted-run-1',
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => [],
      selectPendingEffects: () =>
        phase === 'tool'
          ? [{ type: 'run_tools', toolCallIds: ['mail-tool'] }]
          : phase === 'model'
            ? [{ type: 'call_model' }]
            : [{ type: 'stop' }],
      acquireRunner: () => 'mail-runner',
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
      commitAgentMailboxCommand: (lease, input) => {
        expect(lease.effect.type).toBe('run_tools');
        expect(input.events).toEqual([event]);
        committed += 1;
        state = { ...state, revision: state.revision + 1 };
        return { receipt, events: [event] };
      },
      commitAgentMailboxFacts: (lease, input) => {
        expect(lease.effect.type).toBe('run_tools');
        expect(input).toEqual({ events: [created], mutations: [createMutation] });
        state = { ...state, revision: state.revision + 1 };
        return [created];
      },
      persistAgentMailModelAdmission: (lease, input) => {
        expect(lease.effect.type).toBe('call_model');
        expect(input).toEqual({ events: [model, preparedMail], mutation: preparedMutation });
        state = { ...state, revision: state.revision + 2 };
        return [model, preparedMail];
      },
    };
    const yielded: string[] = [];
    for await (const fact of runStateRuntimeLoop(
      kernel,
      async (effect, _state, _emit, context) => {
        if (effect.type === 'run_tools') {
          expect(context?.commitAgentMailboxCommand).toBeDefined();
          expect(context?.currentRunId?.()).toBe('persisted-run-1');
          lateCommit = context!.commitAgentMailboxCommand;
          lateFacts = context!.commitAgentMailboxFacts;
          const command = { events: [event], mutations: [mutation], evidence };
          const [first, replay, childFacts] = await Promise.all([
            context!.commitAgentMailboxCommand!(command),
            context!.commitAgentMailboxCommand!(command),
            context!.commitAgentMailboxFacts!({
              events: [created],
              mutations: [createMutation],
            }),
          ]);
          expect(first).toEqual(receipt);
          expect(replay).toEqual(first);
          expect(childFacts).toEqual([created]);
          await expect(
            context!.commitAgentMailboxCommand!({
              ...command,
              evidence: { ...evidence, requestDigest: 'b'.repeat(64) },
            }),
          ).rejects.toThrow(/identity conflicts/u);
          phase = 'model';
        } else if (effect.type === 'call_model') {
          seenOutsideTool = context?.commitAgentMailboxCommand !== undefined;
          expect(context?.persistAgentMailModelAdmission).toBeDefined();
          lateModelAdmission = context!.persistAgentMailModelAdmission;
          await context!.persistAgentMailModelAdmission!({
            events: [model, preparedMail],
            mutation: preparedMutation,
          });
          phase = 'stop';
        }
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      10,
    ))
      yielded.push(fact.type);
    expect(yielded).toEqual([
      'agent.mail_accepted',
      'agent.created',
      'model.invocation_prepared',
      'agent.mail_input_prepared',
    ]);
    expect(committed).toBe(1);
    expect(seenOutsideTool).toBe(false);
    await expect(
      lateCommit!({
        events: [event],
        mutations: [mutation],
        evidence,
      }),
    ).rejects.toThrow(/no longer active/u);
    await expect(lateFacts!({ events: [created], mutations: [createMutation] })).rejects.toThrow(
      /no longer active/u,
    );
    await expect(
      lateModelAdmission!({ events: [model, preparedMail], mutation: preparedMutation }),
    ).rejects.toThrow(/no longer active/u);
  });

  test.each([
    'finite_shell',
    'required_child',
  ] as const)('does not advance the model for a no-progress required %s and resumes in the same turn after terminal read', async (kind) => {
    let state = initialState();
    const turnId = state.turn.turnId;
    const startId = kind === 'finite_shell' ? 'shell-start' : 'child-start';
    state = {
      ...state,
      tools: {
        ...state.tools,
        calls: {
          ...state.tools.calls,
          [startId]: {
            toolCallId: startId,
            modelMessageId: 'model-start',
            name: kind === 'finite_shell' ? 'shell_execute' : 'task',
            args:
              kind === 'finite_shell'
                ? { command: 'sleep 1', yield_ms: 0 }
                : {
                    task: 'inspect',
                    subagent_type: 'explore',
                    background: true,
                    result_disposition: 'required',
                  },
            status: 'succeeded',
            createdAtTurnId: turnId,
            result: {
              ok: true,
              summary: 'running',
              resultMeta:
                kind === 'finite_shell'
                  ? { shellId: 'sh-required', shellStatus: 'running' }
                  : {
                      taskId: 'child-required',
                      taskStatus: 'running',
                      taskDisposition: 'required',
                    },
            },
          },
        },
      },
    };
    let phase: 'wait' | 'model' | 'stop' = 'wait';
    let modelCalls = 0;
    const waitingEffect = { type: 'run_tools' as const, toolCallIds: [startId] };
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => [],
      selectPendingEffects: () =>
        phase === 'wait'
          ? [waitingEffect]
          : phase === 'model'
            ? [{ type: 'call_model' }]
            : [{ type: 'stop' }],
      acquireRunner: () => `runner-required-${kind}`,
      releaseRunner: () => undefined,
      beginEffect: (effect) => ({
        effectId: `effect-${phase}`,
        expectedRevision: state.revision,
        turnId,
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
    const run = () =>
      runStateRuntimeLoop(
        kernel,
        async (effect) => {
          if (effect.type === 'run_tools') {
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
      );
    for await (const _event of run()) {
      /* no presentation facts expected */
    }
    expect(modelCalls).toBe(0);
    expect(state.turn.turnId).toBe(turnId);
    expect(state.turn.status).toBe('active');

    state = { ...state, revision: state.revision + 1 };
    for await (const _event of run()) {
      /* terminal read permits same-Run continuation */
    }
    expect(modelCalls).toBe(1);
    expect(state.turn.turnId).toBe(turnId);
    expect(state.turn.status).toBe('active');
  });

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
