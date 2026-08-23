/**
 * Provider-neutral, JSON-safe model invocation evidence contracts.
 *
 * These DTOs deliberately exclude SDK request/response types, executable tool
 * handlers, credentials, endpoints, Runtime state objects, and UI projections.
 */

export type CanonicalJsonScalar = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonScalar
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;
export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

export type Sha256Digest = `sha256:${string}`;

export const MODEL_SURFACE_SCHEMA_ = Object.freeze({
  name: 'kite.model-surface',
  canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
  surfaceFormatVersion: 1,
} as const);

export const MODEL_INVOCATION_ENVELOPE_SCHEMA_ = Object.freeze({
  name: 'kite.model-invocation-envelope',
  version: 1,
} as const);

export const MODEL_RESPONSE_RECORD_SCHEMA_ = Object.freeze({
  name: 'kite.model-response-record',
  canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
  version: 1,
} as const);

export const MODEL_ATTEMPT_OUTCOME_SCHEMA_ = Object.freeze({
  name: 'kite.model-attempt-outcome',
  canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
  version: 1,
} as const);

export const MODEL_INVOCATION_PURPOSES_ = Object.freeze([
  'primary_agent',
  'context_compaction',
  'auto_review',
  'verification_review',
  'subagent',
] as const);

export type ModelInvocationPurpose = (typeof MODEL_INVOCATION_PURPOSES_)[number];

export type ModelProviderDispatchPurpose =
  | 'primary_model'
  | 'compaction'
  | 'auto_review'
  | 'verification_review'
  | 'subagent';

/** Closed mapping shared by Surface compilation and Provider data admission. */
export const MODEL_PURPOSE_TO_PROVIDER_DISPATCH_ = Object.freeze({
  primary_agent: 'primary_model',
  context_compaction: 'compaction',
  auto_review: 'auto_review',
  verification_review: 'verification_review',
  subagent: 'subagent',
} as const satisfies Readonly<Record<ModelInvocationPurpose, ModelProviderDispatchPurpose>>);

export interface ModelAdapterReplayOwner {
  /** Stable adapter family, never a credential or endpoint. */
  adapterKind: string;
  adapterProtocolVersion: string;
  /** Secret-free fingerprint for exact adapter-instance replay ownership. */
  ownerFingerprint: Sha256Digest;
}

export interface ModelRouteIdentity {
  /** Provider family only; API keys, headers and endpoints are forbidden. */
  providerKind: string;
  modelName: string;
  adapterProtocolVersion: string;
  /** Secret-free identity derived at the governed config boundary. */
  routeFingerprint: Sha256Digest;
  replayOwner: ModelAdapterReplayOwner;
}

export interface CanonicalModelTextPart {
  type: 'text';
  text: string;
}

export interface CanonicalModelReasoningPart {
  type: 'reasoning';
  text: string;
}

export interface CanonicalModelToolCallPart {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: CanonicalJsonValue;
}

export interface CanonicalModelToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  output: {
    type: 'text';
    value: string;
  };
}

export type CanonicalModelMessage =
  | {
      role: 'user';
      content: readonly CanonicalModelTextPart[];
    }
  | {
      role: 'assistant';
      content: readonly (
        | CanonicalModelTextPart
        | CanonicalModelReasoningPart
        | CanonicalModelToolCallPart
      )[];
    }
  | {
      role: 'tool';
      content: readonly CanonicalModelToolResultPart[];
    };

export interface CanonicalToolDeclaration {
  name: string;
  description: string | null;
  /** Exact provider-facing JSON Schema; executable handlers are never stored. */
  inputSchema: CanonicalJsonObject;
}

export type ModelCapabilitySource = 'explicit_config' | 'adapter_runtime';

/** Canonical value of the already-resolved model capabilities. */
export interface ResolvedModelCapabilitiesValue {
  providerName: string;
  modelName: string;
  contextWindowTokens: number | null;
  contextWindowSource: ModelCapabilitySource | null;
  maxOutputTokens: number | null;
  maxOutputTokensSource: ModelCapabilitySource | null;
  tokenizerFamily: string | null;
  tokenizerSource: ModelCapabilitySource | null;
  supportsUsageMetadata: boolean | null;
  supportsUsageMetadataSource: ModelCapabilitySource | null;
  supportsPromptCache: boolean | null;
  supportsPromptCacheSource: ModelCapabilitySource | null;
  supportsToolCalls: boolean | null;
  supportsToolCallsSource: ModelCapabilitySource | null;
  streaming: boolean;
  streamingSource: ModelCapabilitySource | null;
}

