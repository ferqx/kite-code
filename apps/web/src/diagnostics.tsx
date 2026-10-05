import {
  type BrowserView,
  ClientError,
  type ExecutionOutputPage,
  parseCursorSequence,
  type SelectedContextPage,
} from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { ContextPanel } from '@kite-ai/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

export type DiagnosticPort = Pick<
  BrowserClient,
  'serverInfo' | 'getContext' | 'listExecutionOutput'
>;
function fail(): never {
  throw new ClientError('diagnostic_page_conflict');
}
function decimal(value: string) {
  return parseCursorSequence(value);
}

function admittedTarget(
  client: DiagnosticPort,
  view: BrowserView,
  capability: 'context' | 'execution_output',
) {
  const info = client.serverInfo;
  if (info?.dataAvailability !== 'available' || info.storeId !== view.storeId)
    throw new ClientError('browser_identity_mismatch');
  if (!info.capabilities.includes(capability)) throw new ClientError('capability_unavailable');
}

/** Two independent cursors, one immutable selection/high-water; never publish partial pages. */
export async function readContext(
  client: DiagnosticPort,
  view: BrowserView,
  signal: AbortSignal,
): Promise<SelectedContextPage> {
  admittedTarget(client, view, 'context');
  let aggregate: SelectedContextPage | undefined;
  let afterSeq = '0',
    afterSourceId: string | undefined;
  let messagesDone = false,
    sourcesDone = false;
  const messages = new Set<string>(),
    sources = new Set<string>();
  while (!messagesDone || !sourcesDone) {
    signal.throwIfAborted();
    const page = await client.getContext(
      view.session.id,
      {
        contextSelectionId: view.session.contextSelectionId,
        afterSeq,
        ...(afterSourceId === undefined ? {} : { afterSourceId }),
        ...(aggregate ? { upperSeq: aggregate.highWaterSeq } : {}),
        messageLimit: 200,
        sourceLimit: 100,
        byteLimit: 8 * 1024 * 1024,
      },
      { signal },
    );
    signal.throwIfAborted();
    if (
      page.selection.sessionId !== view.session.id ||
      page.selection.id !== view.session.contextSelectionId
    )
      fail();
    decimal(page.highWaterSeq);
    if (
      aggregate &&
      (aggregate.highWaterSeq !== page.highWaterSeq ||
        JSON.stringify(aggregate.selection) !== JSON.stringify(page.selection))
    )
      fail();
    let previousSeq = decimal(afterSeq);
    for (const message of page.messages) {
      const seq = decimal(message.seq);
      if (
        messagesDone ||
        message.sessionId !== view.session.id ||
        seq <= previousSeq ||
        seq > decimal(page.highWaterSeq) ||
        messages.has(message.id)
      )
        fail();
      messages.add(message.id);
      previousSeq = seq;
    }
    let previousId = afterSourceId ?? '';
    for (const source of page.resultSources) {
      if (
        sourcesDone ||
        source.sessionId !== view.session.id ||
        source.originStoreId !== view.storeId ||
        source.id <= previousId ||
        decimal(source.seq) > decimal(page.highWaterSeq) ||
        sources.has(source.id)
      )
        fail();
      sources.add(source.id);
      previousId = source.id;
    }
    if (!aggregate) aggregate = { ...page, messages: [], resultSources: [] };
    aggregate.messages.push(...page.messages);
    aggregate.resultSources.push(...page.resultSources);
    if (!messagesDone) {
      if (page.nextAfterSeq === null) {
        messagesDone = true;
        afterSeq = page.highWaterSeq;
      } else {
        if (
          decimal(page.nextAfterSeq) !== previousSeq ||
          (previousSeq <= decimal(afterSeq) && page.resultSources.length === 0)
        )
          fail();
        afterSeq = page.nextAfterSeq;
      }
    } else if (page.nextAfterSeq !== null) fail();
    if (!sourcesDone) {
      if (page.nextAfterSourceId === null) {
        sourcesDone = true;
        afterSourceId = page.resultSources.at(-1)?.id ?? afterSourceId;
      } else {
        // A byte-bound page may advance only messages, so one unchanged source cursor is valid.
        if (page.nextAfterSourceId !== previousId) fail();
        if (previousId === (afterSourceId ?? '') && page.messages.length === 0) fail();
        afterSourceId = page.nextAfterSourceId || undefined;
      }
    } else if (page.nextAfterSourceId !== null) fail();
  }
  return { ...aggregate!, nextAfterSeq: null, nextAfterSourceId: null };
}

