import { validateRequest } from './decode';
import type { Command, Execution, QueryResponse } from './generated/api';
import { canonicalModelBody } from './model-input';

/** Closed public MCP facts; decoding never grants execution or credential authority. */
export type McpSelectionReadSet = {
  userEtag: string;
  workspaceEtag: string | null;
  explicitDigest: string;
  registryDigest: string;
  registryRevision: string;
  scopeDigest: string;
};
export interface McpManagementSnapshot {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  workspacePath: string;
  registryRevision: string;
  readSet: McpSelectionReadSet;
  items: readonly {
    id: string;
    configDigest: string;
    transport: 'http' | 'stdio';
    source: { kind: 'programmatic' | 'user' | 'workspace'; id: string; revision: string };
    admitted: boolean;
    selected: boolean;
    available: boolean;
    reason: string | null;
  }[];
}

export interface McpConnectionExecution {
  id: string;
  originStoreId: string;
  sessionId: string;
  originCommandId: string;
  parentExecutionId: string | null;
  kind: 'job';
  definitionId: string;
  definitionVersion: string;
  status: Execution['status'];
}
export interface McpConnectionFact {
  storeId: string;
  sessionId: string;
  execution: McpConnectionExecution & { inputDigest: string };
  phase: 'pending' | 'ready' | 'failed' | 'outcome_unknown';
  operationRef: {
    childSessionId?: string;
    commandId: string;
    sessionId: string;
    originStoreId: string;
    extensionId: string;
    key: string;
    executionId: string | null;
  } | null;
  connection: McpConnectionExecution | null;
  ready: { serverId: string; configDigest: string; generation: number; toolCount: number } | null;
  live: boolean;
  currentGeneration: number | null;
  created: boolean | null;
  reason: string | null;
}

export interface McpReconnectionTarget {
  carrierExecutionId: string;
  carrierKey: string;
  operationRef: {
    commandId: string;
    sessionId: string;
    originStoreId: string;
    extensionId: 'builtin.mcp';
    key: string;
    executionId: string;
  };
  connectionExecutionId: string;
  configDigest: string;
  currentGeneration: number;
}
export type McpReconnectionReplacement =
  | { kind: 'static'; expectedConfigDigest: string }
  | {
      kind: 'source';
      expectedConfigDigest: string;
      expectedReadSet: McpSourceReadSet;
    };
export interface McpReconnectionInput {
  serverId: string;
  key: string;
  target: McpReconnectionTarget;
  replacement: McpReconnectionReplacement;
}

export interface McpReconnectionFact {
  storeId: string;
  sessionId: string;
  execution: McpConnectionExecution & { inputDigest: string };
  phase: 'pending' | 'ready' | 'failed' | 'cancelled' | 'outcome_unknown';
  target: McpReconnectionTarget | null;
  oldStop: {
    confirmed: boolean;
    execution: (McpConnectionExecution & { resultRevision: string }) | null;
  };
  newOperationRef: McpReconnectionTarget['operationRef'] | null;
  newConnection: McpConnectionExecution | null;
  ready: { serverId: string; configDigest: string; generation: number; toolCount: number } | null;
  live: boolean;
  currentGeneration: number | null;
  reason: string | null;
}

export interface McpSourceIdentity {
  kind: 'user' | 'workspace';
  pathDigest: string;
  rootIdentity: string;
}
export interface McpSourceRead {
  identity: McpSourceIdentity;
  etag: string | null;
  error: string | null;
}
export interface McpSourceReadSet {
  scopeDigest: string;
  user: McpSourceRead;
  workspace: McpSourceRead | null;
  approvalEtag: string | null;
  bindingEtag: string | null;
  variablesDigest: string;
}
export interface McpSourceItem {
  id: string;
  name: string;
  source: McpSourceIdentity;
  rawEntryDigest: string;
  transportDigest: string | null;
  transport: 'http' | 'stdio' | null;
  enabled: boolean;
  admitted: boolean;
  reason: string | null;
  configDigest: string | null;
}
export interface McpSourceSnapshot {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  readSet: McpSourceReadSet | null;
  registryRevision: string | null;
  items: readonly McpSourceItem[];
  errors:
    | {
        user: string | null;
        workspace: string | null;
        approval: string | null;
        binding: string | null;
      }
    | readonly string[];
}

export interface McpSourceDecisionProof {
  decisionId: string;
  storeId: string;
  sessionId: string;
  interactionId: string;
  acceptedRevision: string;
  subjectId: string;
  requestDigest: string;
  recordedAt: number;
}
export interface McpSourceResult {
  storeId: string;
  sessionId: string;
  command: {
    id: string;
    originStoreId: string;
    sessionId: string;
    subjectId: string;
    kind: 'extension.invoke';
    requestDigest: string;
    status: Command['status'];
    executionId: string | null;
  } | null;
  execution: {
    id: string;
    originStoreId: string;
    sessionId: string;
    originCommandId: string;
    parentExecutionId: string | null;
    kind: 'job';
    definitionId: string;
    definitionVersion: string;
    inputDigest: string;
    status: Execution['status'];
  } | null;
  serverId: string | null;
  phase: 'pending' | 'saved' | 'failed' | 'cancelled' | 'outcome_unknown';
  decision: 'approved' | 'rejected' | 'cancel' | null;
  proof: McpSourceDecisionProof | null;
  mutation: {
    id: string;
    originStoreId: string;
    subjectId: string;
    kind: 'config.user.write';
    scope: 'user';
    requestDigest: string;
    state: 'pending' | 'applied' | 'failed' | 'outcome_unknown';
    etag: string | null;
  } | null;
  recordKey: string | null;
  reason: string | null;
}

export type McpSourceMutationInput =
  | {
      scope: 'user' | 'workspace';
      name: string;
      entry: { type: 'http'; url: string } | { type: 'stdio'; command: string };
      expectedReadSet: McpSourceReadSet;
    }
  | {
      scope: 'user' | 'workspace';
      serverId: string;
      expectedRawEntryDigest: string;
      expectedReadSet: McpSourceReadSet;
    };

export interface McpSourceEntryDeclaration {
  serverId: string;
  name: string;
  source: McpSourceIdentity;
  rawEntryDigest: string;
  transport: 'http' | 'stdio' | null;
  enabled: boolean;
  reason: string | null;
}
export interface McpSourceEntryPreview {
  target: McpSourceEntryDeclaration;
  fallback: McpSourceEntryDeclaration | null;
}
export interface McpSourceRemovalPreview {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  readSet: McpSourceReadSet;
  preview: McpSourceEntryPreview;
}
export interface McpSourceMutationResult {
  storeId: string;
  sessionId: string;
  workspaceId: string | null;
  operation: 'add' | 'remove' | null;
  command: {
    id: string;
    originStoreId: string;
    sessionId: string;
    subjectId: string;
    kind: 'extension.invoke';
    requestDigest: string;
    status: Command['status'];
    executionId: string | null;
  } | null;
  execution: {
    id: string;
    originStoreId: string;
    sessionId: string;
    originCommandId: string;
    parentExecutionId: string | null;
    runId: string | null;
    kind: 'job';
    definitionId: string;
    definitionVersion: string;
    inputDigest: string;
    status: string;
  } | null;
  phase: 'pending' | 'saved' | 'failed' | 'cancelled' | 'outcome_unknown';
  mutation: {
    id: string;
    originStoreId: string;
    subjectId: string;
    kind: 'config.user.write' | 'config.workspace.write';
    /** User mutations use `user`; Workspace mutations retain the actual Workspace ID. */
    scope: string;
    requestDigest: string;
    state: 'pending' | 'applied' | 'failed' | 'outcome_unknown';
    etag: string | null;
  } | null;
  receipt:
    | (McpSourceEntryPreview & {
        operationId: string;
        kind: 'add' | 'remove';
        oldEtag: string;
        newEtag: string;
      })
    | null;
  reason: string | null;
  /** Source saved proves only declaration publication. OAuth cleanup has its own result. */
  credentialCleanup?: {
    status: 'not_attempted' | 'not_needed' | 'completed' | 'failed' | 'outcome_unknown';
    attempted: boolean;
  };
}

