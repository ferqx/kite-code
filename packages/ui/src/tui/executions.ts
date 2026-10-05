import type {
  CancelExecutionRequest,
  Command,
  Execution,
  ExecutionOutputPage,
  Message,
  ModelOutputSnapshot,
  SessionView,
} from '@kite-ai/client';

export interface TuiExecutionPort {
  getExecution(id: string, signal: AbortSignal): Promise<Execution>;
  output(
    id: string,
    query: { afterSeq: string; upperSeq?: string; limit: number },
    signal: AbortSignal,
  ): Promise<ExecutionOutputPage>;
  getView(sessionId: string, signal: AbortSignal): Promise<SessionView>;
  messages(
    sessionId: string,
    query: { afterSeq: string; upperSeq: string; limit: number },
    signal: AbortSignal,
  ): Promise<Message[]>;
  modelOutput(
    sessionId: string,
    executionId: string,
    signal: AbortSignal,
  ): Promise<ModelOutputSnapshot>;
  stop(sessionId: string, request: CancelExecutionRequest): Promise<Command>;
  getCommand(commandId: string, signal: AbortSignal): Promise<Command>;
}
export type TuiJobTarget = Readonly<{ storeId: string; sessionId: string; executionId: string }>;
export type TuiJobStop = Readonly<{
  target: TuiJobTarget;
  request: CancelExecutionRequest;
  phase: 'submitting' | 'unknown' | 'applied' | 'rejected';
}>;
export type TuiChildLog = Readonly<{
  target: TuiJobTarget;
  carrier: Execution;
  view: SessionView;
  messages: readonly Message[];
  modelOutputs: ReadonlyMap<string, ModelOutputSnapshot>;
}>;
export function originalJob(target: TuiJobTarget, execution: Execution): Execution {
  if (
    execution.id !== target.executionId ||
    execution.originStoreId !== target.storeId ||
    execution.sessionId !== target.sessionId ||
    execution.kind !== 'job'
  )
    throw Error('tui_job_identity_mismatch');
  return execution;
}
const decimal = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw Error('tui_execution_cursor_invalid');
  return BigInt(value);
};
const carrierKey = (execution: Execution) =>
  JSON.stringify([
    execution.id,
    execution.originStoreId,
    execution.sessionId,
    execution.kind,
    execution.definitionId,
    execution.definitionVersion,
    execution.parentExecutionId,
    execution.childSessionId,
  ]);
