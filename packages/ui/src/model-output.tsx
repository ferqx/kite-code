import {
  ClientError,
  type Execution,
  type Message,
  type ModelOutputSnapshot,
  type Run,
} from '@kite-ai/client';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SafeMessageMarkdown } from './markdown';

export interface ModelOutputMessageProps {
  readonly message: Message;
  readonly storeId: string;
  readonly suspended?: boolean;
  /** Ordinary messages load their verified body without a separate preview/reader UI. */
  readonly autoRead?: boolean;
  /** Host opt-in to a read-only retry after an automatic body read fails. */
  readonly autoReadRetry?: boolean;
  /** Exact execution/owning Run observation only requests a fresh read; it proves no output. */
  readonly terminalObserved?: boolean;
  /** Paused retained display cannot read or publish current copy content. */
  readonly readActive?: boolean;
  /** Explicit diagnostic host opt-in; ordinary conversation reading excludes raw reasoning. */
  readonly showReasoning?: boolean;
  /** The host reader independently proves the original Model Store after profile restore. */
  readonly canReadRestoredOrigin?: boolean;
  /** Host-proved wire EOF/hash snapshot. Exact message ownership is checked again here. */
  readonly verifiedSnapshot?: ModelOutputSnapshot;
  readonly onRead?: (input: {
    sessionId: string;
    executionId: string;
    signal: AbortSignal;
  }) => Promise<ModelOutputSnapshot>;
  /** Current rendered verified content only; undefined revokes full-body copy eligibility. */
  readonly onContent?: (content: string | undefined) => void;
  /** Explicit reader dismissal, including while reading is temporarily paused. */
  readonly onClose?: () => void;
  /** Host presentation of the same preview or verified body; reading semantics stay here. */
  readonly renderText?: (content: string, verifiedSnapshot?: ModelOutputSnapshot) => ReactNode;
}
const terminalOutput = (status: ModelOutputSnapshot['status'] | undefined) =>
  status !== undefined && !['planned', 'dispatching', 'running'].includes(status);

/** A bounded view may omit the Model; its exact owning Run can still trigger revalidation. */
export function modelOutputTerminalObserved(
  message: Message,
  executions: readonly Pick<Execution, 'id' | 'sessionId' | 'runId' | 'kind' | 'status'>[],
  runs: readonly Pick<Run, 'id' | 'sessionId' | 'status'>[],
) {
  if (!message.outputBody || message.outputBody.complete) return false;
  const sessionId = message.originMessage?.sessionId ?? message.sessionId;
  const runId = message.originMessage ? message.originMessage.runId : message.runId;
  if (runId === null) return false;
  return (
    executions.some(
      (execution) =>
        execution.id === message.outputBody!.executionId &&
        execution.sessionId === sessionId &&
        execution.runId === runId &&
        execution.kind === 'model' &&
        terminalOutput(execution.status),
    ) ||
    runs.some(
      (run) =>
        run.id === runId &&
        run.sessionId === sessionId &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status),
    )
  );
}

function validateSnapshot(
  snapshot: ModelOutputSnapshot,
  message: Message,
  storeId: string,
  canReadRestoredOrigin: boolean,
) {
  const body = message.outputBody;
  const origin = message.originMessage;
  if (
    !body ||
    (origin && (origin.runId === null || (origin.storeId !== storeId && !canReadRestoredOrigin))) ||
    snapshot.storeId !== storeId ||
    snapshot.sessionId !== (origin?.sessionId ?? message.sessionId) ||
    snapshot.executionId !== body.executionId ||
    snapshot.runId !== (origin?.runId ?? message.runId) ||
    (body.complete && snapshot.status !== 'succeeded') ||
    snapshot.output.complete !== body.complete ||
    snapshot.contentBytes !== body.contentBytes ||
    snapshot.reasoningBytes !== body.reasoningBytes ||
    String(new TextEncoder().encode(snapshot.output.content).byteLength) !== body.contentBytes ||
    String(new TextEncoder().encode(snapshot.output.reasoning).byteLength) !==
      body.reasoningBytes ||
    (body.complete
      ? snapshot.output.toolCalls.length !== body.toolCallCount
      : snapshot.output.toolCalls.length !== 0)
  )
    throw new ClientError('model_output_identity_conflict');
}

