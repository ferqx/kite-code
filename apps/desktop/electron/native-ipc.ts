import { fileURLToPath } from 'node:url';
import {
  type CallerCommandRequest,
  canonicalCallerCommandRequest,
  validateRequest,
} from '@kite-ai/client';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { DesktopEditor } from '../src/file-changes-bridge';
import {
  type NativeReply,
  type NativeRequest,
  type NativeResult,
  type NativeStartupReply,
  type NativeThemePreference,
  nativeChannel,
  nativeClipboardChannel,
  nativeStartupDiagnosticSaveChannel,
  nativeStartupStatusChannel,
  nativeThemeChannel,
  nativeWindowMaximizeChannel,
} from '../src/native-bridge';
import { openEditor } from './editor';
import { parseNativeMcpOperation } from './mcp-input';
import type { NativeCaller } from './native-caller';
import { saveStartupDiagnosticReport } from './startup-report';

const requestBytes = 1048576,
  responseBytes = 4 * 1048576;
const fields: Record<NativeRequest['method'], readonly string[]> = {
  'extensions.open': ['readId', 'viewSelection', 'historyEpoch'],
  'extensions.query': ['readId', 'observationId', 'extensionId', 'queryId', 'input'],
  'extensions.read': ['readId', 'offset', 'limit'],
  'extensions.close': ['readId'],
  'extensions.release': [],
  'extensions.invoke': [
    'observationId',
    'commandId',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
    'viewIndex',
    'actionIndex',
  ],
  'extensions.lookup': ['commandId'],
  'toolMessages.usage': ['readId', 'messageIds', 'viewSelection', 'historyEpoch'],
  'toolMessages.list': ['readId', 'messageIds', 'viewSelection', 'historyEpoch'],
  'toolMessages.runs': ['readId', 'messageIds', 'viewSelection', 'historyEpoch'],
  'toolMessages.close': ['readId'],
  'interactionHistory.open': ['readId', 'viewSelection', 'historyEpoch'],
  'interactionHistory.next': ['readId'],
  'interactionHistory.close': ['readId'],
  'interactionHistory.attachment.open': ['readId', 'key'],
  'interactionHistory.attachment.read': ['readId', 'offset', 'limit'],
  'interactionHistory.attachment.close': ['readId'],
  'fileChanges.list': ['readId', 'messageIds', 'viewSelection', 'historyEpoch'],
  'fileTargets.list': ['readId', 'messageIds', 'viewSelection', 'historyEpoch'],
  'fileChanges.detail': ['readId', 'changeId'],
  'fileChanges.close': ['readId'],
  'fileChanges.open': ['changeId', 'editor'],
  'messageFile.open': ['viewSelection', 'historyEpoch', 'messageId', 'path', 'editor'],
  'background.open': ['readId'],
  'background.next': ['readId'],
  'background.close': ['readId'],
  'background.stop': ['observationId', 'executionId', 'commandId'],
  'background.output.open': ['observationId', 'executionId', 'readId'],
  'background.output.next': ['readId'],
  'background.output.close': ['readId'],
  'background.child.open': ['observationId', 'executionId', 'readId'],
  'background.child.read': ['readId', 'offset', 'limit'],
  'background.child.close': ['readId'],
  'settings.skills.open': ['readId', 'viewSelection', 'historyEpoch'],
  'settings.skills.next': ['readId'],
  'settings.skills.close': ['readId'],
  'jobOutput.open': ['readId', 'executionId', 'viewSelection', 'historyEpoch'],
  'jobOutput.next': ['readId'],
  'jobOutput.close': ['readId'],
  'settings.mcp.read': [],
  'settings.mcp.close': [],
  'settings.mcp.sources': ['observationId', 'afterId'],
  'settings.mcp.snapshots': ['observationId', 'afterKey'],
  'settings.mcp.auth': ['observationId', 'serverId'],
  'settings.mcp.removePreview': ['observationId', 'serverId', 'scope'],
  'settings.mcp.submit': ['observationId', 'operation'],
  'settings.mcp.lookup': ['commandId'],
  'settings.mcp.cancel': ['commandId'],
  'settings.mcp.clear': ['commandId'],
  'settings.mcp.tools': ['observationId', 'recordKey', 'startIndex'],
  'settings.mcp.descriptor': ['observationId', 'recordKey', 'index', 'readId'],
  'settings.mcp.descriptor.read': ['readId', 'offset', 'limit'],
  'settings.mcp.descriptor.close': ['readId'],
  'interactions.next': ['viewGeneration', 'afterId'],
  'interactions.close': ['viewGeneration'],
  'settings.models.read': ['scope'],
  'input.models.read': [],
  'conversation.models.read': [],
  'conversation.branch': ['workspaceId'],
  'conversation.send': ['creation', 'intent', 'permissionMode', 'targetBranch'],
  'conversation.lookup': ['commandId'],
  'settings.providers.read': [],
  'settings.providers.close': [],
  'settings.providers.save': ['observationId', 'operation', 'secret'],
  'settings.providers.lookup': ['commandId'],
  'settings.models.close': [],
  'settings.models.enabled': ['observationId', 'modelId', 'enabled'],
  'settings.models.default': ['observationId', 'modelId'],
  'settings.models.lookup': ['commandId'],
  'fileRecovery.list': ['readId', 'afterKey'],
  'fileRecovery.detail': ['readId', 'pointId', 'inputRevision'],
  'fileRecovery.status': ['readId', 'pointId', 'restoreId'],
  'fileRecovery.begin': ['observationId', 'scope', 'title', 'inputRevision'],
  'fileRecovery.continue': ['intentId'],
  'fileRecovery.lookup': ['intentId', 'readId'],
  'fileRecovery.listSaved': [],
  'fileRecovery.close': ['readId'],
  'recovery.prepare': ['kind', 'targetId', 'readId'],
  'recovery.submit': ['observationId', 'confirm'],
  'recovery.lookup': ['commandId', 'readId'],
  'recovery.close': ['readId'],
  'session.observe': ['sessionId'],
  'session.fork': ['observationId', 'title'],
  'session.rename': ['observationId', 'title'],
  'session.delete': ['observationId'],
  lookupSessionMutation: ['commandId'],
  'context.read': ['sessionId', 'readId'],
  'context.next': ['sessionId', 'readId'],
  'context.close': ['readId'],
  'context.rewind': ['observationId', 'boundary'],
  'context.include': ['observationId', 'executionId', 'resultRevision', 'scope'],
  lookupContext: ['commandId'],
  'context.compress': ['observationId', 'focus'],
  'context.resetCompression': ['observationId'],
  lookupCompression: ['commandId'],
  'grants.read': ['sessionId', 'afterSeq', 'upperSeq', 'revision'],
  'grants.clear': ['observationId'],
  lookupGrant: ['commandId'],
  'modelInputs.close': ['readId'],
  'modelInputs.list': ['readId', 'expectedStoreId', 'sessionId', 'afterSeq', 'upperSeq', 'limit'],
  'modelInput.open': ['readId', 'expectedStoreId', 'sessionId', 'executionId'],
  'modelInput.read': ['readId', 'offset', 'limit'],
  'modelInput.close': ['readId'],
  'modelOutput.open': ['readId', 'expectedStoreId', 'sessionId', 'executionId', 'messageId'],
  'modelOutput.read': ['readId', 'offset', 'limit'],
  'modelOutput.close': ['readId'],
  'interactionAttachment.open': ['readId', 'key'],
  'interactionAttachment.read': ['readId', 'offset', 'limit'],
  'interactionAttachment.close': ['readId'],
  attach: [],
  state: [],
  directory: [],
  detach: [],
  'workspace.pick': [],
  'workspace.remove': ['workspaceId'],
  'workspace.removal.lookup': ['commandId'],
  select: ['sessionId'],
  createSession: ['workspaceId', 'commandId', 'sessionId', 'title', 'expectedStoreId'],
  messages: ['sessionId', 'expectedStoreId', 'readId', 'afterSeq', 'upperSeq', 'limit'],
  'messages.close': ['readId'],
  submit: ['sessionId', 'intent', 'draft'],
  'caller.prepare': ['sessionId', 'intent', 'draft'],
  'caller.submit': ['commandId'],
  'caller.lookup': ['commandId'],
  'caller.clear': ['commandId'],
  'caller.list': [],
  'caller.body': ['commandId', 'readId', 'offset', 'limit'],
  'caller.close': ['readId'],
  lookupInput: ['commandId'],
  lookupCreation: ['commandId'],
  'draft.list': ['afterId'],
  'draft.original': ['draftId'],
  cancelInput: ['commandId'],
  lookupPermission: ['commandId'],
  lookupInteraction: ['commandId'],
  'draft.read': ['sessionId'],
  'draft.write': ['sessionId', 'revision', 'content'],
  'permission.mode': ['observationId', 'mode', 'makeDefault'],
  'permission.trust': ['observationId', 'trusted'],
  'permission.refresh': [],
  'interaction.answer': ['interactionId', 'revision', 'answer'],
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid_native_request');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw Error('invalid_native_request');
}
export function decodeNativeRequest(value: unknown): NativeRequest {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw Error('invalid_native_request');
  }
  const candidate = record(value);
  if (
    bytes >
    (candidate.method === 'caller.prepare' ||
    candidate.method === 'submit' ||
    candidate.method === 'extensions.invoke'
      ? 16777216
      : requestBytes)
  )
    throw Error('native_request_too_large');
  const input = record(value),
    method = input.method;
  if (typeof method !== 'string' || !Object.hasOwn(fields, method))
    throw Error('invalid_native_request');
  if (method === 'extensions.open') {
    for (const key of ['viewSelection', 'historyEpoch'])
      if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0)
        throw Error('invalid_native_request');
  }
  if (method === 'extensions.read') {
    if (
      !Number.isSafeInteger(input.offset) ||
      Number(input.offset) < 0 ||
      !Number.isInteger(input.limit) ||
      Number(input.limit) < 1 ||
      Number(input.limit) > 65536
    )
      throw Error('invalid_native_request');
  }
  if (method === 'extensions.invoke') {
    try {
      validateRequest('ExtensionCommandRequest', {
        kind: 'extension.invoke',
        expectedStoreId: 'native-observed-store',
        commandId: input.commandId,
        extensionId: input.extensionId,
        actionId: input.actionId,
        definitionVersion: input.definitionVersion,
        input: input.input,
      });
    } catch {
      throw Error('invalid_native_request');
    }
    if ((input.viewIndex === undefined) !== (input.actionIndex === undefined))
      throw Error('invalid_native_request');
    for (const key of ['viewIndex', 'actionIndex'])
      if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0))
        throw Error('invalid_native_request');
  }
  if (method === 'extensions.query') {
    if (
      typeof input.extensionId !== 'string' ||
      !input.extensionId ||
      typeof input.queryId !== 'string' ||
      !input.queryId ||
      input.input === undefined
    )
      throw Error('invalid_native_request');
    try {
      validateRequest('ExtensionCommandRequest', {
        kind: 'extension.invoke',
        expectedStoreId: 'native-observed-store',
        commandId: 'native-query-validation',
        extensionId: input.extensionId,
        actionId: input.queryId,
        definitionVersion: 'query',
        input: input.input,
      });
      if (encodeURIComponent(JSON.stringify(input.input)).length > 8192)
        throw Error('invalid_native_request');
    } catch {
      throw Error('invalid_native_request');
    }
  }
  if (
    method.startsWith('background.') &&
    input.surface !== undefined &&
    input.surface !== 'environment'
  )
    throw Error('invalid_native_request');
  if (method.startsWith('settings.mcp.')) {
    if (method === 'settings.mcp.submit') parseNativeMcpOperation(input.operation);
    if (method === 'settings.mcp.removePreview')
      parseNativeMcpOperation({ kind: 'remove', serverId: input.serverId, scope: input.scope });
    if (
      method === 'settings.mcp.sources' &&
      (typeof input.afterId !== 'string' || !/^mcp-[a-f0-9]{64}$/.test(input.afterId))
    )
      throw Error('invalid_native_request');
    for (const key of ['recordKey', 'afterKey'])
      if (
        fields[method as NativeRequest['method']].includes(key) &&
        (typeof input[key] !== 'string' || !/^tools\/[a-f0-9]{64}$/.test(input[key] as string))
      )
        throw Error('invalid_native_request');
    if (
      method === 'settings.mcp.auth' &&
      (typeof input.serverId !== 'string' || !/^mcp-[a-f0-9]{64}$/.test(input.serverId))
    )
      throw Error('invalid_native_request');
    for (const key of ['startIndex', 'index'])
      if (
        fields[method as NativeRequest['method']].includes(key) &&
        (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0 || Number(input[key]) > 16383)
      )
        throw Error('invalid_native_request');
    if (
      method === 'settings.mcp.descriptor.read' &&
      (!Number.isSafeInteger(input.offset) ||
        Number(input.offset) < 0 ||
        Number(input.offset) > 134217728 ||
        !Number.isSafeInteger(input.limit) ||
        Number(input.limit) < 1 ||
        Number(input.limit) > 65536)
    )
      throw Error('invalid_native_request');
  }
  if (
    (method === 'interactionHistory.open' ||
      method === 'settings.skills.open' ||
      method === 'jobOutput.open' ||
      method === 'fileChanges.list' ||
      method === 'fileTargets.list' ||
      method === 'toolMessages.list' ||
      method === 'toolMessages.runs' ||
      method === 'toolMessages.usage' ||
      method === 'messageFile.open') &&
    (!Number.isSafeInteger(input.viewSelection) ||
      Number(input.viewSelection) < 1 ||
      !Number.isSafeInteger(input.historyEpoch) ||
      Number(input.historyEpoch) < 0)
  )
    throw Error('invalid_native_request');
  if (
    (method === 'settings.models.enabled' || method === 'settings.models.default') &&
    (typeof input.modelId !== 'string' || !input.modelId.length || input.modelId.length > 128)
  )
    throw Error('invalid_native_request');
  if (method === 'settings.models.enabled' && typeof input.enabled !== 'boolean')
    throw Error('invalid_native_request');
  if (method === 'settings.models.read' && !['user', 'workspace'].includes(input.scope as string))
    throw Error('invalid_native_request');
  if (method === 'settings.providers.save') {
    const operation = record(input.operation);
    exact(operation, ['provider', 'connectionId', 'baseURL', 'modelNames', 'credential']);
    if (
      !['openai', 'deepseek', 'compatible', 'ollama'].includes(String(operation.provider)) ||
      !(
        operation.connectionId === null ||
        (typeof operation.connectionId === 'string' &&
          /^[a-f0-9]{64}$/.test(operation.connectionId))
      ) ||
      typeof operation.baseURL !== 'string' ||
      !operation.baseURL ||
      operation.baseURL.length > 4096 ||
      !Array.isArray(operation.modelNames) ||
      operation.modelNames.some(
        (name) => typeof name !== 'string' || !name.trim() || name.length > 256,
      ) ||
      !['keep', 'replace', 'none'].includes(String(operation.credential)) ||
      (operation.credential === 'replace') !== (input.secret !== undefined) ||
      (input.secret !== undefined &&
        (typeof input.secret !== 'string' ||
          !input.secret.trim() ||
          Buffer.byteLength(input.secret) > 65536))
    )
      throw Error('invalid_native_request');
  }
  if (
    method === 'recovery.prepare' &&
    (!['run', 'report', 'interrupt'].includes(String(input.kind)) ||
      (input.kind === 'interrupt'
        ? input.targetId !== undefined
        : typeof input.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.targetId)))
  )
    throw Error('invalid_native_request');
  if (method.startsWith('fileRecovery.')) {
    if (
      (fields[method as NativeRequest['method']].includes('pointId') &&
        (typeof input.pointId !== 'string' || !/^[a-f0-9]{64}$/.test(input.pointId))) ||
      (fields[method as NativeRequest['method']].includes('inputRevision') &&
        (!Number.isSafeInteger(input.inputRevision) || Number(input.inputRevision) < 0)) ||
      (method === 'fileRecovery.begin' &&
        (!['session', 'code', 'both'].includes(String(input.scope)) ||
          typeof input.title !== 'string' ||
          !input.title.trim() ||
          Buffer.byteLength(input.title) > 8192)) ||
      (method === 'fileRecovery.list' &&
        input.afterKey !== undefined &&
        (typeof input.afterKey !== 'string' ||
          !/^checkpoint\/[a-f0-9]{64}\/point$/.test(input.afterKey)))
    )
      throw Error('invalid_native_request');
  }
  if (method === 'recovery.submit' && typeof input.confirm !== 'boolean')
    throw Error('invalid_native_request');
  exact(input, [
    'method',
    ...(method === 'attach' ? [] : ['generation']),
    ...fields[method as NativeRequest['method']],
    ...(method.startsWith('background.') ? ['surface'] : []),
  ]);
  if (
    method !== 'attach' &&
    (!Number.isSafeInteger(input.generation) || Number(input.generation) < 1)
  )
    throw Error('invalid_native_request');
  for (const key of [
    'sessionId',
    'workspaceId',
    'commandId',
    'interactionId',
    'expectedStoreId',
    'executionId',
    'readId',
    'intentId',
    'restoreId',
    'draftId',
  ]) {
    if (
      fields[method as NativeRequest['method']].includes(key) &&
      !(
        method === 'messages' &&
        (key === 'readId' || key === 'expectedStoreId') &&
        input[key] === undefined
      ) &&
      (typeof input[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input[key] as string))
    )
      throw Error('invalid_native_request');
  }
  for (const key of ['revision', 'observationId'])
    if (
      method !== 'interaction.answer' &&
      method !== 'grants.read' &&
      fields[method as NativeRequest['method']].includes(key) &&
      (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0)
    )
      throw Error('invalid_native_request');
  if (
    method === 'draft.list' &&
    input.afterId !== undefined &&
    (typeof input.afterId !== 'string' || !/^[0-9a-f]{64}$/.test(input.afterId))
  )
    throw Error('invalid_native_request');
  if (method === 'draft.write' && typeof input.content !== 'string')
    throw Error('invalid_native_request');
  const resourceId = (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (
    (method === 'fileChanges.list' ||
      method === 'fileTargets.list' ||
      method === 'toolMessages.list' ||
      method === 'toolMessages.runs' ||
      method === 'toolMessages.usage') &&
    (!Array.isArray(input.messageIds) ||
      input.messageIds.length < 1 ||
      input.messageIds.length > 32 ||
      !input.messageIds.every(resourceId) ||
      new Set(input.messageIds).size !== input.messageIds.length)
  )
    throw Error('invalid_native_request');
  if (
    (method === 'fileChanges.detail' || method === 'fileChanges.open') &&
    !resourceId(input.changeId)
  )
    throw Error('invalid_native_request');
  if (
    (method === 'fileChanges.open' || method === 'messageFile.open') &&
    !['vscode', 'zed', 'textedit'].includes(String(input.editor))
  )
    throw Error('invalid_native_request');
  if (
    method === 'messageFile.open' &&
    (!resourceId(input.messageId) ||
      typeof input.path !== 'string' ||
      !input.path ||
      Buffer.byteLength(input.path) > 8192 ||
      Buffer.from(input.path).toString('utf8') !== input.path ||
      /^[a-z][a-z\d+.-]*:|^#/i.test(input.path) ||
      [...input.path].some(
        (character) => (character.codePointAt(0) ?? 0) <= 0x1f || character.codePointAt(0) === 0x7f,
      ))
  )
    throw Error('invalid_native_request');
  if (
    method === 'modelOutput.open' &&
    input.messageId !== undefined &&
    !resourceId(input.messageId)
  )
    throw Error('invalid_native_request');
  if (
    (method === 'session.fork' || method === 'session.rename') &&
    (typeof input.title !== 'string' ||
      Buffer.byteLength(input.title) > 8192 ||
      !input.title.trim())
  )
    throw Error('invalid_native_request');
  const sequence = (value: unknown) =>
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n;
  if (
    method === 'context.compress' &&
    input.focus !== undefined &&
    (typeof input.focus !== 'string' || Buffer.byteLength(input.focus) > 1048576)
  )
    throw Error('invalid_native_request');
  if (method === 'context.rewind' && input.boundary !== null) {
    const boundary = record(input.boundary);
    exact(boundary, ['messageId', 'seq']);
    if (!resourceId(boundary.messageId) || !sequence(boundary.seq))
      throw Error('invalid_native_request');
  }
  if (method === 'context.include') {
    if (!sequence(input.resultRevision)) throw Error('invalid_native_request');
    const scope = record(input.scope);
    exact(scope, ['storeId', 'sessionId', 'contextSelectionId', 'targetRunId']);
    if (
      ![scope.storeId, scope.sessionId, scope.contextSelectionId].every(resourceId) ||
      (scope.targetRunId !== undefined && !resourceId(scope.targetRunId))
    )
      throw Error('invalid_native_request');
  }
  if (
    method === 'createSession' &&
    (typeof input.title !== 'string' || Buffer.byteLength(input.title) > 8192)
  )
    throw Error('invalid_native_request');
  if (
    (method === 'background.child.read' ||
      method === 'interactionHistory.attachment.read' ||
      method === 'modelOutput.read' ||
      method === 'modelInput.read' ||
      method === 'interactionAttachment.read') &&
    (!Number.isSafeInteger(input.offset) ||
      Number(input.offset) < 0 ||
      !Number.isInteger(input.limit) ||
      Number(input.limit) < 1 ||
      Number(input.limit) > 65536)
  )
    throw Error('invalid_native_request');
  if (method === 'messages' || method === 'modelInputs.list' || method === 'grants.read') {
    for (const key of ['afterSeq', 'upperSeq', ...(method === 'grants.read' ? ['revision'] : [])])
      if (
        input[key] !== undefined &&
        (typeof input[key] !== 'string' ||
          !/^(0|[1-9][0-9]{0,18})$/.test(input[key] as string) ||
          BigInt(input[key] as string) > 9223372036854775807n)
      )
        throw Error('invalid_native_request');
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 200)
    )
      throw Error('invalid_native_request');
  }
  if (
    method === 'permission.mode' &&
    (!['ask', 'accept_edits', 'auto', 'full'].includes(String(input.mode)) ||
      typeof input.makeDefault !== 'boolean')
  )
    throw Error('invalid_native_request');
  if (method === 'permission.trust' && typeof input.trusted !== 'boolean')
    throw Error('invalid_native_request');
  if (method === 'conversation.send') {
    const creation = record(input.creation);
    exact(creation, ['commandId', 'sessionId', 'workspaceId', 'expectedStoreId', 'title']);
    if (
      ![
        creation.commandId,
        creation.sessionId,
        creation.workspaceId,
        creation.expectedStoreId,
      ].every(resourceId) ||
      typeof creation.title !== 'string' ||
      Buffer.byteLength(creation.title) > 8192 ||
      (input.permissionMode !== undefined &&
        !['ask', 'accept_edits', 'auto', 'full'].includes(String(input.permissionMode))) ||
      (input.targetBranch !== undefined &&
        (typeof input.targetBranch !== 'string' ||
          !input.targetBranch.length ||
          Buffer.byteLength(input.targetBranch) > 1024))
    )
      throw Error('invalid_native_request');
  }
  if (method === 'submit' || method === 'caller.prepare' || method === 'conversation.send') {
    const intent = record(input.intent);
    if (
      method === 'caller.prepare' &&
      ![
        'run.start',
        'input.steer',
        'input.follow_up',
        'command.cancel',
        'execution.cancel',
      ].includes(String(intent.kind))
    )
      throw Error('invalid_native_request');
    try {
      canonicalCallerCommandRequest(intent as CallerCommandRequest);
    } catch {
      throw Error('invalid_native_request');
    }
    if (
      method === 'submit' &&
      !['run.start', 'input.steer', 'input.follow_up'].includes(String(intent.kind))
    )
      throw Error('invalid_native_request');
    if (
      method === 'conversation.send' &&
      (intent.kind !== 'run.start' || typeof intent.content !== 'string' || !intent.content.trim())
    )
      throw Error('invalid_native_request');
    if (input.draft !== undefined) {
      const draft = record(input.draft);
      exact(draft, ['id', 'revision', 'textDigest']);
      if (
        typeof draft.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(draft.id) ||
        typeof draft.textDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(draft.textDigest) ||
        typeof draft.revision !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(draft.revision) ||
        BigInt(draft.revision) > 9223372036854775807n
      )
        throw Error('invalid_native_request');
    }
  }
  if (
    method === 'caller.body' &&
    (!Number.isSafeInteger(input.offset) ||
      Number(input.offset) < 0 ||
      !Number.isSafeInteger(input.limit) ||
      Number(input.limit) < 1 ||
      Number(input.limit) > 65536)
  )
    throw Error('invalid_native_request');
  if (
    (method === 'interactionAttachment.open' || method === 'interactionHistory.attachment.open') &&
    (typeof input.key !== 'string' || !input.key)
  )
    throw Error('invalid_native_request');
  if (method === 'interaction.answer') {
    if (
      typeof input.revision !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(input.revision) ||
      BigInt(input.revision) > 9223372036854775807n
    )
      throw Error('invalid_native_request');
    const answer = record(input.answer);
    const extras =
      answer.kind === 'question'
        ? ['answers']
        : answer.kind === 'approval'
          ? ['decision', 'grant']
          : answer.kind === 'plan_review'
            ? ['decision', 'mode', 'feedback']
            : undefined;
    if (!extras) throw Error('invalid_native_request');
    exact(answer, ['kind', ...extras]);
    if (
      answer.kind === 'approval' &&
      (!['approve', 'deny'].includes(String(answer.decision)) ||
        (answer.grant !== undefined &&
          (answer.decision !== 'approve' ||
            !['approve_once', 'same_command'].includes(String(answer.grant)))))
    )
      throw Error('invalid_native_request');
  }
  if (
    (method === 'interactions.next' || method === 'interactions.close') &&
    (!Number.isSafeInteger(input.viewGeneration) || Number(input.viewGeneration) < 1)
  )
    throw Error('invalid_native_request');
  if (
    method === 'interactions.next' &&
    (!Number.isSafeInteger(input.viewGeneration) ||
      Number(input.viewGeneration) < 1 ||
      typeof input.afterId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.afterId))
  )
    throw Error('invalid_native_request');
  return structuredClone(input) as NativeRequest;
}
export function assertNativeSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | undefined,
  rendererUrl: string,
) {
  const frame = event.senderFrame;
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !frame ||
    frame !== event.sender.mainFrame
  )
    throw Error('native_sender_denied');
  let same = false;
  try {
    const actual = new URL(frame.url),
      expected = new URL(rendererUrl);
    same =
      actual.protocol === expected.protocol &&
      (actual.protocol === 'file:'
        ? fileURLToPath(actual) === fileURLToPath(expected)
        : actual.origin === expected.origin && actual.pathname === expected.pathname);
  } catch {
    /* Unparseable authority is denied. */
  }
  if (!same) throw Error('native_sender_denied');
}
/** Original window-only theme operation; it never opens the business caller. */
export function registerNativeThemeIpc(options: {
  ipcMain: IpcMain;
  window: () => BrowserWindow | undefined;
  rendererUrl: string;
  setTheme: (theme: NativeThemePreference) => void;
}) {
  options.ipcMain.handle(nativeThemeChannel, (event, payload: unknown): NativeReply => {
    try {
      assertNativeSender(event, options.window(), options.rendererUrl);
      const input = record(payload);
      exact(input, ['theme']);
      if (input.theme !== 'dark' && input.theme !== 'light' && input.theme !== 'system')
        throw Error('invalid_native_theme');
      options.setTheme(input.theme);
      return { ok: true, value: null };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return {
        ok: false,
        code: /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : 'native_theme_failed',
      };
    }
  });
  return () => options.ipcMain.removeHandler(nativeThemeChannel);
}

