import { modelArtifactRoot } from '@/core/model/model-artifact-paths';
import {
  assertCanonicalModelMessageV1,
  assertModelAdapterReplayOwnerV1,
  assertModelRouteIdentityV1,
  assertModelSurfaceV1,
  canonicalModelJsonV1,
  computeCanonicalProviderOptionsDigestV1,
  computeModelSurfaceDigestV1,
} from '@/core/model/surface-canonicalizer';
import {
  type PrivateArtifactGarbageCollectionOptionsV1,
  type PrivateArtifactGarbageCollectionResultV1,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPointV1,
  PrivateImmutableArtifactStorageV1,
} from '@/core/persistence/private-immutable-artifacts';
import type {
  CanonicalJsonObjectV1,
  ModelResponseRecordV1,
  ModelSurfaceV1,
  PrivateArtifactKindV1,
  PrivateArtifactRefV1,
  Sha256DigestV1,
} from '@/protocol/model-surface';
import { MODEL_RESPONSE_RECORD_SCHEMA_V1 } from '@/protocol/model-surface';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const DEFAULT_MODEL_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const INTEGRITY_IDENTIFIER = /^hmac-sha256:[0-9a-f]{64}$/;
const MODEL_RESPONSE_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'error',
  'other',
  'unknown',
]);

const MODEL_ARTIFACT_PARTITIONS = Object.freeze([
  { kind: 'model_surface', directory: 'surfaces', extension: '.json' },
  { kind: 'model_response', directory: 'responses', extension: '.json' },
  { kind: 'provider_options', directory: 'provider-options', extension: '.json' },
] as const);

export interface ModelArtifactStoreOptionsV1 {
  /** Canonical-private key material; callers own durable key lifecycle. */
  integrityKey: Uint8Array;
  root?: string;
  maxArtifactBytes?: number;
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
  faultInjector?: (point: PrivateArtifactWriteFaultPointV1) => void;
}

export interface ModelArtifactGarbageCollectionOptionsV1 {
  /** Must be a complete union of references from every retained session and fork. */
  reachability: {
    complete: boolean;
    reachable: readonly PrivateArtifactRefV1[];
  };
  minimumRetentionMs: number;
  nowMs?: number;
  maxEntries?: number;
}

export interface StoredProviderOptionsV1 {
  artifact: PrivateArtifactRefV1 & { kind: 'provider_options' };
  contentDigest: Sha256DigestV1;
}

/**
 * Schema-aware private store for canonical model request and response evidence.
 * It is intentionally not wired to production dispatch until MS-03/MS-04.
 */
export class ModelArtifactStoreV1 {
  private readonly storage: PrivateImmutableArtifactStorageV1<PrivateArtifactKindV1>;

  constructor(options: ModelArtifactStoreOptionsV1) {
    this.storage = new PrivateImmutableArtifactStorageV1({
      root: options.root ?? modelArtifactRoot(),
      namespace: 'model-artifacts',
      integrityKey: options.integrityKey,
      partitions: MODEL_ARTIFACT_PARTITIONS,
      maxArtifactBytes: options.maxArtifactBytes ?? DEFAULT_MODEL_ARTIFACT_MAX_BYTES,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.secureWindowsPath ? { secureWindowsPath: options.secureWindowsPath } : {}),
      ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
    });
  }

  writeSurface(surface: ModelSurfaceV1): PrivateArtifactRefV1 & { kind: 'model_surface' } {
    computeModelSurfaceDigestV1(surface);
    return this.storage.write('model_surface', Buffer.from(canonicalModelJsonV1(surface), 'utf8'));
  }

  readSurface(ref: PrivateArtifactRefV1 & { kind: 'model_surface' }): ModelSurfaceV1 {
    const value = this.parseCanonicalArtifact(this.storage.read(ref));
    try {
      assertModelSurfaceV1(value as ModelSurfaceV1);
      computeModelSurfaceDigestV1(value as ModelSurfaceV1);
    } catch {
      this.corrupt('Model Surface Artifact schema validation failed.');
    }
    return value as ModelSurfaceV1;
  }

  writeResponse(record: ModelResponseRecordV1): PrivateArtifactRefV1 & { kind: 'model_response' } {
    assertModelResponseRecordV1(record);
    return this.storage.write('model_response', Buffer.from(canonicalModelJsonV1(record), 'utf8'));
  }

  readResponse(ref: PrivateArtifactRefV1 & { kind: 'model_response' }): ModelResponseRecordV1 {
    const value = this.parseCanonicalArtifact(this.storage.read(ref));
    try {
      assertModelResponseRecordV1(value);
    } catch (error) {
      if (error instanceof PrivateArtifactStorageError) throw error;
      this.corrupt('Model Response Artifact schema validation failed.');
    }
    return value as ModelResponseRecordV1;
  }

  writeProviderOptions(value: CanonicalJsonObjectV1): StoredProviderOptionsV1 {
    const contentDigest = computeCanonicalProviderOptionsDigestV1(value);
    const artifact = this.storage.write(
      'provider_options',
      Buffer.from(canonicalModelJsonV1(value), 'utf8'),
    );
    return { artifact, contentDigest };
  }

  readProviderOptions(
    ref: PrivateArtifactRefV1 & { kind: 'provider_options' },
    expectedContentDigest: Sha256DigestV1,
  ): CanonicalJsonObjectV1 {
    const value = this.parseCanonicalArtifact(this.storage.read(ref));
    if (!isObject(value)) this.corrupt('Provider Options Artifact must contain an object.');
    let actualDigest: Sha256DigestV1;
    try {
      actualDigest = computeCanonicalProviderOptionsDigestV1(value as CanonicalJsonObjectV1);
    } catch {
      this.corrupt('Provider Options Artifact schema validation failed.');
    }
    if (actualDigest! !== expectedContentDigest) {
      this.corrupt('Provider Options Artifact digest does not match its Surface reference.');
    }
    return value as CanonicalJsonObjectV1;
  }

  collectGarbage(
    options: ModelArtifactGarbageCollectionOptionsV1,
  ): PrivateArtifactGarbageCollectionResultV1 {
    return this.storage.collectGarbage(
      options as PrivateArtifactGarbageCollectionOptionsV1<PrivateArtifactKindV1>,
    );
  }

  private parseCanonicalArtifact(bytes: Uint8Array): unknown {
    let text: string;
    let value: unknown;
    try {
      text = UTF8_DECODER.decode(bytes);
      value = JSON.parse(text);
      if (canonicalModelJsonV1(value) !== text) {
        this.corrupt('Private model Artifact is not canonical JSON.');
      }
    } catch (error) {
      if (error instanceof PrivateArtifactStorageError) throw error;
      this.corrupt('Private model Artifact is not valid canonical JSON.');
    }
    return value;
  }

  private corrupt(message: string): never {
    throw new PrivateArtifactStorageError('artifact_corrupt', message);
  }
}

