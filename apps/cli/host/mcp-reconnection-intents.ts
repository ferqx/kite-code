import type {
  TuiMcpReconnectionCarrier,
  TuiMcpReconnectionInput,
  TuiMcpReconnectionIntent,
  TuiMcpReconnectionOutcome,
  TuiMcpReconnectionTarget,
  TuiMcpReconnectionTargetRequest,
} from '@kite-ai/ui/tui';
import { parseMcpConnectionIntent } from './mcp-connection-intents';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';
import { parseMcpSourceReadSet } from './mcp-source-approval-intents';

export type McpReconnectionRecord = {
  intent: TuiMcpReconnectionIntent;
  subjectId: string;
  bodySha256: string;
  requestSha256: string;
  phase: 'submitting' | TuiMcpReconnectionOutcome['phase'];
};
const invalid = () => Error('mcp_reconnection_intent_invalid');
export function reconnectionClosed(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const key = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

export function parseMcpReconnectionTarget(value: unknown): TuiMcpReconnectionTarget {
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
    !id(row.carrierExecutionId) ||
    !key(row.carrierKey) ||
    !id(row.connectionExecutionId) ||
    !digest(row.configDigest) ||
    !Number.isSafeInteger(row.currentGeneration) ||
    Number(row.currentGeneration) < 1 ||
    !id(ref.commandId) ||
    !id(ref.sessionId) ||
    !id(ref.originStoreId) ||
    ref.extensionId !== 'builtin.mcp' ||
    typeof ref.key !== 'string' ||
    !/^connection\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,64}$/.test(ref.key) ||
    !id(ref.executionId) ||
    ref.executionId !== row.connectionExecutionId
  )
    throw invalid();
  return structuredClone(row) as unknown as TuiMcpReconnectionTarget;
}
export function parseMcpReconnectionInput(value: unknown): TuiMcpReconnectionInput {
  const row = reconnectionClosed(value, ['serverId', 'key', 'target', 'replacement']);
  const target = parseMcpReconnectionTarget(row.target);
  if (
    !id(row.serverId) ||
    !key(row.key) ||
    !target.operationRef.key.startsWith(`connection/${row.serverId}/`) ||
    row.key === target.carrierKey ||
    row.key === target.operationRef.key.split('/')[2]
  )
    throw invalid();
  const raw = row.replacement;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const replacement = reconnectionClosed(
    raw,
    (raw as Record<string, unknown>).kind === 'source'
      ? ['kind', 'expectedConfigDigest', 'expectedReadSet']
      : ['kind', 'expectedConfigDigest'],
  );
  if (
    !digest(replacement.expectedConfigDigest) ||
    typeof replacement.kind !== 'string' ||
    !['source', 'static'].includes(replacement.kind)
  )
    throw invalid();
  if (replacement.kind === 'source') {
    try {
      parseMcpSourceReadSet(replacement.expectedReadSet);
    } catch {
      throw invalid();
    }
  }
  return structuredClone(row) as unknown as TuiMcpReconnectionInput;
}
export function parseMcpReconnectionTargetRequest(value: unknown): TuiMcpReconnectionTargetRequest {
  const row = reconnectionClosed(value, [
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
  if (row.actionId === 'mcp.connect') {
    const input = reconnectionClosed(row.input, ['serverId', 'key']);
    if (!id(input.serverId) || !key(input.key)) throw invalid();
  } else if (row.actionId === 'mcp.reconnect') {
    const input = parseMcpReconnectionInput(row.input);
    if (
      input.target.operationRef.originStoreId !== row.expectedStoreId ||
      row.commandId === input.target.operationRef.commandId
    )
      throw invalid();
  } else throw invalid();
  return structuredClone(row) as unknown as TuiMcpReconnectionTargetRequest;
}
export function parseMcpReconnectionCarrier(value: unknown): TuiMcpReconnectionCarrier {
  const row = reconnectionClosed(value, [
    'sessionId',
    'workspaceId',
    'workspaceIdentity',
    'request',
  ]);
  if (!id(row.sessionId) || !id(row.workspaceId) || !text(row.workspaceIdentity, 4096))
    throw invalid();
  const request = parseMcpReconnectionTargetRequest(row.request);
  if (
    request.actionId === 'mcp.reconnect' &&
    request.input.target.operationRef.sessionId !== row.sessionId
  )
    throw invalid();
  return { ...structuredClone(row), request } as unknown as TuiMcpReconnectionCarrier;
}
export function parseMcpReconnectionIntent(value: unknown): TuiMcpReconnectionIntent {
  const row = reconnectionClosed(value, [
    'sessionId',
    'workspaceId',
    'workspaceIdentity',
    'targetRequest',
    'request',
  ]);
  const carrier = parseMcpReconnectionCarrier({
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    workspaceIdentity: row.workspaceIdentity,
    request: row.targetRequest,
  });
  const request = parseMcpReconnectionTargetRequest(row.request);
  if (
    request.actionId !== 'mcp.reconnect' ||
    request.expectedStoreId !== carrier.request.expectedStoreId ||
    request.commandId === carrier.request.commandId ||
    request.input.serverId !== carrier.request.input.serverId ||
    request.input.target.carrierKey !== carrier.request.input.key ||
    request.input.target.operationRef.originStoreId !== request.expectedStoreId ||
    request.input.target.operationRef.sessionId !== row.sessionId
  )
    throw invalid();
  if (Buffer.byteLength(JSON.stringify(row)) > 16 * 1024 * 1024) throw invalid();
  // Connect's original closed two-field contract is also verified independently.
  if (carrier.request.actionId === 'mcp.connect') parseMcpConnectionIntent(carrier);
  return {
    ...structuredClone(row),
    targetRequest: carrier.request,
    request,
  } as unknown as TuiMcpReconnectionIntent;
}
export function parseMcpReconnectionRecord(value: unknown): McpReconnectionRecord {
  const row = reconnectionClosed(value, [
    'intent',
    'subjectId',
    'bodySha256',
    'requestSha256',
    'phase',
  ]);
  const intent = parseMcpReconnectionIntent(row.intent);
  const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
  if (
    !text(row.subjectId, 256) ||
    row.bodySha256 !== mcpSha(intent.request) ||
    row.requestSha256 !== mcpSha(request) ||
    typeof row.phase !== 'string' ||
    !['submitting', 'pending', 'ready', 'failed', 'cancelled', 'outcome_unknown'].includes(
      row.phase,
    )
  )
    throw invalid();
  return { ...structuredClone(row), intent } as McpReconnectionRecord;
}
export function createMcpReconnectionRecord(
  intent: TuiMcpReconnectionIntent,
  subjectId: string,
): McpReconnectionRecord {
  const parsed = parseMcpReconnectionIntent(intent);
  const { commandId: _commandId, expectedStoreId: _storeId, ...request } = parsed.request;
  return parseMcpReconnectionRecord({
    intent: parsed,
    subjectId,
    bodySha256: mcpSha(parsed.request),
    requestSha256: mcpSha(request),
    phase: 'submitting',
  });
}
export function mcpReconnectionRecordIdentity(record: McpReconnectionRecord) {
  const { phase: _phase, ...identity } = record;
  return mcpCanonical(identity);
}