export type McpAuthAction =
  | 'mcp.auth.login'
  | 'mcp.auth.refresh'
  | 'mcp.auth.clear'
  | 'mcp.auth.revoke';
export interface McpAuthStatus {
  serverId: string;
  workspaceId: string;
  loginAllowed: boolean;
  policy: 'oauth' | 'auto';
  status: 'available' | 'locked' | 'unavailable';
  credentialPresent: boolean;
}
export interface McpAuthResult {
  storeId: string;
  sessionId: string;
  command: {
    id: string;
    originStoreId: string;
    sessionId: string;
    subjectId: string;
    requestDigest: string;
    status: Command['status'];
    executionId: string | null;
  } | null;
  execution: {
    id: string;
    originStoreId: string;
    sessionId: string;
    originCommandId: string;
    parentExecutionId: null;
    kind: 'job';
    definitionId: string;
    definitionVersion: string;
    inputDigest: string;
    status: Execution['status'];
  } | null;
  binding: {
    version: 1;
    executionId: string;
    originCommandId: string;
    originalStoreId: string;
    sessionId: string;
    workspaceId: string;
    actionId: McpAuthAction;
    serverId: string;
    inputDigest: string;
  } | null;
  phase: 'pending' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  authStatus:
    | 'authenticated'
    | 'revoked'
    | 'not_supported'
    | 'reauth_required'
    | 'error'
    | 'cancelled'
    | 'unknown';
  effectAttempted: boolean | null;
  reason: string | null;
}

const invalid = () => Error('mcp_management_invalid');
function sourceClosed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
const sourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sourceSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sourceServerId = (value: unknown): value is string =>
  typeof value === 'string' && /^mcp-[a-f0-9]{64}$/.test(value);

function parseMcpSourceIdentity(value: unknown) {
  const identity = sourceClosed(value, ['kind', 'pathDigest', 'rootIdentity']);
  if (
    !['user', 'workspace'].includes(typeof identity.kind === 'string' ? identity.kind : '') ||
    !sourceSha(identity.pathDigest) ||
    !sourceSha(identity.rootIdentity)
  )
    throw invalid();
  return identity;
}
/** This is the raw-source read-set, distinct from configuration selection. */
function parseMcpSourceReadSet(value: unknown): McpSourceReadSet {
  const row = sourceClosed(value, [
    'scopeDigest',
    'user',
    'workspace',
    'approvalEtag',
    'bindingEtag',
    'variablesDigest',
  ]);
  const read = (part: unknown, kind: 'user' | 'workspace') => {
    const field = sourceClosed(part, ['identity', 'etag', 'error']);
    if (
      parseMcpSourceIdentity(field.identity).kind !== kind ||
      (field.etag !== null && !sourceSha(field.etag)) ||
      (field.error !== null && typeof field.error !== 'string')
    )
      throw invalid();
  };
  read(row.user, 'user');
  if (row.workspace !== null) read(row.workspace, 'workspace');
  if (
    !sourceSha(row.scopeDigest) ||
    !sourceSha(row.variablesDigest) ||
    (row.approvalEtag !== null && !sourceSha(row.approvalEtag)) ||
    (row.bindingEtag !== null && !sourceSha(row.bindingEtag))
  )
    throw invalid();
  return structuredClone(row) as unknown as McpSourceReadSet;
}

const reconnectionInputinvalid = () => Error('mcp_reconnection_intent_invalid');
function reconnectionClosed(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw reconnectionInputinvalid();
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((reconnectionInputkey) => !keys.includes(reconnectionInputkey))
  )
    throw reconnectionInputinvalid();
  return value as Record<string, unknown>;
}
const reconnectionInputid = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const reconnectionInputkey = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const reconnectionInputdigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function parseMcpReconnectionTarget(value: unknown): McpReconnectionTarget {
  const row = reconnectionClosed(value, [
    'carrierExecutionId',
    'carrierKey',
    'operationRef',
    'connectionExecutionId',
    'configDigest',
    'currentGeneration',
  ]);
  const ref = reconnectionClosed(row.operationRef, [
    'commandId',
    'sessionId',
    'originStoreId',
    'extensionId',
    'key',
    'executionId',
  ]);
  if (
    !reconnectionInputid(row.carrierExecutionId) ||
    !reconnectionInputkey(row.carrierKey) ||
    !reconnectionInputid(row.connectionExecutionId) ||
    !reconnectionInputdigest(row.configDigest) ||
    !Number.isSafeInteger(row.currentGeneration) ||
    Number(row.currentGeneration) < 1 ||
    !reconnectionInputid(ref.commandId) ||
    !reconnectionInputid(ref.sessionId) ||
    !reconnectionInputid(ref.originStoreId) ||
    ref.extensionId !== 'builtin.mcp' ||
    typeof ref.key !== 'string' ||
    !/^connection\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,64}$/.test(ref.key) ||
    !reconnectionInputid(ref.executionId) ||
    ref.executionId !== row.connectionExecutionId
  )
    throw reconnectionInputinvalid();
  return structuredClone(row) as unknown as McpReconnectionTarget;
}
function parseMcpReconnectionInput(value: unknown): McpReconnectionInput {
  const row = reconnectionClosed(value, ['serverId', 'key', 'target', 'replacement']);
  const target = parseMcpReconnectionTarget(row.target);
  if (
    !reconnectionInputid(row.serverId) ||
    !reconnectionInputkey(row.key) ||
    !target.operationRef.key.startsWith(`connection/${row.serverId}/`) ||
    row.key === target.carrierKey ||
    row.key === target.operationRef.key.split('/')[2]
  )
    throw reconnectionInputinvalid();
  const raw = row.replacement;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw reconnectionInputinvalid();
  const replacement = reconnectionClosed(
    raw,
    (raw as Record<string, unknown>).kind === 'source'
      ? ['kind', 'expectedConfigDigest', 'expectedReadSet']
      : ['kind', 'expectedConfigDigest'],
  );
  if (
    !reconnectionInputdigest(replacement.expectedConfigDigest) ||
    typeof replacement.kind !== 'string' ||
    !['source', 'static'].includes(replacement.kind)
  )
    throw reconnectionInputinvalid();
  if (replacement.kind === 'source') {
    try {
      parseMcpSourceReadSet(replacement.expectedReadSet);
    } catch {
      throw reconnectionInputinvalid();
    }
  }
  return structuredClone(row) as unknown as McpReconnectionInput;
}

function managementObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('mcp_directory_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== [...keys].sort().join(','))
    throw Error('mcp_directory_invalid');
  return row;
}
const managementText = (value: unknown, maximum = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const managementHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** One finite fixed Query, including every registered Server; reading does not connect. */
export function decodeMcpManagementSnapshot(result: QueryResponse): McpManagementSnapshot {
  if (
    !Array.isArray(result) ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > 512 * 1024
  )
    throw Error('mcp_directory_invalid');
  const display = result[0];
  if (display)
    managementObject(display, [
      'extensionId',
      'contentType',
      'contentVersion',
      'summary',
      'payload',
      'actions',
      'artifactRefs',
    ]);
  if (
    result.length !== 1 ||
    !display ||
    display.extensionId !== 'builtin.mcp.management' ||
    display.contentType !== 'builtin.mcp.servers' ||
    display.contentVersion !== 1 ||
    typeof display.summary !== 'string' ||
    display.summary.length > 512 ||
    !Array.isArray(display.actions) ||
    !Array.isArray(display.artifactRefs) ||
    display.actions.length !== 0 ||
    display.artifactRefs.length !== 0
  )
    throw Error('mcp_directory_invalid');
  const row = managementObject(display.payload, [
    'storeId',
    'sessionId',
    'workspaceId',
    'workspaceIdentity',
    'workspacePath',
    'registryRevision',
    'readSet',
    'items',
  ]);
  if (
    !sourceId(row.storeId) ||
    !sourceId(row.sessionId) ||
    !sourceId(row.workspaceId) ||
    !managementText(row.workspaceIdentity, 16384) ||
    !managementText(row.workspacePath, 32760) ||
    !managementText(row.registryRevision) ||
    !Array.isArray(row.items) ||
    row.items.length > 32
  )
    throw Error('mcp_directory_invalid');
  const readSet = managementObject(row.readSet, [
    'userEtag',
    'workspaceEtag',
    'explicitDigest',
    'registryDigest',
    'registryRevision',
    'scopeDigest',
  ]);
  if (
    !managementHash(readSet.userEtag) ||
    !(readSet.workspaceEtag === null || managementHash(readSet.workspaceEtag)) ||
    !managementHash(readSet.explicitDigest) ||
    !managementHash(readSet.registryDigest) ||
    !managementHash(readSet.scopeDigest) ||
    readSet.registryRevision !== row.registryRevision
  )
    throw Error('mcp_directory_invalid');
  const ids = new Set<string>();
  for (const value of row.items) {
    const server = managementObject(value, [
      'id',
      'configDigest',
      'transport',
      'source',
      'admitted',
      'selected',
      'available',
      'reason',
    ]);
    const source = managementObject(server.source, ['kind', 'id', 'revision']);
    if (
      typeof server.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(server.id) ||
      ids.has(server.id) ||
      !managementHash(server.configDigest) ||
      typeof server.transport !== 'string' ||
      !['http', 'stdio'].includes(server.transport) ||
      typeof source.kind !== 'string' ||
      !['programmatic', 'user', 'workspace'].includes(source.kind) ||
      !managementText(source.id) ||
      !managementText(source.revision) ||
      ['admitted', 'selected', 'available'].some((key) => typeof server[key] !== 'boolean') ||
      !(server.reason === null || managementText(server.reason))
    )
      throw Error('mcp_directory_invalid');
    ids.add(server.id);
  }
  return structuredClone(row) as unknown as McpManagementSnapshot;
}

const connectionInvalid = () => Error('mcp_connection_fact_invalid');
function connectionClosed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw connectionInvalid();
  return value as Record<string, unknown>;
}
const connectionObj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const connectionId = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const connectionHash = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const connectionText = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const connectionStatuses = [
  'planned',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
];

/** Only the bounded original receipt projection crosses this caller boundary. */
export function decodeMcpConnectionFact(result: QueryResponse): McpConnectionFact {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > 16 * 1024
  )
    throw connectionInvalid();
  const display = connectionClosed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    display.extensionId !== 'builtin.mcp' ||
    display.contentType !== 'builtin.mcp.connection' ||
    display.contentVersion !== 1 ||
    !connectionText(display.summary, 512) ||
    !Array.isArray(display.actions) ||
    display.actions.length !== 0 ||
    !Array.isArray(display.artifactRefs) ||
    display.artifactRefs.length !== 0
  )
    throw connectionInvalid();
  const row = connectionClosed(display.payload, [
    'storeId',
    'sessionId',
    'execution',
    'phase',
    'operationRef',
    'connection',
    'ready',
    'live',
    'currentGeneration',
    'created',
    'reason',
  ]);
  const executionKeys = [
    'id',
    'originStoreId',
    'sessionId',
    'originCommandId',
    'parentExecutionId',
    'kind',
    'definitionId',
    'definitionVersion',
    'status',
  ];
  const execution = (value: unknown, action: boolean) => {
    const fact = connectionClosed(value, [...executionKeys, ...(action ? ['inputDigest'] : [])]);
    if (
      !connectionId(fact.id) ||
      !connectionId(fact.originStoreId) ||
      !connectionId(fact.sessionId) ||
      !connectionId(fact.originCommandId) ||
      (fact.parentExecutionId !== null && !connectionId(fact.parentExecutionId)) ||
      fact.kind !== 'job' ||
      !connectionText(fact.definitionId, 512) ||
      !connectionText(fact.definitionVersion, 128) ||
      typeof fact.status !== 'string' ||
      !connectionStatuses.includes(fact.status) ||
      (action &&
        (!connectionHash(fact.inputDigest) ||
          fact.definitionId !== 'builtin.mcp/mcp.connect' ||
          fact.definitionVersion !== '1'))
    )
      throw connectionInvalid();
    return fact;
  };
  execution(row.execution, true);
  if (row.connection !== null) execution(row.connection, false);
  if (row.operationRef !== null) {
    const raw = connectionObj(row.operationRef);
    if (!raw) throw connectionInvalid();
    const ref = connectionClosed(raw, [
      'commandId',
      'sessionId',
      'originStoreId',
      'extensionId',
      'key',
      'executionId',
      ...(Object.hasOwn(raw, 'childSessionId') ? ['childSessionId'] : []),
    ]);
    if (
      !connectionId(ref.commandId) ||
      !connectionId(ref.sessionId) ||
      !connectionId(ref.originStoreId) ||
      ref.extensionId !== 'builtin.mcp' ||
      typeof ref.key !== 'string' ||
      !/^connection\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,64}$/.test(ref.key) ||
      (ref.executionId !== null && !connectionId(ref.executionId)) ||
      (Object.hasOwn(ref, 'childSessionId') && !connectionId(ref.childSessionId))
    )
      throw connectionInvalid();
  }
  if (row.ready !== null) {
    const ready = connectionClosed(row.ready, [
      'serverId',
      'configDigest',
      'generation',
      'toolCount',
    ]);
    if (
      !connectionId(ready.serverId) ||
      !connectionHash(ready.configDigest) ||
      !Number.isSafeInteger(ready.generation) ||
      Number(ready.generation) < 1 ||
      !Number.isSafeInteger(ready.toolCount) ||
      Number(ready.toolCount) < 0 ||
      Number(ready.toolCount) > 16384
    )
      throw connectionInvalid();
  }
  if (
    !connectionId(row.storeId) ||
    !connectionId(row.sessionId) ||
    typeof row.phase !== 'string' ||
    !['pending', 'ready', 'failed', 'outcome_unknown'].includes(row.phase) ||
    typeof row.live !== 'boolean' ||
    (row.currentGeneration !== null &&
      (!Number.isSafeInteger(row.currentGeneration) || Number(row.currentGeneration) < 1)) ||
    (row.created !== null && typeof row.created !== 'boolean') ||
    (row.reason !== null &&
      (typeof row.reason !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(row.reason))) ||
    (row.live && row.currentGeneration === null) ||
    (!row.live && row.currentGeneration !== null) ||
    (row.phase === 'ready' &&
      (row.ready === null || row.connection === null || row.operationRef === null)) ||
    (row.phase !== 'ready' && row.ready !== null)
  )
    throw connectionInvalid();
  verifyConnectionScope(row, false);
  return structuredClone(row) as unknown as McpConnectionFact;
}

