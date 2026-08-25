import type {
  SandboxPreparationIntentRecord,
  SandboxPreparationReadyRecord,
} from '@kite-ai/runtime-contract';
import { digestCapabilityValue } from '../skills/capability-domain';

export function sandboxPreparationIntentDigest(
  input: Omit<SandboxPreparationIntentRecord, 'intentDigest' | 'recordedAt'>,
): string {
  return digestCapabilityValue(input);
}

export function sandboxPreparationReadyDigest(
  input: Omit<SandboxPreparationReadyRecord, 'readyDigest' | 'readyAt'>,
): string {
  return digestCapabilityValue(input);
}

export function sandboxDisposalLifecycleIntentDigest(input: {
  readonly invocationId: string;
  readonly attempt: number;
  readonly readyDigest: string;
  readonly planDigest: string;
  readonly cleanupDigest: string;
}): string {
  return digestCapabilityValue({ kind: 'sandbox_disposal_lifecycle_intent_v1', ...input });
}

export function sandboxAbandonmentLifecycleIntentDigest(input: {
  readonly invocationId: string;
  readonly attempt: number;
  readonly intentDigest: string;
  readonly preparationDigest: string;
}): string {
  return digestCapabilityValue({ kind: 'sandbox_abandonment_lifecycle_intent_v1', ...input });
}

export function validateSandboxPreparationIntentRecord(
  value: SandboxPreparationIntentRecord,
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
      sandboxPreparationIntentDigest({
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

export function validateSandboxPreparationReadyRecord(value: SandboxPreparationReadyRecord): void {
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
      sandboxPreparationReadyDigest({
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
