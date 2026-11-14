import { createHash } from 'node:crypto';
import {
  type AgentClient,
  type BackgroundExecutionItem,
  ClientError,
  type Command,
  type Message,
} from '@kite-ai/client';
import {
  type NativeBackgroundChild,
  type NativeBackgroundChildChunk,
  type NativeBackgroundChildOpen,
  type NativeBackgroundPage,
  nativeBackgroundPageBytes,
} from '../src/background-bridge';
import type { NativeFileChangeDetail } from '../src/file-changes-bridge';
import type { NativeJobOutputScope } from '../src/job-output-bridge';
import {
  type NativeToolMessageFact,
  nativeRunFact,
  nativeToolExecution,
  nativeToolMessagePageBytes,
  presentableRun,
} from '../src/tool-messages-bridge';
import {
  nativeFileOperationMetadata,
  nativeFileReceiptDetail,
  nativeFileReceiptFacts,
} from './file-changes';
import { NativeInputImageReads } from './input-image-reads';
import { NativeJobOutputReads } from './job-output-reads';
import {
  nativeLiveShellInputFact,
  nativeToolMessageEligible,
  nativeToolMessageFact,
} from './tool-message-fact';

type Scope = {
  generation: number;
  storeId: string;
  subjectId: string;
  rootSessionId?: string;
  viewSelection?: number;
};
type Directory = {
  readId: string;
  scope: Scope;
  abort: AbortController;
  offset: number;
  items?: BackgroundExecutionItem[];
  observationId: number;
};
type Detail = {
  readId: string;
  scope: Scope;
  abort: AbortController;
  item: BackgroundExecutionItem;
  observationId: number;
  bytes?: Uint8Array;
  offset: number;
};
type ChildReceipt = {
  lease: Pick<Detail, 'scope' | 'item' | 'observationId'>;
  childId: string;
  selection: string;
  messageId: string;
  seq: string;
  hash: string;
  revision?: string;
  kind: 'file' | 'text' | 'image';
};
const decimal = (value: string) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new ClientError('background_identity_mismatch');
  return BigInt(value);
};
/** Immutable lineage, separate from mutable lifecycle and current child Session Run. */
export function backgroundIdentity(item: BackgroundExecutionItem) {
  const e = item.execution;
  return JSON.stringify([
    item.seq,
    e.id,
    e.originStoreId,
    e.sessionId,
    e.runId,
    e.originCommandId,
    e.rootSessionId,
    e.rootWorkCommandId,
    e.rootWorkSeq,
    e.parentExecutionId,
    e.cancelWithParent,
    e.childSessionId,
    e.definitionId,
    e.definitionVersion,
    item.session.id,
    item.session.parentSessionId,
    item.session.rootSessionId,
    item.session.workspaceId,
    item.rootSession.id,
    item.rootSession.parentSessionId,
    item.rootSession.workspaceId,
    item.childSession?.id ?? null,
    item.childSession?.parentSessionId ?? null,
    item.childSession?.rootSessionId ?? null,
    item.childSession?.workspaceId ?? null,
    item.childRun?.id ?? null,
    item.childRun?.originCommandId ?? null,
  ]);
}

/** Keep command completeness independent of the snapshot transport's byte chunks. */
function completeShellCommand(
  fact: NativeToolMessageFact,
  nextFact: (offset: number) => NativeToolMessageFact | undefined,
  remainingBytes: number,
) {
  const input = fact.shellInput;
  if (input?.command === undefined) return 0;
  let command = input.command;
  let encodedBytes = Buffer.byteLength(JSON.stringify(command));
  let nextOffset = input.commandNextOffset;
  while (nextOffset != null && encodedBytes <= remainingBytes) {
    const next = nextFact(nextOffset)?.shellInput;
    if (!next?.command || next.commandOffset !== nextOffset)
      throw new ClientError('tool_message_command_offset_invalid');
    command += next.command;
    encodedBytes += Buffer.byteLength(JSON.stringify(next.command)) - 2;
    nextOffset = next.commandNextOffset;
  }
  if (nextOffset == null && encodedBytes <= remainingBytes) {
    fact.shellInput = { ...input, command, commandOffset: 0, commandNextOffset: null };
    return encodedBytes;
  }
  // An original target preview is display only, without a partial command/copy action.
  fact.shellInput = {
    operation: input.operation,
    ...(input.shellId ? { shellId: input.shellId } : {}),
  };
  return 0;
}

