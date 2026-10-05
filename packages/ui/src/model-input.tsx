import {
  ClientError,
  type ModelInputPage,
  type ModelInputSnapshot,
  parseCursorSequence,
  type ServerInfo,
} from '@kite-ai/client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type { ModelInputSnapshot } from '@kite-ai/client';
export type ModelInputIdentity = Pick<
  ModelInputPage['items'][number],
  'executionId' | 'runId' | 'attempt' | 'status' | 'confirmation'
>;
export type ModelInputDirectory = ModelInputPage;
export interface ModelInputPort {
  readonly serverInfo?: {
    readonly storeId?: string | null;
    readonly capabilities: readonly string[];
    readonly dataAvailability: ServerInfo['dataAvailability'];
    readonly instanceId?: string;
    readonly buildId?: string;
    readonly pageIdentity?: string;
  };
  listModelInputs?(
    sessionId: string,
    options: { afterSeq?: string; upperSeq?: string; limit?: number; signal?: AbortSignal },
  ): Promise<ModelInputPage>;
  getModelInput?(
    sessionId: string,
    executionId: string,
    options: { signal?: AbortSignal },
  ): Promise<ModelInputSnapshot>;
}
function conflict(): never {
  throw new ClientError('model_input_identity_conflict');
}
export async function readModelDirectory(
  client: ModelInputPort,
  sessionId: string,
  storeId: string,
  signal: AbortSignal,
): Promise<readonly ModelInputIdentity[]> {
  if (
    !client.listModelInputs ||
    client.serverInfo?.dataAvailability !== 'available' ||
    client.serverInfo.storeId !== storeId
  )
    conflict();
  let afterSeq = '0';
  let upperSeq: string | undefined;
  let rootSessionId: string | undefined;
  const items: ModelInputIdentity[] = [],
    ids = new Set<string>();
  while (true) {
    signal.throwIfAborted();
    const page = await client.listModelInputs(sessionId, {
      afterSeq,
      ...(upperSeq === undefined ? {} : { upperSeq }),
      limit: 200,
      signal,
    });
    signal.throwIfAborted();
    if (
      client.serverInfo?.storeId !== storeId ||
      page.storeId !== storeId ||
      page.sessionId !== sessionId
    )
      conflict();
    if (rootSessionId !== undefined && rootSessionId !== page.rootSessionId) conflict();
    rootSessionId = page.rootSessionId;
    const high = parseCursorSequence(page.highWaterSeq);
    if (upperSeq !== undefined && upperSeq !== page.upperSeq) conflict();
    upperSeq = page.upperSeq;
    if (parseCursorSequence(upperSeq) > high) conflict();
    let last = parseCursorSequence(afterSeq);
    for (const item of page.items) {
      const seq = parseCursorSequence(item.seq);
      if (
        item.sessionId !== sessionId ||
        seq <= last ||
        seq > parseCursorSequence(upperSeq) ||
        ids.has(item.executionId)
      )
        conflict();
      last = seq;
      ids.add(item.executionId);
      items.push(item);
    }
    if (page.nextAfterSeq === null) return items;
    if (!page.items.length || parseCursorSequence(page.nextAfterSeq) !== last) conflict();
    afterSeq = page.nextAfterSeq;
  }
}
function errorCode(error: unknown) {
  return error instanceof ClientError ? error.code : 'model_input_unavailable';
}

