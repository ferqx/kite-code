import { describe, expect, test } from 'bun:test';
import {
  canonicalModelJsonV1,
  computeCanonicalProviderOptionsDigestV1,
  computeModelRouteIdentityDigestV1,
  computeModelSurfaceDigestLayersV1,
  computeModelSurfaceDigestV1,
  computeResolvedModelCapabilitiesDigestV1,
  ModelSurfaceCanonicalizationError,
} from '@kite/builtin-runtime/model';
import {
  type CanonicalJsonObjectV1,
  MODEL_INVOCATION_ENVELOPE_SCHEMA_V1,
  MODEL_INVOCATION_PURPOSES_V1,
  MODEL_PURPOSE_TO_PROVIDER_DISPATCH_V1,
  MODEL_RESPONSE_RECORD_SCHEMA_V1,
  MODEL_SURFACE_SCHEMA_V1,
  type ModelInvocationEnvelopeV1,
  type ModelResponseRecordV1,
  type ModelSurfaceV1,
  type Sha256DigestV1,
} from '@kite/runtime-spi';

function digest(hex: string): Sha256DigestV1 {
  return `sha256:${hex.repeat(64)}`;
}

function baseSurface(): ModelSurfaceV1 {
  const capabilities: ModelSurfaceV1['request']['resolvedCapabilities']['value'] = {
    providerName: 'mock-provider',
    modelName: 'mock-model',
    contextWindowTokens: 32_768,
    contextWindowSource: 'explicit_config',
    maxOutputTokens: 2_048,
    maxOutputTokensSource: 'adapter_runtime',
    tokenizerFamily: 'mock-tokenizer',
    tokenizerSource: 'compatibility_config',
    supportsUsageMetadata: true,
    supportsUsageMetadataSource: 'adapter_runtime',
    supportsPromptCache: false,
    supportsPromptCacheSource: 'explicit_config',
    supportsToolCalls: true,
    supportsToolCallsSource: 'adapter_runtime',
    streaming: true,
    streamingSource: null,
  };
  const providerOptions: CanonicalJsonObjectV1 = {
    mock: {
      thinking: { type: 'disabled' },
    },
  };
  return {
    schema: MODEL_SURFACE_SCHEMA_V1,
    purpose: 'primary_agent',
    route: {
      providerKind: 'mock',
      modelName: 'mock-model',
      adapterProtocolVersion: 'ai-sdk-v3',
      routeFingerprint: digest('1'),
      replayOwner: {
        adapterKind: 'openai-compatible',
        adapterProtocolVersion: 'ai-sdk-v3',
        ownerFingerprint: digest('2'),
      },
    },
    request: {
      system: 'System contract.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'alpha' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'inspect' },
            {
              type: 'tool_call',
              toolCallId: 'call-1',
              toolName: 'read_file',
              input: { path: 'README.md' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call-1',
              toolName: 'read_file',
              output: { type: 'text', value: 'contents' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      temperature: 0,
      maxOutputTokens: 1_024,
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

function cloneSurface(surface = baseSurface()): ModelSurfaceV1 {
  return JSON.parse(JSON.stringify(surface)) as ModelSurfaceV1;
}

function refreshNestedDigests(surface: ModelSurfaceV1): void {
  surface.request.resolvedCapabilities.digest = computeResolvedModelCapabilitiesDigestV1(
    surface.request.resolvedCapabilities.value,
  );
  if (surface.request.providerOptions.kind === 'inline') {
    surface.request.providerOptions.digest = computeCanonicalProviderOptionsDigestV1(
      surface.request.providerOptions.value,
    );
  }
}

function envelope(surfaceArtifactId: string, invocationId: string): ModelInvocationEnvelopeV1 {
  return {
    schema: MODEL_INVOCATION_ENVELOPE_SCHEMA_V1,
    surface: {
      artifact: {
        artifactId: surfaceArtifactId,
        kind: 'model_surface',
        integrityIdentifier: `hmac-sha256:${'3'.repeat(64)}`,
        byteLength: 4_096,
      },
      surfaceIntegrityIdentifier: `hmac-sha256:${'4'.repeat(64)}`,
    },
    admission: {
      providerDataPolicyRevision: 'policy-r1',
      routeIdentityDigest: digest('5'),
      payloadClassificationDigest: digest('6'),
      admitted: true,
    },
    provenance: {
      invocationId,
      threadId: 'thread-1',
      turnId: 'turn-1',
      parentInvocationId: null,
      parentToolCallId: null,
      stateRevision: 42,
      contextCheckpointId: null,
      promptContractVersion: 'v2',
      projectionEnvironmentDigest: digest('7'),
      capabilityBindingDigest: digest('8'),
    },
    resource: {
      budget: {
        kind: 'reservation',
        reservationId: 'reservation-1',
        parentReservationId: null,
      },
      limits: {
        maxAttempts: 3,
        perAttemptTimeoutMs: 30_000,
        totalTimeBudgetMs: 60_000,
      },
    },
  };
}

describe('Model Surface protocol', () => {
  test('keeps the five model purposes in an exhaustive one-to-one Provider mapping', () => {
    expect(MODEL_INVOCATION_PURPOSES_V1).toEqual([
      'primary_agent',
      'context_compaction',
      'auto_review',
      'verification_review',
      'subagent',
    ]);
    expect(Object.keys(MODEL_PURPOSE_TO_PROVIDER_DISPATCH_V1)).toEqual([
      ...MODEL_INVOCATION_PURPOSES_V1,
    ]);
    expect(Object.values(MODEL_PURPOSE_TO_PROVIDER_DISPATCH_V1)).toEqual([
      'primary_model',
      'compaction',
      'auto_review',
      'verification_review',
      'subagent',
    ]);
    expect(new Set(Object.values(MODEL_PURPOSE_TO_PROVIDER_DISPATCH_V1)).size).toBe(5);
  });

  test('keeps response records JSON-safe without exposing an artifact path', () => {
    const response: ModelResponseRecordV1 = {
      schema: MODEL_RESPONSE_RECORD_SCHEMA_V1,
      invocationId: 'invocation-1',
      surfaceIntegrityIdentifier: `hmac-sha256:${'4'.repeat(64)}`,
      route: baseSurface().route,
      response: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
        },
        finishReason: 'stop',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cacheReadTokens: null,
        },
        providerMetadata: {},
      },
      nativeReplayState: null,
    };

    const encoded = canonicalModelJsonV1(response);
    expect(encoded).toContain('"invocationId":"invocation-1"');
    expect(encoded).not.toContain('relativePath');
    expect(encoded).not.toContain('endpoint');
  });
});

describe('private model evidence canonical JSON', () => {
  test('orders object keys while preserving semantic array order and exact text bytes', () => {
    expect(canonicalModelJsonV1({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalModelJsonV1({ values: ['a', 'b'] })).not.toBe(
      canonicalModelJsonV1({ values: ['b', 'a'] }),
    );
    expect(canonicalModelJsonV1({ text: 'line\n' })).not.toBe(
      canonicalModelJsonV1({ text: 'line\r\n' }),
    );
  });

  test.each([
    ['undefined', { value: undefined }],
    ['NaN', { value: Number.NaN }],
    ['infinity', { value: Number.POSITIVE_INFINITY }],
    ['bigint', { value: 1n }],
    ['binary', new Uint8Array([1, 2, 3])],
    ['custom prototype', new (class Evidence {})()],
    ['lone surrogate', { value: '\ud800' }],
  ])('rejects non-JSON evidence: %s', (_name, value) => {
    expect(() => canonicalModelJsonV1(value)).toThrow(ModelSurfaceCanonicalizationError);
  });

  test('rejects sparse arrays, accessors, symbol fields, and cycles', () => {
    const sparse = new Array(2);
    sparse[1] = 'present';
    expect(() => canonicalModelJsonV1(sparse)).toThrow(/sparse/);

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'secret' });
    expect(() => canonicalModelJsonV1(accessor)).toThrow(/accessor/);

    const symbol = { value: true } as Record<PropertyKey, unknown>;
    symbol[Symbol('private')] = true;
    expect(() => canonicalModelJsonV1(symbol)).toThrow(/symbol/);

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalModelJsonV1(cycle)).toThrow(/circular/);
  });
});

describe('Model Surface layered digests', () => {
  test('is stable across object insertion order and returns distinct digest domains', () => {
    const first = baseSurface();
    const reordered = JSON.parse(canonicalModelJsonV1(first)) as ModelSurfaceV1;
    const layers = computeModelSurfaceDigestLayersV1(first);

    expect(computeModelSurfaceDigestV1(reordered)).toBe(layers.surfaceDigest);
    expect(layers.routeIdentityDigest).toBe(computeModelRouteIdentityDigestV1(first.route));
    expect(layers.surfaceDigest).not.toBe(layers.routeIdentityDigest);
    expect(layers.resolvedCapabilitiesDigest).not.toBe(layers.providerOptionsDigest);
  });

  test('changes for every provider dispatch semantic layer', () => {
    const original = baseSurface();
    const originalDigest = computeModelSurfaceDigestV1(original);
    const variants: Array<[string, (surface: ModelSurfaceV1) => void]> = [
      [
        'purpose',
        (surface) => {
          surface.purpose = 'context_compaction';
        },
      ],
      [
        'provider kind',
        (surface) => {
          surface.route.providerKind = 'other';
        },
      ],
      [
        'model',
        (surface) => {
          surface.route.modelName = 'other-model';
        },
      ],
      [
        'adapter protocol',
        (surface) => {
          surface.route.adapterProtocolVersion = 'ai-sdk-v4';
          surface.route.replayOwner.adapterProtocolVersion = 'ai-sdk-v4';
        },
      ],
      [
        'route fingerprint',
        (surface) => {
          surface.route.routeFingerprint = digest('9');
        },
      ],
      [
        'replay owner',
        (surface) => {
          surface.route.replayOwner.ownerFingerprint = digest('a');
        },
      ],
      [
        'system',
        (surface) => {
          surface.request.system = 'Different system contract.';
        },
      ],
      [
        'same-length message text',
        (surface) => {
          surface.request.messages = [
            { role: 'user', content: [{ type: 'text', text: 'bravo' }] },
            ...surface.request.messages.slice(1),
          ];
        },
      ],
      [
        'message order',
        (surface) => {
          surface.request.messages = [...surface.request.messages].reverse();
        },
      ],
      [
        'tool description',
        (surface) => {
          surface.request.tools = [{ ...surface.request.tools[0]!, description: 'Read safely.' }];
        },
      ],
      [
        'tool schema',
        (surface) => {
          surface.request.tools = [
            {
              ...surface.request.tools[0]!,
              inputSchema: { type: 'object', properties: { file: { type: 'string' } } },
            },
          ];
        },
      ],
      [
        'temperature',
        (surface) => {
          surface.request.temperature = 0.5;
        },
      ],
      [
        'max output',
        (surface) => {
          surface.request.maxOutputTokens = 2_000;
        },
      ],
      [
        'transport',
        (surface) => {
          surface.request.transport = 'generate';
        },
      ],
      [
        'resolved capability value',
        (surface) => {
          surface.request.resolvedCapabilities.value.contextWindowTokens = 65_536;
        },
      ],
      [
        'provider options',
        (surface) => {
          if (surface.request.providerOptions.kind === 'inline') {
            surface.request.providerOptions.value = { mock: { thinking: { type: 'enabled' } } };
          }
        },
      ],
    ];

    for (const [name, mutate] of variants) {
      const candidate = cloneSurface(original);
      mutate(candidate);
      refreshNestedDigests(candidate);
      expect(computeModelSurfaceDigestV1(candidate), name).not.toBe(originalDigest);
    }
  });

  test('keeps invocation, admission, resource, time, process, and artifact identity outside surfaceDigest', () => {
    const surface = baseSurface();
    const before = computeModelSurfaceDigestV1(surface);
    const first = envelope('opaque-artifact-a', 'invocation-a');
    const second = envelope('opaque-artifact-b', 'invocation-b');
    second.provenance.threadId = 'thread-2';
    second.provenance.turnId = 'turn-2';
    second.provenance.stateRevision = 900;
    second.admission.admitted = false;
    second.resource = {
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      limits: { maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 1_000 },
    };

    expect(canonicalModelJsonV1(first)).not.toBe(canonicalModelJsonV1(second));
    expect(computeModelSurfaceDigestV1(surface)).toBe(before);
  });

  test('keeps Provider option storage representation and opaque locator outside surfaceDigest', () => {
    const inline = baseSurface();
    if (inline.request.providerOptions.kind !== 'inline') throw new Error('expected inline');
    const contentDigest = inline.request.providerOptions.digest;
    const artifactBacked = cloneSurface(inline);
    artifactBacked.request.providerOptions = {
      kind: 'artifact',
      artifact: {
        artifactId: 'opaque-options-a',
        kind: 'provider_options',
        integrityIdentifier: `hmac-sha256:${'b'.repeat(64)}`,
        byteLength: 128,
      },
      contentDigest,
    };
    const relocated = cloneSurface(artifactBacked);
    if (relocated.request.providerOptions.kind !== 'artifact') {
      throw new Error('expected artifact');
    }
    relocated.request.providerOptions.artifact.artifactId = 'opaque-options-b';
    relocated.request.providerOptions.artifact.integrityIdentifier = `hmac-sha256:${'c'.repeat(64)}`;
    relocated.request.providerOptions.artifact.byteLength = 256;

    expect(computeModelSurfaceDigestV1(artifactBacked)).toBe(computeModelSurfaceDigestV1(inline));
    expect(computeModelSurfaceDigestV1(relocated)).toBe(
      computeModelSurfaceDigestV1(artifactBacked),
    );
  });

  test('fails closed on stale nested evidence digests', () => {
    const staleCapabilities = cloneSurface();
    staleCapabilities.request.resolvedCapabilities.value.contextWindowTokens = 64_000;
    expect(() => computeModelSurfaceDigestV1(staleCapabilities)).toThrow(/capability digest/);

    const staleOptions = cloneSurface();
    if (staleOptions.request.providerOptions.kind === 'inline') {
      staleOptions.request.providerOptions.value = { mock: { thinking: { type: 'enabled' } } };
    }
    expect(() => computeModelSurfaceDigestV1(staleOptions)).toThrow(/options digest/);
  });
});

describe('Model Surface fail-closed contract', () => {
  test('rejects unknown top-level and nested fields', () => {
    const top = cloneSurface() as unknown as Record<string, unknown>;
    top.legacy = true;
    expect(() => computeModelSurfaceDigestV1(top as unknown as ModelSurfaceV1)).toThrow(
      /unsupported or missing fields/,
    );

    const nested = cloneSurface();
    (nested.route as unknown as Record<string, unknown>).baseURL = 'https://private.invalid';
    expect(() => computeModelSurfaceDigestV1(nested)).toThrow(/unsupported or missing fields/);
  });

  test('rejects credential-bearing Provider options without echoing secret values', () => {
    const secret = 'UNIQUE_MODEL_SURFACE_SECRET_MARKER';
    const unsafeOptions: CanonicalJsonObjectV1[] = [
      { mock: { headers: { Authorization: `Bearer ${secret}` } } },
      { mock: { api_token: secret } },
      { mock: { authToken: secret } },
      { mock: { bearerToken: secret } },
      { mock: { defaultHeaders: { mode: 'safe' } } },
      { mock: { proxyUrl: 'https://private.invalid' } },
      { mock: { mode: `Bearer ${secret}` } },
      { mock: { mode: 'https://private.invalid?token=opaque' } },
      { mock: { mode: 'api.private.invalid/v1' } },
      { mock: { mode: `sk-${'a'.repeat(24)}` } },
      { mock: { mode: `sk-proj-${'b'.repeat(24)}` } },
    ];

    for (const value of unsafeOptions) {
      try {
        computeCanonicalProviderOptionsDigestV1(value);
        throw new Error('expected Provider options to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(ModelSurfaceCanonicalizationError);
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  test('requires Provider options and tool schemas to remain JSON objects at runtime', () => {
    for (const invalid of [null, [], 'inline', 42]) {
      expect(() =>
        computeCanonicalProviderOptionsDigestV1(invalid as unknown as CanonicalJsonObjectV1),
      ).toThrow(ModelSurfaceCanonicalizationError);
    }

    const invalidOptions = cloneSurface();
    if (invalidOptions.request.providerOptions.kind !== 'inline') {
      throw new Error('expected inline');
    }
    invalidOptions.request.providerOptions.value = [] as unknown as CanonicalJsonObjectV1;
    expect(() => computeModelSurfaceDigestV1(invalidOptions)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const invalidSchema = cloneSurface();
    invalidSchema.request.tools = [
      {
        ...invalidSchema.request.tools[0]!,
        inputSchema: [] as unknown as CanonicalJsonObjectV1,
      },
    ];
    expect(() => computeModelSurfaceDigestV1(invalidSchema)).toThrow(
      ModelSurfaceCanonicalizationError,
    );
  });

  test('does not admit credential or endpoint fields into route identity', () => {
    const secret = 'UNIQUE_ROUTE_SECRET_MARKER';
    const surface = cloneSurface();
    Object.assign(surface.route, {
      apiKey: secret,
      endpoint: `https://${secret}.invalid`,
    });
    try {
      computeModelSurfaceDigestV1(surface);
      throw new Error('expected route identity to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelSurfaceCanonicalizationError);
      expect(String(error)).not.toContain(secret);
    }
  });

  test('rejects endpoint-shaped route values even without unknown fields', () => {
    const unsafeProvider = cloneSurface();
    unsafeProvider.route.providerKind = 'https://private.invalid';
    expect(() => computeModelRouteIdentityDigestV1(unsafeProvider.route)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const unsafeModel = cloneSurface();
    unsafeModel.route.modelName = 'model:https://private.invalid?credential=opaque';
    expect(() => computeModelRouteIdentityDigestV1(unsafeModel.route)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const rawEndpointModel = cloneSurface();
    rawEndpointModel.route.modelName = 'api.openai.com/v1';
    expect(() => computeModelRouteIdentityDigestV1(rawEndpointModel.route)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const endpointLocator = cloneSurface();
    endpointLocator.request.providerOptions = {
      kind: 'artifact',
      artifact: {
        artifactId: 'https://private.invalid/options',
        kind: 'provider_options',
        integrityIdentifier: `hmac-sha256:${'d'.repeat(64)}`,
        byteLength: 64,
      },
      contentDigest: digest('e'),
    };
    expect(() => computeModelSurfaceDigestV1(endpointLocator)).toThrow(
      ModelSurfaceCanonicalizationError,
    );
  });

  test('requires route and replay-owner adapter protocol versions to agree', () => {
    const protocolMismatch = cloneSurface();
    protocolMismatch.route.replayOwner.adapterProtocolVersion = 'adapter-protocol-v2';
    expect(() => computeModelRouteIdentityDigestV1(protocolMismatch.route)).toThrow(
      ModelSurfaceCanonicalizationError,
    );
  });

  test('rejects executable tool closures and unsupported provider-native message parts', () => {
    const closure = cloneSurface();
    Object.assign(closure.request.tools[0]!, { execute: () => 'not evidence' });
    expect(() => computeModelSurfaceDigestV1(closure)).toThrow(ModelSurfaceCanonicalizationError);

    const nativePart = cloneSurface();
    nativePart.request.messages = [
      {
        role: 'user',
        content: [{ type: 'image', data: new Uint8Array([1, 2, 3]) }],
      },
    ] as unknown as ModelSurfaceV1['request']['messages'];
    expect(() => computeModelSurfaceDigestV1(nativePart)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const nullPart = cloneSurface();
    nullPart.request.messages = [
      { role: 'assistant', content: [null] },
    ] as unknown as ModelSurfaceV1['request']['messages'];
    expect(() => computeModelSurfaceDigestV1(nullPart)).toThrow(ModelSurfaceCanonicalizationError);
  });

  test('rejects attempts to enable SDK retry or multi-step execution', () => {
    const retry = cloneSurface();
    (retry.request.sdkRetry as { maxRetries: number }).maxRetries = 1;
    expect(() => computeModelSurfaceDigestV1(retry)).toThrow(/SDK retries/);

    const multiStep = cloneSurface();
    (multiStep.request.stopPolicy as { kind: string; maxSteps: number }).maxSteps = 2;
    expect(() => computeModelSurfaceDigestV1(multiStep)).toThrow(/single-step/);
  });
});
