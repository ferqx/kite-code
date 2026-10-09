import { createHash } from 'node:crypto';
import { constants, fstatSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../json';
import type { Json } from '../storage/types';
import { closePrivate as closeSync, openPrivate, privateDirectory } from './files';
import { MaintenanceError } from './types';

const invalid = () => new MaintenanceError('backup_caller_intents_invalid');
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw invalid();
  return row;
}
function text(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== 'string') throw invalid();
  let count = 0;
  for (const _ of value) if (++count > maximum) throw invalid();
  if (count < minimum) throw invalid();
}
function selection(request: Record<string, unknown>) {
  if (Object.hasOwn(request, 'modelId'))
    text(request.modelId, request.kind === 'run.start' ? 0 : 1, 256);
  if (Object.hasOwn(request, 'selectedSkills')) {
    if (!Array.isArray(request.selectedSkills) || request.selectedSkills.length > 256)
      throw invalid();
    for (const skill of request.selectedSkills) text(skill, 1, 128);
  }
  if (Object.hasOwn(request, 'extensionInputs')) {
    if (!Array.isArray(request.extensionInputs)) throw invalid();
    for (const raw of request.extensionInputs) {
      const input = object(raw, ['extensionId', 'definitionVersion', 'input']);
      if (
        typeof input.extensionId !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(input.extensionId)
      )
        throw invalid();
      text(input.definitionVersion, 1, 128);
      // JSON parsing provides finite structure; reject overflow numbers without a new depth/quota.
      const pending = [input.input];
      while (pending.length) {
        const value = pending.pop();
        if (typeof value === 'number' && !Number.isFinite(value)) throw invalid();
        if (value && typeof value === 'object')
          for (const part of Object.values(value)) pending.push(part);
      }
    }
  }
}
function requestTarget(
  value: unknown,
  sessionId: unknown,
  allowAuth: boolean,
  allowRunEffort: boolean,
  allowExtension: boolean,
) {
  const kind = object(
    value,
    ['kind'],
    [
      'expectedStoreId',
      'commandId',
      'content',
      'modelId',
      ...(allowRunEffort ? ['reasoningEffort'] : []),
      'selectedSkills',
      'extensionInputs',
      'targetRunId',
      'contextSelectionId',
      'afterRunId',
      'targetCommandId',
      'executionId',
      ...(allowAuth || allowExtension
        ? ['extensionId', 'actionId', 'definitionVersion', 'input']
        : []),
    ],
  ).kind;
  const common = ['kind', 'expectedStoreId', 'commandId'];
  const optional = [
    'modelId',
    'selectedSkills',
    'extensionInputs',
    ...(allowRunEffort ? ['reasoningEffort'] : []),
  ];
  let request: Record<string, unknown>, target: Record<string, unknown>;
  if (kind === 'run.start') {
    request = object(value, [...common, 'content'], optional);
    text(request.content, 0, 262144);
    selection(request);
    target = { kind: 'session', id: sessionId };
  } else if (kind === 'input.steer') {
    request = object(value, [...common, 'content', 'targetRunId', 'contextSelectionId']);
    text(request.content, 1, 1048576);
    if (!id(request.targetRunId) || !id(request.contextSelectionId)) throw invalid();
    target = {
      kind: 'run',
      id: request.targetRunId,
      contextSelectionId: request.contextSelectionId,
    };
  } else if (kind === 'input.follow_up') {
    request = object(value, [...common, 'content', 'afterRunId', 'contextSelectionId'], optional);
    text(request.content, 1, 1048576);
    selection(request);
    if ((request.afterRunId !== null && !id(request.afterRunId)) || !id(request.contextSelectionId))
      throw invalid();
    target = {
      kind: 'after_run',
      id: request.afterRunId,
      contextSelectionId: request.contextSelectionId,
    };
  } else if (kind === 'command.cancel' || kind === 'execution.cancel') {
    const key = kind === 'command.cancel' ? 'targetCommandId' : 'executionId';
    request = object(value, [...common, key]);
    if (!id(request[key])) throw invalid();
    target = { kind: kind === 'command.cancel' ? 'command' : 'execution', id: request[key] };
  } else if (kind === 'extension.invoke' && allowExtension) {
    request = object(value, [...common, 'extensionId', 'actionId', 'definitionVersion', 'input']);
    for (const key of ['extensionId', 'actionId']) {
      text(request[key], 1, 128);
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(String(request[key]))) throw invalid();
    }
    text(request.definitionVersion, 0, 256);
    const pending: unknown[] = [request.input];
    while (pending.length) {
      const part = pending.pop();
      if (part === null || typeof part === 'string' || typeof part === 'boolean') continue;
      if (typeof part === 'number' && Number.isFinite(part)) continue;
      if (Array.isArray(part)) {
        for (const child of part) pending.push(child);
        continue;
      }
      if (part && typeof part === 'object') {
        for (const child of Object.values(part)) pending.push(child);
        continue;
      }
      throw invalid();
    }
    target = { kind: 'session', id: sessionId };
  } else if (kind === 'extension.invoke' && allowAuth) {
    request = object(value, [...common, 'extensionId', 'actionId', 'definitionVersion', 'input']);
    if (
      request.extensionId !== 'builtin.mcp.sources' ||
      request.definitionVersion !== '1' ||
      !['mcp.auth.login', 'mcp.auth.refresh', 'mcp.auth.clear', 'mcp.auth.revoke'].includes(
        String(request.actionId),
      )
    )
      throw invalid();
    const input = object(request.input, ['serverId', 'expectedReadSet']);
    if (!id(input.serverId)) throw invalid();
    const readSet = object(input.expectedReadSet, [
      'scopeDigest',
      'user',
      'workspace',
      'approvalEtag',
      'bindingEtag',
      'variablesDigest',
    ]);
    const nullableHash = (value: unknown) => value === null || hash(value);
    if (
      !hash(readSet.scopeDigest) ||
      !hash(readSet.variablesDigest) ||
      !nullableHash(readSet.approvalEtag) ||
      !nullableHash(readSet.bindingEtag)
    )
      throw invalid();
    const verifyRead = (value: unknown, kind: string) => {
      const read = object(value, ['identity', 'etag', 'error']);
      const identity = object(read.identity, ['kind', 'pathDigest', 'rootIdentity']);
      if (
        identity.kind !== kind ||
        !hash(identity.pathDigest) ||
        !hash(identity.rootIdentity) ||
        !nullableHash(read.etag) ||
        (read.error !== null && typeof read.error !== 'string')
      )
        throw invalid();
    };
    verifyRead(readSet.user, 'user');
    if (readSet.workspace !== null) verifyRead(readSet.workspace, 'workspace');
    target = { kind: 'session', id: sessionId };
  } else throw invalid();
  if (
    !id(request.expectedStoreId) ||
    !id(request.commandId) ||
    (Object.hasOwn(request, 'reasoningEffort') &&
      (typeof request.reasoningEffort !== 'string' ||
        !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
          request.reasoningEffort,
        )))
  )
    throw invalid();
  return { request, target };
}
/** Closed metadata rows, shared by the two explicitly captured private caller assets. */
export function verifyCallerIntentRecords(
  records: unknown,
  allowAuth = false,
  allowRunEffort = false,
  allowExtension = false,
): boolean {
  let hasAuth = false;
  if (!Array.isArray(records) || records.length > 128) throw invalid();
  const commands = new Set<string>();
  for (const raw of records) {
    const record = object(raw, ['intent', 'phase']);
    if (
      typeof record.phase !== 'string' ||
      !['submitting', 'unknown', 'accepted', 'applied', 'rejected'].includes(record.phase)
    )
      throw invalid();
    const intent = object(
      record.intent,
      ['scope', 'request', 'target', 'subjectId', 'bodyDigest', 'requestDigest'],
      ['draft'],
    );
    const scope = object(intent.scope, ['storeId', 'workspaceId', 'sessionId']);
    if (
      !Object.values(scope).every(id) ||
      typeof intent.subjectId !== 'string' ||
      !intent.subjectId ||
      intent.subjectId.length > 256 ||
      !hash(intent.bodyDigest) ||
      !hash(intent.requestDigest)
    )
      throw invalid();
    const { request, target } = requestTarget(
      intent.request,
      scope.sessionId,
      allowAuth,
      allowRunEffort,
      allowExtension,
    );
    if (request.expectedStoreId !== scope.storeId || commands.has(String(request.commandId)))
      throw invalid();
    commands.add(String(request.commandId));
    if (request.kind === 'extension.invoke') {
      hasAuth = true;
      const sha = (value: unknown) =>
        createHash('sha256')
          .update(canonicalJson(value as Json))
          .digest('hex');
      const { expectedStoreId: _store, commandId: _command, ...publicRequest } = request;
      if (
        intent.bodyDigest !== sha(request) ||
        intent.requestDigest !== sha(publicRequest) ||
        Object.hasOwn(intent, 'draft')
      )
        throw invalid();
    }
    const actualTarget = object(intent.target, Object.keys(target));
    if (Object.keys(target).some((key) => actualTarget[key] !== target[key])) throw invalid();
    if (Object.hasOwn(intent, 'draft')) {
      const draft = object(intent.draft, ['id', 'revision', 'textDigest']);
      if (
        !hash(draft.id) ||
        !hash(draft.textDigest) ||
        typeof draft.revision !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(draft.revision) ||
        BigInt(draft.revision) > 9223372036854775807n
      )
        throw invalid();
    }
  }
  return hasAuth;
}
/** Caller metadata bytes only. Digests are retained, never interpreted as a receipt or grant. */
export function verifyCallerIntentsDocument(path: string, allowAuth = false): boolean {
  if (
    process.platform !== 'win32' &&
    (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0)
  )
    throw new MaintenanceError('maintenance_platform_unsupported');
  privateDirectory(dirname(path));
  const fd = openPrivate(path);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      (process.platform !== 'win32' && (Number(before.mode) & 0o777) !== 0o600) ||
      before.nlink !== 1n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size > 16n * 1024n * 1024n
    )
      throw invalid();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw invalid();
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      after.size !== before.size ||
      after.ctimeNs !== before.ctimeNs ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.nlink !== 1n
    )
      throw new MaintenanceError('backup_content_changed');
    const document = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), [
      'version',
      'records',
    ]);
    if (document.version !== 1 || !Array.isArray(document.records) || document.records.length > 128)
      throw invalid();
    return verifyCallerIntentRecords(document.records, allowAuth);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw invalid();
  } finally {
    closeSync(fd);
  }
}
