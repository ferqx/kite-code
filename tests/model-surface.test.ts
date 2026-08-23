import { describe, expect, test } from 'bun:test';
import {
  canonicalModelJson,
  computeCanonicalProviderOptionsDigest,
  computeModelRouteIdentityDigest,
  computeModelSurfaceDigest,
  computeModelSurfaceDigestLayers,
  computeResolvedModelCapabilitiesDigest,
  ModelSurfaceCanonicalizationError,
} from '@kite/builtin-runtime/model';
import {
  type CanonicalJsonObject,
  MODEL_INVOCATION_ENVELOPE_SCHEMA_,
  MODEL_INVOCATION_PURPOSES_,
  MODEL_PURPOSE_TO_PROVIDER_DISPATCH_,
  MODEL_RESPONSE_RECORD_SCHEMA_,
  MODEL_SURFACE_SCHEMA_,
  type ModelInvocationEnvelope,
  type ModelResponseRecord,
  type ModelSurface,
  type Sha256Digest,
} from '@kite/runtime-spi';

function digest(hex: string): Sha256Digest {
  return `sha256:${hex.repeat(64)}`;
}

function baseSurface(): ModelSurface {
  const capabilities: ModelSurface['request']['resolvedCapabilities']['value'] = {
    providerName: 'mock-provider',
    modelName: 'mock-model',
    contextWindowTokens: 32_768,
    contextWindowSource: 'explicit_config',
    maxOutputTokens: 2_048,
    maxOutputTokensSource: 'adapter_runtime',
    tokenizerFamily: 'mock-tokenizer',
    tokenizerSource: 'adapter_runtime',
    supportsUsageMetadata: true,
    supportsUsageMetadataSource: 'adapter_runtime',
    supportsPromptCache: false,
    supportsPromptCacheSource: 'explicit_config',
    supportsToolCalls: true,
    supportsToolCallsSource: 'adapter_runtime',
    streaming: true,
    streamingSource: null,
  };
  const providerOptions: CanonicalJsonObject = {
    mock: {
      thinking: { type: 'disabled' },
    },
  };
  return {
    schema: MODEL_SURFACE_SCHEMA_,
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
        digest: computeResolvedModelCapabilitiesDigest(capabilities),
      },
      providerOptions: {
        kind: 'inline',
        value: providerOptions,
        digest: computeCanonicalProviderOptionsDigest(providerOptions),
      },
    },
  };
}

function cloneSurface(surface = baseSurface()): ModelSurface {
  return JSON.parse(JSON.stringify(surface)) as ModelSurface;
}

function refreshNestedDigests(surface: ModelSurface): void {
  surface.request.resolvedCapabilities.digest = computeResolvedModelCapabilitiesDigest(
    surface.request.resolvedCapabilities.value,
  );
  if (surface.request.providerOptions.kind === 'inline') {
    surface.request.providerOptions.digest = computeCanonicalProviderOptionsDigest(
      surface.request.providerOptions.value,
    );
  }
}

function envelope(surfaceArtifactId: string, invocationId: string): ModelInvocationEnvelope {
  return {
    schema: MODEL_INVOCATION_ENVELOPE_SCHEMA_,
    surface: {
      artifact: {
        artifactId: surfaceArtifactId,
        kind: 'model_surface',
        integrityIdentifier: `sha256:${'3'.repeat(64)}`,
        byteLength: 4_096,
      },
      surfaceIntegrityIdentifier: `sha256:${'4'.repeat(64)}`,
    },
    admission: {
      providerAdmissionRevision: 'policy-r1',
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
    expect(MODEL_INVOCATION_PURPOSES_).toEqual([
      'primary_agent',
      'context_compaction',
      'auto_review',
      'verification_review',
      'subagent',
    ]);
    expect(Object.keys(MODEL_PURPOSE_TO_PROVIDER_DISPATCH_)).toEqual([
      ...MODEL_INVOCATION_PURPOSES_,
    ]);
    expect(Object.values(MODEL_PURPOSE_TO_PROVIDER_DISPATCH_)).toEqual([
      'primary_model',
      'compaction',
      'auto_review',
      'verification_review',
      'subagent',
    ]);
    expect(new Set(Object.values(MODEL_PURPOSE_TO_PROVIDER_DISPATCH_)).size).toBe(5);
  });

  test('keeps response records JSON-safe without exposing an artifact path', () => {
    const response: ModelResponseRecord = {
      schema: MODEL_RESPONSE_RECORD_SCHEMA_,
      invocationId: 'invocation-1',
      surfaceIntegrityIdentifier: `sha256:${'4'.repeat(64)}`,
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

    const encoded = canonicalModelJson(response);
    expect(encoded).toContain('"invocationId":"invocation-1"');
    expect(encoded).not.toContain('relativePath');
    expect(encoded).not.toContain('endpoint');
  });
});

