import type { StateRuntimeState } from '@kite-ai/runtime-host';
import type {
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineReceiptCommit,
  ToolPipelineRetryableCommit,
  ToolPipelineSuspensionCommit,
  ToolPipelineUnknownOutcome,
} from '@kite-ai/runtime-spi';
import { AppStateToolPipelinePersistenceError } from './contracts';

export function assertSupportedAcknowledgement(
  input: Readonly<
    | ToolPipelineUnknownOutcome
    | ToolPipelineReceiptCommit
    | ToolPipelineRetryableCommit
    | ToolPipelineSuspensionCommit
  >,
): Readonly<ToolPipelineAttemptAcknowledgement['attempt']> {
  const acknowledgement = input.acknowledgement;
  const attempt = acknowledgement?.attempt;
  if (
    acknowledgement?.acknowledged !== true ||
    !attempt ||
    !nonEmptyString(attempt.invocationId) ||
    !nonEmptyString(attempt.attemptId) ||
    !Number.isSafeInteger(attempt.attempt) ||
    attempt.attempt < 1 ||
    !nonEmptyString(attempt.toolCallId) ||
    !nonEmptyString(attempt.turnId) ||
    !nonEmptyString(attempt.modelMessageId) ||
    !nonEmptyString(attempt.providerId) ||
    !nonEmptyString(attempt.operationId) ||
    !nonEmptyString(attempt.capabilityId) ||
    !nonEmptyString(attempt.capabilityRevision) ||
    !nonEmptyString(attempt.descriptorRevision) ||
    !nonEmptyString(attempt.argumentsDigest) ||
    !nonEmptyString(attempt.schemaDigest) ||
    !nonEmptyString(attempt.effectiveEffectsDigest) ||
    (attempt.argumentOrigin !== 'model_public' && attempt.argumentOrigin !== 'runtime_private') ||
    attempt.authorizationDigest === null ||
    !nonEmptyString(attempt.authorizationDigest) ||
    attempt.attemptId !== `${attempt.invocationId}:attempt:${attempt.attempt}` ||
    attempt.operationId === 'builtin:ask_user' ||
    (attempt.operationId === 'mcp:dynamic_tool'
      ? attempt.dynamicCatalogRevision === null ||
        attempt.builtinProjectionRevision !== null ||
        attempt.executorRevision !== null ||
        attempt.runtimeWrapperProviderId === null ||
        attempt.runtimeWrapperCapabilityRevision === null ||
        attempt.runtimeWrapperExecutorRevision === null ||
        attempt.runtimeWrapperSchemaDigest === null ||
        attempt.runtimeWrapperBuiltinProjectionRevision === null
      : attempt.dynamicCatalogRevision !== null ||
        attempt.builtinProjectionRevision === null ||
        attempt.runtimeWrapperProviderId !== null ||
        attempt.runtimeWrapperCapabilityRevision !== null ||
        attempt.runtimeWrapperExecutorRevision !== null ||
        attempt.runtimeWrapperSchemaDigest !== null ||
        attempt.runtimeWrapperBuiltinProjectionRevision !== null)
  ) {
    throw new AppStateToolPipelinePersistenceError('acknowledgement_mismatch');
  }
  return attempt;
}

export function assertOpenAcknowledgement(
  issuedAcknowledgements: WeakSet<object>,
  settledAcknowledgements: WeakSet<object>,
  acknowledgement: Readonly<ToolPipelineAttemptAcknowledgement>,
): void {
  if (
    !issuedAcknowledgements.has(acknowledgement) ||
    settledAcknowledgements.has(acknowledgement)
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State persistence rejected an acknowledgement not issued by this owner.',
    );
  }
}

export function assertAcknowledgementState(
  state: Readonly<StateRuntimeState>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): Readonly<StateRuntimeState['capabilities']['invocations'][string]> {
  const invocation = state.capabilities.invocations[identity.invocationId];
  if (
    invocation?.status !== 'running' ||
    invocation.toolCallId !== identity.toolCallId ||
    invocation.capabilityId !== identity.capabilityId ||
    invocation.capabilityRevision !== identity.capabilityRevision ||
    invocation.argumentsDigest !== identity.argumentsDigest ||
    invocation.authorizationDigest !== identity.authorizationDigest ||
    invocation.admissionDigest !== (identity.admissionDigest ?? undefined) ||
    invocation.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    invocation.attemptsStarted !== identity.attempt
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'acknowledgement_mismatch',
      'State acknowledgement is not the current running invocation.',
    );
  }
  return invocation;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
