import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@/core/runtime/events';
import { classifyFailure } from '@/core/runtime/failures';
import { AgentKernel } from '@/core/runtime/kernel';
import { runRuntimeLoop } from '@/core/runtime/runner';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

describe('concurrent shell bounded cancellation', () => {
  test('records cancel_incomplete without reviving a cancelled shell or dispatching successors', async () => {
    const initial = createInitialRuntimeState({
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
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId: 'parallel-shell',
      ordinal: 1,
      name: 'shell_execute',
      args: { command: 'needs-approval' },
      status: 'queued',
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.queue.push('shell-1', 'shell-2');
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: initial,
      interactionMode: 'accept_edits',
    });
    const controller = new AbortController();
    let modelCalls = 0;
    const events: RuntimeEvent[] = [];

    for await (const event of runRuntimeLoop(
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
    const initial = createInitialRuntimeState({
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
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.calls['shell-2'] = {
      toolCallId: 'shell-2',
      modelMessageId: 'parallel-shell',
      ordinal: 1,
      name: 'shell_execute',
      args: { command: 'needs-approval' },
      status: 'queued',
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.queue.push('shell-1', 'shell-2');
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: initial,
      interactionMode: 'accept_edits',
    });
    const controller = new AbortController();
    let interactionPending = false;
    let cleanupFinished = false;
    const events: RuntimeEvent[] = [];

    for await (const event of runRuntimeLoop(
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