export interface ResolvedModelCapabilitiesEvidence {
  value: ResolvedModelCapabilitiesValue;
  digest: Sha256Digest;
}

export type PrivateArtifactKind = 'model_surface' | 'model_response' | 'provider_options';

/** Opaque external reference. It never exposes a content digest or relative path. */
export interface PrivateArtifactRef {
  artifactId: string;
  kind: PrivateArtifactKind;
  integrityIdentifier: string;
  byteLength: number;
}

export type CanonicalProviderOptions =
  | {
      kind: 'inline';
      value: CanonicalJsonObject;
      digest: Sha256Digest;
    }
  | {
      kind: 'artifact';
      artifact: PrivateArtifactRef & { kind: 'provider_options' };
      contentDigest: Sha256Digest;
    };

export interface ModelSemanticRequest {
  /** System messages merged exactly as they will be sent to the transport. */
  system: string;
  messages: readonly CanonicalModelMessage[];
  tools: readonly CanonicalToolDeclaration[];
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
  resolvedCapabilities: ResolvedModelCapabilitiesEvidence;
  providerOptions: CanonicalProviderOptions;
}

/** Complete provider-neutral request semantics, frozen before admission. */
export interface ModelSurface {
  schema: typeof MODEL_SURFACE_SCHEMA_;
  purpose: ModelInvocationPurpose;
  route: ModelRouteIdentity;
  request: ModelSemanticRequest;
}

export interface ModelInvocationEnvelope {
  schema: typeof MODEL_INVOCATION_ENVELOPE_SCHEMA_;
  surface: {
    artifact: PrivateArtifactRef & { kind: 'model_surface' };
    surfaceIntegrityIdentifier: string;
  };
  admission: {
    providerAdmissionRevision: string | null;
    routeIdentityDigest: Sha256Digest;
    payloadClassificationDigest: Sha256Digest;
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
    projectionEnvironmentDigest: Sha256Digest;
    capabilityBindingDigest: Sha256Digest;
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

export type ModelFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'error'
  | 'other'
  | 'unknown';

export interface ModelResponseRecord {
  schema: typeof MODEL_RESPONSE_RECORD_SCHEMA_;
  invocationId: string;
  surfaceIntegrityIdentifier: string;
  route: ModelRouteIdentity;
  response: {
    message: Extract<CanonicalModelMessage, { role: 'assistant' }>;
    finishReason: ModelFinishReason;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      cacheReadTokens: number | null;
    };
    /** Private, JSON-safe metadata required for exact response reconstruction. */
    providerMetadata: CanonicalJsonObject;
  };
  nativeReplayState: null | {
    owner: ModelAdapterReplayOwner;
    value: CanonicalJsonValue;
  };
}

export type ModelAttemptRetryableFailureClassification =
  | 'attempt_timeout'
  | 'connection_failure'
  | 'provider_rate_limited'
  | 'provider_unavailable';

export type ModelAttemptFatalFailureClassification = 'provider_rejected' | 'provider_failure';

export type ModelAttemptAbortedClassification = 'cancelled' | 'transport_aborted';

export interface ModelAttemptRetryObservation {
  providerStatusCode: number | null;
  timedOut: boolean;
}

/** Stable, JSON-safe outcome for exactly one already-occurring Provider attempt. */
export type ModelAttemptOutcome =
  | {
      schema: typeof MODEL_ATTEMPT_OUTCOME_SCHEMA_;
      kind: 'success';
      response: ModelResponseRecord['response'];
      nativeReplayState: ModelResponseRecord['nativeReplayState'];
    }
  | {
      schema: typeof MODEL_ATTEMPT_OUTCOME_SCHEMA_;
      kind: 'retryable_failure';
      classification: ModelAttemptRetryableFailureClassification;
      retryObservation: ModelAttemptRetryObservation;
    }
  | {
      schema: typeof MODEL_ATTEMPT_OUTCOME_SCHEMA_;
      kind: 'fatal_failure';
      classification: ModelAttemptFatalFailureClassification;
      providerStatusCode: number | null;
    }
  | {
      schema: typeof MODEL_ATTEMPT_OUTCOME_SCHEMA_;
      kind: 'aborted';
      classification: ModelAttemptAbortedClassification;
    };