const reconnectionInvalid = () => Error('mcp_reconnection_fact_invalid');
const reconnectionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const reconnectionHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reconnectionText = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const reconnectionGeneration = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const reconnectionTerminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'];
const reconnectionStatuses = ['planned', 'dispatching', 'running', ...reconnectionTerminal];
const reconnectionExecutionKeys = [
  'id',
  'originStoreId',
  'sessionId',
  'originCommandId',
  'parentExecutionId',
  'kind',
  'definitionId',
  'definitionVersion',
  'status',
];
function reconnectionProjection(value: unknown, extra: 'inputDigest' | 'resultRevision' | null) {
  const row = reconnectionClosed(value, [...reconnectionExecutionKeys, ...(extra ? [extra] : [])]);
  if (
    !reconnectionId(row.id) ||
    !reconnectionId(row.originStoreId) ||
    !reconnectionId(row.sessionId) ||
    !reconnectionId(row.originCommandId) ||
    (row.parentExecutionId !== null && !reconnectionId(row.parentExecutionId)) ||
    row.kind !== 'job' ||
    !reconnectionText(row.definitionId, 512) ||
    !reconnectionText(row.definitionVersion, 128) ||
    typeof row.status !== 'string' ||
    !reconnectionStatuses.includes(row.status)
  )
    throw reconnectionInvalid();
  if (
    extra === 'inputDigest' &&
    (!reconnectionHash(row.inputDigest) ||
      row.definitionId !== 'builtin.mcp/mcp.reconnect' ||
      row.definitionVersion !== '1')
  )
    throw reconnectionInvalid();
  if (
    extra === 'resultRevision' &&
    (typeof row.resultRevision !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(row.resultRevision) ||
      BigInt(row.resultRevision) > 9223372036854775807n)
  )
    throw reconnectionInvalid();
  return row;
}
function reconnectionOperation(value: unknown) {
  const row = reconnectionClosed(value, [
    'commandId',
    'sessionId',
    'originStoreId',
    'extensionId',
    'key',
    'executionId',
  ]);
  if (
    !reconnectionId(row.commandId) ||
    !reconnectionId(row.sessionId) ||
    !reconnectionId(row.originStoreId) ||
    row.extensionId !== 'builtin.mcp' ||
    typeof row.key !== 'string' ||
    !/^connection\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,64}$/.test(row.key) ||
    !reconnectionId(row.executionId)
  )
    throw reconnectionInvalid();
  return row;
}
/** One closed, finite original-result display. No caller reconstruction of producer input. */
export function decodeMcpReconnectionFact(result: QueryResponse): McpReconnectionFact {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > 16 * 1024
  )
    throw reconnectionInvalid();
  const display = reconnectionClosed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    display.extensionId !== 'builtin.mcp' ||
    display.contentType !== 'builtin.mcp.reconnection' ||
    display.contentVersion !== 1 ||
    !reconnectionText(display.summary, 512) ||
    !Array.isArray(display.actions) ||
    display.actions.length ||
    !Array.isArray(display.artifactRefs) ||
    display.artifactRefs.length
  )
    throw reconnectionInvalid();
  const row = reconnectionClosed(display.payload, [
    'storeId',
    'sessionId',
    'execution',
    'phase',
    'target',
    'oldStop',
    'newOperationRef',
    'newConnection',
    'ready',
    'live',
    'currentGeneration',
    'reason',
  ]);
  reconnectionProjection(row.execution, 'inputDigest');
  if (row.target !== null) parseMcpReconnectionTarget(row.target);
  const stop = reconnectionClosed(row.oldStop, ['confirmed', 'execution']);
  if (typeof stop.confirmed !== 'boolean') throw reconnectionInvalid();
  if (stop.execution !== null) reconnectionProjection(stop.execution, 'resultRevision');
  if (
    stop.confirmed &&
    (stop.execution === null ||
      !['succeeded', 'failed', 'cancelled'].includes(
        (stop.execution as Record<string, unknown>).status as string,
      ) ||
      (stop.execution as Record<string, unknown>).resultRevision === '0')
  )
    throw reconnectionInvalid();
  if (row.newOperationRef !== null) reconnectionOperation(row.newOperationRef);
  if (row.newConnection !== null) reconnectionProjection(row.newConnection, null);
  if (row.ready !== null) {
    const ready = reconnectionClosed(row.ready, [
      'serverId',
      'configDigest',
      'generation',
      'toolCount',
    ]);
    if (
      !reconnectionId(ready.serverId) ||
      !reconnectionHash(ready.configDigest) ||
      !reconnectionGeneration(ready.generation) ||
      !Number.isSafeInteger(ready.toolCount) ||
      Number(ready.toolCount) < 0 ||
      Number(ready.toolCount) > 16384
    )
      throw reconnectionInvalid();
  }
  if (
    !reconnectionId(row.storeId) ||
    !reconnectionId(row.sessionId) ||
    typeof row.phase !== 'string' ||
    !['pending', 'ready', 'failed', 'cancelled', 'outcome_unknown'].includes(row.phase) ||
    typeof row.live !== 'boolean' ||
    (row.currentGeneration !== null && !reconnectionGeneration(row.currentGeneration)) ||
    (row.reason !== null &&
      (typeof row.reason !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(row.reason))) ||
    row.live !== (row.currentGeneration !== null) ||
    (row.phase === 'ready' &&
      (!row.target ||
        !stop.confirmed ||
        !row.newOperationRef ||
        !row.newConnection ||
        !row.ready)) ||
    (row.phase !== 'ready' && row.ready !== null) ||
    (row.live && row.phase !== 'ready') ||
    (row.newConnection !== null && row.newOperationRef === null) ||
    (row.target === null &&
      (stop.confirmed ||
        stop.execution !== null ||
        row.newOperationRef !== null ||
        row.newConnection !== null))
  )
    throw reconnectionInvalid();
  verifyConnectionScope(row, true);
  return structuredClone(row) as unknown as McpReconnectionFact;
}

