import type {
  TuiMcpSourceApprovalIntent,
  TuiMcpSourceApprovalOutcome,
  TuiMcpSourceReadSet,
} from '@kite-ai/ui/tui';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';

export type McpSourceApprovalRecord = {
  intent: TuiMcpSourceApprovalIntent;
  subjectId: string;
  bodySha256: string;
  requestSha256: string;
  phase: 'submitting' | TuiMcpSourceApprovalOutcome['phase'];
};
const invalid = () => Error('mcp_source_approval_intent_invalid');
export function sourceClosed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
export const sourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const sourceSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const sourceServerId = (value: unknown): value is string =>
  typeof value === 'string' && /^mcp-[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

export function parseMcpSourceIdentity(value: unknown) {
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
export function parseMcpSourceReadSet(value: unknown): TuiMcpSourceReadSet {
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
  return structuredClone(row) as unknown as TuiMcpSourceReadSet;
}
export function parseMcpSourceApprovalIntent(value: unknown): TuiMcpSourceApprovalIntent {
  const row = sourceClosed(value, ['sessionId', 'workspaceId', 'workspaceIdentity', 'request']);
  if (!sourceId(row.sessionId) || !sourceId(row.workspaceId) || !text(row.workspaceIdentity, 4096))
    throw invalid();
  const request = sourceClosed(row.request, [
    'expectedStoreId',
    'commandId',
    'kind',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
  ]);
  if (
    !sourceId(request.expectedStoreId) ||
    !sourceId(request.commandId) ||
    request.kind !== 'extension.invoke' ||
    request.extensionId !== 'builtin.mcp.sources' ||
    request.actionId !== 'mcp.source.approve' ||
    request.definitionVersion !== '1'
  )
    throw invalid();
  const input = sourceClosed(request.input, ['serverId', 'expectedReadSet']);
  if (!sourceServerId(input.serverId)) throw invalid();
  parseMcpSourceReadSet(input.expectedReadSet);
  if (Buffer.byteLength(JSON.stringify(row)) > 16 * 1024 * 1024) throw invalid();
  return structuredClone(row) as unknown as TuiMcpSourceApprovalIntent;
}
export function parseMcpSourceApprovalRecord(value: unknown): McpSourceApprovalRecord {
  const row = sourceClosed(value, ['intent', 'subjectId', 'bodySha256', 'requestSha256', 'phase']);
  const intent = parseMcpSourceApprovalIntent(row.intent);
  const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
  if (
    !text(row.subjectId, 256) ||
    row.bodySha256 !== mcpSha(intent.request) ||
    row.requestSha256 !== mcpSha(request) ||
    !['submitting', 'pending', 'saved', 'failed', 'cancelled', 'outcome_unknown'].includes(
      typeof row.phase === 'string' ? row.phase : '',
    )
  )
    throw invalid();
  return { ...structuredClone(row), intent } as McpSourceApprovalRecord;
}
export function createMcpSourceApprovalRecord(
  value: TuiMcpSourceApprovalIntent,
  subjectId: string,
): McpSourceApprovalRecord {
  const intent = parseMcpSourceApprovalIntent(value);
  const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
  return parseMcpSourceApprovalRecord({
    intent,
    subjectId,
    bodySha256: mcpSha(intent.request),
    requestSha256: mcpSha(request),
    phase: 'submitting',
  });
}
export function mcpSourceApprovalRecordIdentity(record: McpSourceApprovalRecord) {
  const { phase: _phase, ...identity } = record;
  return mcpCanonical(identity);
}