describe('private model evidence canonical JSON', () => {
  test('orders object keys while preserving semantic array order and exact text bytes', () => {
    expect(canonicalModelJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalModelJson({ values: ['a', 'b'] })).not.toBe(
      canonicalModelJson({ values: ['b', 'a'] }),
    );
    expect(canonicalModelJson({ text: 'line\n' })).not.toBe(
      canonicalModelJson({ text: 'line\r\n' }),
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
    expect(() => canonicalModelJson(value)).toThrow(ModelSurfaceCanonicalizationError);
  });

  test('rejects sparse arrays, accessors, symbol fields, and cycles', () => {
    const sparse = new Array(2);
    sparse[1] = 'present';
    expect(() => canonicalModelJson(sparse)).toThrow(/sparse/);

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'secret' });
    expect(() => canonicalModelJson(accessor)).toThrow(/accessor/);

    const symbol = { value: true } as Record<PropertyKey, unknown>;
    symbol[Symbol('private')] = true;
    expect(() => canonicalModelJson(symbol)).toThrow(/symbol/);

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalModelJson(cycle)).toThrow(/circular/);
  });
});

describe('Model Surface layered digests', () => {
  test('is stable across object insertion order and returns distinct digest domains', () => {
    const first = baseSurface();
    const reordered = JSON.parse(canonicalModelJson(first)) as ModelSurface;
    const layers = computeModelSurfaceDigestLayers(first);

    expect(computeModelSurfaceDigest(reordered)).toBe(layers.surfaceDigest);
    expect(layers.routeIdentityDigest).toBe(computeModelRouteIdentityDigest(first.route));
    expect(layers.surfaceDigest).not.toBe(layers.routeIdentityDigest);
    expect(layers.resolvedCapabilitiesDigest).not.toBe(layers.providerOptionsDigest);
  });

  test('changes for every provider dispatch semantic layer', () => {
    const original = baseSurface();
    const originalDigest = computeModelSurfaceDigest(original);
    const variants: Array<[string, (surface: ModelSurface) => void]> = [
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
      expect(computeModelSurfaceDigest(candidate), name).not.toBe(originalDigest);
    }
  });

  test('keeps invocation, admission, resource, time, process, and artifact identity outside surfaceDigest', () => {
    const surface = baseSurface();
    const before = computeModelSurfaceDigest(surface);
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

    expect(canonicalModelJson(first)).not.toBe(canonicalModelJson(second));
    expect(computeModelSurfaceDigest(surface)).toBe(before);
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
        integrityIdentifier: `sha256:${'b'.repeat(64)}`,
        byteLength: 128,
      },
      contentDigest,
    };
    const relocated = cloneSurface(artifactBacked);
    if (relocated.request.providerOptions.kind !== 'artifact') {
      throw new Error('expected artifact');
    }
    relocated.request.providerOptions.artifact.artifactId = 'opaque-options-b';
    relocated.request.providerOptions.artifact.integrityIdentifier = `sha256:${'c'.repeat(64)}`;
    relocated.request.providerOptions.artifact.byteLength = 256;

    expect(computeModelSurfaceDigest(artifactBacked)).toBe(computeModelSurfaceDigest(inline));
    expect(computeModelSurfaceDigest(relocated)).toBe(computeModelSurfaceDigest(artifactBacked));
  });

  test('fails closed on stale nested evidence digests', () => {
    const staleCapabilities = cloneSurface();
    staleCapabilities.request.resolvedCapabilities.value.contextWindowTokens = 64_000;
    expect(() => computeModelSurfaceDigest(staleCapabilities)).toThrow(/capability digest/);

    const staleOptions = cloneSurface();
    if (staleOptions.request.providerOptions.kind === 'inline') {
      staleOptions.request.providerOptions.value = { mock: { thinking: { type: 'enabled' } } };
    }
    expect(() => computeModelSurfaceDigest(staleOptions)).toThrow(/options digest/);
  });
});

