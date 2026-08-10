import type { RuntimeEffect } from './effects';
import { getActivePlanning, type RuntimeState } from './state';

export const LEGACY_PLAN_REPLAN_REQUIRED = 'legacy_plan_replan_required';

const LEGACY_PLAN_ALLOWED_TOOLS = new Set(['read_plan', 'write_plan']);

export function requiresLegacyPlanReplan(state: RuntimeState): boolean {
  const planning = getActivePlanning(state);
  return planning.kind === 'executing' && planning.document.planSchemaVersion !== 2;
}

export function isLegacyPlanContinuationToolAllowed(toolName: string): boolean {
  return LEGACY_PLAN_ALLOWED_TOOLS.has(toolName);
}

export function legacyPlanContinuationBlockedEffect(): RuntimeEffect {
  return {
    type: 'recovery_blocked',
    reason: LEGACY_PLAN_REPLAN_REQUIRED,
    failureKind: 'unknown',
  };
}

function isCanonicalPreparedEffect(
  canonicalEffect: RuntimeEffect,
  preparedEffect: RuntimeEffect,
): boolean {
  switch (canonicalEffect.type) {
    case 'call_model':
      return (
        preparedEffect.type === 'call_model' &&
        preparedEffect.toolSurface === canonicalEffect.toolSurface
      );
    case 'run_tools':
      return (
        preparedEffect.type === 'run_tools' &&
        preparedEffect.toolCallIds.length === canonicalEffect.toolCallIds.length &&
        preparedEffect.toolCallIds.every(
          (toolCallId, index) => toolCallId === canonicalEffect.toolCallIds[index],
        )
      );
    case 'compact_context':
      return (
        preparedEffect.type === 'compact_context' &&
        preparedEffect.compactionId === canonicalEffect.compactionId
      );
    case 'completion_blocked':
      return (
        preparedEffect.type === 'completion_blocked' &&
        preparedEffect.decision.version === canonicalEffect.decision.version &&
        preparedEffect.decision.code === canonicalEffect.decision.code &&
        preparedEffect.decision.nextAction === canonicalEffect.decision.nextAction &&
        preparedEffect.decision.planning === canonicalEffect.decision.planning &&
        preparedEffect.decision.correctionAttempt === canonicalEffect.decision.correctionAttempt &&
        preparedEffect.decision.canCorrect === canonicalEffect.decision.canCorrect
      );
    case 'request_user_input':
    case 'request_plan_review':
    case 'request_tool_approval':
      return (
        preparedEffect.type === canonicalEffect.type &&
        preparedEffect.interactionId === canonicalEffect.interactionId &&
        preparedEffect.toolCallId === canonicalEffect.toolCallId
      );
    case 'run_auto_review':
      return (
        preparedEffect.type === 'run_auto_review' &&
        preparedEffect.reviewId === canonicalEffect.reviewId &&
        preparedEffect.toolCallId === canonicalEffect.toolCallId
      );
    case 'request_provider_action':
      return (
        preparedEffect.type === 'request_provider_action' &&
        preparedEffect.interactionId === canonicalEffect.interactionId &&
        preparedEffect.providerId === canonicalEffect.providerId &&
        preparedEffect.action === canonicalEffect.action &&
        preparedEffect.originatingToolCallId === canonicalEffect.originatingToolCallId
      );
    case 'request_provider_admission':
      return (
        preparedEffect.type === 'request_provider_admission' &&
        preparedEffect.interactionId === canonicalEffect.interactionId &&
        preparedEffect.providerId === canonicalEffect.providerId &&
        preparedEffect.providerStatus === canonicalEffect.providerStatus &&
        preparedEffect.retryable === canonicalEffect.retryable
      );
    case 'subagent.recovery_unavailable':
      return (
        preparedEffect.type === 'subagent.recovery_unavailable' &&
        preparedEffect.toolCallId === canonicalEffect.toolCallId &&
        preparedEffect.subagentId === canonicalEffect.subagentId &&
        preparedEffect.reason === canonicalEffect.reason
      );
    case 'recovery_blocked':
      return (
        preparedEffect.type === 'recovery_blocked' &&
        preparedEffect.reason === canonicalEffect.reason &&
        preparedEffect.failureKind === canonicalEffect.failureKind
      );
    case 'busy':
      return preparedEffect.type === 'busy' && preparedEffect.reason === canonicalEffect.reason;
    case 'stop':
      return preparedEffect.type === 'stop';
    default:
      return false;
  }
}

/** Re-check prepared effects against a fresh scheduler decision from current state. */
export function guardLegacyPlanContinuationEffect(
  state: RuntimeState,
  preparedEffect: RuntimeEffect,
  canonicalEffect: RuntimeEffect,
): RuntimeEffect {
  if (!requiresLegacyPlanReplan(state)) return preparedEffect;
  if (isCanonicalPreparedEffect(canonicalEffect, preparedEffect)) return preparedEffect;
  return legacyPlanContinuationBlockedEffect();
}
