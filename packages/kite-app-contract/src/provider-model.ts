import {
  arrayValue,
  booleanValue,
  type ExactJsonCodec,
  enumValue,
  exactCodec,
  exactObject,
  integerValue,
  invalid,
  type JsonObject,
  nonEmptyString,
  optional,
  required,
  safeIdentifier,
} from './validation';
import { decodeWorkspaceIdentity, type KiteWorkspaceIdentity } from './workspace-trust';

export const PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_ =
  'kite.app.provider-model.snapshot-request.v1' as const;
export const PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_ =
  'kite.app.provider-model.snapshot-response.v1' as const;
export const PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_ =
  'kite.app.provider-model.select-request.v1' as const;
export const PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_ =
  'kite.app.provider-model.select-response.v1' as const;

export type AppModelProviderType = 'deepseek' | 'openai' | 'openai-compatible' | 'ollama';
export type ProviderReadiness = 'ready' | 'not_configured' | 'degraded' | 'unavailable';

/** A model route contains no provider secret or transport address. */
export interface ProviderModelRoute {
  readonly provider: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly reasoning?: boolean;
  readonly streaming?: boolean;
}

export interface ProviderModelSummary {
  readonly provider: string;
  readonly type: AppModelProviderType;
  readonly readiness: ProviderReadiness;
  readonly models: readonly ProviderModelRoute[];
  readonly selectedModel?: string;
  readonly diagnosticCode?: string;
}

export interface ProviderModelSnapshot {
  readonly schema: typeof PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly revision: string;
  readonly providers: readonly ProviderModelSummary[];
  readonly selected?: { readonly provider: string; readonly name: string };
}

export interface ProviderModelSnapshotRequest {
  readonly schema: typeof PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
}

export interface ProviderModelSelectRequest {
  readonly schema: typeof PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly provider: string;
  readonly name: string;
  readonly expectedRevision: string;
}

export type ProviderModelSelectOutcome =
  | 'applied'
  | 'already_selected'
  | 'invalid_model'
  | 'conflict'
  | 'outcome_unknown'
  | 'unavailable';

export interface ProviderModelSelectResponse {
  readonly schema: typeof PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_;
  readonly outcome: ProviderModelSelectOutcome;
  readonly snapshot: ProviderModelSnapshot;
}

export const providerModelSnapshotRequestCodec: ExactJsonCodec<ProviderModelSnapshotRequest> =
  exactCodec({
    schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
    decode: decodeProviderModelSnapshotRequest,
    encode: encodeProviderModelSnapshotRequest,
  });

export const providerModelSnapshotResponseCodec: ExactJsonCodec<ProviderModelSnapshot> = exactCodec(
  {
    schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
    decode: decodeProviderModelSnapshot,
    encode: encodeProviderModelSnapshot,
  },
);

export const providerModelSelectRequestCodec: ExactJsonCodec<ProviderModelSelectRequest> =
  exactCodec({
    schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
    decode: decodeProviderModelSelectRequest,
    encode: encodeProviderModelSelectRequest,
  });

export const providerModelSelectResponseCodec: ExactJsonCodec<ProviderModelSelectResponse> =
  exactCodec({
    schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
    decode: decodeProviderModelSelectResponse,
    encode: encodeProviderModelSelectResponse,
  });

function decodeProviderModelSnapshotRequest(input: unknown): ProviderModelSnapshotRequest {
  const value = exactObject(input, ['schema', 'workspace'], 'ProviderModelSnapshotRequest');
  assertSchema(value, PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_, 'ProviderModelSnapshotRequest');
  return {
    schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
    workspace: decodeWorkspaceIdentity(
      required(value, 'workspace', 'ProviderModelSnapshotRequest'),
    ),
  };
}

function encodeProviderModelSnapshotRequest(value: ProviderModelSnapshotRequest): JsonObject {
  return { schema: value.schema, workspace: encodeWorkspace(value.workspace) };
}

function decodeProviderModelSnapshot(input: unknown): ProviderModelSnapshot {
  const value = exactObject(
    input,
    ['providers', 'revision', 'schema', 'selected', 'workspace'],
    'ProviderModelSnapshot',
  );
  assertSchema(value, PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_, 'ProviderModelSnapshot');
  const selected = optional(value, 'selected');
  return {
    schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'ProviderModelSnapshot')),
    revision: nonEmptyString(
      required(value, 'revision', 'ProviderModelSnapshot'),
      'ProviderModelSnapshot.revision',
      256,
    ),
    providers: arrayValue(
      required(value, 'providers', 'ProviderModelSnapshot'),
      'ProviderModelSnapshot.providers',
      (entry, index) =>
        decodeProviderModelSummary(entry, `ProviderModelSnapshot.providers[${index}]`),
      128,
    ),
    ...(selected === undefined
      ? {}
      : { selected: decodeSelectedRoute(selected, 'ProviderModelSnapshot.selected') }),
  };
}

function encodeProviderModelSnapshot(value: ProviderModelSnapshot): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspace(value.workspace),
    revision: value.revision,
    providers: value.providers.map(encodeProviderModelSummary),
    ...(value.selected === undefined ? {} : { selected: { ...value.selected } }),
  };
}

function decodeProviderModelSelectRequest(input: unknown): ProviderModelSelectRequest {
  const value = exactObject(
    input,
    ['expectedRevision', 'name', 'provider', 'schema', 'workspace'],
    'ProviderModelSelectRequest',
  );
  assertSchema(value, PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_, 'ProviderModelSelectRequest');
  return {
    schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'ProviderModelSelectRequest')),
    provider: safeIdentifier(
      required(value, 'provider', 'ProviderModelSelectRequest'),
      'ProviderModelSelectRequest.provider',
    ),
    name: nonEmptyString(
      required(value, 'name', 'ProviderModelSelectRequest'),
      'ProviderModelSelectRequest.name',
      256,
    ),
    expectedRevision: nonEmptyString(
      required(value, 'expectedRevision', 'ProviderModelSelectRequest'),
      'ProviderModelSelectRequest.expectedRevision',
      256,
    ),
  };
}