/** Retained native clipboard and zoom actions; these never open the Service caller. */
export function registerNativeWindowIpc(options: {
  ipcMain: IpcMain;
  window: () => BrowserWindow | undefined;
  rendererUrl: string;
  writeClipboardText: (text: string) => void;
}) {
  options.ipcMain.handle(nativeClipboardChannel, (event, payload: unknown): NativeReply => {
    try {
      assertNativeSender(event, options.window(), options.rendererUrl);
      const input = record(payload);
      exact(input, ['text']);
      if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > 1048576)
        throw Error('invalid_native_clipboard_text');
      options.writeClipboardText(input.text);
      return { ok: true, value: null };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return {
        ok: false,
        code: /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : 'native_clipboard_failed',
      };
    }
  });
  options.ipcMain.handle(nativeWindowMaximizeChannel, (event, payload: unknown): NativeReply => {
    try {
      const window = options.window();
      assertNativeSender(event, window, options.rendererUrl);
      if (payload !== undefined) throw Error('invalid_native_request');
      if (window!.isMaximized()) window!.unmaximize();
      else window!.maximize();
      return { ok: true, value: null };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return {
        ok: false,
        code: /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : 'native_window_failed',
      };
    }
  });
  return () => {
    options.ipcMain.removeHandler(nativeClipboardChannel);
    options.ipcMain.removeHandler(nativeWindowMaximizeChannel);
  };
}

