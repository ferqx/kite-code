import type { SandboxExecutionBackend } from '@kite-ai/runtime-contract';
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
  stringValue,
} from './validation';
import { decodeWorkspaceIdentity, type KiteWorkspaceIdentity } from './workspace-trust';

export const EXECUTION_STATUS_REQUEST_SCHEMA_ = 'kite.app.execution-status.request.v1' as const;
export const EXECUTION_STATUS_RESPONSE_SCHEMA_ = 'kite.app.execution-status.response.v1' as const;
export const RELEASE_STATUS_REQUEST_SCHEMA_ = 'kite.app.release-status.request.v1' as const;
export const RELEASE_STATUS_RESPONSE_SCHEMA_ = 'kite.app.release-status.response.v1' as const;

export type AppFilesystemScope = 'none' | 'workspace_write' | 'full_access' | 'unknown';
export type AppNetworkMode = 'off' | 'allowlist' | 'unknown';

export interface ExecutionStatusRequest {
  readonly schema: typeof EXECUTION_STATUS_REQUEST_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
}

export interface ExecutionStatusSnapshot {
  readonly schema: typeof EXECUTION_STATUS_RESPONSE_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly revision: string;
  readonly admitted: boolean;
  readonly sandboxBackend: SandboxExecutionBackend;
  readonly filesystemScope: AppFilesystemScope;
  readonly networkMode: AppNetworkMode;
  readonly controllerWorktreeActive: boolean;
}

export interface ReleaseStatusRequest {
  readonly schema: typeof RELEASE_STATUS_REQUEST_SCHEMA_;
}

export interface ReleaseCapabilityStatus {
  readonly capability: string;
  readonly maturity: string;
  readonly rollout: string;
  readonly enabled: boolean;
  readonly disabledReasons: readonly string[];
}

export interface ReleaseStatusSnapshot {
  readonly schema: typeof RELEASE_STATUS_RESPONSE_SCHEMA_;
  readonly revision: string;
  readonly active: boolean;
  readonly production: boolean;
  readonly inactiveReason?: string;
  readonly profile?: {
    readonly id: string;
    readonly channel: string;
  };
  readonly capabilities: readonly ReleaseCapabilityStatus[];
  readonly execution: {
    readonly admitted: boolean;
  };
  readonly logging?: {
    readonly defaultMode: string;
    readonly contentOptInAllowed: boolean;
  };
  readonly telemetry?: { readonly allowed: boolean };
  readonly data?: { readonly providerRouteCount: number };
  readonly verification?: { readonly requirement: string };
}

export const executionStatusRequestCodec: ExactJsonCodec<ExecutionStatusRequest> = exactCodec({
  schema: EXECUTION_STATUS_REQUEST_SCHEMA_,
  decode: decodeExecutionStatusRequest,
  encode: encodeExecutionStatusRequest,
});

export const executionStatusResponseCodec: ExactJsonCodec<ExecutionStatusSnapshot> = exactCodec({
  schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
  decode: decodeExecutionStatusSnapshot,
  encode: encodeExecutionStatusSnapshot,
});

export const releaseStatusRequestCodec: ExactJsonCodec<ReleaseStatusRequest> = exactCodec({
  schema: RELEASE_STATUS_REQUEST_SCHEMA_,
  decode: decodeReleaseStatusRequest,
  encode: encodeReleaseStatusRequest,
});

export const releaseStatusResponseCodec: ExactJsonCodec<ReleaseStatusSnapshot> = exactCodec({
  schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
  decode: decodeReleaseStatusSnapshot,
  encode: encodeReleaseStatusSnapshot,
});

function decodeExecutionStatusRequest(input: unknown): ExecutionStatusRequest {
  const value = exactObject(input, ['schema', 'workspace'], 'ExecutionStatusRequest');
  assertSchema(value, EXECUTION_STATUS_REQUEST_SCHEMA_, 'ExecutionStatusRequest');
  return {
    schema: EXECUTION_STATUS_REQUEST_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'ExecutionStatusRequest')),
  };
}

function encodeExecutionStatusRequest(value: ExecutionStatusRequest): JsonObject {
  return { schema: value.schema, workspace: encodeWorkspace(value.workspace) };
}

