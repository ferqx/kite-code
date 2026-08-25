import type {
  SubagentContinuationArtifactRef,
  SuspendedSubagentSnapshot,
} from '@kite-ai/runtime-spi';
import {
  canonicalModelJson,
  PrivateArtifactStorageError,
  PrivateImmutableArtifactStorage,
} from '../model';
import { subagentContinuationArtifactRoot } from './artifact-paths';
import {
  decodeSubagentContinuationSnapshot,
  subagentContinuationCursorId,
} from './continuation-codec';

export interface SubagentContinuationArtifactOwner {
  parentInvocationId: string;
  parentAttempt: number;
  parentToolCallId: string;
  childInvocationId: string;
  continuationId: string;
}

export interface SubagentContinuationArtifactAccess {
  write(input: {
    owner: SubagentContinuationArtifactOwner;
    snapshot: SuspendedSubagentSnapshot;
  }): SubagentContinuationArtifactRef;
  read(
    ref: SubagentContinuationArtifactRef,
    expected: SubagentContinuationArtifactOwner,
  ): Readonly<SuspendedSubagentSnapshot>;
}

export class SubagentContinuationArtifactError extends Error {
  readonly code:
    | 'invalid_continuation'
    | 'artifact_missing'
    | 'artifact_corrupt'
    | 'artifact_too_large'
    | 'storage_boundary_violation'
    | 'publish_failed';
  constructor(code: SubagentContinuationArtifactError['code']) {
    super('Subagent continuation Artifact operation failed.');
    this.name = 'SubagentContinuationArtifactError';
    this.code = code;
  }
}

export class SubagentContinuationArtifactStore implements SubagentContinuationArtifactAccess {
  readonly #storage: PrivateImmutableArtifactStorage<'subagent_continuation'>;

  constructor(options: { root?: string } = {}) {
    try {
      this.#storage = new PrivateImmutableArtifactStorage({
        root: options.root ?? subagentContinuationArtifactRoot(),
        namespace: 'subagent-continuations',
        partitions: [
          { kind: 'subagent_continuation', directory: 'continuations', extension: '.json' },
        ],
        maxArtifactBytes: 4 * 1024 * 1024,
      });
    } catch (error) {
      throw map(error, 'storage_boundary_violation');
    }
  }

  write(input: {
    owner: SubagentContinuationArtifactOwner;
    snapshot: SuspendedSubagentSnapshot;
  }): SubagentContinuationArtifactRef {
    try {
      const owner = validateOwner(input.owner);
      const snapshot = validateSnapshot(input.snapshot);
      if (
        owner.childInvocationId !== snapshot.subagentId ||
        owner.continuationId !== subagentContinuationCursorId(snapshot)
      ) {
        corrupt('invalid_continuation');
      }
      return this.#storage.write(
        'subagent_continuation',
        Buffer.from(canonicalModelJson({ artifactFormatVersion: 1, owner, snapshot }), 'utf8'),
      );
    } catch (error) {
      throw map(error, 'invalid_continuation');
    }
  }

  read(
    ref: SubagentContinuationArtifactRef,
    expected: SubagentContinuationArtifactOwner,
  ): Readonly<SuspendedSubagentSnapshot> {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#storage.read(ref));
      const parsed: unknown = JSON.parse(text);
      if (!plain(parsed) || !exact(parsed, ['artifactFormatVersion', 'owner', 'snapshot']))
        corrupt();
      if (parsed.artifactFormatVersion !== 1 || canonicalModelJson(parsed) !== text) corrupt();
      const owner = validateOwner(parsed.owner);
      if (canonicalModelJson(owner) !== canonicalModelJson(validateOwner(expected))) corrupt();
      const snapshot = validateSnapshot(parsed.snapshot);
      if (
        owner.childInvocationId !== snapshot.subagentId ||
        owner.continuationId !== subagentContinuationCursorId(snapshot)
      ) {
        corrupt();
      }
      return Object.freeze(structuredClone(snapshot));
    } catch (error) {
      if (error instanceof SubagentContinuationArtifactError) {
        if (error.code === 'invalid_continuation') corrupt();
        throw error;
      }
      throw map(error, 'artifact_corrupt');
    }
  }
}

function validateOwner(value: unknown): SubagentContinuationArtifactOwner {
  if (
    !plain(value) ||
    !exact(value, [
      'childInvocationId',
      'continuationId',
      'parentAttempt',
      'parentInvocationId',
      'parentToolCallId',
    ]) ||
    !Number.isSafeInteger(value.parentAttempt) ||
    Number(value.parentAttempt) < 1
  ) {
    corrupt('invalid_continuation');
  }
  for (const key of [
    'childInvocationId',
    'continuationId',
    'parentInvocationId',
    'parentToolCallId',
  ] as const) {
    if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 16_384) {
      corrupt('invalid_continuation');
    }
  }
  return structuredClone(value) as unknown as SubagentContinuationArtifactOwner;
}

function validateSnapshot(value: unknown): SuspendedSubagentSnapshot {
  try {
    if (!plain(value) || !hasContinuationSnapshotKeys(value)) corrupt('invalid_continuation');
    const canonical = decodeSubagentContinuationSnapshot(
      value as unknown as SuspendedSubagentSnapshot,
    );
    if (canonicalModelJson(canonical) !== canonicalModelJson(value)) {
      corrupt('invalid_continuation');
    }
    return canonical;
  } catch (error) {
    if (error instanceof SubagentContinuationArtifactError) throw error;
    corrupt('invalid_continuation');
  }
}

function hasContinuationSnapshotKeys(value: Record<string, unknown>): boolean {
  const required = [
    'blockedTool',
    'messages',
    'name',
    'role',
    'steps',
    'subagentId',
    'task',
    'toolCallCount',
    'toolRecovery',
  ];
  const optional = [
    'approvalFacts',
    'allowedTools',
    'executionJournal',
    'exhaustedFingerprints',
    'mcpBindingIds',
    'modelInvocationOrdinal',
  ];
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function corrupt(code: SubagentContinuationArtifactError['code'] = 'artifact_corrupt'): never {
  throw new SubagentContinuationArtifactError(code);
}
function map(
  error: unknown,
  fallback: SubagentContinuationArtifactError['code'],
): SubagentContinuationArtifactError {
  if (error instanceof SubagentContinuationArtifactError) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code = error.code === 'invalid_reference' ? 'artifact_corrupt' : error.code;
    return new SubagentContinuationArtifactError(code as SubagentContinuationArtifactError['code']);
  }
  return new SubagentContinuationArtifactError(fallback);
}
