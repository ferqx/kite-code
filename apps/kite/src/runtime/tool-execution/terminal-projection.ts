import type { McpProviderRecoveryAction } from '@kite-ai/builtin-runtime/mcp';
import type { SubAgentEventSink } from '@kite-ai/runtime-contract';
import { createRuntimeHostInteractionId } from '@kite-ai/runtime-host';
import type { ClassifiedFailure } from '#app/bootstrap/runtime/failures';
import type { RuntimeEvent } from '#app/bootstrap/runtime/state-runtime';

export function recoveryActionForFailure(
  failure: ClassifiedFailure,
): McpProviderRecoveryAction | undefined {
  if (failure.kind === 'provider_auth_required') return 'login';
  if (failure.kind === 'provider_approval_required') return 'approve';
  if (failure.kind === 'provider_unavailable' && failure.retryable) return 'retry';
  return undefined;
}

export function providerActionRequiredEvent(input: {
  enabled: boolean;
  providerId: string;
  toolCallId: string;
  action?: McpProviderRecoveryAction;
}): RuntimeEvent | undefined {
  if (!input.enabled || !input.action) return undefined;
  return {
    type: 'provider.action_required',
    interactionId: createRuntimeHostInteractionId(),
    providerId: input.providerId,
    action: input.action,
    originatingToolCallId: input.toolCallId,
  };
}

/** Convert the subagent callback payload into the durable public event union. */
export function toRuntimeSubagentEvent(
  event: Parameters<SubAgentEventSink>[0],
  concurrencyGroupId?: string,
): RuntimeEvent {
  switch (event.type) {
    case 'start':
      return {
        type: 'subagent.started',
        subagent: concurrencyGroupId == null ? event.data : { ...event.data, concurrencyGroupId },
      };
    case 'step':
      return { type: 'subagent.step', subagent: event.data };
    case 'tool_result':
      return { type: 'subagent.tool_result', subagent: event.data };
    case 'done':
      return { type: 'subagent.completed', subagent: event.data };
    case 'error':
      return { type: 'subagent.failed', subagent: event.data };
    case 'cache_metrics':
      return { type: 'subagent.cache_metrics', subagent: event.data };
  }
}
