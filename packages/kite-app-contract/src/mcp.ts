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

export const MCP_SNAPSHOT_REQUEST_SCHEMA_ = 'kite.app.mcp.snapshot-request.v1' as const;
export const MCP_SNAPSHOT_RESPONSE_SCHEMA_ = 'kite.app.mcp.snapshot-response.v1' as const;
export const MCP_ACTION_REQUEST_SCHEMA_ = 'kite.app.mcp.action-request.v1' as const;
export const MCP_ACTION_RESPONSE_SCHEMA_ = 'kite.app.mcp.action-response.v1' as const;

export type AppMcpSource = 'project' | 'user' | 'explicit';
export type AppMcpWritableSource = Extract<AppMcpSource, 'project' | 'user'>;
export type AppMcpTransport = 'http' | 'stdio';
export type AppMcpConfigStatus =
  | 'ready'
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'invalid'
  | 'store_corrupt'
  | 'store_unavailable';
export type AppMcpHealth =
  | 'disconnected'
  | 'discovering'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'half_open'
  | 'circuit_open'
  | 'quarantined'
  | 'failed';
export type AppMcpAuthStatus =
  | 'not_required'
  | 'authenticated'
  | 'authorizing'
  | 'refreshing'
  | 'login_required'
  | 'reauth_required'
  | 'error';

export interface AppMcpServerKey {
  readonly name: string;
  readonly source: AppMcpSource;
}

export interface AppMcpToolParameter {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description?: string;
}

export interface AppMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters: readonly AppMcpToolParameter[];
}

export interface AppMcpApproval {
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly configDigest?: `sha256:${string}`;
}

export interface AppMcpDiagnostic {
  readonly code: string;
  readonly retryable: boolean;
}

/** MCP control metadata safe for the terminal client; no config body is returned. */
export interface AppMcpServer {
  readonly key: AppMcpServerKey;
  readonly effective: boolean;
  readonly fallbackSource?: AppMcpSource;
  readonly transport: AppMcpTransport;
  readonly enabled: boolean;
  readonly configStatus: AppMcpConfigStatus;
  readonly health: AppMcpHealth;
  readonly authStatus: AppMcpAuthStatus;
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly tools: readonly AppMcpTool[];
  readonly approval?: AppMcpApproval;
  readonly diagnostic?: AppMcpDiagnostic;
}

export interface AppMcpSnapshot {
  readonly schema: typeof MCP_SNAPSHOT_RESPONSE_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly revision: string;
  readonly sourceRevisions: Readonly<{
    readonly project: string;
    readonly user: string;
  }>;
  readonly servers: readonly AppMcpServer[];
}

export interface AppMcpSnapshotRequest {
  readonly schema: typeof MCP_SNAPSHOT_REQUEST_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
}

export type AppMcpAction =
  | {
      readonly type: 'approve' | 'reject' | 'login' | 'retry' | 'reconnect' | 'cancel_auth';
      readonly key: AppMcpServerKey;
      readonly expectedRevision: string;
    }
  | {
      readonly type: 'set_enabled';
      readonly key: AppMcpServerKey;
      readonly enabled: boolean;
      readonly expectedRevision: string;
    }
  | {
      readonly type: 'add';
      readonly source: AppMcpWritableSource;
      readonly name: string;
      readonly transport: AppMcpTransport;
      /** User-entered command/address value; it is never returned in a snapshot. */
      readonly value: string;
      readonly expectedRevision: string;
    }
  | {
      readonly type: 'remove';
      readonly key: AppMcpServerKey;
      readonly expectedRevision: string;
    };

export interface AppMcpActionRequest {
  readonly schema: typeof MCP_ACTION_REQUEST_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly action: AppMcpAction;
}

export type AppMcpActionOutcome =
  | 'applied'
  | 'conflict'
  | 'outcome_unknown'
  | 'unavailable'
  | 'rejected';

export interface AppMcpActionResponse {
  readonly schema: typeof MCP_ACTION_RESPONSE_SCHEMA_;
  readonly outcome: AppMcpActionOutcome;
  readonly snapshot: AppMcpSnapshot;
}

