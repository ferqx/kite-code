import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { MaintenanceError } from './types';

// Frozen offline grammar, independently maintained from the Client command protocol.
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
function parseMcpSourceReadSet(value: unknown): Record<string, unknown> {
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
  return structuredClone(row) as Record<string, unknown>;
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

function parseMcpReconnectionTarget(value: unknown): Record<string, unknown> {
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
  return structuredClone(row) as Record<string, unknown>;
}
function parseMcpReconnectionInput(value: unknown): Record<string, unknown> {
  const row = reconnectionClosed(value, ['serverId', 'key', 'target', 'replacement']);
  const target = parseMcpReconnectionTarget(row.target);
  if (
    !reconnectionInputid(row.serverId) ||
    !reconnectionInputkey(row.key) ||
    !String((target.operationRef as Record<string, unknown>).key).startsWith(
      `connection/${row.serverId}/`,
    ) ||
    row.key === target.carrierKey ||
    row.key === String((target.operationRef as Record<string, unknown>).key).split('/')[2]
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
  return structuredClone(row) as Record<string, unknown>;
}

const managementText = (v: unknown, max = 4096) =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
function selectionReadSet(value: unknown): Record<string, unknown> {
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
  return structuredClone(r) as Record<string, unknown>;
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
export function validateMcpCommandRequest(value: unknown): Record<string, unknown> {
  const r = sourceClosed(value, [
    'expectedStoreId',
    'commandId',
    'kind',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
  ]);
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
        ((input.target as Record<string, unknown>).operationRef as Record<string, unknown>)
          .originStoreId !== r.expectedStoreId ||
        ((input.target as Record<string, unknown>).operationRef as Record<string, unknown>)
          .commandId === r.commandId
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
  return structuredClone(r) as Record<string, unknown>;
}

const sha = (value: Record<string, unknown>) =>
  createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');
export function verifyDesktopMcpRecord(value: unknown, commandId: string): void {
  const row = sourceClosed(value, [
    'version',
    'sessionId',
    'workspaceId',
    'workspaceIdentity',
    'subjectId',
    'request',
    'targetRequest',
    'bodySha256',
    'requestSha256',
    'phase',
  ]);
  const current = validateMcpCommandRequest(row.request);
  const { expectedStoreId: _store, commandId: originalCommand, ...body } = current;
  if (
    row.version !== 1 ||
    ![row.sessionId, row.workspaceId, row.subjectId].every(sourceId) ||
    !sourceSha(row.workspaceIdentity) ||
    originalCommand !== commandId ||
    !sourceId(commandId) ||
    row.bodySha256 !== sha(current) ||
    row.requestSha256 !== sha(body) ||
    typeof row.phase !== 'string' ||
    !['submitting', 'pending', 'completed', 'failed', 'cancelled', 'outcome_unknown'].includes(
      row.phase,
    )
  )
    throw invalid();
  if (current.actionId !== 'mcp.reconnect') {
    if (row.targetRequest !== null) throw invalid();
    return;
  }
  const previous = validateMcpCommandRequest(row.targetRequest);
  const input = current.input as Record<string, unknown>;
  const target = input.target as Record<string, unknown>;
  const operation = target.operationRef as Record<string, unknown>;
  const priorInput = previous.input as Record<string, unknown>;
  if (
    !['mcp.connect', 'mcp.reconnect'].includes(String(previous.actionId)) ||
    previous.expectedStoreId !== current.expectedStoreId ||
    previous.commandId === current.commandId ||
    priorInput.serverId !== input.serverId ||
    priorInput.key !== target.carrierKey ||
    operation.sessionId !== row.sessionId
  )
    throw invalid();
  if (
    previous.actionId === 'mcp.reconnect' &&
    ((priorInput.target as Record<string, unknown>).operationRef as Record<string, unknown>)
      .sessionId !== row.sessionId
  )
    throw invalid();
}
/** Exact original SQL bytes are preserved, including unknown outcomes; this grants no execution authority. */
export function verifyDesktopMcpRows(db: Database): void {
  let count = 0,
    bytes = 0;
  const commands = new Set<string>();
  try {
    for (const row of db
      .query<{ command_id: string; state: string; state_hex: string }, []>(
        'SELECT command_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM mcp_intents ORDER BY command_id',
      )
      .iterate()) {
      if (
        typeof row.state !== 'string' ||
        Buffer.from(row.state).toString('hex').toUpperCase() !== row.state_hex ||
        ++count > 128 ||
        commands.has(row.command_id)
      )
        throw invalid();
      bytes += Buffer.byteLength(row.state);
      if (bytes > 16777216) throw invalid();
      verifyDesktopMcpRecord(JSON.parse(row.state), row.command_id);
      commands.add(row.command_id);
    }
  } catch {
    throw new MaintenanceError('backup_ui_invalid');
  }
}
