import { ClientError, type Message, type ModelOutputSnapshot } from '@kite-ai/client';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { SafeMessageMarkdown } from './markdown';

export interface ModelOutputMessageProps {
  readonly message: Message;
  readonly storeId: string;
  readonly suspended?: boolean;
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
  /** Current rendered full content only; undefined means the original explicitly labeled preview. */
  readonly onContent?: (content: string | undefined) => void;
  /** Host presentation of the same preview or verified body; reading semantics stay here. */
  readonly renderText?: (content: string, verifiedSnapshot?: ModelOutputSnapshot) => ReactNode;
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

/** Only current-view full-body state. The host reader verifies complete wire EOF/hash before resolving. */
export function ModelOutputMessage({
  message,
  storeId,
  suspended = false,
  showReasoning = false,
  canReadRestoredOrigin = false,
  verifiedSnapshot,
  onRead,
  onContent,
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
  const callbacks = useRef({ onRead, onContent });
  callbacks.current = { onRead, onContent };
  const request = useRef<AbortController | undefined>(undefined),
    generation = useRef(0);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: Replacing the host snapshot releases the previous body and any pending reader even when message metadata is unchanged.
  useEffect(() => {
    current.current = identity;
    if (suspended) callbacks.current.onContent?.(undefined);
    generation.current++;
    request.current?.abort();
    request.current = undefined;
    setLoaded(undefined);
    setDismissed(undefined);
    setLoading(false);
    setError(undefined);
    return () => {
      generation.current++;
      request.current?.abort();
      callbacks.current.onContent?.(undefined);
    };
  }, [identity, suspended, verifiedSnapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new message scope must publish its content even if the host reuses the same verified snapshot object.
  useEffect(() => {
    callbacks.current.onContent?.(full?.output.content);
  }, [full, identity]);
  function close() {
    if (admittedSnapshot) setDismissed({ identity, snapshot: admittedSnapshot });
    callbacks.current.onContent?.(undefined);
    generation.current++;
    request.current?.abort();
    request.current = undefined;
    setLoaded(undefined);
    setLoading(false);
    setError(undefined);
  }
  async function read() {
    if (
      !body ||
      body.readAvailability === 'unsupported' ||
      (!callbacks.current.onRead && !admittedSnapshot) ||
      suspended ||
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
  }
  const render = (content: string) =>
    renderText ? (
      <div className="message-markdown">{renderText(content, full)}</div>
    ) : (
      <SafeMessageMarkdown content={content} />
    );
  if (!body)
    return (
      <>
        {message.contentFormat === 'unsupported' && (
          <p>Unsupported content format · original preview preserved</p>
        )}
        {render(message.content)}
      </>
    );
  return (
    <div className="model-output-message">
      <p>
        {full
          ? full.output.complete
            ? 'Complete Model output'
            : 'Complete recorded incomplete prefix'
          : body.complete
            ? 'Model output preview · full body not loaded'
            : 'Incomplete Model output preview · recorded prefix not loaded'}
      </p>
      {render(full?.output.content ?? message.content)}
      {!full && (
        <button
          type="button"
          disabled={
            (!onRead && !admittedSnapshot) ||
            suspended ||
            loading ||
            body.readAvailability === 'unsupported'
          }
          onClick={() => void read()}
        >
          Read complete recorded Model output
        </button>
      )}
      {(full || loading) && (
        <button type="button" onClick={close}>
          Close full Model output
        </button>
      )}
      {!onRead && !full && <p>Full Model output reader unavailable</p>}
      {body.readAvailability === 'unsupported' && (
        <p>Full body unavailable · unsupported original content format</p>
      )}
      {loading && <p role="status">Reading complete verified Model output</p>}
      {error && <p role="alert">Full Model output unavailable · {error}</p>}
      {showReasoning && full?.output.reasoning && (
        <details>
          <summary>Recorded reasoning</summary>
          <pre>{full.output.reasoning}</pre>
        </details>
      )}
      {full?.output.complete && full.output.toolCalls.length > 0 && (
        <details>
          <summary>Original complete Tool calls</summary>
          <pre>{JSON.stringify(full.output.toolCalls, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
