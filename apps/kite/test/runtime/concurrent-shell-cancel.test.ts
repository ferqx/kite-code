import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { classifyFailure } from '#app/bootstrap/runtime/failures';
import { projectRuntimeSchedulerFacts } from '#app/bootstrap/runtime/scheduler-facts';
import { runStateRuntimeLoop } from '#app/bootstrap/runtime/state-runner';
import { StateHostSessionHarness as AgentKernel } from '../../../../scripts/support/runtime-host-state';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';
import { testBuiltinToolCatalog } from '../../../../tests/helpers/runtime-model';

function canonicalShellInvocationFacts(command: string) {
  const entry = testBuiltinToolCatalog().entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === 'shell_execute',
  );
  if (!entry) throw new Error('Builtin shell catalog entry is unavailable.');
  const parsed = entry.parse({ command }, { workspace: '/', phase: 'building' });
  if (!parsed.success) throw new Error('Builtin shell fixture is invalid.');
  const effects = entry.classifyEffects(parsed.data, { workspace: '/', phase: 'building' });
  return {
    effectClass: effects.effectClass,
    sideEffect: effects.sideEffect,
    classificationReason: effects.classificationReason,
  };
}

describe('concurrent shell bounded cancellation', () => {
  test('records cancel_incomplete without reviving a cancelled shell or dispatching successors', async () => {
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'cancel-incomplete-shell',
      userId: 'u',
      workspace: '/',
    });
    initial.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId: 'parallel-shell',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'long-running' },
      status: 'approved',
      approvalGrant: 'approve_once',
      ...canonicalShellInvocationFacts('long-running'),
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId: 'parallel-shell',
      ordinal: 1,
      name: 'shell_execute',
      args: { command: 'needs-approval' },
      status: 'queued',
      ...canonicalShellInvocationFacts('needs-approval'),
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.queue = [...initial.tools.queue, 'shell-1', 'shell-2'];
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: initial,
      interactionMode: 'accept_edits',
    });
    const controller = new AbortController();
    let modelCalls = 0;
    const events: RuntimeEvent[] = [];

    for await (const event of runStateRuntimeLoop(
      kernel,
      async (effect, state, emit) => {
        if (effect.type === 'call_model') {
          modelCalls += 1;
          return [];
        }
        if (effect.type !== 'run_tools') return [];
        const toolCallId = effect.toolCallIds[0]!;
        const call = state.tools.calls[toolCallId]!;
        if (call.status === 'queued') {
          emit?.({
            type: 'approval.requested',
            interactionId: `approval-${toolCallId}`,
            toolCallId,
            fullModeBypassEligible: false,
            fullModePolicyBypassAllowed: false,
            approval: {
              scope: 'once',
              cwd: '/',
              threadId: state.session.threadId,
              tool: 'shell_execute',
              command: String((call.args as { command: string }).command),
              risk: 'execute_code',
              approvalHash: `hash-${toolCallId}`,
              summary: 'Run shell',
              reason: 'Test bounded cancellation.',
              expectedEffects: [],
              grantOptions: ['approve_once'],
              recommendedGrant: 'approve_once',
            },
          });
          return [];
        }
        emit?.({ type: 'tool.started', toolCallId });
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        emit?.({
          type: 'runtime.cancellation_diagnostic',
          toolCallId,
          failure: classifyFailure(
            'cancel_incomplete',
            'A descendant could not be confirmed exited.',
          ),
          unconfirmedDescendantCount: 1,
        });
        return [
          {
            type: 'tool.finished',
            toolCallId,
            name: 'shell_execute',
            result: {
              ok: false,
              command: 'long-running',
              exitCode: 130,
              stdout: '',
              stderr: 'cancelled',
            },
          },
        ];
      },
      {
        requestAction: async (effect) => ({
          type: 'cancel',
          interactionId: effect.interactionId,
          reason: 'Cancel later sibling.',
        }),
      },
      10_000,
      undefined,
      controller.signal,
      (state) => projectRuntimeSchedulerFacts(state, testBuiltinToolCatalog()),
    )) {
      events.push(event);
      if (event.type === 'approval.rejected') controller.abort();
    }

    expect(modelCalls).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'runtime.cancellation_diagnostic',
        failure: expect.objectContaining({ kind: 'cancel_incomplete' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.error',
        failure: expect.objectContaining({ kind: 'cancel_incomplete' }),
        outcome: expect.objectContaining({
          status: 'unknown',
          reasonCode: 'cancel_incomplete',
          knownExternalEffects: 'unknown',
          recoveryEntry: 'reconcile',
        }),
      }),
    );
    expect(kernel.getState().tools.calls['shell-1']?.status).toBe('cancelled');
    expect(kernel.getState().tools.calls['shell-2']?.status).toBe('rejected');
    kernel.close();
  });

  test('drains background cleanup when deadline aborts a pending approval interaction', async () => {
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'deadline-pending-approval',
      userId: 'u',
      workspace: '/',
    });
    initial.tools.calls['shell-1'] = {
      toolCallId: 'shell-1',
      modelMessageId: 'parallel-shell',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'long-running' },
      status: 'approved',
      approvalGrant: 'approve_once',
      ...canonicalShellInvocationFacts('long-running'),
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId: 'parallel-shell',
      ordinal: 1,
      name: 'shell_execute',
      args: { command: 'needs-approval' },
      status: 'queued',
      ...canonicalShellInvocationFacts('needs-approval'),
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.queue = [...initial.tools.queue, 'shell-1', 'shell-2'];
    const kernel = new AgentKernel({
      store: openStateStoreForTest(':memory:'),
      initialState: initial,
      interactionMode: 'accept_edits',
    });
    const controller = new AbortController();
    let interactionPending = false;
    let cleanupFinished = false;
    const events: RuntimeEvent[] = [];

    for await (const event of runStateRuntimeLoop(
      kernel,
      async (effect, state, emit) => {
        if (effect.type !== 'run_tools') return [];
        const toolCallId = effect.toolCallIds[0]!;
        const call = state.tools.calls[toolCallId]!;
        if (call.status === 'queued') {
          emit?.({
            type: 'approval.requested',
            interactionId: `approval-${toolCallId}`,
            toolCallId,
            fullModeBypassEligible: false,
            fullModePolicyBypassAllowed: false,
            approval: {
              scope: 'once',
              cwd: '/',
              threadId: state.session.threadId,
              tool: 'shell_execute',
              command: String((call.args as { command: string }).command),
              risk: 'execute_code',
              approvalHash: `hash-${toolCallId}`,
              summary: 'Run shell',
              reason: 'Test deadline cleanup drain.',
              expectedEffects: [],
              grantOptions: ['approve_once'],
              recommendedGrant: 'approve_once',
            },
          });
          return [];
        }
        emit?.({ type: 'tool.started', toolCallId });
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        emit?.({
          type: 'runtime.cancellation_diagnostic',
          toolCallId,
          failure: classifyFailure(
            'cancel_incomplete',
            'A descendant could not be confirmed exited.',
          ),
          unconfirmedDescendantCount: 1,
        });
        cleanupFinished = true;
        return [
          {
            type: 'tool.finished',
            toolCallId,
            name: 'shell_execute',
            result: {
              ok: false,
              command: 'long-running',
              exitCode: 130,
              stdout: '',
              stderr: 'cancelled',
            },
          },
        ];
      },
      {
        requestAction: async () => {
          interactionPending = true;
          setTimeout(() => controller.abort('Runtime deadline exceeded.'), 10);
          return new Promise(() => {});
        },
      },
      10_000,
      undefined,
      controller.signal,
      (state) => projectRuntimeSchedulerFacts(state, testBuiltinToolCatalog()),
    )) {
      events.push(event);
    }

    expect(interactionPending).toBe(true);
    expect(cleanupFinished).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'runtime.cancellation_diagnostic',
        failure: expect.objectContaining({ kind: 'cancel_incomplete' }),
      }),
    );
    kernel.close();
  });
});
