import type {
  SubagentContinuationArtifactRefV1,
  SuspendedSubagentSnapshot,
} from '@kite/runtime-spi';
import {
  canonicalModelJsonV1,
  PrivateArtifactStorageError,
  PrivateImmutableArtifactStorageV1,
} from '../model';
import { subagentContinuationArtifactRootV1 } from './artifact-paths';
import {
  decodeSubagentContinuationSnapshotV1,
  subagentContinuationCursorIdV1,
} from './continuation-codec';

export interface SubagentContinuationArtifactOwnerV1 {
  parentInvocationId: string;
  parentAttempt: number;
  parentToolCallId: string;
  childInvocationId: string;
  continuationId: string;
}

export interface SubagentContinuationArtifactAccessV1 {
  write(input: {
    owner: SubagentContinuationArtifactOwnerV1;
    snapshot: SuspendedSubagentSnapshot;
  }): SubagentContinuationArtifactRefV1;
  read(
    ref: SubagentContinuationArtifactRefV1,
    expected: SubagentContinuationArtifactOwnerV1,
  ): Readonly<SuspendedSubagentSnapshot>;
}

export class SubagentContinuationArtifactErrorV1 extends Error {
  readonly code:
    | 'invalid_continuation'
    | 'artifact_missing'
    | 'artifact_corrupt'
    | 'artifact_too_large'
    | 'storage_boundary_violation'
    | 'publish_failed';
  constructor(code: SubagentContinuationArtifactErrorV1['code']) {
    super('Subagent continuation Artifact operation failed.');
    this.name = 'SubagentContinuationArtifactErrorV1';
    this.code = code;
  }
}

export class SubagentContinuationArtifactStoreV1 implements SubagentContinuationArtifactAccessV1 {
  readonly #storage: PrivateImmutableArtifactStorageV1<'subagent_continuation'>;

  constructor(options: { root?: string } = {}) {
    try {
      this.#storage = new PrivateImmutableArtifactStorageV1({
        root: options.root ?? subagentContinuationArtifactRootV1(),
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
    owner: SubagentContinuationArtifactOwnerV1;
    snapshot: SuspendedSubagentSnapshot;
  }): SubagentContinuationArtifactRefV1 {
    try {
      const owner = validateOwner(input.owner);
      const snapshot = validateSnapshot(input.snapshot);
      if (
        owner.childInvocationId !== snapshot.subagentId ||
        owner.continuationId !== subagentContinuationCursorIdV1(snapshot)
      ) {
        corrupt('invalid_continuation');
      }
      return this.#storage.write(
        'subagent_continuation',
        Buffer.from(canonicalModelJsonV1({ artifactFormatVersion: 1, owner, snapshot }), 'utf8'),
      );
    } catch (error) {
      throw map(error, 'invalid_continuation');
    }
  }

  read(
    ref: SubagentContinuationArtifactRefV1,
    expected: SubagentContinuationArtifactOwnerV1,
  ): Readonly<SuspendedSubagentSnapshot> {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#storage.read(ref));
      const parsed: unknown = JSON.parse(text);
      if (!plain(parsed) || !exact(parsed, ['artifactFormatVersion', 'owner', 'snapshot']))
        corrupt();
      if (parsed.artifactFormatVersion !== 1 || canonicalModelJsonV1(parsed) !== text) corrupt();
      const owner = validateOwner(parsed.owner);
      if (canonicalModelJsonV1(owner) !== canonicalModelJsonV1(validateOwner(expected))) corrupt();
      const snapshot = validateSnapshot(parsed.snapshot);
      if (
        owner.childInvocationId !== snapshot.subagentId ||
        owner.continuationId !== subagentContinuationCursorIdV1(snapshot)
      ) {
        corrupt();
      }
      return Object.freeze(structuredClone(snapshot));
    } catch (error) {
      if (error instanceof SubagentContinuationArtifactErrorV1) {
        if (error.code === 'invalid_continuation') corrupt();
        throw error;
      }
      throw map(error, 'artifact_corrupt');
    }
  }
}

function validateOwner(value: unknown): SubagentContinuationArtifactOwnerV1 {
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
  return structuredClone(value) as unknown as SubagentContinuationArtifactOwnerV1;
}

function validateSnapshot(value: unknown): SuspendedSubagentSnapshot {
  try {
    if (!plain(value) || !hasContinuationSnapshotKeys(value)) corrupt('invalid_continuation');
    const canonical = decodeSubagentContinuationSnapshotV1(
      value as unknown as SuspendedSubagentSnapshot,
    );
    if (canonicalModelJsonV1(canonical) !== canonicalModelJsonV1(value)) {
      corrupt('invalid_continuation');
    }
    return canonical;
  } catch (error) {
    if (error instanceof SubagentContinuationArtifactErrorV1) throw error;
    corrupt('invalid_continuation');
  }
}

function hasContinuationSnapshotKeys(value: Record<string, unknown>): boolean {
  const required = [
    'blockedTool',
    'messages',
    'role',
    'steps',
    'subagentId',
    'task',
    'toolCallCount',
    'toolRecovery',
  ];
  const optional = [
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
function corrupt(code: SubagentContinuationArtifactErrorV1['code'] = 'artifact_corrupt'): never {
  throw new SubagentContinuationArtifactErrorV1(code);
}
function map(
  error: unknown,
  fallback: SubagentContinuationArtifactErrorV1['code'],
): SubagentContinuationArtifactErrorV1 {
  if (error instanceof SubagentContinuationArtifactErrorV1) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code = error.code === 'invalid_reference' ? 'artifact_corrupt' : error.code;
    return new SubagentContinuationArtifactErrorV1(
      code as SubagentContinuationArtifactErrorV1['code'],
    );
  }
  return new SubagentContinuationArtifactErrorV1(fallback);
}