function encodeProviderModelSelectRequest(value: ProviderModelSelectRequest): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspace(value.workspace),
    provider: value.provider,
    name: value.name,
    expectedRevision: value.expectedRevision,
  };
}

function decodeProviderModelSelectResponse(input: unknown): ProviderModelSelectResponse {
  const value = exactObject(
    input,
    ['outcome', 'schema', 'snapshot'],
    'ProviderModelSelectResponse',
  );
  assertSchema(value, PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_, 'ProviderModelSelectResponse');
  return {
    schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
    outcome: enumValue(
      required(value, 'outcome', 'ProviderModelSelectResponse'),
      'ProviderModelSelectResponse.outcome',
      [
        'applied',
        'already_selected',
        'invalid_model',
        'conflict',
        'outcome_unknown',
        'unavailable',
      ] as const,
    ),
    snapshot: decodeProviderModelSnapshot(
      required(value, 'snapshot', 'ProviderModelSelectResponse'),
    ),
  };
}

function encodeProviderModelSelectResponse(value: ProviderModelSelectResponse): JsonObject {
  return {
    schema: value.schema,
    outcome: value.outcome,
    snapshot: encodeProviderModelSnapshot(value.snapshot),
  };
}

function decodeProviderModelSummary(input: unknown, label: string): ProviderModelSummary {
  const value = exactObject(
    input,
    ['diagnosticCode', 'models', 'provider', 'readiness', 'selectedModel', 'type'],
    label,
  );
  const diagnosticCode = optional(value, 'diagnosticCode');
  const selectedModel = optional(value, 'selectedModel');
  return {
    provider: safeIdentifier(required(value, 'provider', label), `${label}.provider`),
    type: enumValue(required(value, 'type', label), `${label}.type`, [
      'deepseek',
      'openai',
      'openai-compatible',
      'ollama',
    ] as const),
    readiness: enumValue(required(value, 'readiness', label), `${label}.readiness`, [
      'ready',
      'not_configured',
      'degraded',
      'unavailable',
    ] as const),
    models: arrayValue(
      required(value, 'models', label),
      `${label}.models`,
      (entry, index) => decodeProviderModelRoute(entry, `${label}.models[${index}]`),
      256,
    ),
    ...(selectedModel === undefined
      ? {}
      : { selectedModel: nonEmptyString(selectedModel, `${label}.selectedModel`, 256) }),
    ...(diagnosticCode === undefined
      ? {}
      : { diagnosticCode: safeIdentifier(diagnosticCode, `${label}.diagnosticCode`, 128) }),
  };
}

function encodeProviderModelSummary(value: ProviderModelSummary): JsonObject {
  return {
    provider: value.provider,
    type: value.type,
    readiness: value.readiness,
    models: value.models.map(encodeProviderModelRoute),
    ...(value.selectedModel === undefined ? {} : { selectedModel: value.selectedModel }),
    ...(value.diagnosticCode === undefined ? {} : { diagnosticCode: value.diagnosticCode }),
  };
}

function decodeProviderModelRoute(input: unknown, label: string): ProviderModelRoute {
  const value = exactObject(
    input,
    [
      'contextWindowTokens',
      'isDefault',
      'maxOutputTokens',
      'name',
      'provider',
      'reasoning',
      'streaming',
    ],
    label,
  );
  const contextWindowTokens = optional(value, 'contextWindowTokens');
  const maxOutputTokens = optional(value, 'maxOutputTokens');
  const reasoning = optional(value, 'reasoning');
  const streaming = optional(value, 'streaming');
  return {
    provider: safeIdentifier(required(value, 'provider', label), `${label}.provider`),
    name: nonEmptyString(required(value, 'name', label), `${label}.name`, 256),
    isDefault: booleanValue(required(value, 'isDefault', label), `${label}.isDefault`),
    ...(contextWindowTokens === undefined
      ? {}
      : {
          contextWindowTokens: integerValue(contextWindowTokens, `${label}.contextWindowTokens`, {
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
        }),
    ...(maxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: integerValue(maxOutputTokens, `${label}.maxOutputTokens`, {
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
        }),
    ...(reasoning === undefined
      ? {}
      : { reasoning: booleanValue(reasoning, `${label}.reasoning`) }),
    ...(streaming === undefined
      ? {}
      : { streaming: booleanValue(streaming, `${label}.streaming`) }),
  };
}

function encodeProviderModelRoute(value: ProviderModelRoute): JsonObject {
  return {
    provider: value.provider,
    name: value.name,
    isDefault: value.isDefault,
    ...(value.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: value.contextWindowTokens }),
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    ...(value.streaming === undefined ? {} : { streaming: value.streaming }),
  };
}

function decodeSelectedRoute(
  input: unknown,
  label: string,
): { readonly provider: string; readonly name: string } {
  const value = exactObject(input, ['name', 'provider'], label);
  return {
    provider: safeIdentifier(required(value, 'provider', label), `${label}.provider`),
    name: nonEmptyString(required(value, 'name', label), `${label}.name`, 256),
  };
}

function encodeWorkspace(value: KiteWorkspaceIdentity): JsonObject {
  return {
    canonicalPath: value.canonicalPath,
    projectId: value.projectId,
    workspaceDigest: value.workspaceDigest,
  };
}

function assertSchema(value: JsonObject, expected: string, label: string): void {
  if (value.schema !== expected) invalid(`${label}.schema must equal ${expected}.`);
}
