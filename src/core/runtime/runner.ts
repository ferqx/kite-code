import { resolveRejectedSubagentContinuation } from '../controllers/tool-controller';
import type { RuntimeUserAction } from './actions';
import { eventsForRuntimeAction } from './actions';
import type { RuntimeEvent } from './events';
import type { AgentKernel, RuntimeEffectExecutor } from './kernel';
import { decideNextEffect } from './scheduler';

export interface RuntimeActionProvider {
  requestAction(
    effect: Extract<import('./effects').RuntimeEffect, { interactionId: string }>,
    state: Readonly<import('./state').RuntimeState>,
  ): Promise<RuntimeUserAction>;
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
  for (let count = 0; count < maxEffects; count++) {
    const effect = decideNextEffect(kernel.getState());
    if (effect.type === 'stop') return;
    if (effect.type === 'subagent.recovery_unavailable') {
      const events = await executor(effect, kernel.getState());
      if (events.length === 0) return;
      kernel.processEventBatch(events);
      yield* events;
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
      effect.type === 'request_tool_approval'
    ) {
      const action = await provider.requestAction(effect, kernel.getState());
      const events = eventsForRuntimeAction(kernel.getState(), action, {
        sandboxAvailable: kernel.isSandboxAvailable(),
      });
      if (events.length === 0)
        throw new Error('Runtime action does not match the active interaction.');

      // When a sub-agent tool approval is rejected, emit subagent.failed +
      // tool.finished to terminate the sub-agent and produce a result for the model.
      if (action.type === 'reject' && effect.type === 'request_tool_approval') {
        const subagentEvents = resolveRejectedSubagentContinuation(
          kernel.getState(),
          effect.toolCallId,
        );
        if (subagentEvents.length > 0) {
          events.push(...subagentEvents);
        }
      }

      kernel.processEventBatch(events);
      yield* events;
      continue;
    }
    const events = await executor(effect, kernel.getState());
    if (events.length === 0) return;
    kernel.processEvents(events);
    yield* events;
  }
  throw new Error(`Runtime effect limit (${maxEffects}) exceeded`);
}
