/**
 * Provider-neutral, JSON-safe model invocation evidence contracts.
 *
 * These DTOs deliberately exclude SDK request/response types, executable tool
 * handlers, credentials, endpoints, Runtime state objects, and UI projections.
 */

export type CanonicalJsonScalarV1 = null | boolean | number | string;
export type CanonicalJsonValueV1 =
  | CanonicalJsonScalarV1
  | readonly CanonicalJsonValueV1[]
  | CanonicalJsonObjectV1;
export interface CanonicalJsonObjectV1 {
  readonly [key: string]: CanonicalJsonValueV1;
}

export type Sha256DigestV1 = `sha256:${string}`;

export const MODEL_SURFACE_SCHEMA_V1 = Object.freeze({
  name: 'kite.model-surface',
  canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
  surfaceFormatVersion: 1,
} as const);

export const MODEL_INVOCATION_ENVELOPE_SCHEMA_V1 = Object.freeze({
  name: 'kite.model-invocation-envelope',
  version: 1,
} as const);

export const MODEL_RESPONSE_RECORD_SCHEMA_V1 = Object.freeze({
  name: 'kite.model-response-record',
  canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
  version: 1,
} as const);

export const MODEL_INVOCATION_PURPOSES_V1 = Object.freeze([
  'primary_agent',
  'context_compaction',
  'auto_review',
  'verification_review',
  'subagent',
] as const);

export type ModelInvocationPurposeV1 = (typeof MODEL_INVOCATION_PURPOSES_V1)[number];

export type ModelProviderDispatchPurposeV1 =
  | 'primary_model'
  | 'compaction'
  | 'auto_review'
  | 'verification_review'
  | 'subagent';

/** Closed mapping shared by Surface compilation and Provider data admission. */
export const MODEL_PURPOSE_TO_PROVIDER_DISPATCH_V1 = Object.freeze({
  primary_agent: 'primary_model',
  context_compaction: 'compaction',
  auto_review: 'auto_review',
  verification_review: 'verification_review',
  subagent: 'subagent',
} as const satisfies Readonly<Record<ModelInvocationPurposeV1, ModelProviderDispatchPurposeV1>>);

export interface ModelAdapterReplayOwnerV1 {
  /** Stable adapter family, never a credential or endpoint. */
  adapterKind: string;
  adapterProtocolVersion: string;
  /** Secret-free fingerprint for exact adapter-instance replay ownership. */
  ownerFingerprint: Sha256DigestV1;
}

export interface ModelRouteIdentityV1 {
  /** Provider family only; API keys, headers and endpoints are forbidden. */
  providerKind: string;
  modelName: string;
  adapterProtocolVersion: string;
  /** Secret-free identity derived at the governed config boundary. */
  routeFingerprint: Sha256DigestV1;
  replayOwner: ModelAdapterReplayOwnerV1;
}

export interface CanonicalModelTextPartV1 {
  type: 'text';
  text: string;
}

export interface CanonicalModelReasoningPartV1 {
  type: 'reasoning';
  text: string;
}

export interface CanonicalModelToolCallPartV1 {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: CanonicalJsonValueV1;
}

export interface CanonicalModelToolResultPartV1 {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  output: {
    type: 'text';
    value: string;
  };
}

export type CanonicalModelMessageV1 =
  | {
      role: 'user';
      content: readonly CanonicalModelTextPartV1[];
    }
  | {
      role: 'assistant';
      content: readonly (
        | CanonicalModelTextPartV1
        | CanonicalModelReasoningPartV1
        | CanonicalModelToolCallPartV1
      )[];
    }
  | {
      role: 'tool';
      content: readonly CanonicalModelToolResultPartV1[];
    };

export interface CanonicalToolDeclarationV1 {
  name: string;
  description: string | null;
  /** Exact provider-facing JSON Schema; executable handlers are never stored. */
  inputSchema: CanonicalJsonObjectV1;
}

export type ModelCapabilitySourceV1 =
  | 'explicit_config'
  | 'adapter_runtime'
  | 'compatibility_config';