/** Original exact Job only. The first server high-water freezes this read, not future output. */
export async function readOutput(
  client: DiagnosticPort,
  view: BrowserView,
  executionId: string,
  signal: AbortSignal,
): Promise<ExecutionOutputPage> {
  admittedTarget(client, view, 'execution_output');
  if (
    !view.executions.some(
      (item) =>
        item.id === executionId && item.sessionId === view.session.id && item.kind === 'job',
    )
  )
    throw new ClientError('job_not_in_selected_view');
  let upper: string | undefined,
    after = '0';
  const items: ExecutionOutputPage['items'] = [];
  const ordinarySequences = new Set<string>();
  const streamEnds = new Map<string, bigint>();
  while (true) {
    signal.throwIfAborted();
    const page = await client.listExecutionOutput(view.session.id, executionId, {
      afterSeq: after,
      ...(upper === undefined ? {} : { upperSeq: upper }),
      limit: 200,
      signal,
    });
    signal.throwIfAborted();
    if (upper === undefined) upper = page.highWaterSeq;
    if (decimal(page.highWaterSeq) < decimal(upper)) fail();
    const ordered = [...page.items].sort((a, b) =>
      decimal(a.seq) < decimal(b.seq) ? -1 : decimal(a.seq) > decimal(b.seq) ? 1 : 0,
    );
    let coveredThrough = decimal(after);
    for (const item of ordered) {
      const start = decimal(item.seq),
        end = decimal(item.throughSeq);
      if (
        item.executionId !== executionId ||
        start <= decimal(after) ||
        start > coveredThrough + 1n ||
        end < start ||
        end > decimal(upper)
      )
        fail();
      const dropped = item.droppedBytes === null ? null : decimal(item.droppedBytes);
      const gap = dropped === null || dropped > 0n || end > start;
      // Sequence allocation is global, but coalesced gaps are per stream. Their spans may
      // include another stream's retained chunks or overlap another stream's gap.
      if (!gap) {
        if (ordinarySequences.has(item.seq)) fail();
        ordinarySequences.add(item.seq);
      }
      if (gap && (item.content !== '' || dropped === 0n)) fail();
      const streamEnd = streamEnds.get(item.stream);
      if (streamEnd !== undefined && start <= streamEnd) fail();
      streamEnds.set(item.stream, end);
      items.push(item);
      if (end > coveredThrough) coveredThrough = end;
    }
    if (ordered.length === 0 && coveredThrough !== decimal(upper)) fail();
    if (ordered.length === 0 || coveredThrough === decimal(upper))
      return { items, highWaterSeq: upper };
    if (coveredThrough <= decimal(after)) fail();
    after = coveredThrough.toString();
  }
}

type Target = { kind: 'context' } | { kind: 'output'; executionId: string };
type Loaded =
  | { kind: 'context'; value: SelectedContextPage }
  | { kind: 'output'; value: ExecutionOutputPage };
