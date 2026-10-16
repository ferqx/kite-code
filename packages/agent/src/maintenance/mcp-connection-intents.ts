import { createHash } from 'node:crypto';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { verifyIntentDocument } from './intent-document';
import { MaintenanceError } from './types';

const invalid = () => new MaintenanceError('backup_mcp_connection_intents_invalid');
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const sha = (value: Record<string, unknown>) =>
  createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');

/** Closed caller metadata. Matching hashes confer neither a receipt nor a POST permit. */
export function verifyMcpConnectionRecords(value: unknown): void {
  if (!Array.isArray(value) || value.length > 128) throw invalid();
  const ids = new Set<string>();
  for (const raw of value) {
    const row = closed(raw, ['intent', 'subjectId', 'bodySha256', 'requestSha256', 'phase']);
    const intent = closed(row.intent, ['sessionId', 'workspaceId', 'workspaceIdentity', 'request']);
    if (!id(intent.sessionId) || !id(intent.workspaceId) || !text(intent.workspaceIdentity, 4096))
      throw invalid();
    const request = closed(intent.request, [
      'expectedStoreId',
      'commandId',
      'kind',
      'extensionId',
      'actionId',
      'definitionVersion',
      'input',
    ]);
    if (
      !id(request.expectedStoreId) ||
      !id(request.commandId) ||
      request.kind !== 'extension.invoke' ||
      request.extensionId !== 'builtin.mcp' ||
      request.actionId !== 'mcp.connect' ||
      request.definitionVersion !== '1'
    )
      throw invalid();
    const input = closed(request.input, ['serverId', 'key']);
    if (
      !id(input.serverId) ||
      typeof input.key !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.key)
    )
      throw invalid();
    const { commandId, expectedStoreId: _store, ...publicRequest } = request;
    if (
      !text(row.subjectId, 256) ||
      row.bodySha256 !== sha(request) ||
      row.requestSha256 !== sha(publicRequest) ||
      !['submitting', 'pending', 'ready', 'failed', 'outcome_unknown'].includes(
        row.phase as string,
      ) ||
      ids.has(commandId as string)
    )
      throw invalid();
    ids.add(commandId as string);
  }
}

export function verifyMcpConnectionIntentsDocument(path: string): void {
  verifyIntentDocument(path, invalid, verifyMcpConnectionRecords);
}