/** Report content and destination remain Main-owned; no business caller is opened. */
export function registerNativeStartupIpc(options: {
  ipcMain: IpcMain;
  window: () => BrowserWindow | undefined;
  rendererUrl: string;
  report: () => string | null;
  pickPath: (window: BrowserWindow) => Promise<string | null>;
  write: (path: string, report: string) => Promise<void>;
}) {
  options.ipcMain.handle(
    nativeStartupStatusChannel,
    (event, payload: unknown): NativeStartupReply => {
      try {
        assertNativeSender(event, options.window(), options.rendererUrl);
        if (payload !== undefined) throw Error('invalid_native_request');
        return { ok: true, value: { diagnosticAvailable: options.report() !== null } };
      } catch {
        return { ok: false, code: 'native_startup_status_unavailable' };
      }
    },
  );
  options.ipcMain.handle(
    nativeStartupDiagnosticSaveChannel,
    async (event, payload: unknown): Promise<NativeStartupReply> => {
      try {
        const window = options.window();
        assertNativeSender(event, window, options.rendererUrl);
        if (payload !== undefined) throw Error('invalid_native_request');
        const report = options.report();
        const saved = await saveStartupDiagnosticReport(
          report,
          () => options.pickPath(window!),
          async (path, content) => {
            assertNativeSender(event, options.window(), options.rendererUrl);
            if (options.window() !== window || options.report() !== report)
              throw Error('native_startup_diagnostic_changed');
            await options.write(path, content);
          },
        );
        return { ok: true, value: saved };
      } catch {
        return { ok: false, code: 'native_startup_diagnostic_save_failed' };
      }
    },
  );
  return () => {
    options.ipcMain.removeHandler(nativeStartupStatusChannel);
    options.ipcMain.removeHandler(nativeStartupDiagnosticSaveChannel);
  };
}

