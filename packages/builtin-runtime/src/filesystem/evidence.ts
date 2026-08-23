import { createHash } from 'node:crypto';
import type {
  FilesystemPreimageArtifactRef,
  WorkspaceFilesystemIntentRecord,
  WorkspaceFilesystemMutationReadyRecord,
  WorkspaceFilesystemObservationRecord,
} from '@kite/runtime-spi';

const MAX_IDENTITY_CHARS = 4_096;

export function validateWorkspaceFilesystemIntentRecord(
  value: unknown,
): WorkspaceFilesystemIntentRecord {
  const intent = plainRecord(value, 'filesystem intent');
  exactKeys(
    intent,
    [
      'attempt',
      'capabilityRevision',
      'argumentsDigest',
      'admissionDigest',
      'operationDigest',
      'searchBoundaryDigest',
      'lexicalTargetDigest',
      'canonicalWorkspaceDigest',
      'protectedPathRevision',
      'approvalSummaryDigest',
      'effectiveEffectsDigest',
      'intentDigest',
      'recordedAt',
    ],
    'filesystem intent',
  );
  const result = {
    attempt: positiveInteger(intent.attempt, 'filesystem intent attempt'),
    capabilityRevision: bareDigest(intent.capabilityRevision, 'capabilityRevision'),
    argumentsDigest: bareDigest(intent.argumentsDigest, 'argumentsDigest'),
    admissionDigest: bareDigest(intent.admissionDigest, 'admissionDigest'),
    operationDigest: prefixedDigest(intent.operationDigest, 'operationDigest'),
    searchBoundaryDigest:
      intent.searchBoundaryDigest === null
        ? null
        : prefixedDigest(intent.searchBoundaryDigest, 'searchBoundaryDigest'),
    lexicalTargetDigest: prefixedDigest(intent.lexicalTargetDigest, 'lexicalTargetDigest'),
    canonicalWorkspaceDigest: prefixedDigest(
      intent.canonicalWorkspaceDigest,
      'canonicalWorkspaceDigest',
    ),
    protectedPathRevision: requiredString(
      intent.protectedPathRevision,
      'protectedPathRevision',
      MAX_IDENTITY_CHARS,
    ),
    approvalSummaryDigest: prefixedDigest(intent.approvalSummaryDigest, 'approvalSummaryDigest'),
    effectiveEffectsDigest: bareDigest(intent.effectiveEffectsDigest, 'effectiveEffectsDigest'),
    intentDigest: prefixedDigest(intent.intentDigest, 'intentDigest'),
    recordedAt: canonicalTimestamp(intent.recordedAt, 'filesystem intent recordedAt'),
  } satisfies WorkspaceFilesystemIntentRecord;
  const { intentDigest, ...unsigned } = result;
  if (intentDigest !== workspaceFilesystemIntentDigest(unsigned)) {
    throw new Error('filesystem intent digest mismatch');
  }
  return frozenClone(result);
}

export function validateWorkspaceFilesystemObservationRecord(
  value: unknown,
): WorkspaceFilesystemObservationRecord {
  const observation = plainRecord(value, 'filesystem observation');
  exactKeys(
    observation,
    [
      'actorIdentityDigest',
      'lexicalTargetDigest',
      'canonicalTargetDigest',
      'targetIdentityDigest',
      'contentDigest',
    ],
    'filesystem observation',
  );
  return frozenClone({
    actorIdentityDigest: bareDigest(observation.actorIdentityDigest, 'actorIdentityDigest'),
    lexicalTargetDigest: prefixedDigest(observation.lexicalTargetDigest, 'lexicalTargetDigest'),
    canonicalTargetDigest: prefixedDigest(
      observation.canonicalTargetDigest,
      'canonicalTargetDigest',
    ),
    targetIdentityDigest: prefixedDigest(observation.targetIdentityDigest, 'targetIdentityDigest'),
    contentDigest: prefixedDigest(observation.contentDigest, 'contentDigest'),
  });
}

