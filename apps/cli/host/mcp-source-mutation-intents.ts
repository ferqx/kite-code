import type { TuiMcpSourceMutationIntent, TuiMcpSourceMutationOutcome } from '@kite-ai/ui/tui';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';
import {
  parseMcpSourceReadSet,
  sourceClosed,
  sourceId,
  sourceServerId,
  sourceSha,
} from './mcp-source-approval-intents';
export type McpSourceMutationRecord = {
  intent: TuiMcpSourceMutationIntent;
  subjectId: string;
  bodySha256: string;
  requestSha256: string;
  phase: 'submitting' | TuiMcpSourceMutationOutcome['phase'];
};
const invalid = () => Error('mcp_source_mutation_intent_invalid');
export function parseMcpSourceMutationIntent(value: unknown): TuiMcpSourceMutationIntent {
  const row = sourceClosed(value, ['sessionId', 'workspaceId', 'workspaceIdentity', 'request']);
  if (
    !sourceId(row.sessionId) ||
    !sourceId(row.workspaceId) ||
    typeof row.workspaceIdentity !== 'string' ||
    !row.workspaceIdentity.length ||
    row.workspaceIdentity.length > 4096
  )
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
    request.definitionVersion !== '1'
  )
    throw invalid();
  if (request.actionId === 'mcp.source.add') {
    const input = sourceClosed(request.input, ['scope', 'name', 'entry', 'expectedReadSet']);
    if (
      typeof input.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.name) ||
      ['constructor', 'prototype'].includes(input.name)
    )
      throw invalid();
    const entry = input.entry as Record<string, unknown>;
    if (entry?.type === 'http') {
      sourceClosed(entry, ['type', 'url']);
      if (
        typeof entry.url !== 'string' ||
        entry.url.length > 8192 ||
        entry.url.includes('${') ||
        entry.url.includes('?') ||
        entry.url.includes('#') ||
        Array.from(entry.url).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
      )
        throw invalid();
      let url: URL;
      try {
        url = new URL(entry.url);
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
    } else if (entry?.type === 'stdio') {
      sourceClosed(entry, ['type', 'command']);
      if (
        typeof entry.command !== 'string' ||
        !entry.command.length ||
        entry.command.length > 4096 ||
        Array.from(entry.command).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        !entry.command.startsWith('/') ||
        entry.command.includes('${')
      )
        throw invalid();
    } else throw invalid();
  } else if (request.actionId === 'mcp.source.remove') {
    const input = sourceClosed(request.input, [
      'scope',
      'serverId',
      'expectedRawEntryDigest',
      'expectedReadSet',
    ]);
    if (!sourceServerId(input.serverId) || !sourceSha(input.expectedRawEntryDigest))
      throw invalid();
  } else throw invalid();
  const input = request.input as Record<string, unknown>;
  if (input.scope !== 'user' && input.scope !== 'workspace') throw invalid();
  const read = parseMcpSourceReadSet(input.expectedReadSet);
  if (input.scope === 'workspace' && read.workspace === null) throw invalid();
  if (Buffer.byteLength(JSON.stringify(row)) > 16 * 1024 * 1024) throw invalid();
  return structuredClone(row) as unknown as TuiMcpSourceMutationIntent;
}
export function parseMcpSourceMutationRecord(value: unknown): McpSourceMutationRecord {
  const row = sourceClosed(value, ['intent', 'subjectId', 'bodySha256', 'requestSha256', 'phase']),
    intent = parseMcpSourceMutationIntent(row.intent);
  const { commandId: _c, expectedStoreId: _s, ...request } = intent.request;
  if (
    typeof row.subjectId !== 'string' ||
    !row.subjectId.length ||
    row.subjectId.length > 256 ||
    row.bodySha256 !== mcpSha(intent.request) ||
    row.requestSha256 !== mcpSha(request) ||
    typeof row.phase !== 'string' ||
    !['submitting', 'pending', 'saved', 'failed', 'cancelled', 'outcome_unknown'].includes(
      row.phase,
    )
  )
    throw invalid();
  return { ...structuredClone(row), intent } as McpSourceMutationRecord;
}
export function createMcpSourceMutationRecord(
  intent: TuiMcpSourceMutationIntent,
  subjectId: string,
): McpSourceMutationRecord {
  const { commandId: _c, expectedStoreId: _s, ...request } = intent.request;
  return parseMcpSourceMutationRecord({
    intent,
    subjectId,
    bodySha256: mcpSha(intent.request),
    requestSha256: mcpSha(request),
    phase: 'submitting',
  });
}
export function mcpSourceMutationRecordIdentity(record: McpSourceMutationRecord) {
  const { phase: _p, ...identity } = record;
  return mcpCanonical(identity);
}
