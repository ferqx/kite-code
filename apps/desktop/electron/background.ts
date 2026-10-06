import { createHash } from 'node:crypto';
import {
  type AgentClient,
  type BackgroundExecutionItem,
  ClientError,
  type Command,
} from '@kite-ai/client';
import {
  type NativeBackgroundChild,
  type NativeBackgroundChildChunk,
  type NativeBackgroundChildOpen,
  type NativeBackgroundPage,
  nativeBackgroundPageBytes,
} from '../src/background-bridge';
import type { NativeJobOutputScope } from '../src/job-output-bridge';
import { NativeJobOutputReads } from './job-output-reads';

type Scope = { generation: number; storeId: string; subjectId: string };
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

/** Complete authenticated observations are independent of the selected conversation. */
export class NativeBackground {
  private directory: Directory | undefined;
  private observed:
    | { id: number; scope: Scope; items: Map<string, BackgroundExecutionItem> }
    | undefined;
  private observation = 0;
  private readonly outputs = new Map<string, Detail>();
  private readonly children = new Map<string, Detail>();
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
      const items = await this.client.listAllBackgroundExecutions({ signal: lease.abort.signal });
      this.check(lease);
      if (this.directory !== lease) throw new ClientError('background_observation_changed');
      lease.items = items;
      this.observed = {
        id: lease.observationId,
        scope: { ...lease.scope },
        items: new Map(items.map((item) => [item.execution.id, structuredClone(item)])),
      };
      return this.page(lease);
    } catch (error) {
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
    this.directory.abort.abort();
    this.directory = undefined;
    // A completed directory's observation remains usable until refresh/reset.
  }
  private target(observationId: number, executionId: string): Detail {
    const observed = this.observed,
      scope = this.scope(),
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
      { storeId: lease.scope.storeId, executionId: lease.item.execution.id, limit: 1 },
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
  async childOpen(input: {
    observationId: number;
    executionId: string;
    readId: string;
  }): Promise<NativeBackgroundChildOpen> {
    if (this.children.has(input.readId)) throw new ClientError('background_read_busy');
    const lease = this.target(input.observationId, input.executionId);
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
          parent.originStoreId !== lease.scope.storeId
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
      let afterSeq = '0';
      for (;;) {
        this.check(lease);
        const page = await this.client.listMessages(childId, {
          signal,
          afterSeq,
          upperSeq,
          limit: 200,
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
            const sourceStore = message.originMessage?.storeId ?? lease.scope.storeId,
              sourceSession = message.originMessage?.sessionId ?? childId,
              runId = message.originMessage ? message.originMessage.runId : message.runId;
            if (sourceStore !== lease.scope.storeId)
              throw new ClientError('background_child_binding_changed');
            const snapshot = await this.client.getModelOutput(
              sourceSession,
              message.outputBody.executionId,
              { expectedStoreId: sourceStore, signal },
            );
            this.check(lease);
            if (
              snapshot.storeId !== sourceStore ||
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
      const body: NativeBackgroundChild = {
        item,
        session: view.session,
        upperSeq,
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
  release() {
    this.observed = undefined;
    if (this.directory) this.close(this.directory.readId);
    for (const id of this.outputs.keys()) this.outputClose(id);
    for (const id of this.children.keys()) this.childClose(id);
  }
}