export function validateWorkspaceFilesystemMutationReadyRecord(
  value: unknown,
): WorkspaceFilesystemMutationReadyRecord {
  const ready = plainRecord(value, 'mutation ready');
  exactKeys(
    ready,
    [
      'attempt',
      'intentDigest',
      'operationDigest',
      'targetIdentityDigest',
      'preimageDigest',
      'preimageArtifact',
      'readyDigest',
      'readyAt',
    ],
    'mutation ready',
  );
  const result = {
    attempt: positiveInteger(ready.attempt, 'ready attempt'),
    intentDigest: prefixedDigest(ready.intentDigest, 'ready intentDigest'),
    operationDigest: prefixedDigest(ready.operationDigest, 'ready operationDigest'),
    targetIdentityDigest: prefixedDigest(ready.targetIdentityDigest, 'ready targetIdentityDigest'),
    preimageDigest:
      ready.preimageDigest === null
        ? null
        : prefixedDigest(ready.preimageDigest, 'ready preimageDigest'),
    preimageArtifact: validatePreimageArtifact(ready.preimageArtifact),
    readyDigest: prefixedDigest(ready.readyDigest, 'readyDigest'),
    readyAt: canonicalTimestamp(ready.readyAt, 'readyAt'),
  } satisfies WorkspaceFilesystemMutationReadyRecord;
  const { readyDigest, ...unsigned } = result;
  if (readyDigest !== workspaceFilesystemMutationReadyDigest(unsigned)) {
    throw new Error('mutation ready digest mismatch');
  }
  return frozenClone(result);
}

export function workspaceFilesystemIntentDigest(
  intent: Omit<WorkspaceFilesystemIntentRecord, 'intentDigest'>,
): string {
  return sha256Canonical(intent);
}

export function workspaceFilesystemMutationReadyDigest(
  ready: Omit<WorkspaceFilesystemMutationReadyRecord, 'readyDigest'>,
): string {
  return sha256Canonical(ready);
}

function validatePreimageArtifact(value: unknown): FilesystemPreimageArtifactRef {
  const artifact = plainRecord(value, 'preimage Artifact');
  exactKeys(
    artifact,
    ['artifactId', 'kind', 'integrityIdentifier', 'byteLength'],
    'preimage Artifact',
  );
  if (artifact.kind !== 'filesystem_preimage') throw new Error('preimage Artifact kind');
  const artifactId = requiredString(artifact.artifactId, 'artifactId', MAX_IDENTITY_CHARS);
  const integrityIdentifier = requiredString(
    artifact.integrityIdentifier,
    'integrityIdentifier',
    MAX_IDENTITY_CHARS,
  );
  if (!/^pa_[a-f0-9]{64}$/u.test(artifactId)) throw new Error('preimage Artifact id');
  if (!/^sha256:[a-f0-9]{64}$/u.test(integrityIdentifier)) {
    throw new Error('preimage Artifact integrity identifier');
  }
  return {
    artifactId,
    kind: 'filesystem_preimage',
    integrityIdentifier,
    byteLength: nonNegativeInteger(artifact.byteLength, 'Artifact byteLength'),
  };
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Non-finite JSON value.');
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Non-JSON value.');
  return serialized;
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${name} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${name} has symbol keys.`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw new Error(`${name} has hidden or accessor fields.`);
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new Error(`${name} has an invalid shape.`);
  }
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function bareDigest(value: unknown, name: string): string {
  const digest = requiredString(value, name, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`Invalid ${name}.`);
  return digest;
}

function prefixedDigest(value: unknown, name: string): string {
  const digest = requiredString(value, name, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error(`Invalid ${name}.`);
  return digest;
}

function canonicalTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name, 32);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`Invalid ${name}.`);
  }
  return timestamp;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Invalid ${name}.`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${name}.`);
  return Number(value);
}

function frozenClone<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
