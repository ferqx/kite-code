import type { TuiMcpConnectionOutcome } from './mcp-connection';
import type {
  TuiMcpReconnectionCarrier,
  TuiMcpReconnectionIntent,
  TuiMcpReconnectionOutcome,
} from './mcp-reconnection';

const invalid = () => Error('mcp_reconnection_intent_invalid');
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nullableHash = (value: unknown) => value === null || hash(value);
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

function readSet(value: unknown): void {
  const row = closed(value, [
    'scopeDigest',
    'user',
    'workspace',
    'approvalEtag',
    'bindingEtag',
    'variablesDigest',
  ]);
  if (
    !hash(row.scopeDigest) ||
    !hash(row.variablesDigest) ||
    !nullableHash(row.approvalEtag) ||
    !nullableHash(row.bindingEtag)
  )
    throw invalid();
  const read = (value: unknown, kind: 'user' | 'workspace') => {
    const row = closed(value, ['identity', 'etag', 'error']);
    const identity = closed(row.identity, ['kind', 'pathDigest', 'rootIdentity']);
    if (
      identity.kind !== kind ||
      !hash(identity.pathDigest) ||
      !hash(identity.rootIdentity) ||
      !nullableHash(row.etag) ||
      (row.error !== null && typeof row.error !== 'string')
    )
      throw invalid();
  };
  read(row.user, 'user');
  if (row.workspace !== null) read(row.workspace, 'workspace');
}
const key = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
function reconnectionInput(value: unknown, storeId: unknown): Record<string, unknown> {
  const input = closed(value, ['serverId', 'key', 'target', 'replacement']);
  if (!id(input.serverId) || !key(input.key)) throw invalid();
  const target = closed(input.target, [
    'carrierExecutionId',
    'carrierKey',
    'operationRef',
    'connectionExecutionId',
    'configDigest',
    'currentGeneration',
  ]);
  const operation = closed(target.operationRef, [
    'commandId',
    'sessionId',
    'originStoreId',
    'extensionId',
    'key',
    'executionId',
  ]);
  if (
    !id(target.carrierExecutionId) ||
    !key(target.carrierKey) ||
    !id(target.connectionExecutionId) ||
    !hash(target.configDigest) ||
    !Number.isSafeInteger(target.currentGeneration) ||
    (target.currentGeneration as number) < 1 ||
    !id(operation.commandId) ||
    !id(operation.sessionId) ||
    operation.originStoreId !== storeId ||
    operation.extensionId !== 'builtin.mcp' ||
    typeof operation.key !== 'string' ||
    !operation.key.startsWith(`connection/${input.serverId}/`) ||
    !key(operation.key.slice(`connection/${input.serverId}/`.length)) ||
    !id(operation.executionId) ||
    operation.executionId !== target.connectionExecutionId ||
    input.key === target.carrierKey ||
    input.key === (operation.key as string).slice(`connection/${input.serverId}/`.length)
  )
    throw invalid();
  if (!input.replacement || typeof input.replacement !== 'object') throw invalid();
  const kind = (input.replacement as Record<string, unknown>).kind;
  const replacement = closed(
    input.replacement,
    kind === 'static'
      ? ['kind', 'expectedConfigDigest']
      : ['kind', 'expectedConfigDigest', 'expectedReadSet'],
  );
  if (!hash(replacement.expectedConfigDigest)) throw invalid();
  if (kind === 'source') readSet(replacement.expectedReadSet);
  else if (kind !== 'static') throw invalid();
  return input;
}
function request(value: unknown, target = false): Record<string, unknown> {
  const row = closed(value, [
    'expectedStoreId',
    'commandId',
    'kind',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
  ]);
  if (
    !id(row.expectedStoreId) ||
    !id(row.commandId) ||
    row.kind !== 'extension.invoke' ||
    row.extensionId !== 'builtin.mcp' ||
    row.definitionVersion !== '1'
  )
    throw invalid();
  if (target && row.actionId === 'mcp.connect') {
    const input = closed(row.input, ['serverId', 'key']);
    if (!id(input.serverId) || !key(input.key)) throw invalid();
  } else {
    if (row.actionId !== 'mcp.reconnect') throw invalid();
    const input = reconnectionInput(row.input, row.expectedStoreId);
    const operation = (input.target as Record<string, unknown>).operationRef as Record<
      string,
      unknown
    >;
    if (row.commandId === operation.commandId) throw invalid();
  }
  return row;
}
export function parseReconnectionIntent(value: unknown): TuiMcpReconnectionIntent {
  const intent = closed(value, [
    'sessionId',
    'workspaceId',
    'workspaceIdentity',
    'targetRequest',
    'request',
  ]);
  if (!id(intent.sessionId) || !id(intent.workspaceId) || !text(intent.workspaceIdentity, 4096))
    throw invalid();
  const current = request(intent.request),
    previous = request(intent.targetRequest, true);
  const input = current.input as Record<string, unknown>,
    priorInput = previous.input as Record<string, unknown>;
  const target = input.target as Record<string, unknown>,
    operation = target.operationRef as Record<string, unknown>;
  const priorOperation =
    previous.actionId === 'mcp.reconnect'
      ? ((priorInput.target as Record<string, unknown>).operationRef as Record<string, unknown>)
      : null;
  if (
    operation.sessionId !== intent.sessionId ||
    (priorOperation && priorOperation.sessionId !== intent.sessionId) ||
    current.expectedStoreId !== previous.expectedStoreId ||
    input.serverId !== priorInput.serverId ||
    target.carrierKey !== priorInput.key ||
    current.commandId === previous.commandId
  )
    throw invalid();
  if (new TextEncoder().encode(JSON.stringify(intent)).byteLength > 16 * 1024 * 1024)
    throw invalid();
  return structuredClone(intent) as unknown as TuiMcpReconnectionIntent;
}
export function sameReconnectionValue(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  };
  return canonical(a) === canonical(b);
}
/** A Host fact is required afresh; journal phases alone never enable a forced reconnect. */
function observedCarrier(
  outcome: TuiMcpConnectionOutcome | TuiMcpReconnectionOutcome | undefined,
  storeId: string,
  sessionId: string,
  workspaceId: string,
): TuiMcpReconnectionCarrier | undefined {
  if (!outcome) return;
  const { intent, fact } = outcome;
  request(intent.request, true);
  if (intent.request.actionId === 'mcp.reconnect') parseReconnectionIntent(intent);
  if (
    intent.request.expectedStoreId !== storeId ||
    intent.sessionId !== sessionId ||
    intent.workspaceId !== workspaceId ||
    outcome.phase !== 'ready' ||
    !fact ||
    fact.phase !== 'ready' ||
    !fact.live ||
    !fact.ready ||
    typeof fact.currentGeneration !== 'number' ||
    !Number.isSafeInteger(fact.currentGeneration) ||
    fact.currentGeneration < 1 ||
    fact.ready.serverId !== intent.request.input.serverId ||
    !hash(fact.ready.configDigest) ||
    fact.storeId !== storeId ||
    fact.sessionId !== sessionId ||
    fact.execution.originStoreId !== storeId ||
    fact.execution.sessionId !== sessionId ||
    fact.execution.originCommandId !== intent.request.commandId ||
    fact.execution.kind !== 'job' ||
    fact.execution.definitionId !== `builtin.mcp/${intent.request.actionId}` ||
    fact.execution.definitionVersion !== '1' ||
    fact.execution.status !== 'succeeded' ||
    !hash(fact.execution.inputDigest)
  )
    return;
  const ref = 'newOperationRef' in fact ? fact.newOperationRef : fact.operationRef;
  const connection = 'newConnection' in fact ? fact.newConnection : fact.connection;
  if (
    !ref ||
    !connection ||
    ref.extensionId !== 'builtin.mcp' ||
    ref.originStoreId !== storeId ||
    ref.sessionId !== sessionId ||
    ref.executionId !== connection.id ||
    connection.originStoreId !== storeId ||
    connection.sessionId !== sessionId ||
    connection.originCommandId !== ref.commandId ||
    !id(ref.commandId) ||
    !id(connection.id) ||
    connection.kind !== 'job' ||
    (connection.status !== 'running' && connection.status !== 'succeeded') ||
    typeof ref.key !== 'string' ||
    !ref.key.startsWith(`connection/${intent.request.input.serverId}/`) ||
    !key(ref.key.slice(`connection/${intent.request.input.serverId}/`.length))
  )
    return;
  if (
    'newOperationRef' in fact &&
    (connection.parentExecutionId !== fact.execution.id ||
      ref.key !== `connection/${intent.request.input.serverId}/${intent.request.input.key}`)
  )
    return;
  return structuredClone({
    sessionId: intent.sessionId,
    workspaceId: intent.workspaceId,
    workspaceIdentity: intent.workspaceIdentity,
    request: intent.request,
  });
}

export function reconnectionCarrier(
  outcome: TuiMcpConnectionOutcome | TuiMcpReconnectionOutcome | undefined,
  storeId: string,
  sessionId: string,
  workspaceId: string,
): TuiMcpReconnectionCarrier | undefined {
  try {
    return observedCarrier(outcome, storeId, sessionId, workspaceId);
  } catch {
    return undefined;
  }
}
