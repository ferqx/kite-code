import { createHash } from 'node:crypto';
import {
  ClientError,
  canonicalMcpCommandRequest,
  canonicalModelBody,
  type McpCommandRequest,
  type UserMcpSettingsRequest,
  validateMcpCommandRequest,
  validateRequest,
} from '@kite-ai/client';
import type { NativeMcpPhase } from '../src/mcp-bridge';
import { parseNativeUserMcpOperation } from './mcp-input';

/** Full nonsecret original bytes; a saved row never carries a POST permit. */
export type NativeMcpRecord = {
  version: 1;
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  subjectId: string;
  request: McpCommandRequest;
  targetRequest: McpCommandRequest | null;
  bodySha256: string;
  requestSha256: string;
  phase: NativeMcpPhase;
};
export interface NativeMcpData {
  mcps(): NativeMcpRecord[];
  beginMcp(record: NativeMcpRecord): { created: boolean; value: NativeMcpRecord };
  finishMcp(commandId: string, phase: NativeMcpPhase): NativeMcpRecord;
  clearMcp(commandId: string): void;
}
export const mcpSha = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (): never => {
  throw new ClientError('mcp_storage_unavailable');
};
export function parseNativeMcpRecord(value: unknown): NativeMcpRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const row = value as NativeMcpRecord;
  if (
    Object.keys(row).sort().join(',') !==
      'bodySha256,phase,request,requestSha256,sessionId,subjectId,targetRequest,version,workspaceId,workspaceIdentity' ||
    row.version !== 1 ||
    ![row.sessionId, row.workspaceId, row.subjectId].every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    ) ||
    ![row.workspaceIdentity, row.bodySha256, row.requestSha256].every(
      (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
    ) ||
    typeof row.phase !== 'string' ||
    !['submitting', 'pending', 'completed', 'failed', 'cancelled', 'outcome_unknown'].includes(
      row.phase,
    )
  )
    fail();
  const request = validateMcpCommandRequest(row.request);
  if (
    row.bodySha256 !== mcpSha(canonicalModelBody(request)) ||
    row.requestSha256 !== mcpSha(canonicalMcpCommandRequest(request))
  )
    fail();
  if (request.actionId === 'mcp.reconnect') {
    const prior = validateMcpCommandRequest(row.targetRequest);
    if (
      (prior.actionId !== 'mcp.connect' && prior.actionId !== 'mcp.reconnect') ||
      prior.expectedStoreId !== request.expectedStoreId ||
      prior.commandId === request.commandId ||
      prior.input.serverId !== request.input.serverId ||
      prior.input.key !== request.input.target.carrierKey ||
      (prior.actionId === 'mcp.reconnect' &&
        prior.input.target.operationRef.sessionId !== row.sessionId) ||
      request.input.target.operationRef.sessionId !== row.sessionId
    )
      fail();
  } else if (row.targetRequest !== null) fail();
  return structuredClone(row);
}
export function nativeMcpIdentity(row: NativeMcpRecord): string {
  const { phase: _phase, ...identity } = parseNativeMcpRecord(row);
  return canonicalModelBody(identity);
}
export function finishNativeMcpRecord(
  old: NativeMcpRecord,
  phase: NativeMcpPhase,
): NativeMcpRecord {
  const value = parseNativeMcpRecord({ ...old, phase });
  if (
    (['completed', 'failed', 'cancelled'].includes(old.phase) && phase !== old.phase) ||
    (phase === 'submitting' && old.phase !== 'submitting')
  )
    throw new ClientError('mcp_intent_conflict');
  return value;
}

/** Global user intent, stored in the existing DB7 table without a Session placeholder. */
export type NativeUserMcpRecord = {
  version: 2;
  scope: 'user';
  subjectId: string;
  request: UserMcpSettingsRequest;
  bodySha256: string;
  requestSha256: string;
  phase: NativeMcpPhase;
};
export type NativeStoredMcpRecord = NativeMcpRecord | NativeUserMcpRecord;
export interface NativeUserMcpData extends NativeMcpData {
  userMcps(): NativeUserMcpRecord[];
  beginUserMcp(record: NativeUserMcpRecord): { created: boolean; value: NativeUserMcpRecord };
  finishUserMcp(commandId: string, phase: NativeMcpPhase): NativeUserMcpRecord;
}
export function canonicalUserMcpRequest(request: UserMcpSettingsRequest): string {
  const { storeId: _store, commandId: _command, ...body } = request;
  return canonicalModelBody(body);
}
export function parseNativeUserMcpRecord(value: unknown): NativeUserMcpRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const row = value as NativeUserMcpRecord;
  if (
    Object.keys(row).sort().join(',') !==
      'bodySha256,phase,request,requestSha256,scope,subjectId,version' ||
    row.version !== 2 ||
    row.scope !== 'user' ||
    typeof row.subjectId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.subjectId) ||
    ![row.bodySha256, row.requestSha256].every(
      (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
    ) ||
    !['submitting', 'pending', 'completed', 'failed', 'cancelled', 'outcome_unknown'].includes(
      row.phase,
    )
  )
    fail();
  try {
    validateRequest('UserMcpSettingsRequest', row.request);
    parseNativeUserMcpOperation(row.request.operation);
  } catch {
    fail();
  }
  if (
    row.bodySha256 !== mcpSha(canonicalModelBody(row.request)) ||
    row.requestSha256 !== mcpSha(canonicalUserMcpRequest(row.request))
  )
    fail();
  return structuredClone(row);
}
export function parseNativeStoredMcpRecord(value: unknown): NativeStoredMcpRecord {
  return value && typeof value === 'object' && (value as { version?: unknown }).version === 2
    ? parseNativeUserMcpRecord(value)
    : parseNativeMcpRecord(value);
}
export function nativeStoredMcpIdentity(row: NativeStoredMcpRecord): string {
  const { phase: _phase, ...identity } = parseNativeStoredMcpRecord(row);
  return canonicalModelBody(identity);
}
export function finishNativeStoredMcpRecord<T extends NativeStoredMcpRecord>(
  old: T,
  phase: NativeMcpPhase,
): T {
  if (
    (['completed', 'failed', 'cancelled'].includes(old.phase) && phase !== old.phase) ||
    (phase === 'submitting' && old.phase !== 'submitting')
  )
    throw new ClientError('mcp_intent_conflict');
  return parseNativeStoredMcpRecord({ ...old, phase }) as T;
}
