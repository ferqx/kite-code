import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalModelJsonV1,
  computeCanonicalProviderOptionsDigestV1,
  computeResolvedModelCapabilitiesDigestV1,
  ModelArtifactStoreV1,
  PrivateArtifactStorageError,
  PrivateImmutableArtifactStorageV1,
} from '@kite/builtin-runtime/model';
import {
  MODEL_RESPONSE_RECORD_SCHEMA_V1,
  MODEL_SURFACE_SCHEMA_V1,
  type ModelResponseRecordV1,
  type ModelSurfaceV1,
} from '@kite/runtime-spi';

const INTEGRITY_KEY = Buffer.alloc(32, 0x51);
const OTHER_KEY = Buffer.alloc(32, 0x52);
let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function artifactRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'kite-model-artifacts-'));
  return join(tempRoot, 'model-artifacts');
}

function surface(): ModelSurfaceV1 {
  const capabilities = {
    providerName: 'fixture-provider',
    modelName: 'fixture-model',
    contextWindowTokens: 128_000,
    contextWindowSource: 'explicit_config' as const,
    maxOutputTokens: 8_192,
    maxOutputTokensSource: 'explicit_config' as const,
    tokenizerFamily: 'fixture-tokenizer',
    tokenizerSource: 'adapter_runtime' as const,
    supportsUsageMetadata: true,
    supportsUsageMetadataSource: 'adapter_runtime' as const,
    supportsPromptCache: false,
    supportsPromptCacheSource: 'explicit_config' as const,
    supportsToolCalls: true,
    supportsToolCallsSource: 'adapter_runtime' as const,
    streaming: true,
    streamingSource: 'explicit_config' as const,
  };
  const providerOptions = { fixture: { thinking: 'disabled' } };
  return {
    schema: MODEL_SURFACE_SCHEMA_V1,
    purpose: 'primary_agent',
    route: {
      providerKind: 'fixture-provider',
      modelName: 'fixture-model',
      adapterProtocolVersion: 'adapter-v1',
      routeFingerprint: `sha256:${'1'.repeat(64)}`,
      replayOwner: {
        adapterKind: 'fixture-adapter',
        adapterProtocolVersion: 'adapter-v1',
        ownerFingerprint: `sha256:${'2'.repeat(64)}`,
      },
    },
    request: {
      system: 'private system instruction',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'private user prompt' }] }],
      tools: [
        {
          name: 'read_file',
          description: 'Read one governed file.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      temperature: 0,
      maxOutputTokens: 1024,
      stopPolicy: { kind: 'single_step', maxSteps: 1 },
      transport: 'stream',
      sdkRetry: { maxRetries: 0 },
      resolvedCapabilities: {
        value: capabilities,
        digest: computeResolvedModelCapabilitiesDigestV1(capabilities),
      },
      providerOptions: {
        kind: 'inline',
        value: providerOptions,
        digest: computeCanonicalProviderOptionsDigestV1(providerOptions),
      },
    },
  };
}

function response(modelSurface = surface()): ModelResponseRecordV1 {
  return {
    schema: MODEL_RESPONSE_RECORD_SCHEMA_V1,
    invocationId: 'invocation-fixture-1',
    surfaceIntegrityIdentifier: `hmac-sha256:${'3'.repeat(64)}`,
    route: modelSurface.route,
    response: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'text', text: 'private response' },
        ],
      },
      finishReason: 'stop',
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cacheReadTokens: 0,
      },
      providerMetadata: { responseId: 'private-provider-response-id' },
    },
    nativeReplayState: {
      owner: modelSurface.route.replayOwner,
      value: { nativeRequestId: 'private-native-id' },
    },
  };
}

function rawStorage(root: string) {
  return new PrivateImmutableArtifactStorageV1({
    root,
    namespace: 'model-artifacts',
    integrityKey: INTEGRITY_KEY,
    partitions: [
      { kind: 'model_surface', directory: 'surfaces', extension: '.json' },
      { kind: 'model_response', directory: 'responses', extension: '.json' },
      { kind: 'provider_options', directory: 'provider-options', extension: '.json' },
    ] as const,
    maxArtifactBytes: 16 * 1024 * 1024,
  });
}

