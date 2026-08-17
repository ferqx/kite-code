import { digestCapability } from '@/core/capabilities/catalog';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import type {
  WorkspaceFilesystemIntentRecordV1,
  WorkspaceFilesystemMutationReadyRecordV1,
  WorkspaceFilesystemObservationRecordV1,
} from '@/protocol/capabilities';
import type { RecordedInvocationV1 } from './types';

type WorkspaceFilesystemObservationEffectV1 = 'read' | 'write';

interface WorkspaceFilesystemObservationAuthorityBindingV1 {
  readonly invocationId: string;
  readonly attempt: number;
  readonly intentDigest: string;
  readonly operationDigest: string;
  readonly capabilityId: 'builtin:read_file' | 'builtin:write_file' | 'builtin:edit_file';
  readonly capabilityRevision: string;
  readonly admissionDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly effect: WorkspaceFilesystemObservationEffectV1;
  readonly mutationReadyDigest: string | null;
  readonly actorIdentityDigest: string;
  readonly lexicalTargetDigest: string;
  readonly canonicalTargetDigest: string;
  readonly targetIdentityDigest: string;
  readonly contentDigest: string;
}

interface IssuedWorkspaceFilesystemObservationAuthorityV1 {
  readonly binding: Readonly<WorkspaceFilesystemObservationAuthorityBindingV1>;
  result: ToolExecutionResult | null;
}

const issuedObservations = new WeakMap<
  WorkspaceFilesystemObservationRecordV1,
  IssuedWorkspaceFilesystemObservationAuthorityV1
>();

/**
 * Process-local issuer used only by the Workspace filesystem Pipeline after its
 * durable intent/ready barriers and successful Provider operation.
 */
export function issueWorkspaceFilesystemObservationAuthorityV1(input: {
  readonly observation: WorkspaceFilesystemObservationRecordV1;
  readonly recorded: Readonly<RecordedInvocationV1>;
  readonly intent: Readonly<WorkspaceFilesystemIntentRecordV1>;
  readonly mutationReady?: Readonly<WorkspaceFilesystemMutationReadyRecordV1>;
}): WorkspaceFilesystemObservationRecordV1 {
  const identity = filesystemInvocationIdentity(input.recorded);
  const { observation, intent, mutationReady } = input;
  if (
    intent.attempt !== input.recorded.attempt ||
    intent.intentDigest.length === 0 ||
    intent.operationDigest.length === 0 ||
    intent.lexicalTargetDigest !== observation.lexicalTargetDigest
  ) {
    throw new Error('Filesystem observation does not match its durable intent authority.');
  }
  if (identity.effect === 'read') {
    if (mutationReady !== undefined) {
      throw new Error('Read observation authority cannot carry mutation-ready evidence.');
    }
  } else if (
    !mutationReady ||
    mutationReady.attempt !== input.recorded.attempt ||
    mutationReady.intentDigest !== intent.intentDigest ||
    mutationReady.operationDigest !== intent.operationDigest
  ) {
    throw new Error('Mutation observation does not match its durable ready authority.');
  }

  const binding = Object.freeze({
    invocationId: input.recorded.invocationId,
    attempt: input.recorded.attempt,
    intentDigest: intent.intentDigest,
    operationDigest: intent.operationDigest,
    capabilityId: identity.capabilityId,
    capabilityRevision: identity.capabilityRevision,
    admissionDigest: identity.admissionDigest,
    effectiveEffectsDigest: identity.effectiveEffectsDigest,
    effect: identity.effect,
    mutationReadyDigest: mutationReady?.readyDigest ?? null,
    actorIdentityDigest: observation.actorIdentityDigest,
    lexicalTargetDigest: observation.lexicalTargetDigest,
    canonicalTargetDigest: observation.canonicalTargetDigest,
    targetIdentityDigest: observation.targetIdentityDigest,
    contentDigest: observation.contentDigest,
  } satisfies WorkspaceFilesystemObservationAuthorityBindingV1);
  issuedObservations.set(observation, { binding, result: null });
  return observation;
}