export const mcpSnapshotRequestCodec: ExactJsonCodec<AppMcpSnapshotRequest> = exactCodec({
  schema: MCP_SNAPSHOT_REQUEST_SCHEMA_,
  decode: decodeMcpSnapshotRequest,
  encode: encodeMcpSnapshotRequest,
});

export const mcpSnapshotResponseCodec: ExactJsonCodec<AppMcpSnapshot> = exactCodec({
  schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
  decode: decodeMcpSnapshot,
  encode: encodeMcpSnapshot,
});

export const mcpActionRequestCodec: ExactJsonCodec<AppMcpActionRequest> = exactCodec({
  schema: MCP_ACTION_REQUEST_SCHEMA_,
  decode: decodeMcpActionRequest,
  encode: encodeMcpActionRequest,
});

export const mcpActionResponseCodec: ExactJsonCodec<AppMcpActionResponse> = exactCodec({
  schema: MCP_ACTION_RESPONSE_SCHEMA_,
  decode: decodeMcpActionResponse,
  encode: encodeMcpActionResponse,
});

function decodeMcpSnapshotRequest(input: unknown): AppMcpSnapshotRequest {
  const value = exactObject(input, ['schema', 'workspace'], 'AppMcpSnapshotRequest');
  assertSchema(value, MCP_SNAPSHOT_REQUEST_SCHEMA_, 'AppMcpSnapshotRequest');
  return {
    schema: MCP_SNAPSHOT_REQUEST_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'AppMcpSnapshotRequest')),
  };
}

function encodeMcpSnapshotRequest(value: AppMcpSnapshotRequest): JsonObject {
  return { schema: value.schema, workspace: encodeWorkspace(value.workspace) };
}

function decodeMcpSnapshot(input: unknown): AppMcpSnapshot {
  const value = exactObject(
    input,
    ['revision', 'schema', 'servers', 'sourceRevisions', 'workspace'],
    'AppMcpSnapshot',
  );
  assertSchema(value, MCP_SNAPSHOT_RESPONSE_SCHEMA_, 'AppMcpSnapshot');
  return {
    schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'AppMcpSnapshot')),
    revision: nonEmptyString(
      required(value, 'revision', 'AppMcpSnapshot'),
      'AppMcpSnapshot.revision',
      256,
    ),
    sourceRevisions: decodeSourceRevisions(required(value, 'sourceRevisions', 'AppMcpSnapshot')),
    servers: arrayValue(
      required(value, 'servers', 'AppMcpSnapshot'),
      'AppMcpSnapshot.servers',
      (entry, index) => decodeMcpServer(entry, `AppMcpSnapshot.servers[${index}]`),
      256,
    ),
  };
}

function encodeMcpSnapshot(value: AppMcpSnapshot): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspace(value.workspace),
    revision: value.revision,
    sourceRevisions: { ...value.sourceRevisions },
    servers: value.servers.map(encodeMcpServer),
  };
}

function decodeMcpActionRequest(input: unknown): AppMcpActionRequest {
  const value = exactObject(input, ['action', 'schema', 'workspace'], 'AppMcpActionRequest');
  assertSchema(value, MCP_ACTION_REQUEST_SCHEMA_, 'AppMcpActionRequest');
  return {
    schema: MCP_ACTION_REQUEST_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'AppMcpActionRequest')),
    action: decodeMcpAction(required(value, 'action', 'AppMcpActionRequest')),
  };
}

function encodeMcpActionRequest(value: AppMcpActionRequest): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspace(value.workspace),
    action: encodeMcpAction(value.action),
  };
}

function decodeMcpActionResponse(input: unknown): AppMcpActionResponse {
  const value = exactObject(input, ['outcome', 'schema', 'snapshot'], 'AppMcpActionResponse');
  assertSchema(value, MCP_ACTION_RESPONSE_SCHEMA_, 'AppMcpActionResponse');
  return {
    schema: MCP_ACTION_RESPONSE_SCHEMA_,
    outcome: enumValue(
      required(value, 'outcome', 'AppMcpActionResponse'),
      'AppMcpActionResponse.outcome',
      ['applied', 'conflict', 'outcome_unknown', 'unavailable', 'rejected'] as const,
    ),
    snapshot: decodeMcpSnapshot(required(value, 'snapshot', 'AppMcpActionResponse')),
  };
}

