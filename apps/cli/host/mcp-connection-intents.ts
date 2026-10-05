import type { TuiMcpConnectionIntent, TuiMcpConnectionOutcome } from '@kite-ai/ui/tui';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';

export type McpConnectionRecord = {
  intent: TuiMcpConnectionIntent;
  subjectId: string;
  bodySha256: string;
  requestSha256: string;
  phase: 'submitting' | TuiMcpConnectionOutcome['phase'];
};
const invalid = () => Error('mcp_connection_intent_invalid');
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw invalid();
}
const text = (value: unknown, maximum = 4096) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function parseMcpConnectionIntent(value: unknown): TuiMcpConnectionIntent {
  closed(value, ['sessionId', 'workspaceId', 'workspaceIdentity', 'request']);
  if (!id(value.sessionId) || !id(value.workspaceId) || !text(value.workspaceIdentity))
    throw invalid();
  closed(value.request, [
    'expectedStoreId',
    'commandId',
    'kind',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
  ]);
  const request = value.request;
  if (
    !id(request.expectedStoreId) ||
    !id(request.commandId) ||
    request.kind !== 'extension.invoke' ||
    request.extensionId !== 'builtin.mcp' ||
    request.actionId !== 'mcp.connect' ||
    request.definitionVersion !== '1'
  )
    throw invalid();
  closed(request.input, ['serverId', 'key']);
  if (
    !id(request.input.serverId) ||
    typeof request.input.key !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(request.input.key)
  )
    throw invalid();
  return structuredClone(value) as unknown as TuiMcpConnectionIntent;
}
export function parseMcpConnectionRecord(value: unknown): McpConnectionRecord {
  closed(value, ['intent', 'subjectId', 'bodySha256', 'requestSha256', 'phase']);
  const intent = parseMcpConnectionIntent(value.intent);
  const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
  if (
    !text(value.subjectId, 256) ||
    value.bodySha256 !== mcpSha(intent.request) ||
    value.requestSha256 !== mcpSha(request) ||
    !['submitting', 'pending', 'ready', 'failed', 'outcome_unknown'].includes(
      typeof value.phase === 'string' ? value.phase : '',
    )
  )
    throw invalid();
  return { ...structuredClone(value), intent } as McpConnectionRecord;
}
export function createMcpConnectionRecord(
  value: TuiMcpConnectionIntent,
  subjectId: string,
): McpConnectionRecord {
  const intent = parseMcpConnectionIntent(value);
  const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
  return parseMcpConnectionRecord({
    intent,
    subjectId,
    bodySha256: mcpSha(intent.request),
    requestSha256: mcpSha(request),
    phase: 'submitting',
  });
}
export function mcpConnectionRecordIdentity(record: McpConnectionRecord) {
  const { phase: _phase, ...identity } = record;
  return mcpCanonical(identity);
}