/** Bind the issued observation to the exact adapter result entering dispatch. */
export function bindWorkspaceFilesystemObservationResultV1(result: ToolExecutionResult): void {
  const observation = result.filesystemObservation;
  if (!observation) return;
  const issued = issuedObservations.get(observation);
  if (!issued) return;
  if (issued.result && issued.result !== result) {
    throw new Error('Filesystem observation authority was already bound to another Tool result.');
  }
  issued.result = result;
  Object.freeze(result);
}

/** Verify the exact object and recorded invocation bound by the internal issuer. */
export function assertWorkspaceFilesystemObservationAuthorityV1(input: {
  readonly observation: WorkspaceFilesystemObservationRecordV1;
  readonly recorded: Readonly<RecordedInvocationV1>;
  readonly result: ToolExecutionResult;
}): void {
  const issued = issuedObservations.get(input.observation);
  if (!issued) {
    throw new Error(
      'Filesystem observation requires authentic process-local Workspace filesystem authority.',
    );
  }
  if (issued.result !== input.result || !Object.isFrozen(input.result)) {
    throw new Error('Filesystem observation authority does not match the dispatched Tool result.');
  }
  const binding = issued.binding;
  const identity = filesystemInvocationIdentity(input.recorded);
  const observation = input.observation;
  if (
    binding.invocationId !== input.recorded.invocationId ||
    binding.attempt !== input.recorded.attempt ||
    binding.capabilityId !== identity.capabilityId ||
    binding.capabilityRevision !== identity.capabilityRevision ||
    binding.admissionDigest !== identity.admissionDigest ||
    binding.effectiveEffectsDigest !== identity.effectiveEffectsDigest ||
    binding.effect !== identity.effect ||
    binding.actorIdentityDigest !== observation.actorIdentityDigest ||
    binding.lexicalTargetDigest !== observation.lexicalTargetDigest ||
    binding.canonicalTargetDigest !== observation.canonicalTargetDigest ||
    binding.targetIdentityDigest !== observation.targetIdentityDigest ||
    binding.contentDigest !== observation.contentDigest
  ) {
    throw new Error('Filesystem observation authority does not match the recorded invocation.');
  }
}

function filesystemInvocationIdentity(recorded: Readonly<RecordedInvocationV1>): {
  capabilityId: WorkspaceFilesystemObservationAuthorityBindingV1['capabilityId'];
  capabilityRevision: string;
  admissionDigest: string;
  effectiveEffectsDigest: string;
  effect: WorkspaceFilesystemObservationEffectV1;
} {
  const classified = recorded.admitted.authorized.policy.classified;
  const validated = classified.validated;
  const name = validated.request.name;
  const capabilityId = validated.resolved.target.descriptor.capabilityId;
  const effect: WorkspaceFilesystemObservationEffectV1 = name === 'read_file' ? 'read' : 'write';
  if (
    validated.request.source !== 'builtin' ||
    validated.resolved.target.executionFamily !== 'builtin' ||
    (name !== 'read_file' && name !== 'write_file' && name !== 'edit_file') ||
    capabilityId !== `builtin:${name}` ||
    classified.effectiveEffectsDigest !==
      digestCapability({ filesystem: effect, network: 'none', externalState: 'none' })
  ) {
    throw new Error('Filesystem observation requires an exact admitted builtin filesystem family.');
  }
  const filesystemCapabilityId = `builtin:${name}` as
    | 'builtin:read_file'
    | 'builtin:write_file'
    | 'builtin:edit_file';
  return {
    capabilityId: filesystemCapabilityId,
    capabilityRevision: validated.resolved.target.descriptor.revision,
    admissionDigest: recorded.admitted.admissionDigest,
    effectiveEffectsDigest: classified.effectiveEffectsDigest,
    effect,
  };
}