function encodeMcpActionResponse(value: AppMcpActionResponse): JsonObject {
  return {
    schema: value.schema,
    outcome: value.outcome,
    snapshot: encodeMcpSnapshot(value.snapshot),
  };
}

function decodeMcpAction(input: unknown): AppMcpAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('AppMcpAction must be an object.');
  }
  const candidate = input as JsonObject;
  const type = nonEmptyString(candidate.type, 'AppMcpAction.type', 32);
  switch (type) {
    case 'approve':
    case 'reject':
    case 'login':
    case 'retry':
    case 'reconnect':
    case 'cancel_auth': {
      const value = exactObject(input, ['expectedRevision', 'key', 'type'], `AppMcpAction.${type}`);
      return {
        type,
        key: decodeMcpServerKey(required(value, 'key', `AppMcpAction.${type}`)),
        expectedRevision: decodeRevision(
          required(value, 'expectedRevision', `AppMcpAction.${type}`),
          `AppMcpAction.${type}.expectedRevision`,
        ),
      };
    }
    case 'set_enabled': {
      const value = exactObject(
        input,
        ['enabled', 'expectedRevision', 'key', 'type'],
        'AppMcpAction.set_enabled',
      );
      return {
        type,
        key: decodeMcpServerKey(required(value, 'key', 'AppMcpAction.set_enabled')),
        enabled: booleanValue(
          required(value, 'enabled', 'AppMcpAction.set_enabled'),
          'AppMcpAction.set_enabled.enabled',
        ),
        expectedRevision: decodeRevision(
          required(value, 'expectedRevision', 'AppMcpAction.set_enabled'),
          'AppMcpAction.set_enabled.expectedRevision',
        ),
      };
    }
    case 'add': {
      const value = exactObject(
        input,
        ['expectedRevision', 'name', 'source', 'transport', 'type', 'value'],
        'AppMcpAction.add',
      );
      return {
        type,
        source: enumValue(
          required(value, 'source', 'AppMcpAction.add'),
          'AppMcpAction.add.source',
          ['project', 'user'] as const,
        ),
        name: safeIdentifier(required(value, 'name', 'AppMcpAction.add'), 'AppMcpAction.add.name'),
        transport: enumValue(
          required(value, 'transport', 'AppMcpAction.add'),
          'AppMcpAction.add.transport',
          ['http', 'stdio'] as const,
        ),
        value: stringValue(required(value, 'value', 'AppMcpAction.add'), 'AppMcpAction.add.value', {
          min: 1,
          max: 4_096,
        }),
        expectedRevision: decodeRevision(
          required(value, 'expectedRevision', 'AppMcpAction.add'),
          'AppMcpAction.add.expectedRevision',
        ),
      };
    }
    case 'remove': {
      const value = exactObject(input, ['expectedRevision', 'key', 'type'], 'AppMcpAction.remove');
      return {
        type,
        key: decodeMcpServerKey(required(value, 'key', 'AppMcpAction.remove')),
        expectedRevision: decodeRevision(
          required(value, 'expectedRevision', 'AppMcpAction.remove'),
          'AppMcpAction.remove.expectedRevision',
        ),
      };
    }
    default:
      invalid('AppMcpAction.type has an unsupported value.');
  }
}

function encodeMcpAction(value: AppMcpAction): JsonObject {
  switch (value.type) {
    case 'approve':
    case 'reject':
    case 'login':
    case 'retry':
    case 'reconnect':
    case 'cancel_auth':
    case 'remove':
      return {
        type: value.type,
        key: encodeMcpServerKey(value.key),
        expectedRevision: value.expectedRevision,
      };
    case 'set_enabled':
      return {
        type: value.type,
        key: encodeMcpServerKey(value.key),
        enabled: value.enabled,
        expectedRevision: value.expectedRevision,
      };
    case 'add':
      return {
        type: value.type,
        source: value.source,
        name: value.name,
        transport: value.transport,
        value: value.value,
        expectedRevision: value.expectedRevision,
      };
  }
}