const sourceInvalid = () => Error('mcp_source_approval_fact_invalid');
const sourceCode = (value: unknown) =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value);
const sourceText = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const sourceExecutionStatuses = [
  'planned',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
];
function sourceEnvelope(result: QueryResponse, contentType: string, maximum: number) {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > maximum
  )
    throw sourceInvalid();
  const display = sourceClosed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    display.extensionId !== 'builtin.mcp.sources' ||
    display.contentType !== contentType ||
    display.contentVersion !== 1 ||
    !sourceText(display.summary, 512) ||
    !Array.isArray(display.actions) ||
    display.actions.length !== 0 ||
    !Array.isArray(display.artifactRefs) ||
    display.artifactRefs.length !== 0
  )
    throw sourceInvalid();
  return display.payload;
}
export function decodeMcpSourcesPage(result: QueryResponse): McpSourcesPage {
  const row = sourceClosed(sourceEnvelope(result, 'builtin.mcp.sources', 64 * 1024), [
    'items',
    'nextAfterId',
    'readSet',
    'registryRevision',
    'errors',
  ]);
  if (
    !Array.isArray(row.items) ||
    row.items.length > 25 ||
    (row.nextAfterId !== null && !sourceServerId(row.nextAfterId))
  )
    throw sourceInvalid();
  if (row.readSet === null) {
    if (
      row.registryRevision !== null ||
      row.items.length ||
      row.nextAfterId !== null ||
      !Array.isArray(row.errors) ||
      !row.errors.length ||
      !row.errors.every(sourceCode)
    )
      throw sourceInvalid();
  } else {
    parseMcpSourceReadSet(row.readSet);
    if (!sourceSha(row.registryRevision)) throw sourceInvalid();
    const errors = sourceClosed(row.errors, ['user', 'workspace', 'approval', 'binding']);
    if (!Object.values(errors).every((value) => value === null || sourceCode(value)))
      throw sourceInvalid();
  }
  let previous: string | undefined;
  for (const raw of row.items) {
    const item = sourceClosed(raw, [
      'id',
      'name',
      'source',
      'rawEntryDigest',
      'transportDigest',
      'transport',
      'enabled',
      'admitted',
      'reason',
      'configDigest',
    ]);
    parseMcpSourceIdentity(item.source);
    if (
      !sourceServerId(item.id) ||
      !sourceText(item.name, 128) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.name as string) ||
      !sourceSha(item.rawEntryDigest) ||
      (item.transportDigest !== null && !sourceSha(item.transportDigest)) ||
      (item.configDigest !== null && !sourceSha(item.configDigest)) ||
      ![null, 'http', 'stdio'].includes(item.transport as string | null) ||
      typeof item.enabled !== 'boolean' ||
      typeof item.admitted !== 'boolean' ||
      (item.reason !== null && !sourceCode(item.reason)) ||
      (previous !== undefined && item.id <= previous)
    )
      throw sourceInvalid();
    previous = item.id;
  }
  if (row.nextAfterId !== null && row.nextAfterId !== previous) throw sourceInvalid();
  return structuredClone(row) as unknown as McpSourcesPage;
}
/** The Service validates private original Question and mutation records; only this finite projection is exposed. */
export function decodeMcpSourceResult(result: QueryResponse): McpSourceResult {
  const row = sourceClosed(sourceEnvelope(result, 'builtin.mcp.source.result', 16 * 1024), [
    'storeId',
    'sessionId',
    'command',
    'execution',
    'serverId',
    'phase',
    'decision',
    'proof',
    'mutation',
    'recordKey',
    'reason',
  ]);
  if (
    !sourceId(row.storeId) ||
    !sourceId(row.sessionId) ||
    (row.serverId !== null && !sourceServerId(row.serverId)) ||
    typeof row.phase !== 'string' ||
    !['pending', 'saved', 'failed', 'cancelled', 'outcome_unknown'].includes(row.phase) ||
    ![null, 'approved', 'rejected', 'cancel'].includes(row.decision as string | null) ||
    (row.recordKey !== null && !sourceSha(row.recordKey)) ||
    (row.reason !== null && !sourceCode(row.reason))
  )
    throw sourceInvalid();
  if (row.command !== null) {
    const command = sourceClosed(row.command, [
      'id',
      'originStoreId',
      'sessionId',
      'subjectId',
      'kind',
      'requestDigest',
      'status',
      'executionId',
    ]);
    if (
      !sourceId(command.id) ||
      !sourceId(command.originStoreId) ||
      !sourceId(command.sessionId) ||
      !sourceText(command.subjectId, 256) ||
      command.kind !== 'extension.invoke' ||
      !sourceSha(command.requestDigest) ||
      typeof command.status !== 'string' ||
      !['accepted', 'applied', 'rejected', 'needs_review'].includes(command.status) ||
      (command.executionId !== null && !sourceId(command.executionId))
    )
      throw sourceInvalid();
  }
  if (row.execution !== null) {
    const execution = sourceClosed(row.execution, [
      'id',
      'originStoreId',
      'sessionId',
      'originCommandId',
      'parentExecutionId',
      'kind',
      'definitionId',
      'definitionVersion',
      'inputDigest',
      'status',
    ]);
    if (
      !sourceId(execution.id) ||
      !sourceId(execution.originStoreId) ||
      !sourceId(execution.sessionId) ||
      !sourceId(execution.originCommandId) ||
      execution.parentExecutionId !== null ||
      execution.kind !== 'job' ||
      execution.definitionId !== 'builtin.mcp.sources/mcp.source.approve' ||
      execution.definitionVersion !== '1' ||
      !sourceSha(execution.inputDigest) ||
      typeof execution.status !== 'string' ||
      !sourceExecutionStatuses.includes(execution.status)
    )
      throw sourceInvalid();
  }
  if (row.proof !== null) {
    const proof = sourceClosed(row.proof, [
      'decisionId',
      'storeId',
      'sessionId',
      'interactionId',
      'acceptedRevision',
      'subjectId',
      'requestDigest',
      'recordedAt',
    ]);
    if (
      !sourceId(proof.storeId) ||
      !sourceId(proof.sessionId) ||
      !sourceId(proof.interactionId) ||
      typeof proof.acceptedRevision !== 'string' ||
      !/^[1-9][0-9]{0,255}$/.test(proof.acceptedRevision) ||
      proof.decisionId !== `${proof.interactionId}@${proof.acceptedRevision}` ||
      !sourceText(proof.subjectId, 256) ||
      !sourceSha(proof.requestDigest) ||
      !Number.isSafeInteger(proof.recordedAt) ||
      Number(proof.recordedAt) <= 0
    )
      throw sourceInvalid();
  }
  if (row.mutation !== null) {
    const mutation = sourceClosed(row.mutation, [
      'id',
      'originStoreId',
      'subjectId',
      'kind',
      'scope',
      'requestDigest',
      'state',
      'etag',
    ]);
    if (
      !sourceId(mutation.id) ||
      !sourceId(mutation.originStoreId) ||
      !sourceText(mutation.subjectId, 256) ||
      mutation.kind !== 'config.user.write' ||
      mutation.scope !== 'user' ||
      !sourceSha(mutation.requestDigest) ||
      typeof mutation.state !== 'string' ||
      !['pending', 'applied', 'failed', 'outcome_unknown'].includes(mutation.state) ||
      (mutation.etag !== null && !sourceSha(mutation.etag))
    )
      throw sourceInvalid();
  }
  if (row.phase !== 'outcome_unknown' && (!row.command || !row.serverId)) throw sourceInvalid();
  if (
    row.phase === 'saved' &&
    ((row.decision !== 'approved' && row.decision !== 'rejected') ||
      !row.proof ||
      !row.mutation ||
      !row.recordKey ||
      !row.execution)
  )
    throw sourceInvalid();
  if (
    row.phase === 'pending' &&
    (row.decision !== null || row.proof !== null || row.mutation !== null || row.recordKey !== null)
  )
    throw sourceInvalid();
  if (
    row.phase === 'failed' &&
    (row.decision !== null || row.proof !== null || row.mutation !== null || row.recordKey !== null)
  )
    throw sourceInvalid();
  if (
    row.phase === 'cancelled' &&
    (row.mutation !== null ||
      row.recordKey !== null ||
      (row.decision === 'cancel'
        ? row.proof === null
        : row.decision !== null || row.proof !== null))
  )
    throw sourceInvalid();
  verifyOriginalScope(row);
  return structuredClone(row) as unknown as McpSourceResult;
}