/** Sensitive immutable original request; never a current Context reconstruction. */
export function ModelInputs({
  client,
  sessionId,
  storeId,
  window: browser,
  suspended = false,
  initialExecutionId,
}: {
  client: ModelInputPort;
  sessionId: string;
  storeId: string;
  window: Window;
  suspended?: boolean;
  initialExecutionId?: string;
}) {
  const [open, setOpen] = useState(false),
    [calls, setCalls] = useState<readonly ModelInputIdentity[]>();
  const [target, setTarget] = useState<string>(),
    [snapshot, setSnapshot] = useState<ModelInputSnapshot>();
  const [error, setError] = useState<string>(),
    [loading, setLoading] = useState(false);
  const request = useRef<AbortController | undefined>(undefined),
    generation = useRef(0);
  const enabled =
    !!client.listModelInputs &&
    !!client.getModelInput &&
    client.serverInfo?.storeId === storeId &&
    client.serverInfo.capabilities.includes('model_inputs');
  const stop = useCallback(() => {
    generation.current++;
    request.current?.abort();
    request.current = undefined;
    setSnapshot(undefined);
    setLoading(false);
  }, []);
  useEffect(() => {
    const hide = () => {
      if (browser.document.visibilityState === 'hidden') stop();
    };
    browser.document.addEventListener('visibilitychange', hide);
    return () => {
      generation.current++;
      request.current?.abort();
      browser.document.removeEventListener('visibilitychange', hide);
    };
  }, [browser, stop]);
  useEffect(() => {
    if (suspended) stop();
  }, [suspended, stop]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed original read scope must clear sensitive body even when this component stays mounted.
  useEffect(() => {
    stop();
    setCalls(undefined);
    setError(undefined);
    setOpen(initialExecutionId !== undefined);
    setTarget(initialExecutionId);
  }, [client, storeId, sessionId, initialExecutionId, stop]);
  async function directory() {
    stop();
    setOpen(true);
    setTarget(undefined);
    setCalls(undefined);
    setError(undefined);
    if (!enabled || suspended || browser.document.visibilityState === 'hidden') return;
    const controller = new AbortController();
    request.current = controller;
    const current = generation.current;
    setLoading(true);
    try {
      const result = await readModelDirectory(client, sessionId, storeId, controller.signal);
      if (current === generation.current && !controller.signal.aborted) setCalls(result);
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) setError(errorCode(cause));
    } finally {
      if (current === generation.current) {
        setLoading(false);
        request.current = undefined;
      }
    }
  }
  async function confirm() {
    if (
      !target ||
      !enabled ||
      suspended ||
      browser.document.visibilityState === 'hidden' ||
      request.current
    )
      return;
    const id = target,
      current = generation.current,
      controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(undefined);
    setSnapshot(undefined);
    try {
      const value = await client.getModelInput!(sessionId, id, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (
        value.storeId !== storeId ||
        value.sessionId !== sessionId ||
        value.executionId !== id ||
        value.request.requestId !== id ||
        client.serverInfo?.storeId !== storeId
      )
        conflict();
      parseCursorSequence(value.bodyBytes);
      if (current === generation.current) setSnapshot(value);
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) setError(errorCode(cause));
    } finally {
      if (current === generation.current) {
        setLoading(false);
        request.current = undefined;
      }
    }
  }
  return (
    <section className="model-inputs" aria-label="Model calls">
      <button type="button" disabled={!enabled || suspended} onClick={() => void directory()}>
        Model calls
      </button>
      {!enabled && <p>Original Model input capability unavailable</p>}
      {open && (
        <div className="model-input-panel">
          <h2>Original Model input</h2>
          <p>Sensitive local diagnostic. Current selected context is a separate projection.</p>
          <button
            type="button"
            onClick={() => {
              stop();
              setOpen(false);
              setCalls(undefined);
              setTarget(undefined);
            }}
          >
            Close Model inspector
          </button>
          {loading && <p role="status">Reading complete original snapshot</p>}
          {error && <p role="alert">Original input unavailable · {error}</p>}
          {calls?.map((call) => (
            <button
              type="button"
              key={call.executionId}
              onClick={() => {
                stop();
                setError(undefined);
                setTarget(call.executionId);
              }}
            >
              {call.executionId} · attempt {call.attempt} · {call.status} · {call.confirmation}
            </button>
          ))}
          {calls?.length === 0 && <p>No recorded Model calls</p>}
          {target && !snapshot && (
            <div>
              <p>
                Read the complete sensitive input of {target}? Content can include project text. No
                execution or permission is granted.
              </p>
              <button type="button" disabled={loading || suspended} onClick={() => void confirm()}>
                Confirm read original input
              </button>
            </div>
          )}
          {snapshot && (
            <>
              <h3>Overview</h3>
              {snapshot.confirmation === 'unconfirmed' && (
                <p>
                  Persisted prepared input; successful Model completion is unconfirmed. This does
                  not prove the Provider received the request.
                </p>
              )}
              <p>
                Original Store {snapshot.storeId} · Session {snapshot.sessionId} · root{' '}
                {snapshot.rootSessionId}
              </p>
              <p>
                Origin command {snapshot.originCommandId} · root work {snapshot.rootWorkCommandId} /{' '}
                {snapshot.rootWorkSeq}
              </p>
              <p>
                {snapshot.executionId} · attempt {snapshot.attempt} · {snapshot.status} ·{' '}
                {snapshot.confirmation}
              </p>
              <p>
                Model {snapshot.request.modelId} · original request {snapshot.request.requestId}
              </p>
              <p>
                Run {snapshot.runId ?? 'unavailable'} · input bytes {snapshot.bodyBytes}
              </p>
              <h3>System prompt</h3>
              {snapshot.request.messages
                .filter((m) => m.role === 'system')
                .map((m, i) => (
                  <pre key={i}>{m.content}</pre>
                ))}
              <h3>Messages · original order</h3>
              {snapshot.request.messages.map((m, i) => (
                <article key={i}>
                  <p>
                    {i + 1} · {m.role} {m.toolCallId ?? ''}
                  </p>
                  <pre>{m.content}</pre>
                  {m.toolCalls && <pre>{JSON.stringify(m.toolCalls, null, 2)}</pre>}
                  {m.sourceIds && <p>Sources: {m.sourceIds.join(', ')}</p>}
                </article>
              ))}
              <h3>Tools · original order</h3>
              {snapshot.request.tools.map((tool, i) => (
                <article key={i}>
                  <p>
                    {tool.id} · {tool.definitionVersion}
                  </p>
                  <pre>{tool.description ?? ''}</pre>
                  <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </article>
              ))}
              <h3>Frozen adapter and request settings</h3>
              {snapshot.metadata.adapter.availability === 'available' ? (
                <>
                  <p>
                    Adapter {snapshot.metadata.adapter.adapterId} /{' '}
                    {snapshot.metadata.adapter.adapterVersion}
                  </p>
                  <p>
                    Provider{' '}
                    {snapshot.metadata.adapter.provider.availability === 'available'
                      ? `${snapshot.metadata.adapter.provider.family} / ${snapshot.metadata.adapter.provider.modelId}`
                      : `unavailable · ${snapshot.metadata.adapter.provider.reason}`}
                  </p>
                  <pre>{JSON.stringify(snapshot.metadata.adapter.settings, null, 2)}</pre>
                  <p>
                    Adapter transformation {snapshot.metadata.adapter.transformation.id} /{' '}
                    {snapshot.metadata.adapter.transformation.version}
                  </p>
                </>
              ) : (
                <p>Adapter and request settings unavailable · {snapshot.metadata.adapter.reason}</p>
              )}
              <h3>Frozen assembly and source identities</h3>
              {snapshot.metadata.assembly === null ? (
                <p>Assembly unavailable</p>
              ) : (
                <pre>{JSON.stringify(snapshot.metadata.assembly, null, 2)}</pre>
              )}
              {snapshot.metadata.context === null ? (
                <p>Context transformation and sources unavailable</p>
              ) : (
                <pre>{JSON.stringify(snapshot.metadata.context, null, 2)}</pre>
              )}
              <h3>Final dispatch authorization</h3>
              {snapshot.metadata.authorization.availability === 'available' ? (
                <>
                  <pre>{JSON.stringify(snapshot.metadata.authorization, null, 2)}</pre>
                  {snapshot.metadata.authorization.policy === null && (
                    <p>
                      Policy explanation unavailable; final authorization facts remain recorded.
                    </p>
                  )}
                </>
              ) : (
                <p>Dispatch authorization unavailable · {snapshot.metadata.authorization.reason}</p>
              )}
              <p>
                These facts belong to this original execution. Current configuration is not
                substituted. Private transport endpoint, credentials and headers are unavailable.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
