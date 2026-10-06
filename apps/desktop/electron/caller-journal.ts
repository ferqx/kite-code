import { createHash } from 'node:crypto';
import {
  type AgentClient,
  type BackgroundExecutionItem,
  type CallerCommandRequest,
  type Command,
  canonicalCallerCommandRequest,
} from '@kite-ai/client';
import type {
  NativeCallerIntent,
  NativeCallerMetadata,
  NativeCallerRecord,
} from '../src/native-bridge';
import type { PrivateData } from './private-data';
export const callerCanonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(callerCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${callerCanonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw Error('caller_storage_unavailable');
  return json;
};
export const callerTextDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export const callerDigest = (value: unknown) => callerTextDigest(callerCanonical(value));
export function callerTarget(
  scope: NativeCallerIntent['scope'],
  request: CallerCommandRequest,
): NativeCallerIntent['target'] {
  switch (request.kind) {
    case 'run.start':
      return { kind: 'session', id: scope.sessionId };
    case 'input.steer':
      return {
        kind: 'run',
        id: request.targetRunId,
        contextSelectionId: request.contextSelectionId,
      };
    case 'input.follow_up':
      return {
        kind: 'after_run',
        id: request.afterRunId,
        contextSelectionId: request.contextSelectionId,
      };
    case 'command.cancel':
      return { kind: 'command', id: request.targetCommandId };
    case 'execution.cancel':
      return { kind: 'execution', id: request.executionId };
    default:
      throw Error('caller_storage_unavailable');
  }
}
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw Error('caller_storage_unavailable');
}
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function validateCallerRecord(raw: unknown): NativeCallerRecord {
  closed(raw, ['intent', 'phase']);
  const item = raw.intent;
  const hasDraft = !!item && typeof item === 'object' && 'draft' in item;
  closed(item, [
    'scope',
    'subjectId',
    'request',
    'target',
    'bodyDigest',
    'requestDigest',
    ...(hasDraft ? ['draft'] : []),
  ]);
  closed(item.scope, ['storeId', 'sessionId', 'workspaceId']);
  if (
    !Object.values(item.scope).every(id) ||
    typeof item.subjectId !== 'string' ||
    !item.subjectId ||
    item.subjectId.length > 256 ||
    !['submitting', 'unknown', 'accepted', 'applied', 'rejected'].includes(String(raw.phase))
  )
    throw Error('caller_storage_unavailable');
  const request = item.request as CallerCommandRequest;
  const canonical = canonicalCallerCommandRequest(request);
  if (
    request.expectedStoreId !== item.scope.storeId ||
    item.bodyDigest !== callerDigest(request) ||
    item.requestDigest !== callerTextDigest(canonical) ||
    callerCanonical(item.target) !==
      callerCanonical(callerTarget(item.scope as NativeCallerIntent['scope'], request))
  )
    throw Error('caller_storage_unavailable');
  if (hasDraft) {
    closed(item.draft, ['id', 'revision', 'textDigest']);
    if (
      typeof item.draft.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.draft.id) ||
      typeof item.draft.textDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.draft.textDigest) ||
      typeof item.draft.revision !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(item.draft.revision) ||
      BigInt(item.draft.revision) > 9223372036854775807n
    )
      throw Error('caller_storage_unavailable');
  }
  return structuredClone(raw) as NativeCallerRecord;
}
export function callerMetadata(row: NativeCallerRecord): NativeCallerMetadata {
  const { request, ...rest } = row.intent;
  return {
    ...rest,
    request: {
      kind: request.kind,
      commandId: request.commandId,
      expectedStoreId: request.expectedStoreId,
    },
    phase: row.phase === 'submitting' ? 'unknown' : row.phase,
  };
}
/** Node main owns durable requests. A persisted row grants no cold POST authority. */
export class NativeCallerJournal {
  private readonly first = new Map<string, NativeCallerIntent>();
  private readonly inflight = new Map<string, Promise<Command>>();
  private readonly client: AgentClient;
  private readonly data: PrivateData;
  constructor(client: AgentClient, data: PrivateData) {
    this.client = client;
    this.data = data;
  }
  records() {
    return this.data.callers();
  }
  prepare(sessionId: string, raw: CallerCommandRequest, draft?: NativeCallerIntent['draft']) {
    return this.prepareIntent(sessionId, raw, draft);
  }
  /** Main supplies an authenticated original directory item; renderer cannot name a child Session. */
  async prepareBackgroundStop(item: BackgroundExecutionItem, commandId: string) {
    const storeId = this.client.serverInfo?.storeId,
      subjectId = this.client.serverInfo?.subjectId;
    const root = await this.client.getView(item.rootSession.id),
      source = await this.client.getCommand(item.execution.originCommandId);
    if (
      !storeId ||
      !subjectId ||
      item.execution.kind !== 'job' ||
      item.execution.originStoreId !== storeId ||
      item.execution.sessionId !== item.session.id ||
      root.storeId !== storeId ||
      root.session.id !== item.rootSession.id ||
      root.session.parentSessionId !== null ||
      root.session.deletedAt !== null ||
      root.session.workspaceId !== item.session.workspaceId ||
      item.session.rootSessionId !== root.session.id ||
      source.id !== item.execution.originCommandId ||
      source.sessionId !== item.session.id ||
      source.originStoreId !== storeId ||
      source.subjectId !== subjectId
    )
      throw Error('caller_scope_unavailable');
    return this.prepareIntent(
      item.session.id,
      {
        kind: 'execution.cancel',
        expectedStoreId: storeId,
        commandId,
        executionId: item.execution.id,
      },
      undefined,
      root.session.id,
    );
  }
  private async prepareIntent(
    sessionId: string,
    raw: CallerCommandRequest,
    draft?: NativeCallerIntent['draft'],
    backgroundRoot?: string,
  ) {
    const canonical = canonicalCallerCommandRequest(raw),
      request = JSON.parse(JSON.stringify(raw)) as CallerCommandRequest;
    const view = await this.client.getView(sessionId),
      scope = {
        storeId: request.expectedStoreId,
        sessionId,
        workspaceId: view.session.workspaceId,
      };
    const subjectId = this.client.serverInfo?.subjectId;
    if (
      view.storeId !== scope.storeId ||
      view.session.id !== sessionId ||
      (view.session.parentSessionId !== null &&
        (request.kind !== 'execution.cancel' || view.session.rootSessionId !== backgroundRoot)) ||
      view.session.deletedAt !== null ||
      this.client.serverInfo?.storeId !== scope.storeId ||
      !subjectId
    )
      throw Error('caller_scope_unavailable');
    const existing = this.records().find((r) => r.intent.request.commandId === request.commandId);
    if (existing) {
      if (
        callerDigest(existing.intent.scope) !== callerDigest(scope) ||
        existing.intent.subjectId !== subjectId ||
        existing.intent.bodyDigest !== callerDigest(request) ||
        (draft && callerDigest(existing.intent.draft) !== callerDigest(draft))
      )
        throw Error('caller_intent_conflict');
      return existing;
    }
    if (request.kind === 'input.steer' || request.kind === 'input.follow_up') {
      if (view.session.contextSelectionId !== request.contextSelectionId)
        throw Error('caller_scope_unavailable');
      const targetRunId = request.kind === 'input.steer' ? request.targetRunId : request.afterRunId;
      if (targetRunId !== null) {
        const run = await this.client.getRun(targetRunId);
        if (
          run.originStoreId !== scope.storeId ||
          run.sessionId !== sessionId ||
          run.id !== targetRunId
        )
          throw Error('caller_scope_unavailable');
      }
    }
    if (request.kind === 'command.cancel') {
      const command = await this.client.getCommand(request.targetCommandId);
      if (
        command.id !== request.targetCommandId ||
        command.sessionId !== sessionId ||
        command.originStoreId !== scope.storeId
      )
        throw Error('caller_scope_unavailable');
    }
    if (request.kind === 'execution.cancel') {
      const execution = await this.client.getExecution(request.executionId);
      if (
        execution.id !== request.executionId ||
        execution.sessionId !== sessionId ||
        execution.originStoreId !== scope.storeId ||
        execution.kind !== 'job' ||
        !['planned', 'dispatching', 'running'].includes(execution.status)
      )
        throw Error('caller_scope_unavailable');
    }
    if (draft) {
      const original = this.data.readId(draft.id);
      if (
        original.storeId !== scope.storeId ||
        original.workspaceId !== scope.workspaceId ||
        original.rootSessionId !== sessionId ||
        String(original.revision) !== draft.revision ||
        callerTextDigest(original.content) !== draft.textDigest ||
        !('content' in request) ||
        request.content !== original.content
      )
        throw Error('caller_draft_unavailable');
    }
    const row = validateCallerRecord({
      intent: {
        scope,
        subjectId,
        request,
        target: callerTarget(scope, request),
        bodyDigest: callerDigest(request),
        requestDigest: callerTextDigest(canonical),
        ...(draft ? { draft } : {}),
      },
      phase: 'submitting',
    });
    const saved = this.data.beginCaller(row);
    if (saved.created) this.first.set(request.commandId, structuredClone(saved.value.intent));
    return saved.value;
  }
  private original(commandId: string) {
    const row = this.records().find((r) => r.intent.request.commandId === commandId);
    if (!row) throw Error('caller_intent_missing');
    return row;
  }
  private async checked(row: NativeCallerRecord, command: Command) {
    const i = row.intent,
      r = i.request;
    if (
      command.id !== r.commandId ||
      command.kind !== r.kind ||
      command.originStoreId !== i.scope.storeId ||
      command.sessionId !== i.scope.sessionId ||
      command.subjectId !== i.subjectId ||
      command.requestDigest !== i.requestDigest
    )
      throw Error('caller_receipt_unavailable');
    const view = await this.client.getView(i.scope.sessionId);
    if (
      view.storeId !== i.scope.storeId ||
      view.session.id !== i.scope.sessionId ||
      view.session.workspaceId !== i.scope.workspaceId
    )
      throw Error('caller_receipt_unavailable');
    if (command.status === 'needs_review') throw Error('caller_receipt_unavailable');
    if (command.status === 'applied') {
      const receipt = command.receipt;
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
        throw Error('caller_receipt_unavailable');
      if (
        (r.kind === 'command.cancel' &&
          (receipt.kind !== r.kind ||
            receipt.targetCommandId !== r.targetCommandId ||
            receipt.outcome !== 'cancel_requested')) ||
        (r.kind === 'execution.cancel' &&
          (receipt.kind !== r.kind ||
            receipt.executionId !== r.executionId ||
            receipt.outcome !== 'cancel_requested'))
      )
        throw Error('caller_receipt_unavailable');
      if (r.kind === 'run.start' || r.kind === 'input.follow_up' || r.kind === 'input.steer') {
        if (typeof receipt.runId !== 'string') throw Error('caller_receipt_unavailable');
        const run = await this.client.getRun(receipt.runId);
        if (
          run.id !== receipt.runId ||
          run.originStoreId !== i.scope.storeId ||
          run.sessionId !== i.scope.sessionId ||
          (r.kind === 'input.steer'
            ? run.id !== r.targetRunId || receipt.contextSelectionId !== r.contextSelectionId
            : run.originCommandId !== r.commandId)
        )
          throw Error('caller_receipt_unavailable');
      }
    }
    this.data.finishCaller(r.commandId, command.status);
    return command;
  }
  async lookup(commandId: string) {
    this.first.delete(commandId);
    const row = this.original(commandId);
    try {
      return await this.checked(row, await this.client.getCommand(commandId));
    } catch (error) {
      this.data.finishCaller(commandId, 'unknown');
      throw error;
    }
  }
  submit(commandId: string): Promise<Command> {
    const pending = this.inflight.get(commandId);
    if (pending) return pending;
    const row = this.original(commandId);
    const first = this.first.get(commandId);
    this.first.delete(commandId);
    if (!first) return this.lookup(commandId);
    if (callerCanonical(first) !== callerCanonical(row.intent))
      throw Error('caller_intent_conflict');
    const r = row.intent.request;
    const pendingRequest = (async () => {
      try {
        if (r.kind === 'execution.cancel') {
          const execution = await this.client.getExecution(r.executionId);
          if (
            execution.id !== r.executionId ||
            execution.originStoreId !== row.intent.scope.storeId ||
            execution.sessionId !== row.intent.scope.sessionId ||
            execution.kind !== 'job' ||
            !['planned', 'dispatching', 'running'].includes(execution.status)
          )
            throw Error('caller_scope_unavailable');
        }
        const command =
          r.kind === 'run.start'
            ? await this.client.startRun(row.intent.scope.sessionId, r)
            : r.kind === 'input.steer'
              ? await this.client.steer(row.intent.scope.sessionId, r)
              : r.kind === 'input.follow_up'
                ? await this.client.followUp(row.intent.scope.sessionId, r)
                : r.kind === 'command.cancel'
                  ? await this.client.cancelCommand(row.intent.scope.sessionId, r)
                  : await this.client.cancelExecution(row.intent.scope.sessionId, r);
        return await this.checked(row, command);
      } catch (error) {
        this.data.finishCaller(commandId, 'unknown');
        throw error;
      } finally {
        this.inflight.delete(commandId);
      }
    })();
    this.inflight.set(commandId, pendingRequest);
    return pendingRequest;
  }
  clear(commandId: string) {
    this.first.delete(commandId);
    this.data.clearCaller(commandId);
  }
}