describe('ModelArtifactStoreV1', () => {
  test('stores canonical Surface and response evidence in independent opaque partitions', () => {
    const root = artifactRoot();
    const store = new ModelArtifactStoreV1({ root, integrityKey: INTEGRITY_KEY });
    const modelSurface = surface();
    const modelResponse = response(modelSurface);

    const surfaceRef = store.writeSurface(modelSurface);
    const responseRef = store.writeResponse(modelResponse);

    expect(store.readSurface(surfaceRef)).toEqual(modelSurface);
    expect(store.readResponse(responseRef)).toEqual(modelResponse);
    expect(surfaceRef.kind).toBe('model_surface');
    expect(responseRef.kind).toBe('model_response');
    expect(JSON.stringify(surfaceRef)).not.toContain('private');
    expect(JSON.stringify(responseRef)).not.toContain('private');
    expect(readFileSync(join(root, 'surfaces', `${surfaceRef.artifactId}.json`), 'utf8')).toBe(
      canonicalModelJsonV1(modelSurface),
    );
    expect(readFileSync(join(root, 'responses', `${responseRef.artifactId}.json`), 'utf8')).toBe(
      canonicalModelJsonV1(modelResponse),
    );
  });

  test('stores provider options by semantic digest without exposing their storage locator', () => {
    const root = artifactRoot();
    const store = new ModelArtifactStoreV1({ root, integrityKey: INTEGRITY_KEY });
    const value = { fixture: { thinking: 'disabled', seed: 7 } };

    const stored = store.writeProviderOptions(value);

    expect(stored.contentDigest).toBe(computeCanonicalProviderOptionsDigestV1(value));
    expect(store.readProviderOptions(stored.artifact, stored.contentDigest)).toEqual(value);
    expect(stored.artifact.kind).toBe('provider_options');
    expect(JSON.stringify(stored.artifact)).not.toContain(stored.contentDigest);
    expect(() => store.readProviderOptions(stored.artifact, `sha256:${'f'.repeat(64)}`)).toThrow(
      PrivateArtifactStorageError,
    );
  });

  test('rejects validly stored but non-canonical or schema-invalid response artifacts', () => {
    const root = artifactRoot();
    const modelStore = new ModelArtifactStoreV1({ root, integrityKey: INTEGRITY_KEY });
    const storage = rawStorage(root);
    const invalid = { ...response(), unexpected: 'field' };
    const invalidRef = storage.write(
      'model_response',
      Buffer.from(canonicalModelJsonV1(invalid), 'utf8'),
    );
    expect(() => modelStore.readResponse(invalidRef)).toThrow(PrivateArtifactStorageError);

    const nonCanonicalRef = storage.write(
      'model_response',
      Buffer.from(`{ "schema": ${JSON.stringify(MODEL_RESPONSE_RECORD_SCHEMA_V1)} }`, 'utf8'),
    );
    expect(() => modelStore.readResponse(nonCanonicalRef)).toThrow(PrivateArtifactStorageError);

    let getterCalled = false;
    const accessorResponse = { ...response() };
    Object.defineProperty(accessorResponse, 'invocationId', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'invocation-accessor';
      },
    });
    expect(() => modelStore.writeResponse(accessorResponse)).toThrow();
    expect(getterCalled).toBe(false);
  });

  test('fails closed when the integrity key is lost and never repairs corrupted evidence', () => {
    const root = artifactRoot();
    const writer = new ModelArtifactStoreV1({ root, integrityKey: INTEGRITY_KEY });
    const ref = writer.writeSurface(surface());

    const wrongKeyStore = new ModelArtifactStoreV1({ root, integrityKey: OTHER_KEY });
    expect(() => wrongKeyStore.readSurface(ref)).toThrow(PrivateArtifactStorageError);

    const target = join(root, 'surfaces', `${ref.artifactId}.json`);
    writeFileSync(target, '{}', 'utf8');
    chmodSync(target, 0o600);
    expect(() => writer.readSurface(ref)).toThrow(PrivateArtifactStorageError);
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });

  test('keeps reachable Surface evidence while collecting old orphan responses', () => {
    const root = artifactRoot();
    const store = new ModelArtifactStoreV1({ root, integrityKey: INTEGRITY_KEY });
    const surfaceRef = store.writeSurface(surface());
    const responseRef = store.writeResponse(response());

    const result = store.collectGarbage({
      reachability: { complete: true, reachable: [surfaceRef] },
      minimumRetentionMs: 0,
      nowMs: Date.now() + 1,
    });

    expect(result.deletedArtifacts).toBe(1);
    expect(store.readSurface(surfaceRef).request.system).toBe('private system instruction');
    expect(() => store.readResponse(responseRef)).toThrow(PrivateArtifactStorageError);
  });
});
