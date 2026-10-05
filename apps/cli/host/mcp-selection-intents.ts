import { createHash } from 'node:crypto';
import type { TuiMcpIntent, TuiMcpOutcome } from '@kite-ai/ui/tui';

export const mcpCanonical = (value: unknown): string => {
  const sort = (part: unknown): unknown => {
    if (Array.isArray(part)) return part.map(sort);
    if (part !== null && typeof part === 'object')
      return Object.fromEntries(
        Object.entries(part)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    return part;
  };
  return JSON.stringify(sort(value));
};
export const mcpSha = (value: unknown) =>
  createHash('sha256').update(mcpCanonical(value)).digest('hex');
export type McpSelectionRecord = {
  intent: TuiMcpIntent;
  subjectId: string;
  bodySha256: string;
  requestSha256: string;
  phase: 'submitting' | TuiMcpOutcome['phase'];
};
const invalid = () => Error('mcp_selection_intent_invalid');
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw invalid();
}
const text = (value: unknown, max = 4096) =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function parseMcpIntent(raw: unknown): TuiMcpIntent {
  closed(raw, ['sessionId', 'workspaceId', 'workspaceIdentity', 'request']);
  if (!id(raw.sessionId) || !id(raw.workspaceId) || !text(raw.workspaceIdentity)) throw invalid();
  closed(raw.request, [
    'expectedStoreId',
    'commandId',
    'kind',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
  ]);
  const req = raw.request;
  if (
    !id(req.expectedStoreId) ||
    !id(req.commandId) ||
    req.kind !== 'extension.invoke' ||
    req.extensionId !== 'builtin.mcp.management' ||
    req.actionId !== 'mcp.server.select' ||
    req.definitionVersion !== '1'
  )
    throw invalid();
  closed(req.input, ['serverId', 'enabled', 'scope', 'expectedReadSet']);
  const input = req.input;
  if (
    !id(input.serverId) ||
    typeof input.enabled !== 'boolean' ||
    (input.scope !== 'user' && input.scope !== 'workspace')
  )
    throw invalid();
  closed(input.expectedReadSet, [
    'userEtag',
    'workspaceEtag',
    'explicitDigest',
    'registryDigest',
    'registryRevision',
    'scopeDigest',
  ]);
  const read = input.expectedReadSet;
  if (
    !sha(read.userEtag) ||
    !(read.workspaceEtag === null || sha(read.workspaceEtag)) ||
    (input.scope === 'workspace' && read.workspaceEtag === null) ||
    !sha(read.explicitDigest) ||
    !sha(read.registryDigest) ||
    !sha(read.scopeDigest) ||
    !text(read.registryRevision)
  )
    throw invalid();
  return structuredClone(raw) as unknown as TuiMcpIntent;
}
export function createMcpSelectionRecord(raw: TuiMcpIntent, subjectId: string): McpSelectionRecord {
  const intent = parseMcpIntent(raw);
  const { commandId: _id, expectedStoreId: _store, ...request } = intent.request;
  return parseMcpSelectionRecord({
    intent,
    subjectId,
    bodySha256: mcpSha(intent.request),
    requestSha256: mcpSha(request),
    phase: 'submitting',
  });
}
export function parseMcpSelectionRecord(raw: unknown): McpSelectionRecord {
  closed(raw, ['intent', 'subjectId', 'bodySha256', 'requestSha256', 'phase']);
  const intent = parseMcpIntent(raw.intent);
  const { commandId: _id, expectedStoreId: _store, ...request } = intent.request;
  if (
    !text(raw.subjectId, 256) ||
    raw.bodySha256 !== mcpSha(intent.request) ||
    raw.requestSha256 !== mcpSha(request) ||
    !['submitting', 'pending', 'applied', 'failed', 'outcome_unknown'].includes(
      typeof raw.phase === 'string' ? raw.phase : '',
    )
  )
    throw invalid();
  return { ...structuredClone(raw), intent } as McpSelectionRecord;
}
export function mcpRecordIdentity(record: McpSelectionRecord) {
  const { phase: _phase, ...identity } = record;
  return mcpCanonical(identity);
}