/** Each Main-owned scope has its own complete authenticated observation and detail readers. */
export class NativeBackground {
  private directory: Directory | undefined;
  private knownSessions: { scope: Scope; ids: Set<string> } | undefined;
  private observed:
    | { id: number; scope: Scope; items: Map<string, BackgroundExecutionItem> }
    | undefined;
  // Only an exact child read may reuse one prior complete directory during refresh
  // and its renderer publication handoff. Controls require the current observation.
  private previousChildObservation: NativeBackground['observed'];
  private observation = 0;
  private readonly outputs = new Map<string, Detail>();
  private readonly children = new Map<string, Detail>();
  private readonly childReceipts = new Map<string, ChildReceipt>();
  private readonly childTextReads = new Set<AbortController>();
  private readonly childImageReads = new Map<
    string,
    { lease: Detail; reader?: NativeInputImageReads }
  >();
  private readonly childFileReads = new Map<string, Detail>();
  private readonly output: NativeJobOutputReads;
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly cancellation: {
    prepare(item: BackgroundExecutionItem, commandId: string): Promise<unknown>;
    submit(commandId: string): Promise<Command>;
  };
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    cancellation: {
      prepare(item: BackgroundExecutionItem, commandId: string): Promise<unknown>;
      submit(commandId: string): Promise<Command>;
    },
  ) {
    this.client = client;
    this.current = current;
    this.cancellation = cancellation;
    this.output = new NativeJobOutputReads(client, (executionId, readId) => {
      const lease = this.outputs.get(readId);
      if (!lease || lease.item.execution.id !== executionId || !this.valid(lease)) return;
      return this.outputScope(lease);
    });
  }
  private valid(lease: { scope: Scope; abort: AbortController }) {
    const now = this.current();
    return (
      !lease.abort.signal.aborted &&
      !!now &&
      Object.keys(lease.scope).every(
        (key) => now[key as keyof Scope] === lease.scope[key as keyof Scope],
      )
    );
  }
  private check(lease: { scope: Scope; abort: AbortController }) {
    if (!this.valid(lease)) throw new ClientError('background_observation_changed');
  }
  private scope() {
    const scope = this.current();
    if (!scope) throw new ClientError('background_unavailable');
    return { ...scope };
  }
  async open(readId: string): Promise<NativeBackgroundPage> {
    if (this.directory) throw new ClientError('background_read_busy');
    this.previousChildObservation = this.observed?.scope.rootSessionId ? this.observed : undefined;
    this.observed = undefined;
    const lease: Directory = {
      readId,
      scope: this.scope(),
      abort: new AbortController(),
      offset: 0,
      observationId: ++this.observation,
    };
    this.directory = lease;
    try {
      await this.client.verifyConnection({ signal: lease.abort.signal });
      this.check(lease);
      const items = await this.client.listAllBackgroundExecutions({
        signal: lease.abort.signal,
        rootSessionId: lease.scope.rootSessionId,
        ...(lease.scope.rootSessionId ? { includeSourceTool: true } : {}),
      });
      this.check(lease);
      if (
        lease.scope.rootSessionId &&
        items.some((item) => item.rootSession.id !== lease.scope.rootSessionId)
      )
        throw new ClientError('background_identity_mismatch');
      if (this.directory !== lease) throw new ClientError('background_observation_changed');
      lease.items = items;
      this.observed = {
        id: lease.observationId,
        scope: { ...lease.scope },
        items: new Map(items.map((item) => [item.execution.id, structuredClone(item)])),
      };
      this.knownSessions = {
        scope: { ...lease.scope },
        ids: new Set(
          items.flatMap((item) => [
            item.rootSession.id,
            item.session.id,
            ...(item.childSession ? [item.childSession.id] : []),
          ]),
        ),
      };
      return this.page(lease);
    } catch (error) {
      this.previousChildObservation = undefined;
      this.close(readId);
      throw error;
    }
  }
  next(readId: string) {
    const lease = this.directory;
    if (!lease || lease.readId !== readId || !lease.items)
      throw new ClientError('background_read_missing');
    if (lease.offset >= lease.items.length) throw new ClientError('background_read_complete');
    return this.page(lease);
  }
  private page(lease: Directory): NativeBackgroundPage {
    this.check(lease);
    const all = lease.items!,
      offset = lease.offset;
    let count = Math.min(200, all.length - offset);
    for (;;) {
      const page: NativeBackgroundPage = {
        kind: 'background.page',
        viewGeneration: lease.scope.generation,
        storeId: lease.scope.storeId,
        readId: lease.readId,
        observationId: lease.observationId,
        ...(lease.scope.rootSessionId
          ? { rootSessionId: lease.scope.rootSessionId, viewSelection: lease.scope.viewSelection }
          : {}),
        startIndex: offset,
        nextIndex: offset + count,
        total: all.length,
        complete: offset + count === all.length,
        entries: all.slice(offset, offset + count),
      };
      if (Buffer.byteLength(JSON.stringify(page)) <= nativeBackgroundPageBytes) {
        lease.offset = page.nextIndex;
        return page;
      }
      if (count <= 1) throw new ClientError('background_page_too_large');
      count = Math.max(1, Math.floor(count / 2));
    }
  }
  close(readId: string) {
    if (this.directory?.readId !== readId) return;
    if (!this.directory.items || this.directory.offset !== this.directory.items.length)
      this.previousChildObservation = undefined;
    this.directory.abort.abort();
    this.directory = undefined;
    // A completed directory's observation remains usable until refresh/reset.
  }
  /** Invalidation routing only. This retained index never grants read or stop admission. */
  includesSession(sessionId: string): boolean {
    const known = this.knownSessions;
    const scope = this.current();
    return !!(
      known &&
      scope &&
      Object.keys(known.scope).every(
        (key) => known.scope[key as keyof Scope] === scope[key as keyof Scope],
      ) &&
      known.ids.has(sessionId)
    );
  }
  private target(observationId: number, executionId: string, childRead = false): Detail {
    const scope = this.scope();
    if (
      this.previousChildObservation &&
      Object.keys(scope).some(
        (key) =>
          this.previousChildObservation!.scope[key as keyof Scope] !== scope[key as keyof Scope],
      )
    )
      this.previousChildObservation = undefined;
    const observed =
        this.observed?.id === observationId
          ? this.observed
          : childRead && this.previousChildObservation?.id === observationId
            ? this.previousChildObservation
            : undefined,
      item = observed?.items.get(executionId);
    if (
      !observed ||
      observed.id !== observationId ||
      !item ||
      Object.keys(scope).some(
        (key) => observed.scope[key as keyof Scope] !== scope[key as keyof Scope],
      )
    )
      throw new ClientError('background_observation_changed');
    return {
      readId: '',
      scope,
      abort: new AbortController(),
      item: structuredClone(item),
      observationId,
      offset: 0,
    };
  }
  private async fresh(lease: Detail, control = false) {
    this.check(lease);
    await this.client.verifyConnection({ signal: lease.abort.signal });
    this.check(lease);
    const page = await this.client.listBackgroundExecutions(
      {
        storeId: lease.scope.storeId,
        executionId: lease.item.execution.id,
        limit: 1,
        ...(lease.scope.rootSessionId ? { includeSourceTool: true } : {}),
      },
      { signal: lease.abort.signal },
    );
    this.check(lease);
    const item = page.items[0];
    if (
      page.items.length !== 1 ||
      !item ||
      backgroundIdentity(item) !== backgroundIdentity(lease.item)
    )
      throw new ClientError('background_identity_mismatch');
    if (
      control &&
      (this.observed?.id !== lease.observationId ||
        item.execution.originStoreId !== lease.scope.storeId ||
        !['planned', 'dispatching', 'running'].includes(item.execution.status) ||
        item.execution.cancelRequested ||
        item.execution.cancelRequestedAt !== null ||
        item.execution.ownerGeneration !== lease.item.execution.ownerGeneration ||
        item.execution.attempt !== lease.item.execution.attempt ||
        item.execution.resultRevision !== lease.item.execution.resultRevision)
    )
      throw new ClientError('background_stop_unavailable');
    return item;
  }
  async stop(observationId: number, executionId: string, commandId: string) {
    const lease = this.target(observationId, executionId);
    try {
      const fresh = await this.fresh(lease, true);
      await this.cancellation.prepare(fresh, commandId);
      await this.fresh(lease, true);
      return await this.cancellation.submit(commandId);
    } finally {
      lease.abort.abort();
    }
  }
  private outputScope(lease: Detail): NativeJobOutputScope {
    return {
      generation: lease.scope.generation,
      viewSelection: lease.observationId,
      historyEpoch: 0,
      storeId: lease.scope.storeId,
      originStoreId: lease.item.execution.originStoreId,
      sessionId: lease.item.session.id,
      workspaceId: lease.item.session.workspaceId,
      executionId: lease.item.execution.id,
    };
  }
  async outputOpen(input: { observationId: number; executionId: string; readId: string }) {
    if (this.outputs.has(input.readId)) throw new ClientError('background_read_busy');
    const lease = this.target(input.observationId, input.executionId);
    lease.readId = input.readId;
    this.outputs.set(lease.readId, lease);
    try {
      await this.fresh(lease);
      const result = await this.output.open({
        readId: lease.readId,
        executionId: input.executionId,
        viewSelection: input.observationId,
        historyEpoch: 0,
      });
      await this.fresh(lease);
      return result;
    } catch (error) {
      this.outputClose(lease.readId);
      throw error;
    }
  }
  async outputNext(readId: string) {
    const lease = this.outputs.get(readId);
    if (!lease) throw new ClientError('background_read_missing');
    try {
      await this.fresh(lease);
      const result = await this.output.next(readId);
      await this.fresh(lease);
      return result;
    } catch (error) {
      this.outputClose(readId);
      throw error;
    }
  }
  outputClose(readId: string) {
    this.output.close(readId);
    this.outputs.get(readId)?.abort.abort();
    this.outputs.delete(readId);
  }
  private childReceiptHandle(entry: ChildReceipt) {
    const handle = createHash('sha256')
      .update(
        JSON.stringify([
          entry.kind,
          entry.lease.scope,
          entry.lease.item.execution.id,
          entry.childId,
          entry.selection,
          entry.messageId,
          entry.seq,
          entry.hash,
          entry.revision,
        ]),
      )
      .digest('hex');
    this.childReceipts.delete(handle);
    this.childReceipts.set(handle, entry);
    while (this.childReceipts.size > 8192)
      this.childReceipts.delete(this.childReceipts.keys().next().value!);
    return handle;
  }
  async childOpen(input: {
    observationId: number;
    executionId: string;
    readId: string;
    cursor?: { afterSeq: string; contextSelectionId: string };
  }): Promise<NativeBackgroundChildOpen> {
    if (this.children.has(input.readId)) throw new ClientError('background_read_busy');
    const lease = this.target(input.observationId, input.executionId, true);
    lease.readId = input.readId;
    this.children.set(lease.readId, lease);
    try {
      const item = await this.fresh(lease),
        childId = item.execution.childSessionId;
      if (!childId || !item.childSession) throw new ClientError('background_child_unavailable');
      const signal = lease.abort.signal,
        parents: Awaited<ReturnType<AgentClient['getExecution']>>[] = [],
        seen = new Set<string>([item.execution.id]);
      let parentId = item.execution.parentExecutionId;
      while (parentId) {
        if (seen.has(parentId)) throw new ClientError('background_child_binding_changed');
        seen.add(parentId);
        const parent = await this.client.getExecution(parentId, { signal });
        this.check(lease);
        if (
          parent.id !== parentId ||
          parent.sessionId !== item.session.id ||
          parent.originStoreId !== item.execution.originStoreId
        )
          throw new ClientError('background_child_binding_changed');
        parents.push(parent);
        parentId = parent.parentExecutionId ?? null;
      }
      const view = await this.client.getView(childId, { signal });
      const valid = (v: typeof view) =>
        v.storeId === lease.scope.storeId &&
        v.session.id === childId &&
        v.session.parentSessionId === item.session.id &&
        v.session.rootSessionId === item.rootSession.id &&
        v.session.workspaceId === item.session.workspaceId &&
        v.session.deletedAt === null;
      if (!valid(view)) throw new ClientError('background_child_binding_changed');
      const upperSeq = view.session.nextSeq,
        messages: NativeBackgroundChild['messages'] = [],
        modelOutputs: NativeBackgroundChild['modelOutputs'] = [],
        ids = new Set<string>();
      const baseSeq =
        input.cursor &&
        lease.scope.rootSessionId &&
        input.cursor.contextSelectionId === view.session.contextSelectionId &&
        decimal(input.cursor.afterSeq) <= decimal(upperSeq)
          ? input.cursor.afterSeq
          : '0';
      let afterSeq = baseSeq;
      for (;;) {
        this.check(lease);
        const page = await this.client.listMessages(childId, {
          signal,
          afterSeq,
          upperSeq,
          limit: 200,
          ...(lease.scope.rootSessionId &&
          this.client.serverInfo?.capabilities.includes('session_state') &&
          this.client.serverInfo.capabilities.includes('message_changes')
            ? { previews: true }
            : {}),
        });
        this.check(lease);
        for (const message of page) {
          if (
            message.sessionId !== childId ||
            decimal(message.seq) <= decimal(afterSeq) ||
            decimal(message.seq) > decimal(upperSeq) ||
            ids.has(message.id)
          )
            throw new ClientError('background_child_history_mismatch');
          messages.push(message);
          ids.add(message.id);
          afterSeq = message.seq;
          if (
            message.outputBody &&
            message.outputBody.readAvailability !== 'unsupported' &&
            message.contentFormat !== 'unsupported'
          ) {
            const sourceSession = message.originMessage?.sessionId ?? childId,
              runId = message.originMessage ? message.originMessage.runId : message.runId;
            if (message.originMessage) {
              const source = await this.client.getExecution(message.outputBody.executionId, {
                signal,
              });
              this.check(lease);
              if (
                source.id !== message.outputBody.executionId ||
                source.kind !== 'model' ||
                source.sessionId !== sourceSession ||
                source.runId !== runId ||
                source.originStoreId !== message.originMessage.storeId
              )
                throw new ClientError('background_child_binding_changed');
            }
            const snapshot = await this.client.getModelOutput(
              sourceSession,
              message.outputBody.executionId,
              { expectedStoreId: lease.scope.storeId, signal },
            );
            this.check(lease);
            // A live prefix can advance between the journal row and authenticated body read.
            // Keep fixed-log consumers strict; the selected environment may publish that newer
            // verified prefix under the same original Model identity.
            if (
              lease.scope.rootSessionId &&
              !message.outputBody.complete &&
              snapshot.storeId === lease.scope.storeId &&
              snapshot.sessionId === sourceSession &&
              snapshot.executionId === message.outputBody.executionId &&
              snapshot.runId === runId &&
              snapshot.rootSessionId === item.rootSession.id &&
              decimal(snapshot.contentBytes) >= decimal(message.outputBody.contentBytes) &&
              decimal(snapshot.reasoningBytes) >= decimal(message.outputBody.reasoningBytes)
            ) {
              message.outputBody = {
                ...message.outputBody,
                complete: snapshot.output.complete,
                contentBytes: snapshot.contentBytes,
                reasoningBytes: snapshot.reasoningBytes,
                toolCallCount: snapshot.output.toolCalls.length,
              };
              message.content = snapshot.output.content.slice(0, 4096);
            }
            if (
              snapshot.storeId !== lease.scope.storeId ||
              snapshot.sessionId !== sourceSession ||
              snapshot.executionId !== message.outputBody.executionId ||
              snapshot.runId !== runId ||
              snapshot.rootSessionId !== item.rootSession.id ||
              snapshot.output.complete !== message.outputBody.complete ||
              snapshot.contentBytes !== message.outputBody.contentBytes ||
              snapshot.reasoningBytes !== message.outputBody.reasoningBytes ||
              snapshot.output.toolCalls.length !== message.outputBody.toolCallCount
            )
              throw new ClientError('background_child_history_mismatch');
            modelOutputs.push({ messageId: message.id, snapshot });
          }
        }
        if (page.length < 200) break;
      }
      const final = await this.client.getView(childId, { signal });
      this.check(lease);
      if (
        !valid(final) ||
        final.session.contextSelectionId !== view.session.contextSelectionId ||
        decimal(final.session.nextSeq) < decimal(upperSeq)
      )
        throw new ClientError('background_child_binding_changed');
      let presentation: NativeBackgroundChild['presentation'];
      if (lease.scope.rootSessionId) {
        const receiptRuns = new Map(final.runs.map((run) => [run.id, run]));
        const runs = new Map(
          final.runs
            .filter((run) => presentableRun(run, lease.scope.storeId, childId))
            .map((run) => [run.id, nativeRunFact(run)]),
        );
        const tools: NonNullable<NativeBackgroundChild['presentation']>['tools'] = [];
        const fileTargets: NonNullable<
          NonNullable<NativeBackgroundChild['presentation']>['fileTargets']
        > = [];
        const textHandles = messages.flatMap((message) =>
          message.deferredText
            ? [
                {
                  messageId: message.id,
                  handle: this.childReceiptHandle({
                    lease: {
                      scope: lease.scope,
                      item: lease.item,
                      observationId: lease.observationId,
                    },
                    childId,
                    selection: view.session.contextSelectionId,
                    messageId: message.id,
                    seq: message.seq,
                    hash: message.deferredText.sha256,
                    kind: 'text',
                  }),
                },
              ]
            : [],
        );
        const imageHandles: { messageId: string; handle: string }[] = [];
        const imageHandle = (message: Message) =>
          imageHandles.push({
            messageId: message.id,
            handle: this.childReceiptHandle({
              lease: { scope: lease.scope, item: lease.item, observationId: lease.observationId },
              childId,
              selection: view.session.contextSelectionId,
              messageId: message.id,
              seq: message.seq,
              hash: createHash('sha256').update(JSON.stringify(message)).digest('hex'),
              kind: 'image',
            }),
          });
        let commandBytes = 0;
        let unavailable: true | undefined;
        try {
          for (const message of messages) {
            if (message.originMessage || !message.runId || runs.has(message.runId)) continue;
            const run = await this.client.getRun(message.runId, { signal });
            this.check(lease);
            if (run.id !== message.runId || run.sessionId !== childId)
              throw new ClientError('background_child_history_mismatch');
            if (presentableRun(run, lease.scope.storeId, childId)) {
              runs.set(run.id, nativeRunFact(run));
              receiptRuns.set(run.id, run);
            }
          }
          for (const message of messages) {
            if (message.role === 'user' && message.status === 'complete' && message.images?.length)
              imageHandle(message);
            if (!nativeToolMessageEligible(message)) continue;
            const execution = await this.client.getExecution(message.sourceIds[0], { signal });
            this.check(lease);
            const fact = nativeToolMessageFact({
              execution,
              run: receiptRuns.get(execution.runId ?? ''),
              message,
              messages,
              sessionId: childId,
            });
            if (fact) {
              commandBytes += completeShellCommand(
                fact,
                (commandOffset) =>
                  nativeToolMessageFact({
                    execution,
                    run: receiptRuns.get(execution.runId ?? ''),
                    message,
                    messages,
                    sessionId: childId,
                    commandOffset,
                  }),
                nativeToolMessagePageBytes - commandBytes,
              );
              tools.push(fact);
              if (fact.images?.length) imageHandle(message);
              if (
                fact.status === 'succeeded' &&
                !message.originMessage &&
                [
                  'files.read',
                  'files.edit',
                  'files.write',
                  'files.edit_path',
                  'files.write_path',
                ].includes(execution.definitionId)
              ) {
                const hash = createHash('sha256')
                  .update(JSON.stringify(execution.result))
                  .digest('hex');
                const changeId = this.childReceiptHandle({
                  lease: {
                    scope: lease.scope,
                    item: lease.item,
                    observationId: lease.observationId,
                  },
                  childId,
                  selection: view.session.contextSelectionId,
                  messageId: message.id,
                  seq: message.seq,
                  hash,
                  revision: execution.resultRevision,
                  kind: 'file',
                });
                const metadata = nativeFileOperationMetadata(message.id, changeId, execution);
                if (metadata) fileTargets.push(metadata);
              }
            }
          }
        } catch (cause) {
          this.check(lease);
          if (
            cause instanceof ClientError &&
            ['background_child_history_mismatch', 'tool_message_identity_mismatch'].includes(
              cause.code,
            )
          )
            throw cause;
          // Optional presentation failure must not hide the independently verified transcript.
          unavailable = true;
        }
        const liveTools: NonNullable<NativeBackgroundChild['presentation']>['tools'] = [];
        const receipts = new Set(
          messages
            .filter(
              (message) =>
                message.role === 'tool' &&
                message.status === 'complete' &&
                message.sourceIds?.length === 1 &&
                (!message.originMessage || message.originMessage.storeId === lease.scope.storeId),
            )
            .map((message) =>
              JSON.stringify([
                message.sourceIds![0],
                message.originMessage ? message.originMessage.runId : message.runId,
              ]),
            ),
        );
        for (const execution of final.executions) {
          if (
            execution.kind !== 'tool' ||
            execution.sessionId !== childId ||
            execution.originStoreId !== lease.scope.storeId ||
            !execution.runId ||
            !runs.get(execution.runId)?.isActive ||
            receipts.has(JSON.stringify([execution.id, execution.runId]))
          )
            continue;
          const fact = nativeLiveShellInputFact(execution);
          if (!fact) continue;
          commandBytes += completeShellCommand(
            fact,
            (offset) => nativeLiveShellInputFact(execution, offset),
            nativeToolMessagePageBytes - commandBytes,
          );
          liveTools.push(fact);
        }
        const compression = final.compressionProgress;
        const compressing = compression && runs.get(compression.runId);
        presentation = {
          ...(unavailable ? { unavailable } : {}),
          ...(compressing?.isActive && compression?.originStoreId === compressing.originStoreId
            ? { compressionProgress: compression }
            : {}),
          runs: [...runs.values()],
          tools,
          fileTargets,
          textHandles,
          imageHandles,
          liveTools,
          executions: final.executions
            .filter(
              (execution) =>
                (execution.kind === 'tool' ||
                  (execution.kind === 'model' && execution.parentExecutionId == null)) &&
                execution.sessionId === childId &&
                execution.originStoreId === lease.scope.storeId &&
                execution.runId !== null &&
                runs.has(execution.runId),
            )
            .map((execution) => ({
              ...nativeToolExecution(execution),
              parentExecutionId: execution.parentExecutionId ?? null,
            })),
        };
      }
      for (const original of parents) {
        const fresh = await this.client.getExecution(original.id, { signal });
        this.check(lease);
        if (
          fresh.id !== original.id ||
          fresh.originStoreId !== original.originStoreId ||
          fresh.sessionId !== original.sessionId ||
          fresh.parentExecutionId !== original.parentExecutionId ||
          fresh.childSessionId !== original.childSessionId
        )
          throw new ClientError('background_child_binding_changed');
      }
      await this.fresh(lease);
      const controlRuns = final.runs.filter(
        (run) =>
          run.carrierExecutionId === item.execution.id &&
          run.originStoreId === item.execution.originStoreId &&
          run.sessionId === childId &&
          run.rootWorkCommandId === item.execution.rootWorkCommandId &&
          run.rootWorkSeq === item.execution.rootWorkSeq,
      );
      const controlIds = new Set(controlRuns.map((run) => run.id));
      const body: NativeBackgroundChild = {
        ...(presentation ? { presentation } : {}),
        control: {
          runs: controlRuns.map(
            ({
              id,
              sessionId,
              originStoreId,
              originCommandId,
              carrierExecutionId,
              rootWorkCommandId,
              rootWorkSeq,
              isActive,
            }) => ({
              id,
              sessionId,
              originStoreId,
              originCommandId,
              carrierExecutionId,
              rootWorkCommandId,
              rootWorkSeq,
              isActive,
            }),
          ),
          executions: final.executions
            .filter(
              (execution) =>
                execution.runId !== null &&
                controlIds.has(execution.runId) &&
                execution.originStoreId === item.execution.originStoreId &&
                execution.sessionId === childId &&
                execution.rootWorkCommandId === item.execution.rootWorkCommandId &&
                execution.rootWorkSeq === item.execution.rootWorkSeq,
            )
            .map(
              ({
                id,
                sessionId,
                originStoreId,
                runId,
                rootWorkCommandId,
                rootWorkSeq,
                authorization,
                status,
                cancelRequestedAt,
              }) => ({
                id,
                sessionId,
                originStoreId,
                runId,
                rootWorkCommandId,
                rootWorkSeq,
                authorization,
                status,
                cancelRequestedAt,
              }),
            ),
        },
        item,
        session: view.session,
        upperSeq,
        ...(input.cursor ? { afterSeq: baseSeq } : {}),
        messages,
        modelOutputs,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      this.check(lease);
      lease.bytes = bytes;
      return {
        kind: 'background.child.opened',
        viewGeneration: lease.scope.generation,
        storeId: lease.scope.storeId,
        readId: lease.readId,
        observationId: lease.observationId,
        executionId: item.execution.id,
        ...(lease.scope.rootSessionId
          ? { rootSessionId: lease.scope.rootSessionId, viewSelection: lease.scope.viewSelection }
          : {}),
        childSessionId: childId,
        childRunId: item.childRun?.id ?? null,
        wireBytes: String(bytes.length),
        wireHash: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error) {
      this.childClose(input.readId);
      throw error;
    }
  }
  childRead(input: { readId: string; offset: number; limit: number }): NativeBackgroundChildChunk {
    const lease = this.children.get(input.readId);
    if (!lease?.bytes) throw new ClientError('background_read_missing');
    this.check(lease);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset !== lease.offset ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 65536
    )
      throw new ClientError('background_offset_invalid');
    const offset = lease.offset,
      end = Math.min(lease.bytes.length, offset + input.limit);
    lease.offset = end;
    return {
      kind: 'background.child.chunk',
      readId: lease.readId,
      offset,
      nextOffset: end,
      eof: end === lease.bytes.length,
      data: Buffer.from(lease.bytes.subarray(offset, end)).toString('base64'),
    };
  }
  childClose(readId: string) {
    const lease = this.children.get(readId);
    lease?.abort.abort();
    if (lease) lease.bytes = undefined;
    this.children.delete(readId);
  }
  async childFile(
    changeId: string,
    readId: string,
    offset = 0,
    view: 'diff' | 'snapshot' = 'diff',
  ): Promise<NativeFileChangeDetail> {
    const entry = this.childReceipts.get(changeId);
    if (entry?.kind !== 'file' || this.childFileReads.has(readId) || this.childFileReads.size >= 32)
      throw new ClientError('background_child_file_unavailable');
    const lease = { ...entry.lease, offset: 0, readId, abort: new AbortController() };
    this.childFileReads.set(readId, lease);
    const signal = lease.abort.signal;
    const original = async () => {
      await this.fresh(lease);
      await this.checkChildReceiptView(lease, entry);
      const [message] = await this.client.listMessages(entry.childId, {
        afterSeq: String(decimal(entry.seq) - 1n),
        upperSeq: entry.seq,
        limit: 1,
        signal,
      });
      if (
        !message ||
        message.id !== entry.messageId ||
        message.seq !== entry.seq ||
        message.sessionId !== entry.childId ||
        message.originMessage ||
        !nativeToolMessageEligible(message)
      )
        throw new ClientError('background_child_history_mismatch');
      const execution = await this.client.getExecution(message.sourceIds[0], { signal });
      const fact = nativeToolMessageFact({
        execution,
        message,
        messages: [message],
        sessionId: entry.childId,
      });
      const hash = createHash('sha256').update(JSON.stringify(execution.result)).digest('hex');
      if (
        fact?.status !== 'succeeded' ||
        hash !== entry.hash ||
        execution.resultRevision !== entry.revision ||
        execution.originStoreId !== lease.scope.storeId
      )
        throw new ClientError('background_child_history_mismatch');
      await this.checkChildReceiptView(lease, entry);
      return nativeFileReceiptFacts(execution);
    };
    try {
      const facts = await original();
      return await nativeFileReceiptDetail(this.client, {
        facts,
        changeId,
        offset,
        view,
        storeId: lease.scope.storeId,
        signal,
        verify: async (snapshot) => {
          this.check(lease);
          if (snapshot) await original();
          await this.client.verifyConnection({ signal });
          this.check(lease);
        },
      });
    } finally {
      this.childFileClose(readId);
    }
  }
  async childImageOpen(handle: string, readId: string, index: number) {
    const entry = this.childReceipts.get(handle);
    if (
      entry?.kind !== 'image' ||
      this.childImageReads.has(readId) ||
      this.childImageReads.size >= 4
    )
      throw new ClientError('background_child_image_unavailable');
    const lease = { ...entry.lease, offset: 0, readId, abort: new AbortController() };
    const operation: { lease: Detail; reader?: NativeInputImageReads } = { lease };
    this.childImageReads.set(readId, operation);
    const signal = lease.abort.signal;
    try {
      await this.fresh(lease);
      await this.checkChildReceiptView(lease, entry);
      const [message] = await this.client.listMessages(entry.childId, {
        afterSeq: String(decimal(entry.seq) - 1n),
        upperSeq: entry.seq,
        limit: 1,
        signal,
        ...(this.client.serverInfo?.capabilities.includes('session_state') &&
        this.client.serverInfo.capabilities.includes('message_changes')
          ? { previews: true }
          : {}),
      });
      this.check(lease);
      if (
        !message ||
        message.id !== entry.messageId ||
        message.seq !== entry.seq ||
        message.sessionId !== entry.childId ||
        createHash('sha256').update(JSON.stringify(message)).digest('hex') !== entry.hash
      )
        throw new ClientError('background_child_history_mismatch');
      const scope = {
        generation: lease.scope.generation,
        viewSelection: lease.scope.viewSelection ?? 0,
        historyEpoch: 0,
        storeId: lease.scope.storeId,
        sessionId: entry.childId,
        workspaceId: lease.item.session.workspaceId,
      };
      const reader = new NativeInputImageReads(
        this.client,
        () => (this.valid(lease) ? scope : undefined),
        () => new Map([[message.id, message]]),
      );
      operation.reader = reader;
      const result = await reader.open({
        method: 'input.image.open',
        ...scope,
        messageId: message.id,
        index,
        readId,
      });
      await this.checkChildReceiptView(lease, entry);
      return result;
    } catch (error) {
      this.childImageClose(readId);
      throw error;
    }
  }
  childImageRead(readId: string, offset: number) {
    const entry = this.childImageReads.get(readId);
    if (!entry?.reader) throw new ClientError('background_child_image_unavailable');
    return entry.reader.read(readId, offset);
  }
  childImageClose(readId: string) {
    const entry = this.childImageReads.get(readId);
    entry?.lease.abort.abort();
    entry?.reader?.close(readId);
    this.childImageReads.delete(readId);
  }
  childFileClose(readId: string) {
    this.childFileReads.get(readId)?.abort.abort();
    this.childFileReads.delete(readId);
  }
  private async checkChildReceiptView(lease: Detail, entry: ChildReceipt) {
    const { storeId, session } = await this.client.getView(entry.childId, {
      signal: lease.abort.signal,
    });
    this.check(lease);
    if (
      storeId !== lease.scope.storeId ||
      session.id !== entry.childId ||
      session.deletedAt !== null ||
      session.parentSessionId !== lease.item.session.id ||
      session.rootSessionId !== lease.item.rootSession.id ||
      session.workspaceId !== lease.item.session.workspaceId ||
      session.contextSelectionId !== entry.selection
    )
      throw new ClientError('background_child_binding_changed');
  }
  async childText(handle: string, offset: string) {
    const entry = this.childReceipts.get(handle);
    if (entry?.kind !== 'text' || this.childTextReads.size >= 16)
      throw new ClientError('background_child_text_unavailable');
    const timeout = AbortSignal.timeout(8_000);
    const lease = { ...entry.lease, offset: 0, readId: '', abort: new AbortController() };
    timeout.addEventListener('abort', () => lease.abort.abort(timeout.reason), { once: true });
    const signal = lease.abort.signal;
    this.childTextReads.add(lease.abort);
    try {
      await this.fresh(lease);
      await this.checkChildReceiptView(lease, entry);
      const chunk = await this.client.readMessageText(
        entry.childId,
        entry.messageId,
        {
          storeId: lease.scope.storeId,
          seq: entry.seq,
          sha256: entry.hash,
          offset,
        },
        { signal },
      );
      await this.checkChildReceiptView(lease, entry);
      return { kind: 'messages.text' as const, ...chunk };
    } finally {
      this.childTextReads.delete(lease.abort);
    }
  }
  release() {
    this.observed = undefined;
    this.previousChildObservation = undefined;
    this.knownSessions = undefined;
    if (this.directory) this.close(this.directory.readId);
    for (const id of this.outputs.keys()) this.outputClose(id);
    for (const id of this.children.keys()) this.childClose(id);
    for (const id of this.childFileReads.keys()) this.childFileClose(id);
    for (const id of this.childImageReads.keys()) this.childImageClose(id);
    for (const abort of this.childTextReads) abort.abort();
    this.childReceipts.clear();
  }
}