export function jobStopReceipt(intent: TuiJobStop, command: Command): TuiJobStop['phase'] {
  const receipt = command.receipt;
  if (
    command.id !== intent.request.commandId ||
    command.kind !== 'execution.cancel' ||
    command.originStoreId !== intent.target.storeId ||
    command.sessionId !== intent.target.sessionId
  )
    return 'unknown';
  if (command.status === 'rejected') return 'rejected';
  if (
    command.status !== 'applied' ||
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.kind !== 'execution.cancel' ||
    receipt.executionId !== intent.target.executionId ||
    receipt.outcome !== 'cancel_requested' ||
    typeof receipt.affectedCount !== 'number' ||
    !Number.isSafeInteger(receipt.affectedCount) ||
    receipt.affectedCount < 0
  )
    return 'unknown';
  return 'applied';
}
/** Freeze one original output high water. Gaps remain explicit facts, never invented text. */
export async function readJobOutput(
  port: TuiExecutionPort,
  target: TuiJobTarget,
  signal: AbortSignal,
): Promise<ExecutionOutputPage> {
  originalJob(target, await port.getExecution(target.executionId, signal));
  let upper: string | undefined,
    after = '0';
  const items: ExecutionOutputPage['items'] = [],
    ordinary = new Set<string>(),
    streams = new Map<string, bigint>();
  for (;;) {
    signal.throwIfAborted();
    const page = await port.output(
      target.executionId,
      { afterSeq: after, ...(upper === undefined ? {} : { upperSeq: upper }), limit: 200 },
      signal,
    );
    signal.throwIfAborted();
    if (upper === undefined) upper = page.highWaterSeq;
    if (decimal(page.highWaterSeq) < decimal(upper)) throw Error('tui_execution_cursor_changed');
    let covered = decimal(after);
    const ordered = [...page.items].sort((a, b) =>
      decimal(a.seq) < decimal(b.seq) ? -1 : decimal(a.seq) > decimal(b.seq) ? 1 : 0,
    );
    for (const item of ordered) {
      const start = decimal(item.seq),
        end = decimal(item.throughSeq),
        dropped = item.droppedBytes === null ? null : decimal(item.droppedBytes);
      const gap = dropped === null || dropped > 0n || end > start;
      if (
        item.executionId !== target.executionId ||
        start <= decimal(after) ||
        start > covered + 1n ||
        end < start ||
        end > decimal(upper) ||
        (gap && (item.content !== '' || dropped === 0n)) ||
        (streams.has(item.stream) && start <= streams.get(item.stream)!)
      )
        throw Error('tui_execution_page_invalid');
      if (!gap) {
        if (ordinary.has(item.seq)) throw Error('tui_execution_page_invalid');
        ordinary.add(item.seq);
      }
      streams.set(item.stream, end);
      items.push(item);
      if (end > covered) covered = end;
    }
    if (!ordered.length && covered !== decimal(upper)) throw Error('tui_execution_page_incomplete');
    if (covered === decimal(upper)) {
      originalJob(target, await port.getExecution(target.executionId, signal));
      signal.throwIfAborted();
      return { items, highWaterSeq: upper };
    }
    if (covered <= decimal(after)) throw Error('tui_execution_cursor_invalid');
    after = String(covered);
  }
}
/** A child ID is a reader target only, justified by the actual carrier and parent chain. */
export async function readChildLog(
  port: TuiExecutionPort,
  target: TuiJobTarget,
  parent: SessionView,
  signal: AbortSignal,
): Promise<TuiChildLog> {
  const carrier = originalJob(target, await port.getExecution(target.executionId, signal));
  if (
    !carrier.childSessionId ||
    !carrier.parentExecutionId ||
    parent.storeId !== target.storeId ||
    parent.session.id !== target.sessionId
  )
    throw Error('tui_child_relation_unavailable');
  const parents: Execution[] = [],
    seen = new Set([carrier.id]);
  let id: string | null = carrier.parentExecutionId;
  while (id) {
    if (seen.has(id)) throw Error('tui_child_parent_cycle');
    seen.add(id);
    const source = await port.getExecution(id, signal);
    if (
      source.id !== id ||
      source.originStoreId !== target.storeId ||
      source.sessionId !== target.sessionId
    )
      throw Error('tui_child_parent_mismatch');
    parents.push(source);
    id = source.parentExecutionId ?? null;
  }
  const childId = carrier.childSessionId,
    view = await port.getView(childId, signal);
  const validView = (fresh: SessionView) =>
    fresh.storeId === target.storeId &&
    fresh.session.id === childId &&
    fresh.session.parentSessionId === target.sessionId &&
    fresh.session.rootSessionId === parent.session.rootSessionId &&
    fresh.session.workspaceId === parent.session.workspaceId;
  if (!validView(view)) throw Error('tui_child_scope_mismatch');
  const upper = view.session.nextSeq,
    messages: Message[] = [],
    messageIds = new Set<string>(),
    modelOutputs = new Map<string, ModelOutputSnapshot>();
  let after = '0';
  for (;;) {
    signal.throwIfAborted();
    const page = await port.messages(
      childId,
      { afterSeq: after, upperSeq: upper, limit: 200 },
      signal,
    );
    signal.throwIfAborted();
    for (const message of page) {
      if (
        message.sessionId !== childId ||
        decimal(message.seq) <= decimal(after) ||
        decimal(message.seq) > decimal(upper) ||
        messageIds.has(message.id)
      )
        throw Error('tui_child_history_mismatch');
      messages.push(message);
      messageIds.add(message.id);
      after = message.seq;
      if (
        message.outputBody &&
        message.outputBody.readAvailability !== 'unsupported' &&
        message.contentFormat !== 'unsupported'
      ) {
        const store = message.originMessage?.storeId ?? target.storeId,
          scope = message.originMessage?.sessionId ?? childId,
          run = message.originMessage ? message.originMessage.runId : message.runId;
        if (store !== target.storeId) throw Error('tui_child_origin_store_unavailable');
        const output = await port.modelOutput(scope, message.outputBody.executionId, signal);
        signal.throwIfAborted();
        if (
          output.storeId !== store ||
          output.sessionId !== scope ||
          output.executionId !== message.outputBody.executionId ||
          output.runId !== run ||
          output.output.complete !== message.outputBody.complete ||
          output.contentBytes !== message.outputBody.contentBytes ||
          output.reasoningBytes !== message.outputBody.reasoningBytes ||
          output.output.toolCalls.length !== message.outputBody.toolCallCount
        )
          throw Error('tui_child_model_output_mismatch');
        modelOutputs.set(message.id, output);
      }
    }
    if (page.length < 200) break;
  }
  const final = await port.getView(childId, signal);
  if (
    !validView(final) ||
    final.session.contextSelectionId !== view.session.contextSelectionId ||
    decimal(final.session.nextSeq) < decimal(upper)
  )
    throw Error('tui_child_scope_changed');
  for (const source of [carrier, ...parents]) {
    const fresh = await port.getExecution(source.id, signal);
    if (carrierKey(source) !== carrierKey(fresh)) throw Error('tui_child_binding_changed');
  }
  signal.throwIfAborted();
  return { target, carrier, view, messages, modelOutputs };
}
