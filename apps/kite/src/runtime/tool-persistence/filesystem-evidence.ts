import type {
  BuiltinWorkspaceFilesystemTerminalVerificationResult,
  BuiltinWorkspaceFilesystemTerminalVerifier,
} from '@kite/builtin-runtime';
import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import type { StateRuntimeState } from '@kite/runtime-host';
import type {
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
  ToolPipelineReceiptCommit,
  WorkspaceFilesystemEditObservationQuery,
} from '@kite/runtime-spi';
import {
  AppStateToolPipelinePersistenceError,
  type StateBuiltinOperationStructuredContent,
} from './contracts';

export type AuthenticatedFilesystemObservation = Extract<
  BuiltinWorkspaceFilesystemTerminalVerificationResult,
  { readonly valid: true }
>['observation'];

export function verifyTerminalFilesystemObservation(
  verifier: BuiltinWorkspaceFilesystemTerminalVerifier | undefined,
  commit: Readonly<ToolPipelineReceiptCommit<StateBuiltinOperationStructuredContent>>,
  value: Readonly<StateBuiltinOperationStructuredContent>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): Readonly<AuthenticatedFilesystemObservation> | undefined {
  const candidate = value.filesystemObservation;
  const observationOperation =
    identity.operationId === 'builtin:read_file' ||
    identity.operationId === 'builtin:write_file' ||
    identity.operationId === 'builtin:edit_file';
  if (
    candidate === undefined &&
    observationOperation &&
    commit.result.status === 'success' &&
    value.ok
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'A successful filesystem terminal must carry an authentic filesystem observation.',
    );
  }
  if (candidate === undefined) return undefined;
  if (!verifier) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Filesystem observation requires the injected Builtin terminal verifier.',
    );
  }
  let verification: ReturnType<BuiltinWorkspaceFilesystemTerminalVerifier>;
  try {
    verification = verifier(commit);
  } catch {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Builtin filesystem terminal verification failed.',
    );
  }
  if (
    !verification.valid ||
    !observationOperation ||
    commit.result.status !== 'success' ||
    !value.ok ||
    !isExactFilesystemObservation(candidate) ||
    !isExactFilesystemObservation(verification.observation) ||
    verification.observation !== candidate ||
    !sameJson(verification.observation, candidate)
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Builtin filesystem terminal observation authority did not match the exact terminal.',
    );
  }
  return verification.observation;
}

export interface LatestFilesystemObservationInvocation {
  readonly invocationId: string;
  readonly attemptsStarted: number;
  readonly capabilityRevision: string;
  readonly finishedAt: string;
  readonly resultDigest: string;
  readonly evidenceDigest: string;
  readonly artifact: NonNullable<
    StateRuntimeState['capabilities']['invocations'][string]['artifact']
  >;
  readonly filesystemObservation: NonNullable<
    StateRuntimeState['capabilities']['invocations'][string]['filesystemObservation']
  >;
}

export function latestFilesystemObservationInvocation(
  state: Readonly<StateRuntimeState>,
  query: Readonly<WorkspaceFilesystemEditObservationQuery>,
): Readonly<LatestFilesystemObservationInvocation> | null {
  let latest: Readonly<LatestFilesystemObservationInvocation> | undefined;
  for (const invocation of Object.values(state.capabilities.invocations)) {
    const observation = invocation.filesystemObservation;
    const expectedEffect =
      invocation.capabilityId === 'builtin:read_file'
        ? 'read'
        : invocation.capabilityId === 'builtin:write_file' ||
            invocation.capabilityId === 'builtin:edit_file'
          ? 'write'
          : null;
    const mutationReady = invocation.filesystemMutationReady;
    const intent = invocation.filesystemIntent;
    if (
      invocation.status !== 'succeeded' ||
      expectedEffect === null ||
      invocation.effectiveEffectsDigest !==
        digestCapabilityValue({
          filesystem: expectedEffect,
          network: 'none',
          externalState: 'none',
        }) ||
      invocation.receiptRequirement !==
        (expectedEffect === 'read' ? 'observation_receipt' : 'effect_receipt') ||
      !Number.isSafeInteger(invocation.attemptsStarted) ||
      (invocation.attemptsStarted ?? 0) < 1 ||
      typeof invocation.finishedAt !== 'string' ||
      typeof invocation.resultDigest !== 'string' ||
      typeof invocation.evidenceDigest !== 'string' ||
      !invocation.artifact ||
      !intent ||
      intent.attempt !== invocation.attemptsStarted ||
      !observation ||
      intent.lexicalTargetDigest !== observation.lexicalTargetDigest ||
      (expectedEffect === 'read'
        ? mutationReady !== undefined
        : !mutationReady ||
          mutationReady.attempt !== invocation.attemptsStarted ||
          mutationReady.intentDigest !== intent.intentDigest ||
          mutationReady.operationDigest !== intent.operationDigest) ||
      observation.actorIdentityDigest !== query.actorIdentityDigest ||
      observation.lexicalTargetDigest !== query.lexicalTargetDigest
    ) {
      continue;
    }
    const candidate = Object.freeze({
      invocationId: invocation.invocationId,
      attemptsStarted: invocation.attemptsStarted,
      capabilityRevision: invocation.capabilityRevision,
      finishedAt: invocation.finishedAt,
      resultDigest: invocation.resultDigest,
      evidenceDigest: invocation.evidenceDigest,
      artifact: invocation.artifact,
      filesystemObservation: observation,
    });
    if (!latest || candidate.finishedAt > latest.finishedAt) latest = candidate;
  }
  return latest ?? null;
}

function isExactFilesystemObservation(
  value: RuntimeJsonValue | undefined,
): value is Readonly<AuthenticatedFilesystemObservation> {
  if (!isJsonRecord(value)) return false;
  const expected = [
    'actorIdentityDigest',
    'canonicalTargetDigest',
    'contentDigest',
    'lexicalTargetDigest',
    'targetIdentityDigest',
  ];
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    expected.every((key) => typeof value[key] === 'string')
  );
}

function isJsonRecord(
  value: RuntimeJsonValue | undefined,
): value is { readonly [key: string]: RuntimeJsonValue } {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