function decodeMcpServer(input: unknown, label: string): AppMcpServer {
  const value = exactObject(
    input,
    [
      'approval',
      'authStatus',
      'configStatus',
      'diagnostic',
      'effective',
      'fallbackSource',
      'health',
      'key',
      'enabled',
      'promptCount',
      'resourceCount',
      'toolCount',
      'tools',
      'transport',
    ],
    label,
  );
  const approval = optional(value, 'approval');
  const diagnostic = optional(value, 'diagnostic');
  const fallbackSource = optional(value, 'fallbackSource');
  return {
    key: decodeMcpServerKey(required(value, 'key', label)),
    effective: booleanValue(required(value, 'effective', label), `${label}.effective`),
    ...(fallbackSource === undefined
      ? {}
      : {
          fallbackSource: enumValue(fallbackSource, `${label}.fallbackSource`, [
            'project',
            'user',
            'explicit',
          ] as const),
        }),
    transport: enumValue(required(value, 'transport', label), `${label}.transport`, [
      'http',
      'stdio',
    ] as const),
    enabled: booleanValue(required(value, 'enabled', label), `${label}.enabled`),
    configStatus: enumValue(required(value, 'configStatus', label), `${label}.configStatus`, [
      'ready',
      'pending_approval',
      'rejected',
      'disabled',
      'invalid',
      'store_corrupt',
      'store_unavailable',
    ] as const),
    health: enumValue(required(value, 'health', label), `${label}.health`, [
      'disconnected',
      'discovering',
      'connecting',
      'ready',
      'degraded',
      'half_open',
      'circuit_open',
      'quarantined',
      'failed',
    ] as const),
    authStatus: enumValue(required(value, 'authStatus', label), `${label}.authStatus`, [
      'not_required',
      'authenticated',
      'authorizing',
      'refreshing',
      'login_required',
      'reauth_required',
      'error',
    ] as const),
    toolCount: integerValue(required(value, 'toolCount', label), `${label}.toolCount`, {
      min: 0,
    }),
    resourceCount: integerValue(required(value, 'resourceCount', label), `${label}.resourceCount`, {
      min: 0,
    }),
    promptCount: integerValue(required(value, 'promptCount', label), `${label}.promptCount`, {
      min: 0,
    }),
    tools: arrayValue(
      required(value, 'tools', label),
      `${label}.tools`,
      (entry, index) => decodeMcpTool(entry, `${label}.tools[${index}]`),
      256,
    ),
    ...(approval === undefined
      ? {}
      : { approval: decodeMcpApproval(approval, `${label}.approval`) }),
    ...(diagnostic === undefined
      ? {}
      : { diagnostic: decodeMcpDiagnostic(diagnostic, `${label}.diagnostic`) }),
  };
}

function encodeMcpServer(value: AppMcpServer): JsonObject {
  return {
    key: encodeMcpServerKey(value.key),
    effective: value.effective,
    ...(value.fallbackSource === undefined ? {} : { fallbackSource: value.fallbackSource }),
    transport: value.transport,
    enabled: value.enabled,
    configStatus: value.configStatus,
    health: value.health,
    authStatus: value.authStatus,
    toolCount: value.toolCount,
    resourceCount: value.resourceCount,
    promptCount: value.promptCount,
    tools: value.tools.map(encodeMcpTool),
    ...(value.approval === undefined ? {} : { approval: encodeMcpApproval(value.approval) }),
    ...(value.diagnostic === undefined
      ? {}
      : { diagnostic: encodeMcpDiagnostic(value.diagnostic) }),
  };
}

function decodeMcpServerKey(input: unknown): AppMcpServerKey {
  const value = exactObject(input, ['name', 'source'], 'AppMcpServerKey');
  return {
    name: safeIdentifier(required(value, 'name', 'AppMcpServerKey'), 'AppMcpServerKey.name'),
    source: enumValue(required(value, 'source', 'AppMcpServerKey'), 'AppMcpServerKey.source', [
      'project',
      'user',
      'explicit',
    ] as const),
  };
}