describe('Model Surface fail-closed contract', () => {
  test('rejects unknown top-level and nested fields', () => {
    const top = cloneSurface() as unknown as Record<string, unknown>;
    top.legacy = true;
    expect(() => computeModelSurfaceDigest(top as unknown as ModelSurface)).toThrow(
      /unsupported or missing fields/,
    );

    const nested = cloneSurface();
    (nested.route as unknown as Record<string, unknown>).baseURL = 'https://private.invalid';
    expect(() => computeModelSurfaceDigest(nested)).toThrow(/unsupported or missing fields/);
  });

  test('rejects credential-bearing Provider options without echoing secret values', () => {
    const secret = 'UNIQUE_MODEL_SURFACE_SECRET_MARKER';
    const unsafeOptions: CanonicalJsonObject[] = [
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
        computeCanonicalProviderOptionsDigest(value);
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
        computeCanonicalProviderOptionsDigest(invalid as unknown as CanonicalJsonObject),
      ).toThrow(ModelSurfaceCanonicalizationError);
    }

    const invalidOptions = cloneSurface();
    if (invalidOptions.request.providerOptions.kind !== 'inline') {
      throw new Error('expected inline');
    }
    invalidOptions.request.providerOptions.value = [] as unknown as CanonicalJsonObject;
    expect(() => computeModelSurfaceDigest(invalidOptions)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const invalidSchema = cloneSurface();
    invalidSchema.request.tools = [
      {
        ...invalidSchema.request.tools[0]!,
        inputSchema: [] as unknown as CanonicalJsonObject,
      },
    ];
    expect(() => computeModelSurfaceDigest(invalidSchema)).toThrow(
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
      computeModelSurfaceDigest(surface);
      throw new Error('expected route identity to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelSurfaceCanonicalizationError);
      expect(String(error)).not.toContain(secret);
    }
  });

  test('rejects endpoint-shaped route values even without unknown fields', () => {
    const unsafeProvider = cloneSurface();
    unsafeProvider.route.providerKind = 'https://private.invalid';
    expect(() => computeModelRouteIdentityDigest(unsafeProvider.route)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const unsafeModel = cloneSurface();
    unsafeModel.route.modelName = 'model:https://private.invalid?credential=opaque';
    expect(() => computeModelRouteIdentityDigest(unsafeModel.route)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const rawEndpointModel = cloneSurface();
    rawEndpointModel.route.modelName = 'api.openai.com/v1';
    expect(() => computeModelRouteIdentityDigest(rawEndpointModel.route)).toThrow(
      ModelSurfaceCanonicalizationError,
    );

    const endpointLocator = cloneSurface();
    endpointLocator.request.providerOptions = {
      kind: 'artifact',
      artifact: {
        artifactId: 'https://private.invalid/options',
        kind: 'provider_options',
        integrityIdentifier: `sha256:${'d'.repeat(64)}`,
        byteLength: 64,
      },
      contentDigest: digest('e'),
    };
    expect(() => computeModelSurfaceDigest(endpointLocator)).toThrow(
      ModelSurfaceCanonicalizationError,
    );
  });

  test('requires route and replay-owner adapter protocol versions to agree', () => {
    const protocolMismatch = cloneSurface();
    protocolMismatch.route.replayOwner.adapterProtocolVersion = 'adapter-protocol-v2';
    expect(() => computeModelRouteIdentityDigest(protocolMismatch.route)).toThrow(
      ModelSurfaceCanonicalizationError,
    );
  });

  test('rejects executable tool closures and unsupported provider-native message parts', () => {
    const closure = cloneSurface();
    Object.assign(closure.request.tools[0]!, { execute: () => 'not evidence' });
    expect(() => computeModelSurfaceDigest(closure)).toThrow(ModelSurfaceCanonicalizationError);

    const nativePart = cloneSurface();
    nativePart.request.messages = [
      {
        role: 'user',
        content: [{ type: 'image', data: new Uint8Array([1, 2, 3]) }],
      },
    ] as unknown as ModelSurface['request']['messages'];
    expect(() => computeModelSurfaceDigest(nativePart)).toThrow(ModelSurfaceCanonicalizationError);

    const nullPart = cloneSurface();
    nullPart.request.messages = [
      { role: 'assistant', content: [null] },
    ] as unknown as ModelSurface['request']['messages'];
    expect(() => computeModelSurfaceDigest(nullPart)).toThrow(ModelSurfaceCanonicalizationError);
  });

  test('rejects attempts to enable SDK retry or multi-step execution', () => {
    const retry = cloneSurface();
    (retry.request.sdkRetry as { maxRetries: number }).maxRetries = 1;
    expect(() => computeModelSurfaceDigest(retry)).toThrow(/SDK retries/);

    const multiStep = cloneSurface();
    (multiStep.request.stopPolicy as { kind: string; maxSteps: number }).maxSteps = 2;
    expect(() => computeModelSurfaceDigest(multiStep)).toThrow(/single-step/);
  });
});