/** Canonical value of the already-resolved model capabilities. */
export interface ResolvedModelCapabilitiesValueV1 {
  providerName: string;
  modelName: string;
  contextWindowTokens: number | null;
  contextWindowSource: ModelCapabilitySourceV1 | null;
  maxOutputTokens: number | null;
  maxOutputTokensSource: ModelCapabilitySourceV1 | null;
  tokenizerFamily: string | null;
  tokenizerSource: ModelCapabilitySourceV1 | null;
  supportsUsageMetadata: boolean | null;
  supportsUsageMetadataSource: ModelCapabilitySourceV1 | null;
  supportsPromptCache: boolean | null;
  supportsPromptCacheSource: ModelCapabilitySourceV1 | null;
  supportsToolCalls: boolean | null;
  supportsToolCallsSource: ModelCapabilitySourceV1 | null;
  streaming: boolean;
  streamingSource: ModelCapabilitySourceV1 | null;
}

export interface ResolvedModelCapabilitiesEvidenceV1 {
  value: ResolvedModelCapabilitiesValueV1;
  digest: Sha256DigestV1;
}

export type PrivateArtifactKindV1 = 'model_surface' | 'model_response' | 'provider_options';

/** Opaque external reference. It never exposes a content digest or relative path. */
export interface PrivateArtifactRefV1 {
  artifactId: string;
  kind: PrivateArtifactKindV1;
  integrityIdentifier: string;
  byteLength: number;
}

export type CanonicalProviderOptionsV1 =
  | {
      kind: 'inline';
      value: CanonicalJsonObjectV1;
      digest: Sha256DigestV1;
    }
  | {
      kind: 'artifact';
      artifact: PrivateArtifactRefV1 & { kind: 'provider_options' };
      contentDigest: Sha256DigestV1;
    };

export interface ModelSemanticRequestV1 {
  /** System messages merged exactly as they will be sent to the transport. */
  system: string;
  messages: readonly CanonicalModelMessageV1[];
  tools: readonly CanonicalToolDeclarationV1[];
  temperature: number;
  maxOutputTokens: number | null;
  stopPolicy: {
    kind: 'single_step';
    maxSteps: 1;
  };
  transport: 'stream' | 'generate';
  sdkRetry: {
    maxRetries: 0;
  };
  resolvedCapabilities: ResolvedModelCapabilitiesEvidenceV1;
  providerOptions: CanonicalProviderOptionsV1;
}

/** Complete provider-neutral request semantics, frozen before admission. */
export interface ModelSurfaceV1 {
  schema: typeof MODEL_SURFACE_SCHEMA_V1;
  purpose: ModelInvocationPurposeV1;
  route: ModelRouteIdentityV1;
  request: ModelSemanticRequestV1;
}

export interface ModelInvocationEnvelopeV1 {
  schema: typeof MODEL_INVOCATION_ENVELOPE_SCHEMA_V1;
  surface: {
    artifact: PrivateArtifactRefV1 & { kind: 'model_surface' };
    surfaceIntegrityIdentifier: string;
  };
  admission: {
    providerDataPolicyRevision: string | null;
    routeIdentityDigest: Sha256DigestV1;
    payloadClassificationDigest: Sha256DigestV1;
    admitted: boolean;
  };
  provenance: {
    invocationId: string;
    threadId: string;
    turnId: string;
    parentInvocationId: string | null;
    parentToolCallId: string | null;
    stateRevision: number;
    contextCheckpointId: string | null;
    promptContractVersion: string;
    projectionEnvironmentDigest: Sha256DigestV1;
    capabilityBindingDigest: Sha256DigestV1;
  };
  resource: {
    budget:
      | {
          kind: 'reservation';
          reservationId: string;
          parentReservationId: string | null;
        }
      | {
          kind: 'no_budget';
          reason: 'resource_budget_disabled';
        };
    limits: {
      maxAttempts: number;
      perAttemptTimeoutMs: number;
      totalTimeBudgetMs: number;
    };
  };
}

export type ModelFinishReasonV1 =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'error'
  | 'other'
  | 'unknown';

export interface ModelResponseRecordV1 {
  schema: typeof MODEL_RESPONSE_RECORD_SCHEMA_V1;
  invocationId: string;
  surfaceIntegrityIdentifier: string;
  route: ModelRouteIdentityV1;
  response: {
    message: Extract<CanonicalModelMessageV1, { role: 'assistant' }>;
    finishReason: ModelFinishReasonV1;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      cacheReadTokens: number | null;
    };
    /** Private, JSON-safe metadata required for exact response reconstruction. */
    providerMetadata: CanonicalJsonObjectV1;
  };
  nativeReplayState: null | {
    owner: ModelAdapterReplayOwnerV1;
    value: CanonicalJsonValueV1;
  };
}
