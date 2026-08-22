import type {
  SandboxPreparationIntentRecordV1,
  SandboxPreparationReadyRecordV1,
} from '@kite/runtime-contract';
import { digestCapabilityValueV1 } from '../skills/capability-domain';

export function sandboxPreparationIntentDigestV1(
  input: Omit<SandboxPreparationIntentRecordV1, 'intentDigest' | 'recordedAt'>,
): string {
  return digestCapabilityValueV1(input);
}

export function sandboxPreparationReadyDigestV1(
  input: Omit<SandboxPreparationReadyRecordV1, 'readyDigest' | 'readyAt'>,
): string {
  return digestCapabilityValueV1(input);
}

export function sandboxDisposalLifecycleIntentDigestV1(input: {
  readonly invocationId: string;
  readonly attempt: number;
  readonly readyDigest: string;
  readonly planDigest: string;
  readonly cleanupDigest: string;
}): string {
  return digestCapabilityValueV1({ kind: 'sandbox_disposal_lifecycle_intent_v1', ...input });
}

export function sandboxAbandonmentLifecycleIntentDigestV1(input: {
  readonly invocationId: string;
  readonly attempt: number;
  readonly intentDigest: string;
  readonly preparationDigest: string;
}): string {
  return digestCapabilityValueV1({ kind: 'sandbox_abandonment_lifecycle_intent_v1', ...input });
}

export function validateSandboxPreparationIntentRecordV1(
  value: SandboxPreparationIntentRecordV1,
): void {
  if (
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    !value.toolCallId ||
    !value.capabilityId ||
    !value.capabilityRevision ||
    !value.canonicalWorkspace ||
    !value.effectiveEffectsDigest ||
    !value.admissionDigest ||
    !value.preparationDigest ||
    !value.commandDigest ||
    !value.executionBoundaryDigest ||
    value.resourceSemantics !== 'allocating' ||
    value.intentDigest !==
      sandboxPreparationIntentDigestV1({
        attempt: value.attempt,
        toolCallId: value.toolCallId,
        capabilityId: value.capabilityId,
        capabilityRevision: value.capabilityRevision,
        canonicalWorkspace: value.canonicalWorkspace,
        effectiveEffectsDigest: value.effectiveEffectsDigest,
        admissionDigest: value.admissionDigest,
        preparationDigest: value.preparationDigest,
        commandDigest: value.commandDigest,
        executionBoundaryDigest: value.executionBoundaryDigest,
        resourceSemantics: value.resourceSemantics,
      }) ||
    !Number.isFinite(Date.parse(value.recordedAt))
  ) {
    throw new Error('Sandbox preparation intent is invalid.');
  }
}

export function validateSandboxPreparationReadyRecordV1(
  value: SandboxPreparationReadyRecordV1,
): void {
  const artifact = value?.preparationArtifact;
  if (
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    !value.intentDigest ||
    !value.preparationDigest ||
    !value.commandDigest ||
    !value.planDigest ||
    !value.cleanupDigest ||
    !value.backendCapabilitiesDigest ||
    !['seatbelt', 'bubblewrap', 'windows_restricted_token', 'none'].includes(value.backend) ||
    !['full', 'partial'].includes(value.enforcement) ||
    !['pure', 'allocating'].includes(value.resourceSemantics) ||
    !artifact ||
    artifact.kind !== 'sandbox_preparation' ||
    typeof artifact.artifactId !== 'string' ||
    artifact.artifactId.length === 0 ||
    typeof artifact.integrityIdentifier !== 'string' ||
    artifact.integrityIdentifier.length === 0 ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 1 ||
    value.readyDigest !==
      sandboxPreparationReadyDigestV1({
        attempt: value.attempt,
        intentDigest: value.intentDigest,
        preparationDigest: value.preparationDigest,
        commandDigest: value.commandDigest,
        planDigest: value.planDigest,
        backend: value.backend,
        backendCapabilitiesDigest: value.backendCapabilitiesDigest,
        enforcement: value.enforcement,
        resourceSemantics: value.resourceSemantics,
        cleanupDigest: value.cleanupDigest,
        preparationArtifact: value.preparationArtifact,
      }) ||
    !Number.isFinite(Date.parse(value.readyAt))
  ) {
    throw new Error('Sandbox preparation ready record is invalid.');
  }
}