const mutationInvalid = () => Error('mcp_source_mutation_fact_invalid');
const mutationCode = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(v);
const mutationStates = [
  'planned',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
];
function mutationEnvelope(result: QueryResponse, type: string) {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > 16 * 1024
  )
    throw mutationInvalid();
  const c = sourceClosed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    c.extensionId !== 'builtin.mcp.sources' ||
    c.contentType !== type ||
    c.contentVersion !== 1 ||
    typeof c.summary !== 'string' ||
    c.summary.length > 512 ||
    !Array.isArray(c.actions) ||
    c.actions.length ||
    !Array.isArray(c.artifactRefs) ||
    c.artifactRefs.length
  )
    throw mutationInvalid();
  return c.payload;
}
function mutationDeclaration(v: unknown): McpSourceEntryDeclaration {
  const x = sourceClosed(v, [
    'serverId',
    'name',
    'source',
    'rawEntryDigest',
    'transport',
    'enabled',
    'reason',
  ]);
  parseMcpSourceIdentity(x.source);
  if (
    !sourceServerId(x.serverId) ||
    typeof x.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x.name) ||
    !sourceSha(x.rawEntryDigest) ||
    ![null, 'http', 'stdio'].includes(x.transport as string | null) ||
    typeof x.enabled !== 'boolean' ||
    (x.reason !== null && !mutationCode(x.reason))
  )
    throw mutationInvalid();
  return structuredClone(x) as unknown as McpSourceEntryDeclaration;
}
export function decodeMcpSourceRemovalPreview(result: QueryResponse): McpSourceRemovalPreview {
  const row = sourceClosed(mutationEnvelope(result, 'builtin.mcp.source.entry.preview'), [
    'storeId',
    'sessionId',
    'workspaceId',
    'readSet',
    'preview',
  ]);
  if (![row.storeId, row.sessionId, row.workspaceId].every(sourceId)) throw mutationInvalid();
  parseMcpSourceReadSet(row.readSet);
  const preview = sourceClosed(row.preview, ['target', 'fallback']);
  const target = mutationDeclaration(preview.target);
  if (preview.fallback !== null) {
    const fallback = mutationDeclaration(preview.fallback);
    if (
      target.source.kind !== 'workspace' ||
      fallback.source.kind !== 'user' ||
      target.serverId !== fallback.serverId ||
      target.name !== fallback.name
    )
      throw mutationInvalid();
  }
  return structuredClone(row) as unknown as McpSourceRemovalPreview;
}
export function decodeMcpSourceMutationResult(result: QueryResponse): McpSourceMutationResult {
  const value = mutationEnvelope(result, 'builtin.mcp.source.mutation.result');
  const hasCleanup =
    !!value && typeof value === 'object' && Object.hasOwn(value, 'credentialCleanup');
  const x = sourceClosed(value, [
    'storeId',
    'sessionId',
    'workspaceId',
    'operation',
    'command',
    'execution',
    'phase',
    'mutation',
    'receipt',
    'reason',
    ...(hasCleanup ? ['credentialCleanup'] : []),
  ]);
  if (hasCleanup) {
    const cleanup = sourceClosed(x.credentialCleanup, ['status', 'attempted']);
    if (
      x.operation !== 'remove' ||
      typeof cleanup.status !== 'string' ||
      !['not_attempted', 'not_needed', 'completed', 'failed', 'outcome_unknown'].includes(
        cleanup.status as string,
      ) ||
      typeof cleanup.attempted !== 'boolean' ||
      (['completed', 'failed'].includes(cleanup.status as string) && cleanup.attempted !== true)
    )
      throw mutationInvalid();
  }
  if (
    !sourceId(x.storeId) ||
    !sourceId(x.sessionId) ||
    (x.workspaceId !== null && !sourceId(x.workspaceId)) ||
    ![null, 'add', 'remove'].includes(x.operation as string | null) ||
    typeof x.phase !== 'string' ||
    !['pending', 'saved', 'failed', 'cancelled', 'outcome_unknown'].includes(x.phase) ||
    (x.reason !== null && !mutationCode(x.reason))
  )
    throw mutationInvalid();
  if (x.command !== null) {
    const c = sourceClosed(x.command, [
      'id',
      'originStoreId',
      'sessionId',
      'subjectId',
      'kind',
      'requestDigest',
      'status',
      'executionId',
    ]);
    if (
      !sourceId(c.id) ||
      !sourceId(c.originStoreId) ||
      !sourceId(c.sessionId) ||
      typeof c.subjectId !== 'string' ||
      !c.subjectId.length ||
      c.subjectId.length > 256 ||
      c.kind !== 'extension.invoke' ||
      !sourceSha(c.requestDigest) ||
      typeof c.status !== 'string' ||
      !['accepted', 'applied', 'rejected', 'needs_review'].includes(c.status) ||
      (c.executionId !== null && !sourceId(c.executionId))
    )
      throw mutationInvalid();
  }
  if (x.execution !== null) {
    const e = sourceClosed(x.execution, [
      'id',
      'originStoreId',
      'sessionId',
      'originCommandId',
      'parentExecutionId',
      'runId',
      'kind',
      'definitionId',
      'definitionVersion',
      'inputDigest',
      'status',
    ]);
    for (const k of ['id', 'originStoreId', 'sessionId', 'originCommandId'])
      if (!sourceId(e[k])) throw mutationInvalid();
    if (
      (e.parentExecutionId !== null && !sourceId(e.parentExecutionId)) ||
      (e.runId !== null && !sourceId(e.runId)) ||
      e.kind !== 'job' ||
      typeof e.definitionId !== 'string' ||
      !['builtin.mcp.sources/mcp.source.add', 'builtin.mcp.sources/mcp.source.remove'].includes(
        e.definitionId,
      ) ||
      (x.operation !== null &&
        e.definitionId !== `builtin.mcp.sources/mcp.source.${x.operation}`) ||
      e.definitionVersion !== '1' ||
      !sourceSha(e.inputDigest) ||
      typeof e.status !== 'string' ||
      !mutationStates.includes(e.status)
    )
      throw mutationInvalid();
  }
  if (x.mutation !== null) {
    const m = sourceClosed(x.mutation, [
      'id',
      'originStoreId',
      'subjectId',
      'kind',
      'scope',
      'requestDigest',
      'state',
      'etag',
    ]);
    if (
      !sourceId(m.id) ||
      !sourceId(m.originStoreId) ||
      typeof m.subjectId !== 'string' ||
      !m.subjectId.length ||
      m.subjectId.length > 256 ||
      typeof m.kind !== 'string' ||
      !['config.user.write', 'config.workspace.write'].includes(m.kind) ||
      (m.kind === 'config.user.write'
        ? m.scope !== 'user'
        : !sourceId(x.workspaceId) || m.scope !== x.workspaceId) ||
      !sourceSha(m.requestDigest) ||
      typeof m.state !== 'string' ||
      !['pending', 'applied', 'failed', 'outcome_unknown'].includes(m.state) ||
      (m.etag !== null && !sourceSha(m.etag))
    )
      throw mutationInvalid();
  }
  if (x.receipt !== null) {
    const r = sourceClosed(x.receipt, [
      'target',
      'fallback',
      'operationId',
      'kind',
      'oldEtag',
      'newEtag',
    ]);
    mutationDeclaration(r.target);
    if (r.fallback !== null) mutationDeclaration(r.fallback);
    if (
      !sourceId(r.operationId) ||
      typeof r.kind !== 'string' ||
      !['add', 'remove'].includes(r.kind) ||
      !sourceSha(r.oldEtag) ||
      !sourceSha(r.newEtag)
    )
      throw mutationInvalid();
  }
  if (x.phase === 'saved' && (!x.command || !x.execution || !x.mutation || !x.receipt))
    throw mutationInvalid();
  verifyOriginalScope(x);
  return structuredClone(x) as unknown as McpSourceMutationResult;
}
const authInvalid = () => Error('mcp_auth_fact_invalid');
const authClosed = (value: unknown, keys: string[]) => {
  try {
    return sourceClosed(value, keys);
  } catch {
    throw authInvalid();
  }
};
const authCode = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(v);
function authEnvelope(result: QueryResponse, type: string) {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384
  )
    throw authInvalid();
  const row = authClosed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    row.extensionId !== 'builtin.mcp.sources' ||
    row.contentType !== type ||
    row.contentVersion !== 1 ||
    typeof row.summary !== 'string' ||
    row.summary.length > 512 ||
    !Array.isArray(row.actions) ||
    row.actions.length ||
    !Array.isArray(row.artifactRefs) ||
    row.artifactRefs.length
  )
    throw authInvalid();
  return row.payload;
}
export function decodeMcpAuthStatus(result: QueryResponse): McpAuthStatus {
  const row = authClosed(authEnvelope(result, 'builtin.mcp.auth.status'), [
    'serverId',
    'workspaceId',
    'loginAllowed',
    'policy',
    'status',
    'credentialPresent',
  ]);
  if (
    !sourceServerId(row.serverId) ||
    !sourceId(row.workspaceId) ||
    typeof row.loginAllowed !== 'boolean' ||
    typeof row.credentialPresent !== 'boolean' ||
    typeof row.policy !== 'string' ||
    !['oauth', 'auto'].includes(row.policy) ||
    typeof row.status !== 'string' ||
    !['available', 'locked', 'unavailable'].includes(row.status)
  )
    throw authInvalid();
  return structuredClone(row) as unknown as McpAuthStatus;
}
export function decodeMcpAuthResult(result: QueryResponse): McpAuthResult {
  const row = authClosed(authEnvelope(result, 'builtin.mcp.auth.result'), [
    'storeId',
    'sessionId',
    'command',
    'execution',
    'binding',
    'phase',
    'authStatus',
    'effectAttempted',
    'reason',
  ]);
  if (
    !sourceId(row.storeId) ||
    !sourceId(row.sessionId) ||
    typeof row.phase !== 'string' ||
    !['pending', 'completed', 'failed', 'cancelled', 'outcome_unknown'].includes(row.phase) ||
    typeof row.authStatus !== 'string' ||
    ![
      'authenticated',
      'revoked',
      'not_supported',
      'reauth_required',
      'error',
      'cancelled',
      'unknown',
    ].includes(row.authStatus) ||
    (row.effectAttempted !== null && typeof row.effectAttempted !== 'boolean') ||
    (row.reason !== null && !authCode(row.reason))
  )
    throw authInvalid();
  if (row.command !== null) {
    const c = authClosed(row.command, [
      'id',
      'originStoreId',
      'sessionId',
      'subjectId',
      'requestDigest',
      'status',
      'executionId',
    ]);
    if (
      ![c.id, c.originStoreId, c.sessionId].every(sourceId) ||
      typeof c.subjectId !== 'string' ||
      !c.subjectId ||
      c.subjectId.length > 256 ||
      !sourceSha(c.requestDigest) ||
      typeof c.status !== 'string' ||
      !['accepted', 'applied', 'rejected', 'needs_review'].includes(c.status) ||
      (c.executionId !== null && !sourceId(c.executionId))
    )
      throw authInvalid();
  }
  if (row.execution !== null) {
    const e = authClosed(row.execution, [
      'id',
      'originStoreId',
      'sessionId',
      'originCommandId',
      'parentExecutionId',
      'kind',
      'definitionId',
      'definitionVersion',
      'inputDigest',
      'status',
    ]);
    if (
      ![e.id, e.originStoreId, e.sessionId, e.originCommandId].every(sourceId) ||
      e.parentExecutionId !== null ||
      e.kind !== 'job' ||
      typeof e.definitionId !== 'string' ||
      !/^builtin\.mcp\.sources\/mcp\.auth\.(login|refresh|clear|revoke)$/.test(e.definitionId) ||
      e.definitionVersion !== '1' ||
      !sourceSha(e.inputDigest) ||
      typeof e.status !== 'string' ||
      ![
        'planned',
        'dispatching',
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'outcome_unknown',
      ].includes(e.status)
    )
      throw authInvalid();
  }
  if (row.binding !== null) {
    const b = authClosed(row.binding, [
      'version',
      'executionId',
      'originCommandId',
      'originalStoreId',
      'sessionId',
      'workspaceId',
      'actionId',
      'serverId',
      'inputDigest',
    ]);
    if (
      b.version !== 1 ||
      ![b.executionId, b.originCommandId, b.originalStoreId, b.sessionId, b.workspaceId].every(
        sourceId,
      ) ||
      !sourceServerId(b.serverId) ||
      !sourceSha(b.inputDigest) ||
      typeof b.actionId !== 'string' ||
      !['mcp.auth.login', 'mcp.auth.refresh', 'mcp.auth.clear', 'mcp.auth.revoke'].includes(
        b.actionId,
      )
    )
      throw authInvalid();
  }
  verifyOriginalScope(row);
  return structuredClone(row) as unknown as McpAuthResult;
}
export interface McpSourcesPage {
  items: readonly McpSourceItem[];
  nextAfterId: string | null;
  readSet: McpSourceReadSet | null;
  registryRevision: string | null;
  errors: McpSourceSnapshot['errors'];
}