function encodeMcpServerKey(value: AppMcpServerKey): JsonObject {
  return { name: value.name, source: value.source };
}

function decodeMcpTool(input: unknown, label: string): AppMcpTool {
  const value = exactObject(input, ['description', 'name', 'parameters'], label);
  const description = optional(value, 'description');
  return {
    name: safeIdentifier(required(value, 'name', label), `${label}.name`, 256),
    ...(description === undefined
      ? {}
      : { description: stringValue(description, `${label}.description`, { max: 8_192 }) }),
    parameters: arrayValue(
      required(value, 'parameters', label),
      `${label}.parameters`,
      (entry, index) => decodeMcpToolParameter(entry, `${label}.parameters[${index}]`),
      128,
    ),
  };
}

function encodeMcpTool(value: AppMcpTool): JsonObject {
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    parameters: value.parameters.map(encodeMcpToolParameter),
  };
}

function decodeMcpToolParameter(input: unknown, label: string): AppMcpToolParameter {
  const value = exactObject(input, ['description', 'name', 'required', 'type'], label);
  const description = optional(value, 'description');
  return {
    name: safeIdentifier(required(value, 'name', label), `${label}.name`, 256),
    type: nonEmptyString(required(value, 'type', label), `${label}.type`, 256),
    required: booleanValue(required(value, 'required', label), `${label}.required`),
    ...(description === undefined
      ? {}
      : { description: stringValue(description, `${label}.description`, { max: 2_048 }) }),
  };
}

function encodeMcpToolParameter(value: AppMcpToolParameter): JsonObject {
  return {
    name: value.name,
    type: value.type,
    required: value.required,
    ...(value.description === undefined ? {} : { description: value.description }),
  };
}

function decodeMcpApproval(input: unknown, label: string): AppMcpApproval {
  const value = exactObject(input, ['configDigest', 'status'], label);
  const configDigest = optional(value, 'configDigest');
  return {
    status: enumValue(required(value, 'status', label), `${label}.status`, [
      'pending',
      'approved',
      'rejected',
    ] as const),
    ...(configDigest === undefined
      ? {}
      : { configDigest: requireDigest(configDigest, `${label}.configDigest`) }),
  };
}

function encodeMcpApproval(value: AppMcpApproval): JsonObject {
  return {
    status: value.status,
    ...(value.configDigest === undefined ? {} : { configDigest: value.configDigest }),
  };
}

function decodeMcpDiagnostic(input: unknown, label: string): AppMcpDiagnostic {
  const value = exactObject(input, ['code', 'retryable'], label);
  return {
    code: safeIdentifier(required(value, 'code', label), `${label}.code`, 128),
    retryable: booleanValue(required(value, 'retryable', label), `${label}.retryable`),
  };
}

function encodeMcpDiagnostic(value: AppMcpDiagnostic): JsonObject {
  return { code: value.code, retryable: value.retryable };
}

function decodeSourceRevisions(input: unknown): Readonly<{ project: string; user: string }> {
  const value = exactObject(input, ['project', 'user'], 'AppMcpSnapshot.sourceRevisions');
  return Object.freeze({
    project: decodeRevision(
      required(value, 'project', 'AppMcpSnapshot.sourceRevisions'),
      'AppMcpSnapshot.sourceRevisions.project',
    ),
    user: decodeRevision(
      required(value, 'user', 'AppMcpSnapshot.sourceRevisions'),
      'AppMcpSnapshot.sourceRevisions.user',
    ),
  });
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

function requireDigest(input: unknown, label: string): `sha256:${string}` {
  const value = stringValue(input, label, { min: 71, max: 71 });
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) invalid(`${label} must be a sha256 digest.`);
  return value as `sha256:${string}`;
}

function assertSchema(value: JsonObject, expected: string, label: string): void {
  if (value.schema !== expected) invalid(`${label}.schema must equal ${expected}.`);
}
