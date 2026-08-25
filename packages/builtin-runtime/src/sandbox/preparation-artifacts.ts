import { join } from 'node:path';
import type { PreparedSandboxExecution, SandboxPreparationArtifactRef } from '@kite/runtime-spi';
import {
  canonicalModelJson,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPoint,
  PrivateImmutableArtifactStorage,
} from '../model';
import { userKiteCodeDir } from '../model/artifact-paths';

export interface SandboxPreparationArtifactStoreOptions {
  readonly root?: string;
  readonly faultInjector?: (point: PrivateArtifactWriteFaultPoint) => void;
}

export type SandboxPreparationArtifactErrorCode =
  | 'invalid_preparation'
  | 'artifact_missing'
  | 'artifact_corrupt'
  | 'artifact_too_large'
  | 'storage_boundary_violation'
  | 'publish_failed';

export class SandboxPreparationArtifactError extends Error {
  readonly code: SandboxPreparationArtifactErrorCode;

  constructor(code: SandboxPreparationArtifactErrorCode, message: string) {
    super(message);
    this.name = 'SandboxPreparationArtifactError';
    this.code = code;
  }
}

/** Installation-private root for durable Sandbox preparation evidence. */
export function sandboxPreparationArtifactRoot(): string {
  return join(userKiteCodeDir(), 'sandbox-preparations');
}

/** Private immutable evidence used both for ready ack and post-crash disposal. */
export class SandboxPreparationArtifactStore {
  readonly #storage: PrivateImmutableArtifactStorage<'sandbox_preparation'>;

  constructor(options: SandboxPreparationArtifactStoreOptions) {
    this.#storage = new PrivateImmutableArtifactStorage({
      root: options.root ?? sandboxPreparationArtifactRoot(),
      namespace: 'sandbox-preparations',
      partitions: [
        { kind: 'sandbox_preparation', directory: 'plans', extension: '.json' },
      ] as const,
      maxArtifactBytes: 2 * 1024 * 1024,
      ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
    });
  }

  write(prepared: Readonly<PreparedSandboxExecution>): SandboxPreparationArtifactRef {
    try {
      if (!isPreparedSandboxExecution(prepared)) invalidPreparation();
      const payload = Buffer.from(
        canonicalModelJson({ artifactFormatVersion: 1, prepared }),
        'utf8',
      );
      return this.#storage.write('sandbox_preparation', payload);
    } catch (error) {
      throw mapArtifactError(error, 'invalid_preparation');
    }
  }

  read(ref: SandboxPreparationArtifactRef): Readonly<PreparedSandboxExecution> {
    try {
      const bytes = this.#storage.read(ref);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (
        canonicalModelJson(parsed) !== text ||
        !isRecord(parsed) ||
        !hasExactKeys(parsed, ['artifactFormatVersion', 'prepared'])
      ) {
        artifactCorrupt();
      }
      const prepared = parsed.prepared;
      if (parsed.artifactFormatVersion !== 1 || !isPreparedSandboxExecution(prepared)) {
        artifactCorrupt();
      }
      return deepFreeze(prepared);
    } catch (error) {
      throw mapArtifactError(error, 'artifact_corrupt');
    }
  }
}

const PREPARED_KEYS = [
  'schema',
  'kind',
  'planId',
  'toolCallId',
  'capabilityId',
  'capabilityRevision',
  'invocationId',
  'attempt',
  'canonicalWorkspace',
  'effectiveEffectsDigest',
  'admissionDigest',
  'preparationDigest',
  'commandDigest',
  'approvedArgv',
  'argv',
  'cwd',
  'env',
  'stdin',
  'transport',
  'backend',
  'backendCapabilities',
  'enforcement',
  'resourceSemantics',
  'expiresAtMs',
  'cleanup',
] as const;

