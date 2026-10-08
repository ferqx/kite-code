import type { BackgroundExecutionItem } from '@kite-ai/client';
import { type BackgroundExecutionSummary, BackgroundExecutions } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type { NativeBackgroundChild } from './background-bridge';
import { readNativeBackground, readNativeBackgroundChild } from './native-background';
import type { NativeBridge, NativeCallerMetadata, NativeSelection } from './native-bridge';

type Display = {
  rows: BackgroundExecutionSummary[];
  children: Map<string, string>;
};
type Facts = Awaited<ReturnType<typeof readNativeBackground>>;
type Child = {
  scope: string;
  sessionId: string;
  loading: boolean;
  facts?: NativeBackgroundChild;
  error?: string;
};
const safeError = (cause: unknown) => {
  const code = (cause as { code?: string; message?: string })?.code ?? (cause as Error)?.message;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(code)
    ? code
    : 'environment_unavailable';
};

/** Only public metadata is adapted; lifecycle does not prove process cleanup. */
export function environmentDisplay(
  items: readonly BackgroundExecutionItem[],
  storeId: string,
): Display {
  const rows: BackgroundExecutionSummary[] = [],
    children = new Map<string, string>();
  for (const item of items) {
    const e = item.execution;
    if (!e.childSessionId && e.definitionId !== 'shell.command') continue;
    const restored = e.originStoreId !== storeId;
    const status: BackgroundExecutionSummary['status'] = restored
      ? 'restored'
      : e.status === 'running' && e.cancelRequested
        ? 'stopping'
        : e.status === 'succeeded'
          ? 'completed'
          : e.status === 'planned'
            ? 'queued'
            : e.status === 'dispatching'
              ? 'starting'
              : e.status === 'outcome_unknown'
                ? 'unknown'
                : e.status;
    rows.push({
      executionId: e.id,
      ...(item.childSession?.title ? { displayName: item.childSession.title } : {}),
      kind: e.childSessionId ? 'subagent' : 'shell',
      status,
      cleanupConfirmed: false,
      canStop:
        !restored && e.status === 'running' && !e.cancelRequested && e.cancelRequestedAt === null,
    });
    if (e.childSessionId && item.childSession) children.set(e.id, e.childSessionId);
  }
  return { rows, children };
}

