import {
  booleanValue,
  type ExactJsonCodec,
  enumValue,
  exactCodec,
  exactObject,
  invalid,
  type JsonObject,
  nonEmptyString,
  required,
  safeIdentifier,
  sha256Digest,
  stringValue,
} from './validation';

export const WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_ =
  'kite.app.workspace-trust.query-request.v1' as const;
export const WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_ =
  'kite.app.workspace-trust.query-response.v1' as const;
export const WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_ =
  'kite.app.workspace-trust.decision-request.v1' as const;
export const WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_ =
  'kite.app.workspace-trust.decision-response.v1' as const;

export interface KiteWorkspaceIdentity {
  readonly canonicalPath: string;
  readonly projectId: string;
  readonly workspaceDigest: `sha256:${string}`;
}

export type WorkspaceTrustStatus = 'trusted' | 'unknown' | 'corrupt' | 'unavailable';

export interface WorkspaceTrustQueryRequest {
  readonly schema: typeof WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_;
  /** The path the user asked to open; the Service canonicalizes it. */
  readonly workspace: string;
}

export interface WorkspaceTrustQueryResponse {
  readonly schema: typeof WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly status: WorkspaceTrustStatus;
  readonly revision: string;
  readonly canDecide: boolean;
}

export interface WorkspaceTrustDecisionRequest {
  readonly schema: typeof WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly observedStatus: WorkspaceTrustStatus;
  readonly expectedRevision: string;
  readonly decision: 'trust' | 'decline';
}

export type WorkspaceTrustDecisionOutcome =
  | 'recorded'
  | 'already_trusted'
  | 'declined'
  | 'conflict'
  | 'unavailable';

export interface WorkspaceTrustDecisionResponse {
  readonly schema: typeof WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly status: WorkspaceTrustStatus;
  readonly outcome: WorkspaceTrustDecisionOutcome;
  readonly revision: string;
}

export const workspaceTrustQueryRequestCodec: ExactJsonCodec<WorkspaceTrustQueryRequest> =
  exactCodec({
    schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
    decode: decodeWorkspaceTrustQueryRequest,
    encode: encodeWorkspaceTrustQueryRequest,
  });

export const workspaceTrustQueryResponseCodec: ExactJsonCodec<WorkspaceTrustQueryResponse> =
  exactCodec({
    schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
    decode: decodeWorkspaceTrustQueryResponse,
    encode: encodeWorkspaceTrustQueryResponse,
  });

export const workspaceTrustDecisionRequestCodec: ExactJsonCodec<WorkspaceTrustDecisionRequest> =
  exactCodec({
    schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
    decode: decodeWorkspaceTrustDecisionRequest,
    encode: encodeWorkspaceTrustDecisionRequest,
  });

export const workspaceTrustDecisionResponseCodec: ExactJsonCodec<WorkspaceTrustDecisionResponse> =
  exactCodec({
    schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
    decode: decodeWorkspaceTrustDecisionResponse,
    encode: encodeWorkspaceTrustDecisionResponse,
  });

export function decodeWorkspaceIdentity(
  input: unknown,
  label = 'workspace',
): KiteWorkspaceIdentity {
  const value = exactObject(input, ['canonicalPath', 'projectId', 'workspaceDigest'], label);
  return {
    canonicalPath: stringValue(required(value, 'canonicalPath', label), `${label}.canonicalPath`, {
      min: 1,
      max: 4_096,
    }),
    projectId: safeIdentifier(required(value, 'projectId', label), `${label}.projectId`),
    workspaceDigest: sha256Digest(
      required(value, 'workspaceDigest', label),
      `${label}.workspaceDigest`,
    ),
  };
}

function decodeWorkspaceTrustQueryRequest(input: unknown): WorkspaceTrustQueryRequest {
  const value = exactObject(input, ['schema', 'workspace'], 'WorkspaceTrustQueryRequest');
  assertSchema(value, WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_, 'WorkspaceTrustQueryRequest');
  return {
    schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
    workspace: stringValue(
      required(value, 'workspace', 'WorkspaceTrustQueryRequest'),
      'workspace',
      {
        min: 1,
        max: 4_096,
      },
    ),
  };
}

function encodeWorkspaceTrustQueryRequest(value: WorkspaceTrustQueryRequest): JsonObject {
  return { schema: value.schema, workspace: value.workspace };
}

