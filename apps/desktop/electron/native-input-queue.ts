import { randomUUID } from 'node:crypto';
import {
  type AgentClient,
  ClientError,
  type Command,
  type PendingInputQueue,
  type SteerCommandRequest,
} from '@kite-ai/client';
import type {
  NativeInputQueueObservation,
  NativeInputQueueRequest,
  NativeInputQueueScope,
  NativeInputQueueSubmission,
} from '../src/input-queue-bridge';
import { callerDigest } from './caller-journal';
import {
  type NativeQueueData,
  type NativeQueueRecord,
  parseNativeQueueRecord,
} from './native-input-queue-journal';

type Scope = NativeInputQueueScope & { subjectId: string };
const pending = (row: NativeQueueRecord) => ['submitting', 'unknown'].includes(row.phase);
const sameIdentity = (a: NativeQueueRecord['scope'], b: NativeQueueRecord['scope']) =>
  a.storeId === b.storeId && a.sessionId === b.sessionId && a.workspaceId === b.workspaceId;
const unavailable = () => new ClientError('input_queue_observation_unavailable');

/** Main retains exact queue bodies. Renderer IDs only select an already observed item. */
export class NativeInputQueue {
  private sequence = 0;
  private epoch = 0;
  private observed?: {
    scope: Scope;
    facts: NativeInputQueueObservation;
    inputs: Map<string, PendingInputQueue['commands'][number]['request']>;
  };
  private reading?: { readId: string; abort: AbortController };
  private mutation = false;
  private readonly inflight = new Map<string, Promise<NativeInputQueueSubmission>>();
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly data: () => NativeQueueData;
  private readonly notify: () => void;
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    data: () => NativeQueueData,
    notify: () => void,
  ) {
    this.client = client;
    this.current = current;
    this.data = data;
    this.notify = notify;
  }
  release() {
    this.epoch++;
    this.observed = undefined;
    this.reading?.abort.abort();
    this.reading = undefined;
  }
  closeRead(readId: string) {
    if (this.reading?.readId === readId || this.observed?.facts.readId === readId) this.release();
  }
  async close() {
    this.release();
    await Promise.allSettled(this.inflight.values());
  }
  private scope() {
    const scope = this.current();
    if (
      !scope ||
      !this.client.serverInfo?.capabilities.includes('pending_input_queue') ||
      scope.storeId !== this.client.serverInfo.storeId ||
      scope.subjectId !== this.client.serverInfo.subjectId
    )
      throw unavailable();
    return { ...scope };
  }
  private same(scope: Scope) {
    const now = this.current();
    return (
      !!now &&
      this.client.serverInfo?.storeId === scope.storeId &&
      this.client.serverInfo.subjectId === scope.subjectId &&
      this.client.serverInfo.capabilities.includes('pending_input_queue') &&
      Object.entries(scope).every(([k, v]) => now[k as keyof Scope] === v)
    );
  }
  private records(scope: Scope) {
    return this.data()
      .inputQueueRecords()
      .filter((row) => sameIdentity(row.scope, scope) && row.subjectId === scope.subjectId);
  }
  private metadata(row: NativeQueueRecord, includeText = false): NativeInputQueueSubmission {
    return {
      kind: 'input.queue.submission',
      scope: row.scope,
      commandId: row.request.commandId,
      operation: row.operation,
      ...(row.request.kind === 'input.withdraw'
        ? { targetCommandId: row.request.targetCommandId }
        : {}),
      phase: row.phase === 'submitting' ? 'unknown' : row.phase,
      ...(includeText && row.phase === 'applied' && row.operation === 'edit' && !row.delivered
        ? { text: row.text! }
        : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }
  private async root(scope: Scope) {
    const view = await this.client.getView(scope.sessionId);
    if (
      !this.same(scope) ||
      view.storeId !== scope.storeId ||
      view.session.id !== scope.sessionId ||
      view.session.workspaceId !== scope.workspaceId ||
      view.session.parentSessionId !== null ||
      view.session.deletedAt !== null
    )
      throw unavailable();
    return view;
  }
  async read(
    request: Extract<NativeInputQueueRequest, { method: 'input.queue.read' }>,
  ): Promise<NativeInputQueueObservation> {
    this.release();
    const scope = this.scope(),
      epoch = this.epoch;
    if (
      request.generation !== scope.generation ||
      request.viewSelection !== scope.viewSelection ||
      request.historyEpoch !== scope.historyEpoch
    )
      throw unavailable();
    const abort = new AbortController();
    this.reading = { readId: request.readId, abort };
    try {
      const view = await this.root(scope);
      const active = view.runs.find((run) => run.isActive);
      const activeCommand = active
        ? await this.client.getCommand(active.originCommandId)
        : undefined;
      const items: NativeInputQueueObservation['entries'] = [],
        seen = new Set<string>();
      const inputs = new Map<string, PendingInputQueue['commands'][number]['request']>();
      let revision: string | undefined,
        afterOrder: string | undefined,
        bytes = 0,
        count = 0;
      do {
        const page: PendingInputQueue = await this.client.getPendingInputQueue(
          scope.sessionId,
          {
            storeId: scope.storeId,
            limit: 200,
            ...(afterOrder ? { afterOrder } : {}),
            ...(revision ? { expectedRevision: revision } : {}),
          },
          { signal: abort.signal },
        );
        if (
          !this.same(scope) ||
          epoch !== this.epoch ||
          abort.signal.aborted ||
          (revision !== undefined && page.revision !== revision)
        )
          throw unavailable();
        revision = page.revision;
        if (!/^[a-f0-9]{64}$/.test(revision) || page.commands.length !== page.orders.length)
          throw new ClientError('input_queue_response_invalid');
        for (const command of page.commands) {
          if (
            ++count > 4096 ||
            seen.has(command.id) ||
            command.originStoreId !== scope.storeId ||
            command.sessionId !== scope.sessionId ||
            command.status !== 'accepted' ||
            command.kind !== command.request.kind
          )
            throw new ClientError('input_queue_response_invalid');
          seen.add(command.id);
          if (command.request.kind === 'result.include') continue;
          const input = command.request;
          inputs.set(command.id, structuredClone(input));
          bytes += Buffer.byteLength(input.content);
          if (bytes > 3 * 1048576) throw new ClientError('input_queue_too_large');
          const editable =
            !!input.content.trim() &&
            Buffer.byteLength(input.content) <= 1048576 &&
            !input.images?.length &&
            !input.files?.length &&
            !(
              input.kind === 'input.follow_up' &&
              (input.extensionInputs?.length || input.selectedSkills?.length)
            );
          items.push({
            id: command.id,
            text: input.content.trim()
              ? input.content
              : input.images?.length || input.files?.length
                ? '包含附件的消息'
                : '空白消息',
            editable,
            steerable:
              input.kind === 'input.follow_up' &&
              !!active &&
              input.afterRunId === active.id &&
              input.contextSelectionId === view.session.contextSelectionId &&
              !['context.compress', 'context.compression.reset'].includes(
                activeCommand?.kind ?? '',
              ) &&
              !input.extensionInputs?.length &&
              !input.selectedSkills?.length,
          });
        }
        if (
          page.nextAfterOrder !== null &&
          (!page.orders.length ||
            page.nextAfterOrder !== page.orders.at(-1) ||
            (afterOrder !== undefined && BigInt(page.nextAfterOrder) <= BigInt(afterOrder)))
        )
          throw new ClientError('input_queue_response_invalid');
        afterOrder = page.nextAfterOrder ?? undefined;
      } while (afterOrder !== undefined);
      const facts: NativeInputQueueObservation = {
        kind: 'input.queue.observation',
        scope: {
          generation: scope.generation,
          viewSelection: scope.viewSelection,
          historyEpoch: scope.historyEpoch,
          storeId: scope.storeId,
          sessionId: scope.sessionId,
          workspaceId: scope.workspaceId,
        },
        readId: request.readId,
        observationId: ++this.sequence,
        revision: revision!,
        entries: items,
        submissions: this.records(scope)
          .filter(
            (row) =>
              pending(row) ||
              (row.phase === 'applied' && row.operation === 'edit' && !row.delivered),
          )
          .map((row) => this.metadata(row)),
      };
      if (!this.same(scope) || epoch !== this.epoch) throw unavailable();
      this.observed = { scope, facts: structuredClone(facts), inputs };
      return facts;
    } finally {
      if (this.reading?.abort === abort) this.reading = undefined;
    }
  }
  private observation(observationId: number) {
    const observed = this.observed;
    if (
      !observed ||
      observed.facts.observationId !== observationId ||
      !this.same(observed.scope) ||
      this.mutation ||
      this.records(observed.scope).some(pending)
    )
      throw unavailable();
    return observed;
  }
  async prepareSteer(
    request: Extract<NativeInputQueueRequest, { method: 'input.queue.steer' }>,
  ): Promise<{ sessionId: string; intent: SteerCommandRequest }> {
    const { scope, facts, inputs } = this.observation(request.observationId);
    if (
      request.generation !== scope.generation ||
      !facts.entries.some((item) => item.id === request.targetCommandId && item.steerable)
    )
      throw unavailable();
    const view = await this.root(scope);
    const run = view.runs.find((item) => item.isActive);
    const command = await this.client.getCommand(request.targetCommandId);
    const input = inputs.get(request.targetCommandId);
    if (
      !this.same(scope) ||
      !run ||
      command.originStoreId !== scope.storeId ||
      command.sessionId !== scope.sessionId ||
      command.subjectId !== scope.subjectId ||
      command.status !== 'accepted' ||
      command.kind !== 'input.follow_up' ||
      input?.kind !== 'input.follow_up' ||
      input.afterRunId !== run.id ||
      input.contextSelectionId !== view.session.contextSelectionId ||
      input.extensionInputs?.length ||
      input.selectedSkills?.length
    )
      throw new ClientError('input_queue_target_unavailable');
    const origin = await this.client.getCommand(run.originCommandId);
    if (
      !this.same(scope) ||
      ['context.compress', 'context.compression.reset'].includes(origin.kind)
    )
      throw unavailable();
    this.observed = undefined;
    return {
      sessionId: scope.sessionId,
      intent: {
        expectedStoreId: scope.storeId,
        commandId: randomUUID(),
        kind: 'input.steer',
        queuedInputCommandId: command.id,
        content: input.content,
        ...(input.images?.length ? { images: input.images } : {}),
        ...(input.files?.length ? { files: input.files } : {}),
        targetRunId: run.id,
        contextSelectionId: input.contextSelectionId,
      },
    };
  }
  async mutate(
    request: Extract<
      NativeInputQueueRequest,
      { method: 'input.queue.withdraw' | 'input.queue.reorder' }
    >,
  ) {
    const observed = this.observation(request.observationId),
      { scope, facts } = observed;
    if (request.generation !== scope.generation) throw unavailable();
    this.mutation = true;
    this.observed = undefined;
    try {
      const target =
        request.method === 'input.queue.withdraw'
          ? facts.entries.find((item) => item.id === request.targetCommandId)
          : undefined;
      if (
        request.method === 'input.queue.withdraw' &&
        (!target || (request.purpose === 'edit' && !target.editable))
      )
        throw new ClientError('input_queue_target_unavailable');
      if (
        request.method === 'input.queue.reorder' &&
        (request.commandIds.length !== facts.entries.length ||
          new Set(request.commandIds).size !== request.commandIds.length ||
          request.commandIds.some((id) => !facts.entries.some((item) => item.id === id)))
      )
        throw new ClientError('input_queue_target_unavailable');
      await this.root(scope);
      const base = {
        expectedStoreId: scope.storeId,
        commandId: randomUUID(),
        expectedRevision: facts.revision,
      };
      const input =
        request.method === 'input.queue.withdraw'
          ? { kind: 'input.withdraw' as const, ...base, targetCommandId: request.targetCommandId }
          : { kind: 'input.reorder' as const, ...base, commandIds: [...request.commandIds] };
      const { expectedStoreId: _store, commandId: _command, ...body } = input;
      const row = parseNativeQueueRecord({
        scope: {
          storeId: scope.storeId,
          sessionId: scope.sessionId,
          workspaceId: scope.workspaceId,
        },
        subjectId: scope.subjectId,
        request: input,
        requestDigest: callerDigest(body),
        operation: request.method === 'input.queue.withdraw' ? request.purpose : 'reorder',
        phase: 'submitting',
        ...(request.method === 'input.queue.withdraw' && request.purpose === 'edit'
          ? { text: target!.text, delivered: false }
          : {}),
      });
      this.data().saveInputQueueRecord(row);
      const promise = this.dispatch(row, scope);
      this.inflight.set(input.commandId, promise);
      try {
        return await promise;
      } finally {
        this.inflight.delete(input.commandId);
      }
    } finally {
      this.mutation = false;
      this.notify();
    }
  }
  private async checked(row: NativeQueueRecord, command: Command, scope: Scope) {
    const receipt = command.receipt;
    if (
      command.id !== row.request.commandId ||
      command.kind !== row.request.kind ||
      command.originStoreId !== row.scope.storeId ||
      command.sessionId !== row.scope.sessionId ||
      command.subjectId !== row.subjectId ||
      command.requestDigest !== row.requestDigest
    )
      throw new ClientError('input_queue_receipt_unavailable');
    let phase: NativeQueueRecord['phase'] = 'unknown';
    if (command.status === 'rejected') phase = 'rejected';
    else if (command.status === 'applied') {
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        Array.isArray(receipt) ||
        (row.request.kind === 'input.withdraw'
          ? receipt.outcome !== 'input_withdrawn' ||
            receipt.targetCommandId !== row.request.targetCommandId
          : receipt.outcome !== 'inputs_reordered')
      )
        throw new ClientError('input_queue_receipt_unavailable');
      phase = 'applied';
    }
    const next = { ...row, phase };
    this.data().saveInputQueueRecord(next);
    // Persist the known result even if the user navigated; return no body to a replacement view.
    if (!this.same(scope)) throw unavailable();
    await this.root(scope);
    return this.metadata(next, true);
  }
  private async dispatch(row: NativeQueueRecord, scope: Scope) {
    try {
      const input = row.request;
      const command =
        input.kind === 'input.withdraw'
          ? await this.client.withdrawPendingInput(row.scope.sessionId, input)
          : await this.client.reorderPendingInputs(row.scope.sessionId, input);
      return await this.checked(row, command, scope);
    } catch (error) {
      const known =
        error instanceof ClientError &&
        [
          'input_already_consumed',
          'input_queue_changed',
          'input_not_found',
          'input_not_editable',
          'input_queue_members_changed',
        ].includes(error.code);
      const saved = this.data()
        .inputQueueRecords()
        .find((r) => r.request.commandId === row.request.commandId)!;
      const next = ['applied', 'rejected'].includes(saved.phase)
        ? saved
        : {
            ...saved,
            phase: known ? ('rejected' as const) : ('unknown' as const),
            ...(known ? { error: error.code } : {}),
          };
      this.data().saveInputQueueRecord(next);
      if (!this.same(scope)) throw unavailable();
      return this.metadata(next);
    }
  }
  async lookup(commandId: string): Promise<NativeInputQueueSubmission> {
    const scope = this.scope();
    const row = this.records(scope).find((r) => r.request.commandId === commandId);
    if (!row) throw new ClientError('input_queue_intent_missing');
    const inflight = this.inflight.get(commandId);
    if (inflight) return inflight;
    try {
      return await this.checked(row, await this.client.getCommand(commandId), scope);
    } catch {
      if (!this.same(scope)) throw unavailable();
      return this.metadata(row.phase === 'submitting' ? { ...row, phase: 'unknown' } : row);
    }
  }
  ack(commandId: string) {
    const scope = this.scope(),
      row = this.records(scope).find((r) => r.request.commandId === commandId);
    if (row?.operation !== 'edit' || row.phase !== 'applied')
      throw new ClientError('input_queue_ack_unconfirmed');
    this.data().saveInputQueueRecord({ ...row, delivered: true });
    this.notify();
  }
}