function assertModelResponseRecordV1(value: unknown): asserts value is ModelResponseRecordV1 {
  canonicalModelJsonV1(value);
  assertExactKeys(value, [
    'schema',
    'invocationId',
    'surfaceIntegrityIdentifier',
    'route',
    'response',
    'nativeReplayState',
  ]);
  const record = value as Record<string, unknown>;
  assertExactKeys(record.schema, ['name', 'canonicalizerVersion', 'version']);
  const schema = record.schema as Record<string, unknown>;
  if (
    schema.name !== MODEL_RESPONSE_RECORD_SCHEMA_V1.name ||
    schema.canonicalizerVersion !== MODEL_RESPONSE_RECORD_SCHEMA_V1.canonicalizerVersion ||
    schema.version !== MODEL_RESPONSE_RECORD_SCHEMA_V1.version
  ) {
    throw new Error('unsupported response schema');
  }
  if (typeof record.invocationId !== 'string' || !SAFE_INVOCATION_ID.test(record.invocationId)) {
    throw new Error('invalid invocation identity');
  }
  if (
    typeof record.surfaceIntegrityIdentifier !== 'string' ||
    !INTEGRITY_IDENTIFIER.test(record.surfaceIntegrityIdentifier)
  ) {
    throw new Error('invalid surface integrity identity');
  }
  assertModelRouteIdentityV1(record.route);

  assertExactKeys(record.response, ['message', 'finishReason', 'usage', 'providerMetadata']);
  const response = record.response as Record<string, unknown>;
  assertCanonicalModelMessageV1(response.message);
  if ((response.message as { role: string }).role !== 'assistant') {
    throw new Error('response message must be assistant');
  }
  if (
    typeof response.finishReason !== 'string' ||
    !MODEL_RESPONSE_FINISH_REASONS.has(response.finishReason)
  ) {
    throw new Error('invalid finish reason');
  }
  assertExactKeys(response.usage, [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
  ]);
  for (const count of Object.values(response.usage as Record<string, unknown>)) {
    if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0)) {
      throw new Error('invalid token usage');
    }
  }
  if (!isObject(response.providerMetadata)) throw new Error('invalid provider metadata');
  canonicalModelJsonV1(response.providerMetadata);

  if (record.nativeReplayState !== null) {
    assertExactKeys(record.nativeReplayState, ['owner', 'value']);
    const nativeReplayState = record.nativeReplayState as Record<string, unknown>;
    assertModelAdapterReplayOwnerV1(nativeReplayState.owner);
    canonicalModelJsonV1(nativeReplayState.value);
    if (
      canonicalModelJsonV1(nativeReplayState.owner) !==
      canonicalModelJsonV1((record.route as ModelResponseRecordV1['route']).replayOwner)
    ) {
      throw new Error('native replay owner does not match route owner');
    }
  }
}

function assertExactKeys(value: unknown, expected: readonly string[]): void {
  if (!isObject(value)) throw new Error('expected object');
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new Error('unexpected object fields');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
