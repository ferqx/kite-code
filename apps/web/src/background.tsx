import {
  type BackgroundExecutionItem,
  type BrowserView,
  ClientError,
  type ExecutionOutputPage,
  ExecutionOutputPages,
} from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Complete public metadata only. No result bodies, guessed labels, or execution callbacks. */
export function BackgroundExecutions({
  client,
  view,
  window: browser,
  suspended,
  onOpen,
  stale = false,
}: {
  client: BrowserClient;
  view: BrowserView;
  window: Window;
  suspended: boolean;
  stale?: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const [items, setItems] = useState<BackgroundExecutionItem[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | undefined>(undefined);
  const rootSessionId =
    view.session.rootSessionId ??
    (view.session.parentSessionId === null ? view.session.id : undefined);
  const enabled =
    client.serverInfo?.capabilities.includes('sessions') &&
    typeof client.listAllBackgroundExecutions === 'function' &&
    rootSessionId !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh starts a new complete metadata observation.
  useEffect(() => {
    const read = new AbortController();
    active.current = read;
    if (!enabled || suspended || browser.document.visibilityState === 'hidden') return;
    setLoading(true);
    setError(undefined);
    const hidden = () => {
      if (browser.document.visibilityState === 'hidden') {
        read.abort();
        setLoading(false);
        setError('background_hidden');
      }
    };
    browser.document.addEventListener('visibilitychange', hidden);
    void client
      .listAllBackgroundExecutions({
        workspaceId: view.session.workspaceId,
        rootSessionId,
        signal: read.signal,
      })
      .then((result) => {
        if (!read.signal.aborted) {
          if (client.serverInfo?.storeId !== view.storeId)
            throw new ClientError('browser_identity_mismatch');
          setItems(result);
        }
      })
      .catch((cause) => {
        if (!read.signal.aborted)
          setError(cause instanceof ClientError ? cause.code : 'background_unavailable');
      })
      .finally(() => {
        if (!read.signal.aborted) setLoading(false);
      });
    return () => {
      read.abort();
      browser.document.removeEventListener('visibilitychange', hidden);
    };
  }, [
    client,
    browser,
    enabled,
    rootSessionId,
    view.storeId,
    view.session.workspaceId,
    suspended,
    revision,
  ]);
  // Identity is owned by the caller's Store/Session key. Pausing never cancels Runtime.
  useEffect(() => {
    if (suspended) {
      active.current?.abort();
      setLoading(false);
      setError('background_paused');
    }
  }, [suspended]);
  return (
    <section aria-label="Background executions">
      <h2>Background executions</h2>
      <button
        type="button"
        disabled={!enabled || loading || suspended}
        onClick={() => setRevision((value) => value + 1)}
      >
        Refresh background executions
      </button>
      {!enabled && <p>Background metadata unavailable.</p>}
      {loading && <p role="status">Reading background executions</p>}
      {error && (
        <p role="alert">
          {items ? 'Stale · Last known background metadata · ' : 'Background unavailable · '}
          {error}
        </p>
      )}
      {items && (stale || suspended) && !error && (
        <p role="status">Stale · Last known background metadata</p>
      )}
      {items && (
        <p>Metadata from the last complete directory read; refresh to check current status.</p>
      )}
      {items?.length === 0 && <p>No background executions</p>}
      {items?.map(({ execution, ...item }) => (
        <article key={execution.id} data-background-id={execution.id}>
          <p>
            {execution.childSessionId
              ? 'Child Agent'
              : execution.definitionId === 'shell.command' && execution.definitionVersion === '1'
                ? 'Shell'
                : 'Job'}{' '}
            · {execution.definitionId} · {execution.status}
          </p>
          <p>
            Execution {execution.id} · Source Session {execution.sessionId} · Origin Store{' '}
            {execution.originStoreId}
          </p>
          <p>
            Directory cursor {item.seq} · Result revision {execution.resultRevision}
          </p>
          <p>Cleanup confirmation unavailable · Output cursor unavailable in directory metadata</p>
          {execution.cancelRequested && (
            <p>Cancellation requested; completion is not confirmed by this request.</p>
          )}
          {item.run && (
            <p>
              Original Run {item.run.id} · {item.run.status}
            </p>
          )}
          {item.childRun && (
            <p>
              Original child Run {item.childRun.id} · {item.childRun.status}
            </p>
          )}
          {item.childSession && (
            <a
              href={`/sessions/${encodeURIComponent(item.childSession.id)}`}
              onClick={(event) => {
                event.preventDefault();
                onOpen(item.childSession!.id);
              }}
            >
              Open child Session {item.childSession.title}
            </a>
          )}
          <BackgroundOutput
            key={`${execution.id}:${execution.resultRevision}`}
            client={client}
            item={{ execution, ...item }}
            window={browser}
            suspended={suspended}
          />
          {execution.delivery && (
            <p>
              Result delivery {execution.delivery}
              {execution.deliveryReason ? ` · ${execution.deliveryReason}` : ''}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}

function BackgroundOutput({
  client,
  item,
  window: browser,
  suspended,
}: {
  client: BrowserClient;
  item: BackgroundExecutionItem;
  window: Window;
  suspended: boolean;
}) {
  const [value, setValue] = useState<ExecutionOutputPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const close = useCallback(() => {
    active.current?.abort();
    active.current = undefined;
    setValue(undefined);
    setError(undefined);
    setLoading(false);
  }, []);
  useEffect(() => {
    const hide = () => {
      if (browser.document.visibilityState === 'hidden') close();
    };
    browser.document.addEventListener('visibilitychange', hide);
    return () => {
      active.current?.abort();
      browser.document.removeEventListener('visibilitychange', hide);
    };
  }, [browser, close]);
  useEffect(() => {
    if (suspended) close();
  }, [suspended, close]);
  async function read() {
    if (active.current || suspended || browser.document.visibilityState === 'hidden') return;
    const controller = new AbortController();
    active.current = controller;
    const storeId = client.serverInfo?.storeId;
    setLoading(true);
    setError(undefined);
    try {
      const pages = new ExecutionOutputPages(item.execution.id),
        items: ExecutionOutputPage['items'] = [];
      while (!pages.complete) {
        controller.signal.throwIfAborted();
        const page = await client.listExecutionOutput(item.session.id, item.execution.id, {
          afterSeq: pages.afterSeq,
          upperSeq: pages.upperSeq,
          limit: 200,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (client.serverInfo?.storeId !== storeId)
          throw new ClientError('browser_identity_mismatch');
        items.push(...pages.accept(page).items);
      }
      setValue({ items, highWaterSeq: pages.upperSeq! });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof ClientError ? cause.code : 'background_output_unavailable');
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        setLoading(false);
      }
    }
  }
  return (
    <div>
      <button
        type="button"
        disabled={
          loading || suspended || !client.serverInfo?.capabilities.includes('execution_output')
        }
        onClick={() => void read()}
      >
        Read background output {item.execution.id}
      </button>
      {(value || loading || error) && (
        <button type="button" onClick={close}>
          Close background output {item.execution.id}
        </button>
      )}
      {loading && <p role="status">Reading original background output</p>}
      {error && (
        <p role="alert">
          {value ? 'Stale · ' : ''}
          {error}
        </p>
      )}
      {value && (
        <section aria-label={`Background output ${item.execution.id}`}>
          <p>Complete saved output through {value.highWaterSeq}; recorded gaps remain gaps.</p>
          {value.items.map((chunk) => (
            <article key={`${chunk.stream}:${chunk.seq}:${chunk.throughSeq}`}>
              <p>
                {chunk.stream} · {chunk.seq}–{chunk.throughSeq}
                {chunk.droppedBytes !== '0'
                  ? ` · Output gap ${chunk.droppedBytes ?? 'unknown'} bytes`
                  : ''}
              </p>
              <pre>{chunk.content}</pre>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