/** Retained environment card and child navigation share the existing bounded background readers. */
export function useNativeEnvironment({
  bridge,
  generation,
  selection,
  revision,
  unavailable,
  controlUnavailable = false,
  submissions,
  onChanged,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  revision: number;
  unavailable: boolean;
  controlUnavailable?: boolean;
  submissions?: readonly NativeCallerMetadata[];
  onChanged: () => Promise<void>;
}) {
  const root = selection?.session.parentSessionId === null ? selection : undefined,
    storeId = root?.storeId,
    rootSessionId = root?.session.id,
    viewSelection = root?.viewSelection;
  const scope =
    rootSessionId && viewSelection
      ? JSON.stringify([generation, storeId, rootSessionId, viewSelection])
      : undefined;
  const cacheKey = rootSessionId ? JSON.stringify([generation, storeId, rootSessionId]) : undefined;
  const live = useRef(scope);
  live.current = scope;
  const cache = useRef(new Map<string, Display>()),
    pendingRead = useRef<{ scope: string; promise: Promise<Facts> } | undefined>(undefined),
    childRead = useRef<AbortController | undefined>(undefined),
    stopBusy = useRef(false);
  const [refresh, setRefresh] = useState(0),
    [view, setView] = useState<{
      scope: string;
      display?: Display;
      facts?: Facts;
      busy: boolean;
      error?: string;
    }>(),
    [child, setChild] = useState<Child>(),
    [stopping, setStopping] = useState<string>(),
    [stopNotice, setStopNotice] = useState('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: A navigation scope change releases the old child read and local notices.
  useEffect(() => {
    childRead.current?.abort();
    setChild(undefined);
    setStopNotice('');
    return () => childRead.current?.abort();
  }, [scope]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: SSE revision and explicit refresh reopen this same read-only scope.
  useEffect(() => {
    if (!bridge || !scope || !storeId || !rootSessionId || !viewSelection || !cacheKey) return;
    const display = cache.current.get(cacheKey);
    if (unavailable) {
      setView({ scope, display, busy: false, error: 'environment_unavailable' });
      return;
    }
    const abort = new AbortController();
    setView({ scope, display, busy: true });
    const promise = readNativeBackground({
      bridge,
      generation,
      storeId,
      signal: abort.signal,
      isCurrent: () => live.current === scope,
      environment: { rootSessionId, viewSelection },
    });
    const reading = { scope, promise };
    pendingRead.current = reading;
    void promise
      .then(
        (facts) => {
          if (abort.signal.aborted || live.current !== scope) return;
          const display = environmentDisplay(facts.items, storeId);
          // Presentation-only cache: no observation IDs, output, stop permission or submitted intent.
          if (
            new TextEncoder().encode(JSON.stringify([...display.rows, ...display.children]))
              .byteLength <= 524288
          ) {
            cache.current.delete(cacheKey);
            cache.current.set(cacheKey, display);
            while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
          }
          setView({ scope, display, facts, busy: false });
        },
        (cause) => {
          if (!abort.signal.aborted && live.current === scope)
            setView({ scope, display, busy: false, error: safeError(cause) });
        },
      )
      .finally(() => {
        if (pendingRead.current === reading) pendingRead.current = undefined;
      });
    return () => abort.abort();
  }, [
    bridge,
    generation,
    storeId,
    rootSessionId,
    viewSelection,
    scope,
    cacheKey,
    revision,
    refresh,
    unavailable,
  ]);

  async function openChild(sessionId: string) {
    if (!bridge || !scope || !storeId || !rootSessionId || !viewSelection) return;
    childRead.current?.abort();
    const abort = new AbortController();
    childRead.current = abort;
    const previous =
      child?.scope === scope && child.sessionId === sessionId ? child.facts : undefined;
    setChild({ scope, sessionId, loading: true, facts: previous });
    try {
      const facts =
        pendingRead.current?.scope === scope
          ? await pendingRead.current.promise
          : view?.scope === scope
            ? view.facts
            : undefined;
      abort.signal.throwIfAborted();
      if (live.current !== scope) return;
      const item = facts?.items.find((entry) => entry.execution.childSessionId === sessionId);
      if (!item || !facts) throw new Error('background_child_unavailable');
      const result = await readNativeBackgroundChild({
        bridge,
        generation,
        storeId,
        observationId: facts.observationId,
        item,
        signal: abort.signal,
        isCurrent: () => live.current === scope,
        environment: { rootSessionId, viewSelection },
      });
      if (!abort.signal.aborted && live.current === scope)
        setChild({ scope, sessionId, loading: false, facts: result });
    } catch (cause) {
      if (!abort.signal.aborted && live.current === scope)
        setChild({ scope, sessionId, loading: false, facts: previous, error: safeError(cause) });
    }
  }

  const current = view?.scope === scope ? view : undefined,
    display = current?.display ?? (cacheKey ? cache.current.get(cacheKey) : undefined),
    stale = !current?.facts || current.busy || !!current.error || unavailable;
  const blocked = new Set(
    submissions
      ?.filter(
        (row) =>
          row.scope.storeId === storeId &&
          row.target.kind === 'execution' &&
          row.request.kind === 'execution.cancel' &&
          row.phase !== 'rejected',
      )
      .map((row) => row.target.id),
  );
  async function stop(execution: BackgroundExecutionSummary) {
    const facts = current?.facts,
      item = facts?.items.find((entry) => entry.execution.id === execution.executionId);
    if (
      !bridge ||
      !scope ||
      stale ||
      controlUnavailable ||
      !facts ||
      !item ||
      !execution.canStop ||
      blocked.has(execution.executionId) ||
      stopBusy.current
    )
      return;
    stopBusy.current = true;
    const commandId = crypto.randomUUID();
    setStopping(execution.executionId);
    setStopNotice('');
    try {
      const result = await bridge.request({
        method: 'background.stop',
        surface: 'environment',
        generation,
        observationId: facts.observationId,
        executionId: execution.executionId,
        commandId,
      });
      if (live.current !== scope) return;
      if (
        result &&
        'status' in result &&
        'id' in result &&
        result.id === commandId &&
        (result.status === 'accepted' || result.status === 'applied')
      )
        setStopNotice('停止请求已受理，仍须等待实际执行状态。');
      else setStopNotice(`停止结果待核实：${commandId}。请查询原申请，不重复停止。`);
    } catch (cause) {
      if (live.current === scope)
        setStopNotice(`原停止申请 ${commandId}：${safeError(cause)}。请在原申请面板核实。`);
    } finally {
      stopBusy.current = false;
      if (live.current === scope) {
        setStopping(undefined);
        setRefresh((value) => value + 1);
        void onChanged();
      }
    }
  }

  const visibleChild = child?.scope === scope ? child : undefined;
  return {
    child: visibleChild,
    openChild: (sessionId: string) => void openChild(sessionId),
    closeChild: () => {
      childRead.current?.abort();
      setChild(undefined);
    },
    refreshChild: () => {
      if (visibleChild) void openChild(visibleChild.sessionId);
    },
    card: scope ? (
      <>
        <BackgroundExecutions
          id="session-environment-information"
          executions={
            display?.rows.map((row) => ({
              ...row,
              canStop: row.canStop && !blocked.has(row.executionId),
            })) ?? []
          }
          currentOnly
          stale={stale}
          stoppingExecutionId={stopping}
          onStop={!stale && !controlUnavailable ? (execution) => void stop(execution) : undefined}
          subagentDetails={{
            sessionIdsByExecutionId: display?.children ?? new Map(),
            loading: current?.busy ?? true,
            error: current?.error,
            onOpen: (sessionId) => void openChild(sessionId),
            onRefresh: () => setRefresh((value) => value + 1),
          }}
        />
        {stopNotice && <p role="status">{stopNotice}</p>}
      </>
    ) : undefined,
  };
}
