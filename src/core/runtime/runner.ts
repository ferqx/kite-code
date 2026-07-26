import { resolveRejectedSubagentContinuation } from '../controllers/tool-controller';
import type { RuntimeUserAction } from './actions';
import type { RuntimeEvent } from './events';
import type { AgentKernel, RuntimeEffectExecutor } from './kernel';
import { decideNextEffect } from './scheduler';

export interface RuntimeActionProvider {
  requestAction(
    effect: Extract<import('./effects').RuntimeEffect, { interactionId: string }>,
    state: Readonly<import('./state').RuntimeState>,
  ): Promise<RuntimeUserAction>;
}

type EffectExecutionOutcome = { applied: boolean; emitted: boolean };

function isEphemeralModelDelta(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: 'model.reasoning_delta' | 'model.text_delta' }> {
  return event.type === 'model.reasoning_delta' || event.type === 'model.text_delta';
}

/** Execute an effect while forwarding events produced during the effect. */
async function* executeEffectWithStreaming(
  kernel: AgentKernel,
  executor: RuntimeEffectExecutor,
  lease: import('./effects').RuntimeEffectLease,
): AsyncGenerator<RuntimeEvent, EffectExecutionOutcome> {
  const pending: RuntimeEvent[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  let result: RuntimeEvent[] = [];
  let failure: unknown;

  const execution = executor(lease.effect, kernel.getState(), (event) => {
    pending.push(event);
    wake?.();
    wake = null;
  }).then(
    (events) => {
      result = events;
      settled = true;
      wake?.();
      wake = null;
    },
    (error: unknown) => {
      failure = error;
      settled = true;
      wake?.();
      wake = null;
    },
  );

  let emitted = false;
  while (!settled || pending.length > 0) {
    if (pending.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    while (pending.length > 0) {
      const event = pending.shift()!;
      emitted = true;
      if (isEphemeralModelDelta(event)) {
        if (kernel.isEffectLeaseCurrent(lease)) yield event;
      } else if (kernel.applyEffectEvent(lease, event)) {
        yield event;
      }
    }
  }
  await execution;
  if (failure) throw failure;

  if (result.length > 0) {
    emitted = true;
    if (!kernel.applyEffectResult(lease, result)) {
      return { applied: false, emitted };
    }
    yield* result;
  }
  if (!emitted) return { applied: true, emitted: false };
  return { applied: true, emitted: true };
}

/**
 * Kernel-native execution loop.  It is deliberately free of LangGraph stream,
 * checkpoint and AgentEvent concepts so application runners can adopt it as a
 * single, testable replacement boundary.
 */
export async function* runRuntimeLoop(
  kernel: AgentKernel,
  executor: RuntimeEffectExecutor,
  provider: RuntimeActionProvider,
  maxEffects = 10_000,
): AsyncGenerator<RuntimeEvent> {
  const runnerId = kernel.acquireRunner();
  if (!runnerId) return;
  try {
    for (let count = 0; count < maxEffects; count++) {
      const effect = decideNextEffect(kernel.getState());
      if (effect.type === 'stop') return;
      if (effect.type === 'recovery_blocked') {
        const lease = kernel.beginEffect(effect);
        yield {
          type: 'run.error',
          message: `Runtime recovery is blocked: ${effect.reason}`,
          recoverable: false,
          effectId: lease.effectId,
          turnId: lease.turnId,
        };
        return;
      }
      if (effect.type === 'subagent.recovery_unavailable') {
        const lease = kernel.beginEffect(effect);
        const outcome = yield* executeEffectWithStreaming(kernel, executor, lease);
        if (!outcome.emitted) return;
        if (!outcome.applied) continue;
        continue;
      }
      if (effect.type === 'emit_final') {
        const completed: RuntimeEvent = {
          type: 'run.completed',
          turnId: kernel.getState().turn.turnId,
          output: kernel.getState().transcript.final ?? '',
        };
        kernel.processEvent(completed);
        yield completed;

        const turnCompleted: RuntimeEvent = {
          type: 'turn.completed',
          turnId: kernel.getState().turn.turnId,
        };
        kernel.processEvent(turnCompleted);
        yield turnCompleted;
        return;
      }
      if (
        effect.type === 'request_user_input' ||
        effect.type === 'request_plan_review' ||
        effect.type === 'request_tool_approval' ||
        effect.type === 'request_verification_decision' ||
        effect.type === 'request_provider_action' ||
        effect.type === 'request_provider_admission'
      ) {
        const interaction = kernel.getState().interactions;
        if (
          effect.type === 'request_provider_action' &&
          interaction.kind === 'awaiting_provider_action' &&
          interaction.status === 'required'
        ) {
          const started: RuntimeEvent = {
            type: 'provider.action_started',
            interactionId: effect.interactionId,
          };
          kernel.processEvent(started);
          yield started;
        }
        let action: RuntimeUserAction;
        try {
          action = await provider.requestAction(effect, kernel.getState());
        } catch (error) {
          if (effect.type === 'request_provider_action') {
            action = {
              type: 'provider_action_result',
              interactionId: effect.interactionId,
              outcome: 'failed',
              failureCode: 'unknown',
            };
          } else if (effect.type === 'request_provider_admission') {
            action = {
              type: 'provider_admission_decision',
              interactionId: effect.interactionId,
              decision: { kind: 'cancel' },
            };
          } else {
            throw error;
          }
        }
        const actionResult = kernel.applyAction(action);
        if (actionResult.status !== 'applied') {
          // Stale UI actions are expected during cancellation/session-switch races.
          // They are recorded by the runtime logger but must not become user errors.
          yield actionResult.telemetry;
          continue;
        }
        const events = actionResult.events;
        let subagentEvents: RuntimeEvent[] = [];

        // When a sub-agent tool approval is rejected, emit subagent.failed +
        // tool.finished to terminate the sub-agent and produce a result for the model.
        if (
          (action.type === 'reject' || action.type === 'cancel') &&
          effect.type === 'request_tool_approval'
        ) {
          subagentEvents = resolveRejectedSubagentContinuation(
            kernel.getState(),
            effect.toolCallId,
          );
        }

        yield* events;
        if (subagentEvents.length > 0) {
          kernel.processEventBatch(subagentEvents);
          yield* subagentEvents;
        }
        if (
          effect.type === 'request_provider_admission' &&
          (action.type === 'cancel' ||
            (action.type === 'provider_admission_decision' && action.decision.kind === 'cancel'))
        ) {
          return;
        }
        continue;
      }
      const lease = kernel.beginEffect(effect);
      const outcome = yield* executeEffectWithStreaming(kernel, executor, lease);
      if (!outcome.emitted) return;
      if (!outcome.applied) continue;
    }
    throw new Error(`Runtime effect limit (${maxEffects}) exceeded`);
  } finally {
    kernel.releaseRunner(runnerId);
  }
}