type McpInvoke<E extends string, A extends string, I> = {
  expectedStoreId: string;
  commandId: string;
  kind: 'extension.invoke';
  extensionId: E;
  actionId: A;
  definitionVersion: '1';
  input: I;
};
/** Fixed MCP actions only. Secrets, arbitrary extensions and prior intent trees are rejected. */
export type McpCommandRequest =
  | McpInvoke<
      'builtin.mcp.management',
      'mcp.server.select',
      {
        serverId: string;
        enabled: boolean;
        scope: 'user' | 'workspace';
        expectedReadSet: McpSelectionReadSet;
      }
    >
  | McpInvoke<'builtin.mcp', 'mcp.connect', { serverId: string; key: string }>
  | McpInvoke<
      'builtin.mcp',
      'mcp.catalogue.refresh',
      {
        serverId: string;
        connectionKey: string;
        connectionExecutionId: string;
        configDigest: string;
        generation: number;
      }
    >
  | McpInvoke<'builtin.mcp', 'mcp.reconnect', McpReconnectionInput>
  | McpInvoke<
      'builtin.mcp.sources',
      'mcp.source.approve' | McpAuthAction,
      {
        serverId: string;
        expectedReadSet: McpSourceReadSet;
      }
    >
  | McpInvoke<
      'builtin.mcp.sources',
      'mcp.credential.bind',
      {
        serverId: string;
        expectedReadSet: McpSourceReadSet;
        expiresAt: number;
      }
    >
  | McpInvoke<
      'builtin.mcp.sources',
      'mcp.source.add',
      Extract<McpSourceMutationInput, { name: string }>
    >
  | McpInvoke<
      'builtin.mcp.sources',
      'mcp.source.remove',
      Extract<McpSourceMutationInput, { serverId: string }>
    >;