function isPreparedSandboxExecution(value: unknown): value is PreparedSandboxExecution {
  if (!isRecord(value) || !hasExactKeys(value, PREPARED_KEYS)) return false;
  if (
    value.schema !== 'kite.sandbox-execution-provider.v1' ||
    value.kind !== 'prepared_sandbox_execution' ||
    !nonEmpty(value.planId) ||
    !nonEmpty(value.toolCallId) ||
    !nonEmpty(value.capabilityId) ||
    !nonEmpty(value.capabilityRevision) ||
    !nonEmpty(value.invocationId) ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    !nonEmpty(value.canonicalWorkspace) ||
    !nonEmpty(value.effectiveEffectsDigest) ||
    !nonEmpty(value.admissionDigest) ||
    !nonEmpty(value.preparationDigest) ||
    !nonEmpty(value.commandDigest) ||
    !stringArray(value.approvedArgv) ||
    value.approvedArgv.length < 1 ||
    !stringArray(value.argv) ||
    value.argv.length < 1 ||
    !nonEmpty(value.cwd) ||
    value.cwd !== value.canonicalWorkspace ||
    !(value.env === null || stringRecord(value.env)) ||
    !(value.stdin === null || typeof value.stdin === 'string') ||
    !['stdio', 'windows_restricted_token_v1'].includes(String(value.transport)) ||
    !['seatbelt', 'bubblewrap', 'windows_restricted_token', 'none'].includes(
      String(value.backend),
    ) ||
    !isBackendCapabilities(value.backendCapabilities, String(value.backend)) ||
    !['full', 'partial'].includes(String(value.enforcement)) ||
    !['pure', 'allocating'].includes(String(value.resourceSemantics)) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    Number(value.expiresAtMs) < 1 ||
    !isCleanup(value.cleanup)
  ) {
    return false;
  }
  return (
    (value.transport === 'windows_restricted_token_v1') ===
      (value.backend === 'windows_restricted_token') &&
    (value.cleanup.kind === 'windows_restricted_token') ===
      (value.backend === 'windows_restricted_token')
  );
}

function isBackendCapabilities(value: unknown, backend: string): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'backend',
      'filesystem',
      'network',
      'syscallFilter',
      'processTreeLimit',
      'childProcessInheritance',
      'verifiedInProcessReadOnly',
    ]) ||
    value.backend !== backend ||
    !isRecord(value.filesystem) ||
    !hasExactKeys(value.filesystem, ['read_only', 'workspace_write', 'full_access']) ||
    !isRecord(value.network) ||
    !hasExactKeys(value.network, ['off', 'allowlist'])
  ) {
    return false;
  }
  return [
    ...Object.values(value.filesystem),
    ...Object.values(value.network),
    value.syscallFilter,
    value.processTreeLimit,
    value.childProcessInheritance,
    value.verifiedInProcessReadOnly,
  ].every((entry) => entry === 'enforced' || entry === 'unsupported');
}

function isCleanup(value: unknown): value is PreparedSandboxExecution['cleanup'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'resourceId', 'recoveryPayload']) ||
    !['none', 'runtime_directory', 'windows_restricted_token'].includes(String(value.kind)) ||
    !nonEmpty(value.resourceId) ||
    !isRecord(value.recoveryPayload)
  ) {
    return false;
  }
  if (
    !Object.values(value.recoveryPayload).every(
      (entry) =>
        entry === null ||
        typeof entry === 'string' ||
        typeof entry === 'boolean' ||
        (typeof entry === 'number' && Number.isFinite(entry)),
    )
  ) {
    return false;
  }
  if (value.kind === 'none') return hasExactKeys(value.recoveryPayload, []);
  if (value.kind === 'runtime_directory') {
    return (
      hasExactKeys(value.recoveryPayload, ['controlRoot', 'dataRoot']) &&
      nonEmpty(value.recoveryPayload.controlRoot) &&
      nonEmpty(value.recoveryPayload.dataRoot) &&
      value.recoveryPayload.controlRoot !== value.recoveryPayload.dataRoot
    );
  }
  return (
    hasExactKeys(value.recoveryPayload, ['path', 'transport']) &&
    nonEmpty(value.recoveryPayload.path) &&
    nonEmpty(value.recoveryPayload.transport)
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
}

function invalidPreparation(): never {
  throw new SandboxPreparationArtifactError(
    'invalid_preparation',
    'Sandbox preparation Artifact payload is invalid.',
  );
}

function artifactCorrupt(): never {
  throw new SandboxPreparationArtifactError(
    'artifact_corrupt',
    'Sandbox preparation Artifact is corrupt.',
  );
}

function mapArtifactError(
  error: unknown,
  fallback: SandboxPreparationArtifactErrorCode,
): SandboxPreparationArtifactError {
  if (error instanceof SandboxPreparationArtifactError) return error;
  if (error instanceof PrivateArtifactStorageError) {
    const code: SandboxPreparationArtifactErrorCode =
      error.code === 'artifact_missing'
        ? 'artifact_missing'
        : error.code === 'artifact_corrupt' || error.code === 'invalid_reference'
          ? 'artifact_corrupt'
          : error.code === 'artifact_too_large'
            ? 'artifact_too_large'
            : error.code === 'publish_failed'
              ? 'publish_failed'
              : 'storage_boundary_violation';
    return new SandboxPreparationArtifactError(code, error.message);
  }
  return new SandboxPreparationArtifactError(
    fallback,
    fallback === 'artifact_corrupt'
      ? 'Sandbox preparation Artifact is corrupt.'
      : 'Sandbox preparation Artifact payload is invalid.',
  );
}