interface PanelState {
  key: string;
  phase: 'loading' | 'ready' | 'stale' | 'error';
  loaded?: Loaded;
  error?: string;
}
export function Diagnostics({
  client,
  view,
  window: browser,
  suspended = false,
}: {
  client: DiagnosticPort;
  view: BrowserView;
  window: Window;
  suspended?: boolean;
}) {
  const [target, setTarget] = useState<Target>();
  const [state, setState] = useState<PanelState>();
  const active = useRef<{ key: string; controller: AbortController } | undefined>(undefined);
  const latestView = useRef(view);
  latestView.current = view;
  const identity = `${view.storeId}:${view.session.id}:${view.session.contextSelectionId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const capabilities = client.serverInfo?.capabilities ?? [];
  const stop = useCallback(() => {
    active.current?.controller.abort();
    active.current = undefined;
  }, []);
  useEffect(() => {
    currentIdentity.current = identity;
    setTarget(undefined);
    setState(undefined);
    const hide = () => {
      if (browser.document.visibilityState === 'hidden' && active.current) {
        stop();
        setState((prior) =>
          prior
            ? { ...prior, phase: prior.loaded ? 'stale' : 'error', error: 'diagnostic_hidden' }
            : prior,
        );
      }
    };
    browser.document.addEventListener('visibilitychange', hide);
    return () => {
      stop();
      browser.document.removeEventListener('visibilitychange', hide);
    };
  }, [identity, browser, stop]);
  useEffect(() => {
    if (suspended && active.current) {
      stop();
      setState((prior) =>
        prior
          ? { ...prior, phase: prior.loaded ? 'stale' : 'error', error: 'diagnostic_paused' }
          : prior,
      );
    }
  }, [suspended, stop]);
  function close() {
    stop();
    setTarget(undefined);
    setState(undefined);
  }
  async function load(next: Target) {
    if (suspended) return;
    const selected = latestView.current;
    const key = `${identity}:${next.kind}:${next.kind === 'output' ? next.executionId : ''}`;
    if (active.current?.key === key) return;
    stop();
    setTarget(next);
    const controller = new AbortController();
    active.current = { key, controller };
    setState((prior) => ({
      key,
      phase: 'loading',
      ...(prior?.key === key && prior.loaded ? { loaded: prior.loaded } : {}),
    }));
    try {
      if (browser.document.visibilityState === 'hidden') throw new ClientError('diagnostic_hidden');
      const loaded: Loaded =
        next.kind === 'context'
          ? { kind: 'context', value: await readContext(client, selected, controller.signal) }
          : {
              kind: 'output',
              value: await readOutput(client, selected, next.executionId, controller.signal),
            };
      if (
        !controller.signal.aborted &&
        active.current?.controller === controller &&
        currentIdentity.current === identity
      )
        setState({ key, phase: 'ready', loaded });
    } catch (error) {
      if (
        !controller.signal.aborted &&
        active.current?.controller === controller &&
        currentIdentity.current === identity
      )
        setState((prior) => ({
          key,
          phase: prior?.key === key && prior.loaded ? 'stale' : 'error',
          ...(prior?.key === key && prior.loaded ? { loaded: prior.loaded } : {}),
          error: error instanceof ClientError ? error.code : 'diagnostic_read_unavailable',
        }));
    } finally {
      if (active.current?.controller === controller) active.current = undefined;
    }
  }
  return (
    <section aria-label="Read-only diagnostics" className="diagnostics">
      <button
        type="button"
        disabled={!capabilities.includes('context')}
        onClick={() => void load({ kind: 'context' })}
      >
        Read current selected context
      </button>
      {!capabilities.includes('context') && <p>Current context capability unavailable.</p>}
      {view.executions
        .filter((item) => item.kind === 'job' && item.sessionId === view.session.id)
        .map((job) => (
          <button
            type="button"
            key={job.id}
            disabled={!capabilities.includes('execution_output')}
            onClick={() => void load({ kind: 'output', executionId: job.id })}
          >
            Read Job output {job.id}
          </button>
        ))}
      {!capabilities.includes('execution_output') && <p>Job output capability unavailable.</p>}
      {target && (
        <div className="diagnostic-panel">
          <h2>
            {target.kind === 'context'
              ? 'Current selected context'
              : `Job output ${target.executionId}`}
          </h2>
          <p>
            {target.kind === 'context'
              ? 'Current selection projection, not any Model actual input inspector.'
              : 'Exact Job output, not the full Runtime event log or a Shell classification.'}
          </p>
          <button type="button" onClick={() => void load(target)}>
            Refresh diagnostic
          </button>
          <button type="button" onClick={close}>
            Close diagnostic
          </button>
          <p role={state?.error ? 'alert' : 'status'}>
            {state?.phase}
            {state?.phase === 'stale' ? ' · Last known same-target snapshot' : ''}
            {state?.error ? ` · ${state.error}` : ''}
          </p>
          {state?.loaded?.kind === 'context' && <ContextPanel context={state.loaded.value} />}
          {state?.loaded?.kind === 'output' && (
            <section aria-label="Job output chunks">
              <p>Frozen output through {state.loaded.value.highWaterSeq}</p>
              {state.loaded.value.items.map((item) => (
                <article key={`${item.stream}:${item.seq}:${item.throughSeq}`}>
                  <p>
                    {item.stream} · {item.seq}–{item.throughSeq}
                  </p>
                  {(item.throughSeq !== item.seq || item.droppedBytes !== '0') && (
                    <p>
                      Output gap:{' '}
                      {item.droppedBytes === null
                        ? 'byte count unavailable / clipped interval'
                        : `${item.droppedBytes} bytes`}
                    </p>
                  )}
                  <pre>{item.content}</pre>
                </article>
              ))}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