function selectionReadSet(value: unknown): McpSelectionReadSet {
  const r = sourceClosed(value, [
    'userEtag',
    'workspaceEtag',
    'explicitDigest',
    'registryDigest',
    'registryRevision',
    'scopeDigest',
  ]);
  if (
    ![r.userEtag, r.explicitDigest, r.registryDigest, r.scopeDigest].every(sourceSha) ||
    (r.workspaceEtag !== null && !sourceSha(r.workspaceEtag)) ||
    !managementText(r.registryRevision)
  )
    throw invalid();
  return structuredClone(r) as unknown as McpSelectionReadSet;
}
const actionKey = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const positiveInteger = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function sourceEntry(value: unknown): void {
  const v = sourceClosed(
    value,
    value && typeof value === 'object' && (value as Record<string, unknown>).type === 'http'
      ? ['type', 'url']
      : ['type', 'command'],
  );
  if (v.type === 'http') {
    if (
      typeof v.url !== 'string' ||
      !v.url ||
      v.url.length > 8192 ||
      v.url.includes('${') ||
      v.url.includes('?') ||
      v.url.includes('#') ||
      Array.from(v.url).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
    )
      throw invalid();
    let url: URL;
    try {
      url = new URL(v.url);
    } catch {
      throw invalid();
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw invalid();
  } else if (v.type === 'stdio') {
    if (
      typeof v.command !== 'string' ||
      !v.command.startsWith('/') ||
      v.command.length > 4096 ||
      Array.from(v.command).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      v.command.includes('${')
    )
      throw invalid();
  } else throw invalid();
}
/** Validates and clones the complete original HTTP request before any host admission. */
export function validateMcpCommandRequest(value: unknown): McpCommandRequest {
  const r = sourceClosed(value, [
    'expectedStoreId',
    'commandId',
    'kind',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
  ]);
  validateRequest('ExtensionCommandRequest', r);
  if (
    !sourceId(r.expectedStoreId) ||
    !sourceId(r.commandId) ||
    r.kind !== 'extension.invoke' ||
    r.definitionVersion !== '1'
  )
    throw invalid();
  let i: Record<string, unknown>;
  if (r.extensionId === 'builtin.mcp.management' && r.actionId === 'mcp.server.select') {
    i = sourceClosed(r.input, ['serverId', 'enabled', 'scope', 'expectedReadSet']);
    const reads = selectionReadSet(i.expectedReadSet);
    if (
      !sourceId(i.serverId) ||
      typeof i.enabled !== 'boolean' ||
      (i.scope !== 'user' && i.scope !== 'workspace') ||
      (i.scope === 'workspace' && reads.workspaceEtag === null)
    )
      throw invalid();
  } else if (r.extensionId === 'builtin.mcp') {
    if (r.actionId === 'mcp.connect') {
      i = sourceClosed(r.input, ['serverId', 'key']);
      if (!sourceId(i.serverId) || !actionKey(i.key)) throw invalid();
    } else if (r.actionId === 'mcp.catalogue.refresh') {
      i = sourceClosed(r.input, [
        'serverId',
        'connectionKey',
        'connectionExecutionId',
        'configDigest',
        'generation',
      ]);
      if (
        !sourceId(i.serverId) ||
        !actionKey(i.connectionKey) ||
        !managementText(i.connectionExecutionId, 256) ||
        !sourceSha(i.configDigest) ||
        !positiveInteger(i.generation)
      )
        throw invalid();
    } else if (r.actionId === 'mcp.reconnect') {
      const input = parseMcpReconnectionInput(r.input);
      if (
        input.target.operationRef.originStoreId !== r.expectedStoreId ||
        input.target.operationRef.commandId === r.commandId
      )
        throw invalid();
    } else throw invalid();
  } else if (r.extensionId === 'builtin.mcp.sources') {
    if (r.actionId === 'mcp.source.add') {
      i = sourceClosed(r.input, ['scope', 'name', 'entry', 'expectedReadSet']);
      if (
        typeof i.name !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(i.name) ||
        ['constructor', 'prototype'].includes(i.name)
      )
        throw invalid();
      sourceEntry(i.entry);
    } else if (r.actionId === 'mcp.source.remove') {
      i = sourceClosed(r.input, ['scope', 'serverId', 'expectedRawEntryDigest', 'expectedReadSet']);
      if (!sourceServerId(i.serverId) || !sourceSha(i.expectedRawEntryDigest)) throw invalid();
    } else if (r.actionId === 'mcp.credential.bind') {
      i = sourceClosed(r.input, ['serverId', 'expectedReadSet', 'expiresAt']);
      if (!sourceServerId(i.serverId) || !positiveInteger(i.expiresAt)) throw invalid();
    } else if (
      typeof r.actionId === 'string' &&
      [
        'mcp.source.approve',
        'mcp.auth.login',
        'mcp.auth.refresh',
        'mcp.auth.clear',
        'mcp.auth.revoke',
      ].includes(r.actionId)
    ) {
      i = sourceClosed(r.input, ['serverId', 'expectedReadSet']);
      if (!sourceServerId(i.serverId)) throw invalid();
    } else throw invalid();
    const reads = parseMcpSourceReadSet(i.expectedReadSet);
    if (r.actionId === 'mcp.source.add' || r.actionId === 'mcp.source.remove') {
      if (
        (i.scope !== 'user' && i.scope !== 'workspace') ||
        (i.scope === 'workspace' && reads.workspace === null)
      )
        throw invalid();
    }
  } else throw invalid();
  return structuredClone(r) as unknown as McpCommandRequest;
}
/** Core canonical bytes exclude only the independently bound Store and Command IDs. */
export function canonicalMcpCommandRequest(value: McpCommandRequest): string {
  const {
    expectedStoreId: _store,
    commandId: _command,
    ...request
  } = validateMcpCommandRequest(value);
  return canonicalModelBody(request);
}

/** Historical Source/Auth producers admit only facts in the current original Store. */
function verifyOriginalScope(row: Record<string, unknown>): void {
  const command = row.command as Record<string, unknown> | null;
  const execution = row.execution as Record<string, unknown> | null;
  for (const part of [command, execution]) {
    if (part && (part.originStoreId !== row.storeId || part.sessionId !== row.sessionId))
      throw invalid();
  }
  if (
    command &&
    execution &&
    (command.executionId !== execution.id || execution.originCommandId !== command.id)
  )
    throw invalid();
  const proof = row.proof as Record<string, unknown> | null | undefined;
  if (
    proof &&
    (proof.storeId !== row.storeId ||
      proof.sessionId !== row.sessionId ||
      (command && proof.subjectId !== command.subjectId))
  )
    throw invalid();
  const mutation = row.mutation as Record<string, unknown> | null | undefined;
  if (
    mutation &&
    (mutation.originStoreId !== row.storeId ||
      (command && mutation.subjectId !== command.subjectId))
  )
    throw invalid();
  const binding = row.binding as Record<string, unknown> | null | undefined;
  if (
    binding &&
    (binding.originalStoreId !== row.storeId ||
      binding.sessionId !== row.sessionId ||
      (command && binding.originCommandId !== command.id) ||
      (execution &&
        (binding.executionId !== execution.id ||
          binding.inputDigest !== execution.inputDigest ||
          execution.definitionId !== `builtin.mcp.sources/${binding.actionId}`)))
  )
    throw invalid();
}

function verifyConnectionScope(row: Record<string, unknown>, reconnect: boolean): void {
  const execution = row.execution as Record<string, unknown>;
  if (execution.originStoreId !== row.storeId || execution.sessionId !== row.sessionId)
    throw invalid();
  const ref = (reconnect ? row.newOperationRef : row.operationRef) as Record<
    string,
    unknown
  > | null;
  const connection = (reconnect ? row.newConnection : row.connection) as Record<
    string,
    unknown
  > | null;
  const ready = row.ready as Record<string, unknown> | null;
  if (ref && (ref.originStoreId !== row.storeId || ref.sessionId !== row.sessionId))
    throw invalid();
  if (
    connection &&
    (!ref ||
      connection.id !== ref.executionId ||
      connection.originStoreId !== ref.originStoreId ||
      connection.sessionId !== ref.sessionId ||
      connection.originCommandId !== ref.commandId)
  )
    throw invalid();
  if (ready && ref && (ref.key as string).split('/')[1] !== ready.serverId) throw invalid();
  if (reconnect) {
    const target = row.target as McpReconnectionTarget | null;
    const stop = row.oldStop as { confirmed: boolean; execution: Record<string, unknown> | null };
    if (
      target &&
      (target.operationRef.originStoreId !== row.storeId ||
        target.operationRef.sessionId !== row.sessionId)
    )
      throw invalid();
    if (
      stop.execution &&
      (!target ||
        stop.execution.id !== target.connectionExecutionId ||
        stop.execution.originStoreId !== row.storeId ||
        stop.execution.sessionId !== row.sessionId ||
        stop.execution.originCommandId !== target.operationRef.commandId)
    )
      throw invalid();
  }
}
