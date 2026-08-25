import type { StateRuntimeEvent, StateRuntimeState } from '@kite-ai/runtime-host';
import type { PreparedToolInvocationIdentity } from '@kite-ai/runtime-spi';
import type { AppToolPipelinePreparedRequest } from '#app/bootstrap/runtime/tool-pipeline-prepared';
import { AppStateToolPipelinePersistenceError } from './contracts';
import { includesAcknowledgedRevision } from './recovery-committer';

export function invocationRecordedEvent(
  identity: Readonly<PreparedToolInvocationIdentity>,
  request: Readonly<AppToolPipelinePreparedRequest>,
  recordedAt: string,
): Extract<StateRuntimeEvent, { type: 'capability.invocation_recorded' }> {
  return {
    type: 'capability.invocation_recorded',
    invocationId: identity.invocationId,
    toolCallId: identity.toolCallId,
    capabilityId: identity.capabilityId,
    capabilityRevision: identity.capabilityRevision,
    ...(request.taskId === null ? {} : { taskId: request.taskId }),
    ...(request.planId === null ? {} : { planId: request.planId }),
    ...(request.planStepId === null ? {} : { planStepId: request.planStepId }),
    argumentsDigest: identity.argumentsDigest,
    authorizationDigest: identity.authorizationDigest!,
    ...(identity.admissionDigest === null ? {} : { admissionDigest: identity.admissionDigest }),
    effectiveEffectsDigest: identity.effectiveEffectsDigest,
    effectiveEffects: request.effectiveEffects,
    receiptRequirement: request.receiptRequirement,
    retryEligibility: request.retryEligibility,
    recordedAt,
    ...(identity.idempotencyKey === null ? {} : { idempotencyKey: identity.idempotencyKey }),
  };
}

export function assertRecordedState(
  after: Readonly<StateRuntimeState>,
  before: Readonly<StateRuntimeState>,
  eventCount: number,
  identity: Readonly<PreparedToolInvocationIdentity>,
  request: Readonly<AppToolPipelinePreparedRequest>,
  attempt: number,
  recordedAt: string,
  startedAt: string,
): void {
  const invocation = after.capabilities.invocations[identity.invocationId];
  if (
    !includesAcknowledgedRevision(after, before, eventCount) ||
    invocation?.status !== 'running' ||
    invocation.toolCallId !== identity.toolCallId ||
    invocation.capabilityRevision !== identity.capabilityRevision ||
    invocation.argumentsDigest !== identity.argumentsDigest ||
    invocation.authorizationDigest !== identity.authorizationDigest ||
    invocation.admissionDigest !== (identity.admissionDigest ?? undefined) ||
    invocation.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    invocation.attemptsStarted !== attempt ||
    invocation.recordedAt !== recordedAt ||
    invocation.startedAt !== startedAt ||
    invocation.idempotencyKey !== (identity.idempotencyKey ?? undefined) ||
    request.receiptRequirement !== invocation.receiptRequirement ||
    request.retryEligibility !== invocation.retryEligibility ||
    after.tools.calls[identity.toolCallId]?.status !== 'running'
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State attempt acknowledgement does not match the committed invocation.',
    );
  }
}
