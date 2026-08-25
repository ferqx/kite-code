import type {
  CanonicalJsonObject,
  ModelResponseRecord,
  ModelSurface,
  PrivateArtifactKind,
  PrivateArtifactRef,
  Sha256Digest,
} from '@kite/runtime-spi';
import { MODEL_RESPONSE_RECORD_SCHEMA_ } from '@kite/runtime-spi';
import { modelArtifactRoot } from './artifact-paths';
import {
  type PrivateArtifactGarbageCollectionOptions,
  type PrivateArtifactGarbageCollectionResult,
  PrivateArtifactStorageError,
  type PrivateArtifactWriteFaultPoint,
  PrivateImmutableArtifactStorage,
} from './private-immutable-artifacts';
import {
  assertCanonicalModelMessage,
  assertModelAdapterReplayOwner,
  assertModelRouteIdentity,
  assertModelSurface,
  canonicalModelJson,
  computeCanonicalProviderOptionsDigest,
  computeModelSurfaceDigest,
} from './surface-canonicalizer';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const DEFAULT_MODEL_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const INTEGRITY_IDENTIFIER = /^sha256:[0-9a-f]{64}$/;
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

export interface ModelArtifactStoreOptions {
  root?: string;
  maxArtifactBytes?: number;
  platform?: NodeJS.Platform;
  secureWindowsPath?: (path: string) => void;
  faultInjector?: (point: PrivateArtifactWriteFaultPoint) => void;
}

export interface ModelArtifactGarbageCollectionOptions {
  /** Must be a complete union of references from every retained session and fork. */
  reachability: {
    complete: boolean;
    reachable: readonly PrivateArtifactRef[];
  };
  minimumRetentionMs: number;
  nowMs?: number;
  maxEntries?: number;
}

export interface StoredProviderOptions {
  artifact: PrivateArtifactRef & { kind: 'provider_options' };
  contentDigest: Sha256Digest;
}

/**
 * Schema-aware private store for canonical model request and response evidence.
 * It is intentionally not wired to production dispatch until MS-03/MS-04.
 */
export class ModelArtifactStore {
  private readonly storage: PrivateImmutableArtifactStorage<PrivateArtifactKind>;

  constructor(options: ModelArtifactStoreOptions) {
    this.storage = new PrivateImmutableArtifactStorage({
      root: options.root ?? modelArtifactRoot(),
      namespace: 'model-artifacts',
      partitions: MODEL_ARTIFACT_PARTITIONS,
      maxArtifactBytes: options.maxArtifactBytes ?? DEFAULT_MODEL_ARTIFACT_MAX_BYTES,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.secureWindowsPath ? { secureWindowsPath: options.secureWindowsPath } : {}),
      ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
    });
  }

  writeSurface(surface: ModelSurface): PrivateArtifactRef & { kind: 'model_surface' } {
    computeModelSurfaceDigest(surface);
    return this.storage.write('model_surface', Buffer.from(canonicalModelJson(surface), 'utf8'));
  }

  readSurface(ref: PrivateArtifactRef & { kind: 'model_surface' }): ModelSurface {
    const value = this.parseCanonicalArtifact(this.storage.read(ref));
    try {
      assertModelSurface(value as ModelSurface);
      computeModelSurfaceDigest(value as ModelSurface);
    } catch {
      this.corrupt('Model Surface Artifact schema validation failed.');
    }
    return value as ModelSurface;
  }

  writeResponse(record: ModelResponseRecord): PrivateArtifactRef & { kind: 'model_response' } {
    assertModelResponseRecord(record);
    return this.storage.write('model_response', Buffer.from(canonicalModelJson(record), 'utf8'));
  }

  readResponse(ref: PrivateArtifactRef & { kind: 'model_response' }): ModelResponseRecord {
    const value = this.parseCanonicalArtifact(this.storage.read(ref));
    try {
      assertModelResponseRecord(value);
    } catch (error) {
      if (error instanceof PrivateArtifactStorageError) throw error;
      this.corrupt('Model Response Artifact schema validation failed.');
    }
    return value as ModelResponseRecord;
  }

  writeProviderOptions(value: CanonicalJsonObject): StoredProviderOptions {
    const contentDigest = computeCanonicalProviderOptionsDigest(value);
    const artifact = this.storage.write(
      'provider_options',
      Buffer.from(canonicalModelJson(value), 'utf8'),
    );
    return { artifact, contentDigest };
  }

  readProviderOptions(
    ref: PrivateArtifactRef & { kind: 'provider_options' },
    expectedContentDigest: Sha256Digest,
  ): CanonicalJsonObject {
    const value = this.parseCanonicalArtifact(this.storage.read(ref));
    if (!isObject(value)) this.corrupt('Provider Options Artifact must contain an object.');
    let actualDigest: Sha256Digest;
    try {
      actualDigest = computeCanonicalProviderOptionsDigest(value as CanonicalJsonObject);
    } catch {
      this.corrupt('Provider Options Artifact schema validation failed.');
    }
    if (actualDigest! !== expectedContentDigest) {
      this.corrupt('Provider Options Artifact digest does not match its Surface reference.');
    }
    return value as CanonicalJsonObject;
  }

  collectGarbage(
    options: ModelArtifactGarbageCollectionOptions,
  ): PrivateArtifactGarbageCollectionResult {
    return this.storage.collectGarbage(
      options as PrivateArtifactGarbageCollectionOptions<PrivateArtifactKind>,
    );
  }

  private parseCanonicalArtifact(bytes: Uint8Array): unknown {
    let text: string;
    let value: unknown;
    try {
      text = UTF8_DECODER.decode(bytes);
      value = JSON.parse(text);
      if (canonicalModelJson(value) !== text) {
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

function assertModelResponseRecord(value: unknown): asserts value is ModelResponseRecord {
  canonicalModelJson(value);
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
    schema.name !== MODEL_RESPONSE_RECORD_SCHEMA_.name ||
    schema.canonicalizerVersion !== MODEL_RESPONSE_RECORD_SCHEMA_.canonicalizerVersion ||
    schema.version !== MODEL_RESPONSE_RECORD_SCHEMA_.version
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
  assertModelRouteIdentity(record.route);

  assertExactKeys(record.response, ['message', 'finishReason', 'usage', 'providerMetadata']);
  const response = record.response as Record<string, unknown>;
  assertCanonicalModelMessage(response.message);
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
  canonicalModelJson(response.providerMetadata);

  if (record.nativeReplayState !== null) {
    assertExactKeys(record.nativeReplayState, ['owner', 'value']);
    const nativeReplayState = record.nativeReplayState as Record<string, unknown>;
    assertModelAdapterReplayOwner(nativeReplayState.owner);
    canonicalModelJson(nativeReplayState.value);
    if (
      canonicalModelJson(nativeReplayState.owner) !==
      canonicalModelJson((record.route as ModelResponseRecord['route']).replayOwner)
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
