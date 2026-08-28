import {
  isRuntimeClientInteraction,
  type RuntimeClientInteraction,
  type RuntimeInteractionQueueProjection,
  type RuntimeInteractionResponse,
  sameRuntimeClientInteractionIdentity,
} from '@kite-ai/runtime-contract';
import type { RuntimeUserAction } from '#kite-service/bootstrap/runtime/state-actions';
import type { RuntimeEffect, RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';
import { projectRuntimeClientCommand, projectRuntimeClientText } from './safe-text';

export type RuntimeInteractionEffect = Extract<RuntimeEffect, { type: `request_${string}` }>;

export interface RuntimeInteractionProjectionContext {
  /** Host/Server projection revision used by the settlement command fence. */
  readonly sessionRevision?: number;
  /** Current in-memory focus, revalidated against durable State before projection. */
  readonly focusedInteraction?: RuntimeClientInteraction;
}

/**
 * App-owned interaction projection. It narrows State/effect facts into the
 * closed Contract union and deliberately omits commands, paths, args, grant
 * subjects, bindings, provider bodies, and all other private evidence.
 */
export function projectRuntimeClientInteraction(
  state: Readonly<RuntimeState>,
  effect: Extract<RuntimeInteractionEffect, { type: 'request_tool_approval' }>,
  context?: RuntimeInteractionProjectionContext,
): Extract<RuntimeClientInteraction, { kind: 'approval' }> | null;
export function projectRuntimeClientInteraction(
  state: Readonly<RuntimeState>,
  effect: Extract<RuntimeInteractionEffect, { type: 'request_user_input' }>,
  context?: RuntimeInteractionProjectionContext,
): Extract<RuntimeClientInteraction, { kind: 'input' }> | null;
export function projectRuntimeClientInteraction(
  state: Readonly<RuntimeState>,
  effect: Extract<RuntimeInteractionEffect, { type: 'request_plan_review' }>,
  context?: RuntimeInteractionProjectionContext,
): Extract<RuntimeClientInteraction, { kind: 'plan_review' }> | null;
export function projectRuntimeClientInteraction(
  state: Readonly<RuntimeState>,
  effect: Extract<
    RuntimeInteractionEffect,
    { type: 'request_provider_action' | 'request_provider_admission' }
  >,
  context?: RuntimeInteractionProjectionContext,
): Extract<RuntimeClientInteraction, { kind: 'provider_action' }> | null;
export function projectRuntimeClientInteraction(
  state: Readonly<RuntimeState>,
  effect: Extract<RuntimeInteractionEffect, { type: 'request_verification_decision' }>,
  context?: RuntimeInteractionProjectionContext,
): Extract<RuntimeClientInteraction, { kind: 'verification' }> | null;
export function projectRuntimeClientInteraction(
  state: Readonly<RuntimeState>,
  effect: RuntimeInteractionEffect,
  context?: RuntimeInteractionProjectionContext,
): RuntimeClientInteraction | null;
export function projectRuntimeClientInteraction(
  state: Readonly<RuntimeState>,
  effect: RuntimeInteractionEffect,
  context: RuntimeInteractionProjectionContext = {},
): RuntimeClientInteraction | null {
  const revision = context.sessionRevision ?? state.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  switch (effect.type) {
    case 'request_tool_approval': {
      const interaction = state.interactions;
      const pending = state.pendingApprovals.get(effect.interactionId);
      if (
        interaction.kind !== 'awaiting_tool_approval' ||
        interaction.interactionId !== effect.interactionId ||
        interaction.toolCallId !== effect.toolCallId ||
        !pending ||
        pending.interactionId !== effect.interactionId ||
        pending.toolCallId !== effect.toolCallId ||
        pending.generation !== state.approvalGeneration
      ) {
        return null;
      }
      return projectPendingRuntimeApproval(state, pending, revision);
    }
    case 'request_user_input': {
      const interaction = state.interactions;
      if (
        interaction.kind !== 'awaiting_user_input' ||
        interaction.interactionId !== effect.interactionId ||
        interaction.toolCallId !== effect.toolCallId
      ) {
        return null;
      }
      const options = interaction.request.options.map((option) => ({
        id: option.id,
        label: projectRuntimeClientText(option.label, 512),
        ...(option.description === undefined
          ? {}
          : { description: projectRuntimeClientText(option.description, 1_024) }),
      }));
      return validInteraction({
        kind: 'input',
        interactionId: interaction.interactionId,
        sessionRevision: revision,
        question: projectRuntimeClientText(interaction.request.question, 4_000),
        allowFreeText: interaction.request.allow_free_text,
        ...(options.length === 0 ? {} : { options }),
      });
    }
    case 'request_plan_review': {
      const interaction = state.interactions;
      if (
        interaction.kind !== 'awaiting_review' ||
        interaction.interactionId !== effect.interactionId ||
        interaction.toolCallId !== effect.toolCallId
      ) {
        return null;
      }
      return validInteraction({
        kind: 'plan_review',
        interactionId: interaction.interactionId,
        sessionRevision: revision,
        plan: {
          planId: interaction.planId,
          version: interaction.version,
          structuralDigest: interaction.structuralDigest,
        },
        title: projectRuntimeClientText(interaction.plan.name, 256),
        summary: projectRuntimeClientText(interaction.planSummary, 1_024),
      });
    }
    case 'request_provider_action': {
      const interaction = state.interactions;
      if (
        interaction.kind !== 'awaiting_provider_action' ||
        interaction.interactionId !== effect.interactionId ||
        interaction.providerId !== effect.providerId ||
        interaction.action !== effect.action ||
        interaction.originatingToolCallId !== effect.originatingToolCallId
      ) {
        return null;
      }
      const directoryRevision = currentProviderDirectoryRevision(state, interaction.providerId);
      return validInteraction({
        kind: 'provider_action',
        interactionId: interaction.interactionId,
        sessionRevision: revision,
        provider: {
          providerId: interaction.providerId,
          ...(directoryRevision ? { directoryRevision } : {}),
        },
        action: interaction.action,
        title: 'Provider action required',
      });
    }
    case 'request_provider_admission': {
      const interaction = state.interactions;
      const pending = state.providerAdmission.pending.find(
        (entry) => entry.interactionId === effect.interactionId,
      );
      if (
        interaction.kind !== 'awaiting_provider_admission' ||
        interaction.interactionId !== effect.interactionId ||
        interaction.providerId !== effect.providerId ||
        interaction.providerStatus !== effect.providerStatus ||
        interaction.retryable !== effect.retryable ||
        !pending ||
        pending.providerId !== interaction.providerId ||
        pending.providerStatus !== interaction.providerStatus ||
        pending.retryable !== interaction.retryable
      ) {
        return null;
      }
      const directoryRevision = currentProviderDirectoryRevision(state, interaction.providerId);
      if (interaction.retryable && !directoryRevision) return null;
      return validInteraction({
        kind: 'provider_action',
        interactionId: interaction.interactionId,
        sessionRevision: revision,
        provider: {
          providerId: interaction.providerId,
          ...(directoryRevision ? { directoryRevision } : {}),
        },
        action: interaction.retryable ? 'retry' : 'approve',
        title: 'Provider admission required',
      });
    }
    case 'request_verification_decision': {
      const record = state.verification.records[effect.verificationId];
      if (
        !record ||
        record.verificationId !== effect.verificationId ||
        !nonEmpty(record.requestedAt)
      ) {
        return null;
      }
      return validInteraction({
        kind: 'verification',
        interactionId: effect.interactionId,
        sessionRevision: revision,
        verification: { verificationId: record.verificationId, revision: record.requestedAt },
        title: 'Verification decision required',
      });
    }
    default:
      return null;
  }
}

/** Project the complete ordered set used to replace Client/TUI interaction state after a gap. */
export function projectRuntimeClientInteractionQueue(
  state: Readonly<RuntimeState>,
  context: RuntimeInteractionProjectionContext = {},
): RuntimeInteractionQueueProjection {
  const revision = context.sessionRevision ?? state.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return Object.freeze({ revision: 0, interactions: Object.freeze([]) });
  }
  const approvals = [...state.pendingApprovals.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map((pending) => projectPendingRuntimeApproval(state, pending, revision))
    .filter((interaction): interaction is Extract<RuntimeClientInteraction, { kind: 'approval' }> =>
      Boolean(interaction),
    );
  const focused = projectFocusedRuntimeInteraction(state, revision, context.focusedInteraction);
  const focusedIsQueuedApproval =
    focused?.kind === 'approval' &&
    approvals.some((entry) => entry.interactionId === focused.interactionId);
  const interactions = focused && !focusedIsQueuedApproval ? [focused, ...approvals] : approvals;
  const activeInteractionId =
    focused?.interactionId ??
    (state.activeApprovalId &&
    approvals.some((entry) => entry.interactionId === state.activeApprovalId)
      ? state.activeApprovalId
      : undefined);
  return Object.freeze({
    revision,
    ...(activeInteractionId === undefined ? {} : { activeInteractionId }),
    interactions: Object.freeze(interactions),
  });
}

function projectPendingRuntimeApproval(
  state: Readonly<RuntimeState>,
  pending: Readonly<RuntimeState['pendingApprovals']> extends ReadonlyMap<string, infer Entry>
    ? Entry
    : never,
  revision: number,
): Extract<RuntimeClientInteraction, { kind: 'approval' }> | null {
  if (
    pending.route !== 'user' ||
    pending.generation !== state.approvalGeneration ||
    !['queued_user', 'awaiting_user', 'approving'].includes(pending.status)
  ) {
    return null;
  }
  const grants = pending.approval.grantOptions.filter(
    (grant): grant is 'approve_once' | 'same_command' =>
      grant === 'approve_once' || grant === 'same_command',
  );
  if (grants.length === 0 || new Set(grants).size !== grants.length) return null;
  const projected = validInteraction({
    kind: 'approval',
    interactionId: pending.interactionId,
    sessionRevision: revision,
    generation: pending.generation,
    grants,
    command: projectRuntimeClientCommand(pending.approval.command),
    title: projectRuntimeClientText(pending.approval.tool, 256),
    summary: projectRuntimeClientText(pending.approval.summary, 1_024),
  });
  return projected?.kind === 'approval' ? projected : null;
}

function projectFocusedRuntimeInteraction(
  state: Readonly<RuntimeState>,
  revision: number,
  hint?: RuntimeClientInteraction,
): RuntimeClientInteraction | null {
  if (hint) {
    const effect = resolveRuntimeInteractionEffect(state, hint);
    if (effect)
      return projectRuntimeClientInteraction(state, effect, { sessionRevision: revision });
  }
  const interaction = state.interactions;
  switch (interaction.kind) {
    case 'awaiting_tool_approval':
      return projectRuntimeClientInteraction(
        state,
        {
          type: 'request_tool_approval',
          interactionId: interaction.interactionId,
          toolCallId: interaction.toolCallId,
        },
        { sessionRevision: revision },
      );
    case 'awaiting_user_input':
      return projectRuntimeClientInteraction(
        state,
        {
          type: 'request_user_input',
          interactionId: interaction.interactionId,
          toolCallId: interaction.toolCallId,
        },
        { sessionRevision: revision },
      );
    case 'awaiting_review':
      return projectRuntimeClientInteraction(
        state,
        {
          type: 'request_plan_review',
          interactionId: interaction.interactionId,
          toolCallId: interaction.toolCallId,
        },
        { sessionRevision: revision },
      );
    case 'awaiting_provider_action':
      return projectRuntimeClientInteraction(
        state,
        {
          type: 'request_provider_action',
          interactionId: interaction.interactionId,
          providerId: interaction.providerId,
          action: interaction.action,
          originatingToolCallId: interaction.originatingToolCallId,
        },
        { sessionRevision: revision },
      );
    case 'awaiting_provider_admission':
      return projectRuntimeClientInteraction(
        state,
        {
          type: 'request_provider_admission',
          interactionId: interaction.interactionId,
          providerId: interaction.providerId,
          providerStatus: interaction.providerStatus,
          retryable: interaction.retryable,
        },
        { sessionRevision: revision },
      );
    case 'idle':
    case 'awaiting_auto_review':
      return null;
  }
}

/** Resolve the exact pending State effect for a Client-provided interaction identity. */
export function resolveRuntimeInteractionEffect(
  state: Readonly<RuntimeState>,
  interaction: RuntimeClientInteraction,
): RuntimeInteractionEffect | null {
  let effect: RuntimeInteractionEffect | null = null;
  switch (interaction.kind) {
    case 'approval':
      if (
        state.interactions.kind === 'awaiting_tool_approval' &&
        state.interactions.interactionId === interaction.interactionId
      ) {
        effect = {
          type: 'request_tool_approval',
          interactionId: interaction.interactionId,
          toolCallId: state.interactions.toolCallId,
        };
      }
      break;
    case 'input':
      if (
        state.interactions.kind === 'awaiting_user_input' &&
        state.interactions.interactionId === interaction.interactionId
      ) {
        effect = {
          type: 'request_user_input',
          interactionId: interaction.interactionId,
          toolCallId: state.interactions.toolCallId,
        };
      }
      break;
    case 'plan_review':
      if (
        state.interactions.kind === 'awaiting_review' &&
        state.interactions.interactionId === interaction.interactionId
      ) {
        effect = {
          type: 'request_plan_review',
          interactionId: interaction.interactionId,
          toolCallId: state.interactions.toolCallId,
        };
      }
      break;
    case 'provider_action':
      if (
        state.interactions.kind === 'awaiting_provider_action' &&
        state.interactions.interactionId === interaction.interactionId
      ) {
        effect = {
          type: 'request_provider_action',
          interactionId: interaction.interactionId,
          providerId: state.interactions.providerId,
          action: state.interactions.action,
          originatingToolCallId: state.interactions.originatingToolCallId,
        };
      } else if (
        state.interactions.kind === 'awaiting_provider_admission' &&
        state.interactions.interactionId === interaction.interactionId
      ) {
        effect = {
          type: 'request_provider_admission',
          interactionId: interaction.interactionId,
          providerId: state.interactions.providerId,
          providerStatus: state.interactions.providerStatus,
          retryable: state.interactions.retryable,
        };
      }
      break;
    case 'verification':
      if (state.verification.records[interaction.verification.verificationId]) {
        effect = {
          type: 'request_verification_decision',
          interactionId: interaction.interactionId,
          verificationId: interaction.verification.verificationId,
        };
      }
      break;
  }
  if (!effect) return null;
  const projected = projectRuntimeClientInteraction(state, effect, {
    sessionRevision: interaction.sessionRevision,
  });
  return projected && sameIdentity(projected, interaction) ? effect : null;
}

/** Project the one current interaction from a UI-safe kind/id hint. */
export function projectCurrentRuntimeClientInteraction(
  state: Readonly<RuntimeState>,
  hint: Pick<RuntimeClientInteraction, 'kind' | 'interactionId'>,
  context: RuntimeInteractionProjectionContext = {},
): RuntimeClientInteraction | null {
  let effect: RuntimeInteractionEffect | null = null;
  switch (hint.kind) {
    case 'approval':
      if (
        state.interactions.kind === 'awaiting_tool_approval' &&
        state.interactions.interactionId === hint.interactionId
      ) {
        effect = {
          type: 'request_tool_approval',
          interactionId: hint.interactionId,
          toolCallId: state.interactions.toolCallId,
        };
      }
      break;
    case 'input':
      if (
        state.interactions.kind === 'awaiting_user_input' &&
        state.interactions.interactionId === hint.interactionId
      ) {
        effect = {
          type: 'request_user_input',
          interactionId: hint.interactionId,
          toolCallId: state.interactions.toolCallId,
        };
      }
      break;
    case 'plan_review':
      if (
        state.interactions.kind === 'awaiting_review' &&
        state.interactions.interactionId === hint.interactionId
      ) {
        effect = {
          type: 'request_plan_review',
          interactionId: hint.interactionId,
          toolCallId: state.interactions.toolCallId,
        };
      }
      break;
    case 'provider_action':
      if (
        state.interactions.kind === 'awaiting_provider_action' &&
        state.interactions.interactionId === hint.interactionId
      ) {
        effect = {
          type: 'request_provider_action',
          interactionId: hint.interactionId,
          providerId: state.interactions.providerId,
          action: state.interactions.action,
          originatingToolCallId: state.interactions.originatingToolCallId,
        };
      } else if (
        state.interactions.kind === 'awaiting_provider_admission' &&
        state.interactions.interactionId === hint.interactionId
      ) {
        effect = {
          type: 'request_provider_admission',
          interactionId: hint.interactionId,
          providerId: state.interactions.providerId,
          providerStatus: state.interactions.providerStatus,
          retryable: state.interactions.retryable,
        };
      }
      break;
    case 'verification': {
      const record = Object.values(state.verification.records).find(
        (candidate) => candidate.verificationId === hint.interactionId,
      );
      if (record) {
        effect = {
          type: 'request_verification_decision',
          interactionId: hint.interactionId,
          verificationId: record.verificationId,
        };
      }
      break;
    }
  }
  return effect ? projectRuntimeClientInteraction(state, effect, context) : null;
}

/**
 * Maps one already-validated Contract response back to the exact State action.
 * Re-projecting and comparing identity prevents stale sessions, generations,
 * plan digests, provider revisions, and verification records from settling.
 */
export function mapRuntimeInteractionResponseToUserAction(input: {
  readonly state: Readonly<RuntimeState>;
  readonly effect: RuntimeInteractionEffect;
  readonly interaction: RuntimeClientInteraction;
  readonly response: RuntimeInteractionResponse;
  /** Current Host command CAS revision; interaction identity is re-projected at this revision. */
  readonly expectedStateRevision?: number;
}): RuntimeUserAction | null {
  const expectedStateRevision = input.expectedStateRevision ?? input.interaction.sessionRevision;
  if (input.state.revision !== expectedStateRevision) return null;
  const expected = projectRuntimeClientInteraction(input.state, input.effect, {
    sessionRevision: input.interaction.sessionRevision,
  });
  if (!expected || !sameIdentity(expected, input.interaction)) return null;
  switch (expected.kind) {
    case 'approval':
      if (input.response.kind !== 'approval') return null;
      if (input.response.decision === 'reject') {
        return {
          type: 'reject',
          interactionId: expected.interactionId,
          generation: expected.generation,
        };
      }
      if (!expected.grants.includes(input.response.decision)) return null;
      return {
        type: 'approve',
        interactionId: expected.interactionId,
        generation: expected.generation,
        grant: input.response.decision,
      };
    case 'input':
      return input.response.kind === 'text'
        ? { type: 'input', interactionId: expected.interactionId, text: input.response.value }
        : input.response.kind === 'input_cancel'
          ? { type: 'cancel', interactionId: expected.interactionId }
          : null;
    case 'plan_review':
      if (input.response.kind !== 'plan_review') return null;
      if (input.response.decision === 'auto' || input.response.decision === 'accept_edits') {
        return {
          type: 'plan_review_decision',
          interactionId: expected.interactionId,
          planId: expected.plan.planId,
          version: expected.plan.version,
          structuralDigest: expected.plan.structuralDigest,
          decision: { kind: 'approve', nextMode: input.response.decision },
        };
      }
      if (input.response.decision === 'feedback') {
        return input.response.feedback && nonEmpty(input.response.feedback)
          ? {
              type: 'plan_review_decision',
              interactionId: expected.interactionId,
              planId: expected.plan.planId,
              version: expected.plan.version,
              structuralDigest: expected.plan.structuralDigest,
              decision: { kind: 'revise', feedback: input.response.feedback },
            }
          : null;
      }
      return {
        type: 'plan_review_decision',
        interactionId: expected.interactionId,
        planId: expected.plan.planId,
        version: expected.plan.version,
        structuralDigest: expected.plan.structuralDigest,
        decision: { kind: 'cancel' },
      };
    case 'provider_action':
      return mapProviderResponse(input.effect, expected, input.response);
    case 'verification':
      if (input.response.kind !== 'verification') return null;
      if (input.response.decision === 'compensate') {
        return {
          type: 'request_verification_compensation',
          verificationId: expected.verification.verificationId,
        };
      }
      return input.response.decision === 'waive'
        ? {
            type: 'waive_verification',
            verificationId: expected.verification.verificationId,
            reason: input.response.detail,
          }
        : {
            type: 'replan_verification',
            verificationId: expected.verification.verificationId,
            instruction: input.response.detail,
          };
  }
}

function mapProviderResponse(
  effect: RuntimeInteractionEffect,
  interaction: Extract<RuntimeClientInteraction, { kind: 'provider_action' }>,
  response: RuntimeInteractionResponse,
): RuntimeUserAction | null {
  if (response.kind !== 'provider_action') return null;
  if (effect.type === 'request_provider_action') {
    if (response.outcome === 'cancelled')
      return { type: 'cancel', interactionId: interaction.interactionId };
    return {
      type: 'provider_action_result',
      interactionId: interaction.interactionId,
      outcome: response.outcome,
      providerDirectoryRevision: interaction.provider.directoryRevision,
    };
  }
  if (effect.type !== 'request_provider_admission') return null;
  if (response.outcome === 'cancelled')
    return { type: 'cancel', interactionId: interaction.interactionId };
  if (response.outcome === 'deferred') {
    return {
      type: 'provider_admission_decision',
      interactionId: interaction.interactionId,
      decision: { kind: 'waive' },
    };
  }
  if (interaction.action !== 'retry' || !interaction.provider.directoryRevision) return null;
  return {
    type: 'provider_admission_decision',
    interactionId: interaction.interactionId,
    decision: {
      kind: 'retry',
      outcome: 'ready',
      providerDirectoryRevision: interaction.provider.directoryRevision,
    },
  };
}

function currentProviderDirectoryRevision(
  state: Readonly<RuntimeState>,
  providerId: string,
): string | null {
  const revisions = new Set(
    Object.values(state.providerReadiness)
      .filter(
        (entry) => entry.providerId === providerId && nonEmpty(entry.providerDirectoryRevision),
      )
      .map((entry) => entry.providerDirectoryRevision!),
  );
  return revisions.size === 1 ? [...revisions][0]! : null;
}

function validInteraction(value: RuntimeClientInteraction): RuntimeClientInteraction | null {
  return isRuntimeClientInteraction(value) ? value : null;
}

function sameIdentity(left: RuntimeClientInteraction, right: RuntimeClientInteraction): boolean {
  return (
    left.sessionRevision === right.sessionRevision &&
    sameRuntimeClientInteractionIdentity(left, right)
  );
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