function decodeExecutionStatusSnapshot(input: unknown): ExecutionStatusSnapshot {
  const value = exactObject(
    input,
    [
      'admitted',
      'controllerWorktreeActive',
      'filesystemScope',
      'networkMode',
      'revision',
      'sandboxBackend',
      'schema',
      'workspace',
    ],
    'ExecutionStatusSnapshot',
  );
  assertSchema(value, EXECUTION_STATUS_RESPONSE_SCHEMA_, 'ExecutionStatusSnapshot');
  return {
    schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'ExecutionStatusSnapshot')),
    revision: decodeRevision(
      required(value, 'revision', 'ExecutionStatusSnapshot'),
      'ExecutionStatusSnapshot.revision',
    ),
    admitted: booleanValue(
      required(value, 'admitted', 'ExecutionStatusSnapshot'),
      'ExecutionStatusSnapshot.admitted',
    ),
    sandboxBackend: enumValue(
      required(value, 'sandboxBackend', 'ExecutionStatusSnapshot'),
      'ExecutionStatusSnapshot.sandboxBackend',
      ['seatbelt', 'bubblewrap', 'windows_restricted_token', 'none'] as const,
    ),
    filesystemScope: enumValue(
      required(value, 'filesystemScope', 'ExecutionStatusSnapshot'),
      'ExecutionStatusSnapshot.filesystemScope',
      ['none', 'workspace_write', 'full_access', 'unknown'] as const,
    ),
    networkMode: enumValue(
      required(value, 'networkMode', 'ExecutionStatusSnapshot'),
      'ExecutionStatusSnapshot.networkMode',
      ['off', 'allowlist', 'unknown'] as const,
    ),
    controllerWorktreeActive: booleanValue(
      required(value, 'controllerWorktreeActive', 'ExecutionStatusSnapshot'),
      'ExecutionStatusSnapshot.controllerWorktreeActive',
    ),
  };
}

function encodeExecutionStatusSnapshot(value: ExecutionStatusSnapshot): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspace(value.workspace),
    revision: value.revision,
    admitted: value.admitted,
    sandboxBackend: value.sandboxBackend,
    filesystemScope: value.filesystemScope,
    networkMode: value.networkMode,
    controllerWorktreeActive: value.controllerWorktreeActive,
  };
}

function decodeReleaseStatusRequest(input: unknown): ReleaseStatusRequest {
  const value = exactObject(input, ['schema'], 'ReleaseStatusRequest');
  assertSchema(value, RELEASE_STATUS_REQUEST_SCHEMA_, 'ReleaseStatusRequest');
  return { schema: RELEASE_STATUS_REQUEST_SCHEMA_ };
}

function encodeReleaseStatusRequest(value: ReleaseStatusRequest): JsonObject {
  return { schema: value.schema };
}

function decodeReleaseStatusSnapshot(input: unknown): ReleaseStatusSnapshot {
  const value = exactObject(
    input,
    [
      'active',
      'capabilities',
      'data',
      'execution',
      'inactiveReason',
      'logging',
      'profile',
      'production',
      'revision',
      'schema',
      'telemetry',
      'verification',
    ],
    'ReleaseStatusSnapshot',
  );
  assertSchema(value, RELEASE_STATUS_RESPONSE_SCHEMA_, 'ReleaseStatusSnapshot');
  const inactiveReason = optional(value, 'inactiveReason');
  const profile = optional(value, 'profile');
  const logging = optional(value, 'logging');
  const telemetry = optional(value, 'telemetry');
  const data = optional(value, 'data');
  const verification = optional(value, 'verification');
  return {
    schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
    revision: decodeRevision(
      required(value, 'revision', 'ReleaseStatusSnapshot'),
      'ReleaseStatusSnapshot.revision',
    ),
    active: booleanValue(
      required(value, 'active', 'ReleaseStatusSnapshot'),
      'ReleaseStatusSnapshot.active',
    ),
    production: booleanValue(
      required(value, 'production', 'ReleaseStatusSnapshot'),
      'ReleaseStatusSnapshot.production',
    ),
    ...(inactiveReason === undefined
      ? {}
      : {
          inactiveReason: stringValue(inactiveReason, 'ReleaseStatusSnapshot.inactiveReason', {
            max: 256,
          }),
        }),
    ...(profile === undefined ? {} : { profile: decodeReleaseProfile(profile) }),
    capabilities: arrayValue(
      required(value, 'capabilities', 'ReleaseStatusSnapshot'),
      'ReleaseStatusSnapshot.capabilities',
      (entry, index) =>
        decodeReleaseCapability(entry, `ReleaseStatusSnapshot.capabilities[${index}]`),
      256,
    ),
    execution: decodeReleaseExecution(required(value, 'execution', 'ReleaseStatusSnapshot')),
    ...(logging === undefined ? {} : { logging: decodeLogging(logging) }),
    ...(telemetry === undefined ? {} : { telemetry: decodeTelemetry(telemetry) }),
    ...(data === undefined ? {} : { data: decodeReleaseData(data) }),
    ...(verification === undefined ? {} : { verification: decodeVerification(verification) }),
  };
}

