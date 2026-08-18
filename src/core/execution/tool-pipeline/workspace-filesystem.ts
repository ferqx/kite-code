import { digestCapability } from '@/core/capabilities/catalog';
import {
  type CapabilityArtifactReaderV1,
  readBoundCapabilityArtifactV1,
} from '@/core/persistence/capability-artifacts';
import type { FilesystemPreimageArtifactWriterV1 } from '@/core/persistence/filesystem-preimage-artifacts';
import type { ProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { FilePreimageRecorder } from '@/core/runtime/file-checkpoints';
import type { RuntimeState } from '@/core/runtime/state';
import type {
  WorkspaceFilesystemIntentRecordV1,
  WorkspaceFilesystemMutationReadyRecordV1,
  WorkspaceFilesystemObservationRecordV1,
} from '@/protocol/capabilities';
import type {
  WorkspaceFilesystemCommittedMutationV1,
  WorkspaceFilesystemMutationOperationV1,
  WorkspaceFilesystemObserveObservationV1,
  WorkspaceFilesystemObserveOperationV1,
  WorkspaceFilesystemOperationV1,
  WorkspaceFilesystemPreimageObservationV1,
  WorkspaceFilesystemProtectedBoundaryV1,
  WorkspaceFilesystemProviderFailureV1,
  WorkspaceFilesystemProviderV1,
} from '@/protocol/workspace-filesystem-provider';
import type { WorkspaceFilesystemGrantAuthorityV1 } from '../workspace-filesystem/grant-authority';
import {
  validateWorkspaceFilesystemOperationV1,
  workspaceFilesystemIntentDigestV1,
  workspaceFilesystemMutationReadyDigestV1,
  workspaceFilesystemOperationDigestV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
  workspaceFilesystemStringDigestV1,
} from '../workspace-filesystem/grant-authority';
import type { ToolInvocationPersistenceV1 } from './dispatch';
import { issueWorkspaceFilesystemObservationAuthorityV1 } from './filesystem-observation-authority';
import { filesystemObservationFromCapabilityResultV1 } from './receipt';
import type { RecordedInvocationV1 } from './types';

const DEFAULT_GRANT_TTL_MS = 30_000;

export interface WorkspaceFilesystemRuntimeV1 {
  readonly canonicalWorkspace: string;
  readonly provider: WorkspaceFilesystemProviderV1;
  readonly grants: WorkspaceFilesystemGrantAuthorityV1;
  readonly preimageArtifacts: FilesystemPreimageArtifactWriterV1;
  /** Required for edit admission; absence or corrupt evidence fails closed. */
  readonly capabilityArtifacts?: CapabilityArtifactReaderV1;
  readonly grantTtlMs?: number;
}

export interface WorkspaceFilesystemPipelineContextV1 {
  readonly runtime: WorkspaceFilesystemRuntimeV1;
  readonly recorded: Readonly<RecordedInvocationV1>;
  readonly persistence: ToolInvocationPersistenceV1;
  readonly protectedPathRevision: string;
  readonly protectedPathEvaluator: ProtectedPathEvaluatorV1;
  readonly actorIdentity: string;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly recordFilePreimage?: FilePreimageRecorder;
}

export type WorkspaceFilesystemPipelineObservationV1 =
  | WorkspaceFilesystemObserveObservationV1
  | WorkspaceFilesystemCommittedMutationV1;

export type WorkspaceFilesystemPipelineResultV1 =
  | {
      readonly ok: true;
      readonly observation: WorkspaceFilesystemPipelineObservationV1;
      readonly filesystemObservation?: WorkspaceFilesystemObservationRecordV1;
      readonly preimage?: WorkspaceFilesystemPreimageObservationV1;
    }
  | { readonly ok: false; readonly failure: WorkspaceFilesystemProviderFailureV1 };

export interface WorkspaceFilesystemInvocationDispatcherV1 {
  dispatch(operation: WorkspaceFilesystemOperationV1): Promise<WorkspaceFilesystemPipelineResultV1>;
}

/** A Provider crossed its commit boundary but did not return bounded certainty. */
export class WorkspaceFilesystemCommitUnknownErrorV1 extends Error {
  readonly causeValue: unknown;

  constructor(causeValue: unknown) {
    super('Workspace filesystem Provider did not return commit certainty.');
    this.name = 'WorkspaceFilesystemCommitUnknownErrorV1';
    this.causeValue = causeValue;
  }
}

export function createWorkspaceFilesystemInvocationDispatcherV1(
  context: WorkspaceFilesystemPipelineContextV1,
): WorkspaceFilesystemInvocationDispatcherV1 {
  return Object.freeze({
    dispatch: (operation: WorkspaceFilesystemOperationV1) =>
      dispatchWorkspaceFilesystemOperationV1(operation, context),
  });
}

async function dispatchWorkspaceFilesystemOperationV1(
  operation: WorkspaceFilesystemOperationV1,
  context: WorkspaceFilesystemPipelineContextV1,
): Promise<WorkspaceFilesystemPipelineResultV1> {
  const family = isObserveOperation(operation) ? 'observe' : 'mutation';
  let validated: Readonly<WorkspaceFilesystemOperationV1>;
  try {
    validated = validateWorkspaceFilesystemOperationV1(operation, family);
  } catch {
    return failure('invalid_grant', 'Filesystem operation is structurally invalid.');
  }
  if (!operationMatchesAdmittedInvocation(validated, context)) {
    return failure(
      'invalid_grant',
      'Filesystem operation does not match the recorded admitted builtin capability.',
    );
  }
  const protectedBoundary = currentProtectedBoundary(context);
  if (!protectedBoundary) {
    return failure(
      'invalid_grant',
      'Filesystem protected boundary does not match the current protected-path policy.',
    );
  }
  const intent = await acknowledgeFilesystemIntent(validated, protectedBoundary, context);
  if (!intent) {
    return failure(
      'operation_failed',
      'Filesystem intent acknowledgement failed before Provider grant issuance.',
    );
  }
  if (isObserveOperation(validated)) return observe(validated, intent, protectedBoundary, context);
  return mutate(validated, intent, protectedBoundary, context);
}

async function observe(
  operation: WorkspaceFilesystemObserveOperationV1,
  intent: WorkspaceFilesystemIntentRecordV1,
  protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1,
  context: WorkspaceFilesystemPipelineContextV1,
): Promise<WorkspaceFilesystemPipelineResultV1> {
  const grant = context.runtime.grants.issueObserveGrant({
    binding: grantBinding(context, intent, protectedBoundary),
    operation,
    protectedBoundary,
    ttlMs: context.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS,
  });
  const result = await context.runtime.provider.observe({ grant, signal: context.signal });
  if (!result.ok) return result;
  const filesystemObservation =
    result.observation.kind === 'read_file'
      ? issueWorkspaceFilesystemObservationAuthorityV1({
          observation: observationRecord(
            context,
            result.observation.targetEvidence,
            result.observation.contentDigest,
          ),
          recorded: context.recorded,
          intent,
        })
      : undefined;
  return Object.freeze({
    ok: true,
    observation: result.observation,
    ...(filesystemObservation ? { filesystemObservation } : {}),
  });
}

async function mutate(
  operation: WorkspaceFilesystemMutationOperationV1,
  intent: WorkspaceFilesystemIntentRecordV1,
  protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1,
  context: WorkspaceFilesystemPipelineContextV1,
): Promise<WorkspaceFilesystemPipelineResultV1> {
  const binding = grantBinding(context, intent, protectedBoundary);
  const prepareGrant = context.runtime.grants.issuePrepareGrant({
    binding,
    operation,
    protectedBoundary,
    ttlMs: context.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS,
  });
  const preparedResult = await context.runtime.provider.prepareMutation({
    grant: prepareGrant,
    signal: context.signal,
  });
  if (!preparedResult.ok) return preparedResult;
  const prepared = preparedResult.observation;

  if (operation.kind === 'edit_file') {
    const actorIdentityDigest = actorIdentityDigestV1(context);
    const prior = latestFilesystemObservationInvocation(
      context.persistence.getState(),
      actorIdentityDigest,
      prepared.targetEvidence.lexicalTargetDigest,
    );
    if (!prior) return failure('read_required', 'File must be read before edit_file can commit.');
    const durableObservation = prior.filesystemObservation;
    let artifactObservation: WorkspaceFilesystemObservationRecordV1 | undefined;
    try {
      artifactObservation =
        prior.artifact &&
        prior.resultDigest &&
        prior.evidenceDigest &&
        context.runtime.capabilityArtifacts
          ? filesystemObservationFromCapabilityResultV1(
              readBoundCapabilityArtifactV1(context.runtime.capabilityArtifacts, prior.artifact, {
                invocationId: prior.invocationId,
                resultDigest: prior.resultDigest,
                evidenceDigest: prior.evidenceDigest,
                filesystemObservation: durableObservation,
              }),
            )
          : undefined;
    } catch {
      artifactObservation = undefined;
    }
    if (
      !durableObservation ||
      !artifactObservation ||
      !exactRecord(durableObservation, artifactObservation)
    ) {
      return failure(
        'read_required',
        'Committed read evidence is missing or does not match its Capability Artifact.',
      );
    }
    if (
      durableObservation.canonicalTargetDigest !== prepared.targetEvidence.canonicalTargetDigest ||
      durableObservation.targetIdentityDigest !== prepared.targetEvidence.targetIdentityDigest ||
      durableObservation.contentDigest !== prepared.preimage.contentDigest
    ) {
      return failure('stale_read', 'File changed after the committed read observation.');
    }
  }

  let preimageArtifact: ReturnType<FilesystemPreimageArtifactWriterV1['write']>;
  try {
    preimageArtifact = context.runtime.preimageArtifacts.write({
      invocationId: context.recorded.invocationId,
      operationDigest: prepared.operationDigest,
      targetIdentityDigest: prepared.targetIdentityDigest,
      preimage: prepared.preimage,
    });
  } catch {
    return failure(
      'operation_failed',
      'Filesystem preimage Artifact could not be persisted before commit.',
    );
  }

  // Legacy rewind projection remains best-effort and never authorizes commit.
  try {
    context.recordFilePreimage?.(
      operation.path,
      prepared.preimage.content,
      prepared.preimage.existed,
    );
  } catch {
    // The immutable Artifact and ready acknowledgement are the safety authority.
  }

  const readyAt = (context.now?.() ?? new Date()).toISOString();
  const readyUnsigned = {
    attempt: context.recorded.attempt,
    intentDigest: intent.intentDigest,
    operationDigest: prepared.operationDigest,
    targetIdentityDigest: prepared.targetIdentityDigest,
    preimageDigest: prepared.preimage.contentDigest,
    preimageArtifact,
    readyAt,
  } satisfies Omit<WorkspaceFilesystemMutationReadyRecordV1, 'readyDigest'>;
  const readyRecord = Object.freeze({
    ...readyUnsigned,
    readyDigest: workspaceFilesystemMutationReadyDigestV1(readyUnsigned),
  });
  const readyEvent: RuntimeEvent = {
    type: 'capability.filesystem_mutation_ready',
    invocationId: context.recorded.invocationId,
    ...readyRecord,
  };
  let persisted = false;
  try {
    persisted = await context.persistence.persistEvents([readyEvent]);
  } catch {
    persisted = false;
  }
  const ready =
    context.persistence.getState().capabilities.invocations[context.recorded.invocationId]
      ?.filesystemMutationReady;
  if (!persisted || !exactRecord(ready, readyRecord)) {
    return failure(
      'operation_failed',
      'Filesystem mutation-ready acknowledgement failed before commit.',
    );
  }

  let readyAuthorization: ReturnType<
    WorkspaceFilesystemGrantAuthorityV1['acknowledgeMutationReady']
  >;
  try {
    readyAuthorization = context.runtime.grants.acknowledgeMutationReady({
      binding,
      operation,
      protectedBoundary,
      prepared,
      ready: readyRecord,
    });
  } catch {
    return failure('operation_failed', 'Filesystem mutation-ready authorization was rejected.');
  }
  const commitGrant = context.runtime.grants.issueCommitGrant({
    authorization: readyAuthorization,
    ttlMs: context.runtime.grantTtlMs ?? DEFAULT_GRANT_TTL_MS,
  });
  let committedResult: Awaited<ReturnType<WorkspaceFilesystemProviderV1['commitMutation']>>;
  try {
    committedResult = await context.runtime.provider.commitMutation({
      grant: commitGrant,
      signal: context.signal,
    });
  } catch (error) {
    throw new WorkspaceFilesystemCommitUnknownErrorV1(error);
  }
  if (!committedResult.ok) return committedResult;
  const committed = committedResult.observation;
  try {
    context.recordFilePreimage?.recordPostimage?.(operation.path, committed.content, true);
  } catch {
    // Compatibility projection only; terminal Provider evidence remains authoritative.
  }
  return Object.freeze({
    ok: true,
    observation: committed,
    filesystemObservation: issueWorkspaceFilesystemObservationAuthorityV1({
      observation: observationRecord(
        context,
        committed.targetEvidence,
        committed.afterContentDigest,
      ),
      recorded: context.recorded,
      intent,
      mutationReady: readyRecord,
    }),
    preimage: prepared.preimage,
  });
}

function grantBinding(
  context: WorkspaceFilesystemPipelineContextV1,
  intent: WorkspaceFilesystemIntentRecordV1,
  protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1,
) {
  const classified = context.recorded.admitted.authorized.policy.classified;
  return Object.freeze({
    threadId: context.persistence.getState().session.threadId,
    turnId: classified.validated.resolved.call.createdAtTurnId,
    toolCallId: classified.validated.resolved.call.toolCallId,
    invocationId: context.recorded.invocationId,
    attempt: context.recorded.attempt,
    intentDigest: intent.intentDigest,
    searchBoundaryDigest: intent.searchBoundaryDigest,
    capabilityRevision: classified.validated.resolved.target.descriptor.revision,
    effectDigest: classified.effectiveEffectsDigest,
    canonicalWorkspace: protectedBoundary.canonicalWorkspace,
    protectedPathRevision: context.protectedPathRevision,
    approvalSummary: classified.validated.request.approvalSummary,
  });
}

async function acknowledgeFilesystemIntent(
  operation: Readonly<WorkspaceFilesystemOperationV1>,
  protectedBoundary: WorkspaceFilesystemProtectedBoundaryV1,
  context: WorkspaceFilesystemPipelineContextV1,
): Promise<WorkspaceFilesystemIntentRecordV1 | null> {
  const classified = context.recorded.admitted.authorized.policy.classified;
  const validated = classified.validated;
  const descriptor = validated.resolved.target.descriptor;
  const recordedAt = (context.now?.() ?? new Date()).toISOString();
  const unsigned = {
    attempt: context.recorded.attempt,
    capabilityRevision: descriptor.revision,
    argumentsDigest: validated.request.argumentsDigest,
    admissionDigest: context.recorded.admitted.admissionDigest,
    operationDigest: workspaceFilesystemOperationDigestV1(operation),
    // Runtime V24 retains this field name; PS-01 now binds the complete
    // protected boundary for every filesystem operation without an epoch cut.
    searchBoundaryDigest: protectedBoundary.boundaryDigest,
    lexicalTargetDigest: workspaceFilesystemStringDigestV1(operation.path),
    canonicalWorkspaceDigest: workspaceFilesystemStringDigestV1(
      protectedBoundary.canonicalWorkspace,
    ),
    protectedPathRevision: context.protectedPathRevision,
    approvalSummaryDigest: workspaceFilesystemStringDigestV1(validated.request.approvalSummary),
    effectiveEffectsDigest: classified.effectiveEffectsDigest,
    recordedAt,
  } satisfies Omit<WorkspaceFilesystemIntentRecordV1, 'intentDigest'>;
  const intent = Object.freeze({
    ...unsigned,
    intentDigest: workspaceFilesystemIntentDigestV1(unsigned),
  });
  let persisted = false;
  try {
    persisted = await context.persistence.persistEvents([
      {
        type: 'capability.filesystem_intent_recorded',
        invocationId: context.recorded.invocationId,
        ...intent,
      },
    ]);
  } catch {
    persisted = false;
  }
  const acknowledged =
    context.persistence.getState().capabilities.invocations[context.recorded.invocationId];
  if (
    !persisted ||
    acknowledged?.status !== 'running' ||
    acknowledged.attemptsStarted !== context.recorded.attempt ||
    !exactRecord(acknowledged.filesystemIntent, intent)
  ) {
    return null;
  }
  return intent;
}

function currentProtectedBoundary(
  context: WorkspaceFilesystemPipelineContextV1,
): WorkspaceFilesystemProtectedBoundaryV1 | null {
  try {
    const projection = context.protectedPathEvaluator.projectFilesystemBoundary();
    if (
      !sameCanonicalWorkspaceIdentity(
        projection.canonicalWorkspace,
        context.runtime.canonicalWorkspace,
      ) ||
      !sameCanonicalWorkspaceIdentity(
        context.protectedPathEvaluator.workspaceRoot,
        context.runtime.canonicalWorkspace,
      )
    ) {
      return null;
    }
    const unsigned = {
      schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
      ...structuredClone(projection),
    };
    return Object.freeze({
      ...unsigned,
      boundaryDigest: workspaceFilesystemProtectedBoundaryDigestV1(unsigned),
    });
  } catch {
    return null;
  }
}

function sameCanonicalWorkspaceIdentity(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function operationMatchesAdmittedInvocation(
  operation: Readonly<WorkspaceFilesystemOperationV1>,
  context: WorkspaceFilesystemPipelineContextV1,
): boolean {
  const classified = context.recorded.admitted.authorized.policy.classified;
  const validated = classified.validated;
  if (
    validated.request.source !== 'builtin' ||
    validated.resolved.target.executionFamily !== 'builtin' ||
    validated.request.name !== operation.kind
  ) {
    return false;
  }
  const approvedExternalMutation =
    context.recorded.admitted.authorized.authorizationKind === 'approved_call' ||
    context.recorded.admitted.authorized.policy.decision.grantUsed !== 'none';
  if (
    (operation.pathScope === 'external_read' && !isObserveOperation(operation)) ||
    (operation.pathScope === 'approved_external' && !approvedExternalMutation)
  ) {
    return false;
  }
  const expectedEffect = isObserveOperation(operation) ? 'read' : 'write';
  if (classified.effectiveEffects.filesystem !== expectedEffect) return false;
  const args = validated.request.arguments;
  switch (operation.kind) {
    case 'read_file':
      return (
        operation.path === args.path &&
        operation.offset === args.offset &&
        operation.limit === args.limit
      );
    case 'search_files':
      return operation.path === (args.path ?? '.') && operation.pattern === args.pattern;
    case 'search_content':
      return (
        operation.path === (args.path ?? '.') &&
        operation.pattern === args.pattern &&
        operation.glob === args.glob
      );
    case 'write_file':
      return operation.path === args.path && operation.content === args.content;
    case 'edit_file':
      return (
        operation.path === args.path &&
        operation.oldString === args.old_string &&
        operation.newString === args.new_string &&
        operation.replaceAll === args.replace_all
      );
  }
}

function exactRecord(left: unknown, right: unknown): boolean {
  if (left === undefined || left === null) return left === right;
  try {
    return digestCapability(left) === digestCapability(right);
  } catch {
    return false;
  }
}

function actorIdentityDigestV1(context: WorkspaceFilesystemPipelineContextV1): string {
  return digestCapability({
    schema: 'kite.workspace-filesystem-actor.v1',
    threadId: context.persistence.getState().session.threadId,
    actorIdentity: context.actorIdentity,
  });
}

function observationRecord(
  context: WorkspaceFilesystemPipelineContextV1,
  target: {
    lexicalTargetDigest: string;
    canonicalTargetDigest: string;
    targetIdentityDigest: string;
  },
  contentDigest: string,
): WorkspaceFilesystemObservationRecordV1 {
  return Object.freeze({
    actorIdentityDigest: actorIdentityDigestV1(context),
    lexicalTargetDigest: target.lexicalTargetDigest,
    canonicalTargetDigest: target.canonicalTargetDigest,
    targetIdentityDigest: target.targetIdentityDigest,
    contentDigest,
  });
}

function latestFilesystemObservationInvocation(
  state: Readonly<RuntimeState>,
  actorIdentityDigest: string,
  lexicalTargetDigest: string,
): import('@/protocol/capabilities').CapabilityInvocationRecord | null {
  let latest: import('@/protocol/capabilities').CapabilityInvocationRecord | undefined;
  for (const invocation of Object.values(state.capabilities.invocations)) {
    const observation = invocation.filesystemObservation;
    const expectedEffect =
      invocation.capabilityId === 'builtin:read_file'
        ? 'read'
        : invocation.capabilityId === 'builtin:write_file' ||
            invocation.capabilityId === 'builtin:edit_file'
          ? 'write'
          : null;
    if (
      invocation.status !== 'succeeded' ||
      expectedEffect === null ||
      invocation.effectiveEffectsDigest !==
        digestCapability({
          filesystem: expectedEffect,
          network: 'none',
          externalState: 'none',
        }) ||
      invocation.receiptRequirement !==
        (expectedEffect === 'read' ? 'observation_receipt' : 'effect_receipt') ||
      !invocation.filesystemIntent ||
      invocation.filesystemIntent.attempt !== invocation.attemptsStarted ||
      !observation ||
      invocation.filesystemIntent.lexicalTargetDigest !== observation.lexicalTargetDigest ||
      (expectedEffect === 'read'
        ? invocation.filesystemMutationReady !== undefined
        : !invocation.filesystemMutationReady ||
          invocation.filesystemMutationReady.attempt !== invocation.attemptsStarted ||
          invocation.filesystemMutationReady.intentDigest !==
            invocation.filesystemIntent.intentDigest ||
          invocation.filesystemMutationReady.operationDigest !==
            invocation.filesystemIntent.operationDigest) ||
      observation.actorIdentityDigest !== actorIdentityDigest ||
      observation.lexicalTargetDigest !== lexicalTargetDigest
    ) {
      continue;
    }
    if (!latest || (invocation.finishedAt ?? '') > (latest.finishedAt ?? '')) latest = invocation;
  }
  return latest ?? null;
}

function failure(
  code: WorkspaceFilesystemProviderFailureV1['code'],
  message: string,
): WorkspaceFilesystemPipelineResultV1 {
  return Object.freeze({ ok: false, failure: Object.freeze({ code, message }) });
}

function isObserveOperation(
  operation: WorkspaceFilesystemOperationV1,
): operation is WorkspaceFilesystemObserveOperationV1 {
  return (
    operation.kind === 'read_file' ||
    operation.kind === 'search_files' ||
    operation.kind === 'search_content'
  );
}