export function registerNativeIpc(options: {
  ipcMain: IpcMain;
  window: () => BrowserWindow | undefined;
  rendererUrl: string;
  caller: () => Promise<NativeCaller>;
  confirmWorkspaceRemoval?: (label: string) => Promise<boolean>;
  openEditor?: (editor: DesktopEditor, path: string) => Promise<void>;
  pickWorkspace?: (
    generation: number,
    caller: NativeCaller,
  ) => Promise<void | { workspaceId: string }>;
}) {
  options.ipcMain.handle(nativeChannel, async (event, payload: unknown): Promise<NativeReply> => {
    try {
      assertNativeSender(event, options.window(), options.rendererUrl);
      const request = decodeNativeRequest(payload);
      const caller = await options.caller();
      // Recheck sender after startup/admission awaits; a replaced frame cannot submit work.
      assertNativeSender(event, options.window(), options.rendererUrl);
      let value: NativeResult;
      if (request.method === 'workspace.pick') {
        if (!options.pickWorkspace) throw Error('native_host_operation_unavailable');
        const picked = await options.pickWorkspace(request.generation, caller);
        value = picked ? { kind: 'workspace.picked', workspaceId: picked.workspaceId } : null;
      } else if (request.method === 'workspace.remove') {
        if (!options.confirmWorkspaceRemoval) throw Error('native_host_operation_unavailable');
        value = await caller.removeWorkspace(
          request.generation,
          request.workspaceId,
          async (label) => {
            const confirmed = await options.confirmWorkspaceRemoval!(label);
            assertNativeSender(event, options.window(), options.rendererUrl);
            return confirmed;
          },
        );
      } else if (request.method === 'fileChanges.open' || request.method === 'messageFile.open') {
        const perform = async (editor: DesktopEditor, target: string) => {
          assertNativeSender(event, options.window(), options.rendererUrl);
          try {
            await (options.openEditor ?? openEditor)(editor, target);
          } catch {
            throw Error('file_editor_open_failed');
          }
        };
        if (request.method === 'fileChanges.open') await caller.openChangedFile(request, perform);
        else await caller.openMessageFile(request, perform);
        value = null;
      } else value = await caller.invoke(request);
      if (Buffer.byteLength(JSON.stringify(value)) > responseBytes)
        throw Error('native_response_too_large');
      return { ok: true, value };
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : error instanceof Error
            ? error.message
            : '';
      return {
        ok: false,
        code: /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : 'native_request_failed',
      };
    }
  });
  return () => options.ipcMain.removeHandler(nativeChannel);
}