function decodeWorkspaceTrustQueryResponse(input: unknown): WorkspaceTrustQueryResponse {
  const value = exactObject(
    input,
    ['canDecide', 'revision', 'schema', 'status', 'workspace'],
    'WorkspaceTrustQueryResponse',
  );
  assertSchema(value, WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_, 'WorkspaceTrustQueryResponse');
  return {
    schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'WorkspaceTrustQueryResponse')),
    status: enumValue(
      required(value, 'status', 'WorkspaceTrustQueryResponse'),
      'WorkspaceTrustQueryResponse.status',
      ['trusted', 'unknown', 'corrupt', 'unavailable'] as const,
    ),
    revision: nonEmptyString(
      required(value, 'revision', 'WorkspaceTrustQueryResponse'),
      'WorkspaceTrustQueryResponse.revision',
      256,
    ),
    canDecide: booleanValue(
      required(value, 'canDecide', 'WorkspaceTrustQueryResponse'),
      'WorkspaceTrustQueryResponse.canDecide',
    ),
  };
}

function encodeWorkspaceTrustQueryResponse(value: WorkspaceTrustQueryResponse): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspaceIdentity(value.workspace),
    status: value.status,
    revision: value.revision,
    canDecide: value.canDecide,
  };
}

function decodeWorkspaceTrustDecisionRequest(input: unknown): WorkspaceTrustDecisionRequest {
  const value = exactObject(
    input,
    ['decision', 'expectedRevision', 'observedStatus', 'schema', 'workspace'],
    'WorkspaceTrustDecisionRequest',
  );
  assertSchema(value, WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_, 'WorkspaceTrustDecisionRequest');
  return {
    schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
    workspace: decodeWorkspaceIdentity(
      required(value, 'workspace', 'WorkspaceTrustDecisionRequest'),
    ),
    observedStatus: enumValue(
      required(value, 'observedStatus', 'WorkspaceTrustDecisionRequest'),
      'WorkspaceTrustDecisionRequest.observedStatus',
      ['trusted', 'unknown', 'corrupt', 'unavailable'] as const,
    ),
    expectedRevision: nonEmptyString(
      required(value, 'expectedRevision', 'WorkspaceTrustDecisionRequest'),
      'WorkspaceTrustDecisionRequest.expectedRevision',
      256,
    ),
    decision: enumValue(
      required(value, 'decision', 'WorkspaceTrustDecisionRequest'),
      'WorkspaceTrustDecisionRequest.decision',
      ['trust', 'decline'] as const,
    ),
  };
}

function encodeWorkspaceTrustDecisionRequest(value: WorkspaceTrustDecisionRequest): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspaceIdentity(value.workspace),
    observedStatus: value.observedStatus,
    expectedRevision: value.expectedRevision,
    decision: value.decision,
  };
}

function decodeWorkspaceTrustDecisionResponse(input: unknown): WorkspaceTrustDecisionResponse {
  const value = exactObject(
    input,
    ['outcome', 'revision', 'schema', 'status', 'workspace'],
    'WorkspaceTrustDecisionResponse',
  );
  assertSchema(value, WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_, 'WorkspaceTrustDecisionResponse');
  return {
    schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
    workspace: decodeWorkspaceIdentity(
      required(value, 'workspace', 'WorkspaceTrustDecisionResponse'),
    ),
    status: enumValue(
      required(value, 'status', 'WorkspaceTrustDecisionResponse'),
      'WorkspaceTrustDecisionResponse.status',
      ['trusted', 'unknown', 'corrupt', 'unavailable'] as const,
    ),
    outcome: enumValue(
      required(value, 'outcome', 'WorkspaceTrustDecisionResponse'),
      'WorkspaceTrustDecisionResponse.outcome',
      ['recorded', 'already_trusted', 'declined', 'conflict', 'unavailable'] as const,
    ),
    revision: nonEmptyString(
      required(value, 'revision', 'WorkspaceTrustDecisionResponse'),
      'WorkspaceTrustDecisionResponse.revision',
      256,
    ),
  };
}

function encodeWorkspaceTrustDecisionResponse(value: WorkspaceTrustDecisionResponse): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspaceIdentity(value.workspace),
    status: value.status,
    outcome: value.outcome,
    revision: value.revision,
  };
}

function encodeWorkspaceIdentity(value: KiteWorkspaceIdentity): JsonObject {
  return {
    canonicalPath: value.canonicalPath,
    projectId: value.projectId,
    workspaceDigest: value.workspaceDigest,
  };
}

function assertSchema(value: JsonObject, expected: string, label: string): void {
  if (value.schema !== expected) invalid(`${label}.schema must equal ${expected}.`);
}