function encodeReleaseStatusSnapshot(value: ReleaseStatusSnapshot): JsonObject {
  return {
    schema: value.schema,
    revision: value.revision,
    active: value.active,
    production: value.production,
    ...(value.inactiveReason === undefined ? {} : { inactiveReason: value.inactiveReason }),
    ...(value.profile === undefined ? {} : { profile: { ...value.profile } }),
    capabilities: value.capabilities.map((entry) => ({
      capability: entry.capability,
      maturity: entry.maturity,
      rollout: entry.rollout,
      enabled: entry.enabled,
      disabledReasons: [...entry.disabledReasons],
    })),
    execution: { admitted: value.execution.admitted },
    ...(value.logging === undefined ? {} : { logging: { ...value.logging } }),
    ...(value.telemetry === undefined ? {} : { telemetry: { ...value.telemetry } }),
    ...(value.data === undefined ? {} : { data: { ...value.data } }),
    ...(value.verification === undefined ? {} : { verification: { ...value.verification } }),
  };
}

function decodeReleaseProfile(input: unknown): { readonly id: string; readonly channel: string } {
  const value = exactObject(input, ['channel', 'id'], 'ReleaseStatusSnapshot.profile');
  return {
    id: safeIdentifier(
      required(value, 'id', 'ReleaseStatusSnapshot.profile'),
      'ReleaseStatusSnapshot.profile.id',
    ),
    channel: safeIdentifier(
      required(value, 'channel', 'ReleaseStatusSnapshot.profile'),
      'ReleaseStatusSnapshot.profile.channel',
    ),
  };
}

function decodeReleaseCapability(input: unknown, label: string): ReleaseCapabilityStatus {
  const value = exactObject(
    input,
    ['capability', 'disabledReasons', 'enabled', 'maturity', 'rollout'],
    label,
  );
  return {
    capability: safeIdentifier(required(value, 'capability', label), `${label}.capability`, 256),
    maturity: safeIdentifier(required(value, 'maturity', label), `${label}.maturity`, 128),
    rollout: safeIdentifier(required(value, 'rollout', label), `${label}.rollout`, 128),
    enabled: booleanValue(required(value, 'enabled', label), `${label}.enabled`),
    disabledReasons: arrayValue(
      required(value, 'disabledReasons', label),
      `${label}.disabledReasons`,
      (entry, index) => safeIdentifier(entry, `${label}.disabledReasons[${index}]`, 128),
      64,
    ),
  };
}

function decodeReleaseExecution(input: unknown): { readonly admitted: boolean } {
  const value = exactObject(input, ['admitted'], 'ReleaseStatusSnapshot.execution');
  return {
    admitted: booleanValue(
      required(value, 'admitted', 'ReleaseStatusSnapshot.execution'),
      'ReleaseStatusSnapshot.execution.admitted',
    ),
  };
}

function decodeLogging(input: unknown): {
  readonly defaultMode: string;
  readonly contentOptInAllowed: boolean;
} {
  const value = exactObject(
    input,
    ['contentOptInAllowed', 'defaultMode'],
    'ReleaseStatusSnapshot.logging',
  );
  return {
    defaultMode: safeIdentifier(
      required(value, 'defaultMode', 'ReleaseStatusSnapshot.logging'),
      'ReleaseStatusSnapshot.logging.defaultMode',
      128,
    ),
    contentOptInAllowed: booleanValue(
      required(value, 'contentOptInAllowed', 'ReleaseStatusSnapshot.logging'),
      'ReleaseStatusSnapshot.logging.contentOptInAllowed',
    ),
  };
}

function decodeTelemetry(input: unknown): { readonly allowed: boolean } {
  const value = exactObject(input, ['allowed'], 'ReleaseStatusSnapshot.telemetry');
  return {
    allowed: booleanValue(
      required(value, 'allowed', 'ReleaseStatusSnapshot.telemetry'),
      'ReleaseStatusSnapshot.telemetry.allowed',
    ),
  };
}

function decodeReleaseData(input: unknown): { readonly providerRouteCount: number } {
  const value = exactObject(input, ['providerRouteCount'], 'ReleaseStatusSnapshot.data');
  return {
    providerRouteCount: integerValue(
      required(value, 'providerRouteCount', 'ReleaseStatusSnapshot.data'),
      'ReleaseStatusSnapshot.data.providerRouteCount',
      { min: 0 },
    ),
  };
}

function decodeVerification(input: unknown): { readonly requirement: string } {
  const value = exactObject(input, ['requirement'], 'ReleaseStatusSnapshot.verification');
  return {
    requirement: safeIdentifier(
      required(value, 'requirement', 'ReleaseStatusSnapshot.verification'),
      'ReleaseStatusSnapshot.verification.requirement',
      128,
    ),
  };
}

function encodeWorkspace(value: KiteWorkspaceIdentity): JsonObject {
  return {
    canonicalPath: value.canonicalPath,
    projectId: value.projectId,
    workspaceDigest: value.workspaceDigest,
  };
}

function decodeRevision(input: unknown, label: string): string {
  return nonEmptyString(input, label, 256);
}

function assertSchema(value: JsonObject, expected: string, label: string): void {
  if (value.schema !== expected) invalid(`${label}.schema must equal ${expected}.`);
}