/** Verified display may survive deactivation; reads and content publication require current admission. */
export function ModelOutputMessage({
  message,
  storeId,
  suspended = false,
  autoRead = false,
  autoReadRetry = false,
  terminalObserved = false,
  readActive = true,
  showReasoning = false,
  canReadRestoredOrigin = false,
  verifiedSnapshot,
  onRead,
  onContent,
  onClose,
  renderText,
}: ModelOutputMessageProps) {
  const body = message.outputBody;
  const identity = useMemo(
    () =>
      JSON.stringify([
        storeId,
        canReadRestoredOrigin,
        message.sessionId,
        message.runId,
        message.id,
        message.originMessage,
        body,
        message.content,
      ]),
    [
      storeId,
      canReadRestoredOrigin,
      message.sessionId,
      message.runId,
      message.id,
      message.originMessage,
      body,
      message.content,
    ],
  );
  const current = useRef(identity);
  current.current = identity;
  const callbacks = useRef({ onRead, onContent, onClose });
  callbacks.current = { onRead, onContent, onClose };
  const request = useRef<AbortController | undefined>(undefined),
    generation = useRef(0);
  const terminalRefresh = useRef<{ identity: string; pending: boolean } | undefined>(undefined);
  const [loaded, setLoaded] = useState<{ identity: string; snapshot: ModelOutputSnapshot }>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState<string>();
  const admittedSnapshot = useMemo(() => {
    if (!verifiedSnapshot || !body || body.readAvailability === 'unsupported') return undefined;
    try {
      validateSnapshot(verifiedSnapshot, message, storeId, canReadRestoredOrigin);
      return verifiedSnapshot;
    } catch {
      return undefined;
    }
  }, [verifiedSnapshot, message, storeId, canReadRestoredOrigin, body]);
  const [dismissed, setDismissed] = useState<{ identity: string; snapshot: ModelOutputSnapshot }>();
  const full = !suspended
    ? admittedSnapshot
      ? dismissed?.identity === identity && dismissed.snapshot === admittedSnapshot
        ? undefined
        : admittedSnapshot
      : loaded?.identity === identity
        ? loaded.snapshot
        : undefined
    : undefined;

  const installed = useRef({ identity, suspended, verifiedSnapshot });
  useEffect(() => {
    current.current = identity;
    if (suspended || !readActive) callbacks.current.onContent?.(undefined);
    generation.current++;
    request.current?.abort();
    request.current = undefined;
    const previous = installed.current;
    installed.current = { identity, suspended, verifiedSnapshot };
    if (
      previous.identity !== identity ||
      previous.suspended !== suspended ||
      previous.verifiedSnapshot !== verifiedSnapshot
    ) {
      setLoaded(undefined);
      setDismissed(undefined);
      setError(undefined);
    }
    setLoading(false);
    return () => {
      generation.current++;
      request.current?.abort();
      request.current = undefined;
      if (terminalRefresh.current?.pending) terminalRefresh.current = undefined;
      callbacks.current.onContent?.(undefined);
    };
  }, [identity, suspended, verifiedSnapshot, readActive]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new message scope must publish its content even if the host reuses the same verified snapshot object.
  useEffect(() => {
    callbacks.current.onContent?.(readActive ? full?.output.content : undefined);
  }, [full, identity, readActive]);
  function close() {
    callbacks.current.onClose?.();
    if (admittedSnapshot) setDismissed({ identity, snapshot: admittedSnapshot });
    callbacks.current.onContent?.(undefined);
    generation.current++;
    request.current?.abort();
    request.current = undefined;
    setLoaded(undefined);
    setLoading(false);
    setError(undefined);
  }
  const read = useCallback(async () => {
    if (
      !body ||
      body.readAvailability === 'unsupported' ||
      (!callbacks.current.onRead && !admittedSnapshot) ||
      suspended ||
      !readActive ||
      request.current
    )
      return;
    if (admittedSnapshot) {
      setDismissed(undefined);
      setLoaded({ identity, snapshot: admittedSnapshot });
      return;
    }
    const origin = message.originMessage;
    if (
      origin &&
      (origin.runId === null || (origin.storeId !== storeId && !canReadRestoredOrigin))
    ) {
      setError('model_output_identity_conflict');
      return;
    }
    const controller = new AbortController(),
      started = identity,
      version = generation.current;
    request.current = controller;
    setLoading(true);
    setError(undefined);
    let accepted = false;
    try {
      const snapshot = await callbacks.current.onRead!({
        sessionId: origin?.sessionId ?? message.sessionId,
        executionId: body.executionId,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (version !== generation.current || current.current !== started) return;
      validateSnapshot(snapshot, message, storeId, canReadRestoredOrigin);
      setLoaded({ identity: started, snapshot });
      accepted = true;
    } catch (cause) {
      if (
        version === generation.current &&
        current.current === started &&
        !controller.signal.aborted
      )
        setError(cause instanceof ClientError ? cause.code : 'model_output_unavailable');
    } finally {
      if (version === generation.current && current.current === started) {
        if (!accepted) {
          controller.abort();
          request.current = undefined;
        }
        setLoading(false);
      }
    }
  }, [
    body,
    admittedSnapshot,
    suspended,
    readActive,
    message,
    storeId,
    canReadRestoredOrigin,
    identity,
  ]);
  const canRead = !!onRead;
  useEffect(() => {
    if (
      autoRead &&
      terminalObserved &&
      body &&
      !body.complete &&
      body.readAvailability !== 'unsupported' &&
      canRead &&
      readActive &&
      !suspended &&
      !admittedSnapshot &&
      !terminalOutput(full?.status) &&
      terminalRefresh.current?.identity !== identity
    ) {
      const refresh = { identity, pending: true };
      terminalRefresh.current = refresh;
      generation.current++;
      request.current?.abort();
      request.current = undefined;
      void read().finally(() => {
        refresh.pending = false;
      });
    } else if (autoRead && !full && !error) void read();
  }, [
    autoRead,
    terminalObserved,
    body,
    canRead,
    readActive,
    suspended,
    admittedSnapshot,
    full,
    identity,
    error,
    read,
  ]);
  const render = (content: string) =>
    renderText ? (
      <div className="message-markdown">{renderText(content, full)}</div>
    ) : (
      <SafeMessageMarkdown content={content} />
    );
  if (!body)
    return (
      <>
        {message.contentFormat === 'unsupported' && <p>暂不支持此内容格式，已保留原始预览</p>}
        {render(message.content)}
      </>
    );
  return (
    <div className="model-output-message" aria-busy={loading || undefined}>
      {!autoRead && (
        <p>
          {full
            ? full.output.complete
              ? '完整回复'
              : '已记录的回复内容（回复未完成）'
            : body.complete
              ? '回复预览'
              : '回复预览（回复未完成）'}
        </p>
      )}
      {autoRead && !body.complete && full && terminalOutput(full.status) && <p>回复未完成</p>}
      {render(full?.output.content ?? message.content)}
      {!autoRead && !full && (
        <button
          type="button"
          disabled={
            (!onRead && !admittedSnapshot) ||
            suspended ||
            loading ||
            body.readAvailability === 'unsupported'
          }
          aria-disabled={!readActive || undefined}
          onClick={() => void read()}
        >
          查看完整回复
        </button>
      )}
      {!autoRead && (full || loading) && (
        <button type="button" onClick={close}>
          收起完整回复
        </button>
      )}
      {!onRead && !full && <p>暂时无法查看完整回复</p>}
      {body.readAvailability === 'unsupported' && <p>暂不支持此内容格式，已保留回复预览</p>}
      {error && (
        <div role="alert">
          <p>{autoRead && !autoReadRetry ? '完整回复读取失败。' : '完整回复读取失败，请重试。'}</p>
          {autoRead && autoReadRetry && (
            <button
              type="button"
              disabled={!onRead || suspended || loading || body.readAvailability === 'unsupported'}
              aria-disabled={!readActive || undefined}
              onClick={() => void read()}
            >
              重新读取
            </button>
          )}
        </div>
      )}
      {showReasoning && full?.output.reasoning && (
        <details>
          <summary>思考记录</summary>
          <pre>{full.output.reasoning}</pre>
        </details>
      )}
      {!autoRead && full?.output.complete && full.output.toolCalls.length > 0 && (
        <details>
          <summary>完整工具调用记录</summary>
          <pre>{JSON.stringify(full.output.toolCalls, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
