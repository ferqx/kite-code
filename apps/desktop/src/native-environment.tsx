import type { BackgroundExecutionItem } from '@kite-ai/client';
import { type BackgroundExecutionSummary, BackgroundExecutions } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type { NativeBackgroundChild } from './background-bridge';
import { readNativeBackground, readNativeBackgroundChild } from './native-background';
import type { NativeBridge, NativeCallerMetadata, NativeSelection } from './native-bridge';
import { estimateNativeSnapshotBytes } from './native-history-cache';
import { NativeMarkdownOwner } from './native-markdown';

type Display = {
  rows: BackgroundExecutionSummary[];
  children: Map<string, string>;
};
type Facts = Awaited<ReturnType<typeof readNativeBackground>>;
/** Cancel only this child's wait; the shared directory remains owned by its environment. */
export function waitForNativeDirectory<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener('abort', abort);
        reject(cause);
      },
    );
    if (signal.aborted) abort();
  });
}

type Child = {
  scope: string;
  sessionId: string;
  executionId?: string;
  title?: string;
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

/** Saved human authorization wins over review progress only within this exact carrier Run. */
export function nativeChildActivity(facts: NativeBackgroundChild): string | undefined {
  const carrier = facts.item.execution;
  if (
    !['planned', 'dispatching', 'running'].includes(carrier.status) ||
    carrier.cancelRequested ||
    carrier.cancelRequestedAt !== null
  )
    return;
  const runs =
    facts.control?.runs.filter(
      (run) =>
        run.isActive &&
        run.carrierExecutionId === carrier.id &&
        run.sessionId === carrier.childSessionId &&
        run.originStoreId === carrier.originStoreId &&
        run.rootWorkCommandId === carrier.rootWorkCommandId &&
        run.rootWorkSeq === carrier.rootWorkSeq,
    ) ?? [];
  if (runs.length !== 1) return;
  const executions = facts.control!.executions.filter(
    (execution) =>
      execution.runId === runs[0]!.id &&
      execution.sessionId === carrier.childSessionId &&
      execution.originStoreId === carrier.originStoreId &&
      execution.rootWorkCommandId === carrier.rootWorkCommandId &&
      execution.rootWorkSeq === carrier.rootWorkSeq &&
      execution.cancelRequestedAt === null &&
      ['planned', 'dispatching', 'running'].includes(execution.status),
  );
  if (executions.some((execution) => execution.authorization?.human?.state === 'pending'))
    return '等待你的批准';
  if (
    executions.some((execution) =>
      ['dispatching', 'running'].includes(execution.authorization?.review?.status ?? ''),
    )
  )
    return '正在自动审核';
  if (executions.some((execution) => execution.authorization?.review?.status === 'planned'))
    return '等待自动审核';
  return undefined;
}

/** Only public metadata is adapted; lifecycle does not prove process cleanup. */
export function environmentDisplay(
  items: readonly BackgroundExecutionItem[],
  storeId: string,
): Display {
  const rows: BackgroundExecutionSummary[] = [],
    children = new Map<string, string>();
  for (const item of items) {
    const e = item.execution;
    // Automatic title generation stays in execution history, outside this task list.
    if (
      e.definitionId === 'agent/session-title' ||
      (!e.childSessionId &&
        (e.definitionId !== 'shell.command' ||
          item.sourceTool?.id !== e.parentExecutionId ||
          item.sourceTool?.definitionId !== 'shell.launch' ||
          item.sourceTool?.definitionVersion !== '1'))
    )
      continue;
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
  historyEpoch = 0,
  unavailable,
  controlUnavailable = false,
  paused = false,
  submissions,
  onChanged,
  onOpenChild,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  revision: number;
  historyEpoch?: number;
  unavailable: boolean;
  controlUnavailable?: boolean;
  /** A known selection handoff pauses IO while retaining the displayed card. */
  paused?: boolean;
  submissions?: readonly NativeCallerMetadata[];
  onChanged: () => Promise<void>;
  /** A tab host may route navigation before activating this hook's one visible child reader. */
  onOpenChild?: (sessionId: string, executionId: string, title: string) => void;
}) {
  const root = selection?.session.parentSessionId === null ? selection : undefined,
    storeId = root?.storeId,
    rootSessionId = root?.session.id,
    viewSelection = root?.viewSelection;
  const scope =
    rootSessionId && viewSelection
      ? JSON.stringify([generation, historyEpoch, storeId, rootSessionId, viewSelection])
      : undefined;
  const cacheKey = rootSessionId
    ? JSON.stringify([generation, historyEpoch, storeId, rootSessionId])
    : undefined;
  const live = useRef(scope);
  live.current = scope;
  const cache = useRef(new Map<string, Display>()),
    pendingRead = useRef<{ scope: string; promise: Promise<Facts> } | undefined>(undefined),
    childRead = useRef<AbortController | undefined>(undefined),
    stopBusy = useRef<{ scope: string; wait: AbortController } | undefined>(undefined),
    directoryQueued = useRef(false);
  const [directoryTick, setDirectoryTick] = useState(0);
  const lastDirectoryRevision = useRef({ scope, revision, refresh: 0 });
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
  const childCache = useRef(new Map<string, { facts: NativeBackgroundChild; bytes: number }>());
  type ChildJob = {
    scope: string;
    sessionId: string;
    executionId?: string;
    title?: string;
    targetResolved: boolean;
    abort: AbortController;
    running: boolean;
    queued: boolean;
    full: boolean;
    directoryFacts?: Facts;
    queuedDirectoryFacts?: Facts;
    facts?: NativeBackgroundChild;
    cached?: NativeBackgroundChild;
    markdown?: NativeMarkdownOwner;
  };
  const childJob = useRef<ChildJob | undefined>(undefined);
  // Explicit navigation is synchronous; stale passive effects cannot reopen a departed child.
  const childNavigation = useRef<
    { scope: string; sessionId: string; executionId?: string } | undefined
  >(undefined);
  const latest = useRef(view);
  latest.current = view;
  const readable = useRef(!unavailable && !paused);
  readable.current = !unavailable && !paused;
  const control = useRef({ unavailable: unavailable || paused, controlUnavailable });
  control.current = { unavailable: unavailable || paused, controlUnavailable };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new authority epoch releases retained old data.
  useEffect(() => {
    childCache.current.clear();
  }, [generation, historyEpoch, bridge]);

  // A navigation scope change releases only its view readers and local notices.
  useEffect(() => {
    childNavigation.current = undefined;
    childRead.current?.abort();
    childJob.current = undefined;
    setChild(undefined);
    setStopNotice('');
    setStopping(undefined);
    return () => {
      childRead.current?.abort();
      const stopping = stopBusy.current;
      if (stopping && stopping.scope === scope) stopping.wait.abort();
    };
  }, [scope]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Revisions queue behind the owned read rather than aborting it.
  useEffect(() => {
    if (!bridge || !scope || !storeId || !rootSessionId || !viewSelection || !cacheKey) return;
    const display = cache.current.get(cacheKey);
    if (paused) {
      setView((previous) => ({
        scope,
        display,
        facts: previous?.scope === scope ? previous.facts : undefined,
        busy: true,
        error: previous?.scope === scope ? previous.error : undefined,
      }));
      return;
    }
    if (unavailable) {
      setView({ scope, display, busy: false, error: 'environment_unavailable' });
      return;
    }
    if (stopBusy.current?.scope === scope) {
      directoryQueued.current = true;
      return;
    }
    const abort = new AbortController();
    directoryQueued.current = false;
    setView({
      scope,
      display,
      facts: latest.current?.scope === scope ? latest.current.facts : undefined,
      busy: true,
    });
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
          latest.current = { scope, display, facts, busy: false };
          setView(latest.current);
        },
        (cause) => {
          if (!abort.signal.aborted && live.current === scope)
            setView({ scope, display, busy: false, error: safeError(cause) });
        },
      )
      .finally(() => {
        if (pendingRead.current === reading) {
          pendingRead.current = undefined;
          if (
            !abort.signal.aborted &&
            live.current === scope &&
            directoryQueued.current &&
            stopBusy.current?.scope !== scope
          )
            setDirectoryTick((value) => value + 1);
        }
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
    directoryTick,
    unavailable,
    paused,
  ]);
  useEffect(() => {
    const before = lastDirectoryRevision.current;
    lastDirectoryRevision.current = { scope, revision, refresh };
    if (
      before.scope !== scope ||
      (before.revision === revision && before.refresh === refresh) ||
      unavailable ||
      paused
    )
      return;
    if (pendingRead.current?.scope === scope || stopBusy.current?.scope === scope)
      directoryQueued.current = true;
    else setDirectoryTick((value) => value + 1);
  }, [scope, revision, refresh, unavailable, paused]);

  async function runChild(job: ChildJob) {
    if (job.running) return;
    job.running = true;
    try {
      while (
        job.queued &&
        readable.current &&
        !job.abort.signal.aborted &&
        live.current === job.scope
      ) {
        job.queued = false;
        const full = job.full;
        job.full = false;
        try {
          const previous = latest.current?.scope === job.scope ? latest.current.facts : undefined;
          const pinned =
            job.targetResolved &&
            previous?.items.some(
              (entry) =>
                entry.execution.id === job.executionId &&
                entry.execution.childSessionId === job.sessionId,
            );
          // A known exact carrier can be freshly checked by Main without waiting
          // for an unrelated full directory. Session-only discovery still waits.
          const facts = pinned
            ? previous
            : pendingRead.current?.scope === job.scope
              ? await waitForNativeDirectory(pendingRead.current.promise, job.abort.signal)
              : previous;
          job.abort.signal.throwIfAborted();
          if (live.current !== job.scope || !readable.current || childJob.current !== job) return;
          if (!facts) throw new Error('background_child_unavailable');
          if (!job.targetResolved) {
            job.targetResolved = true;
            const candidates = facts?.items.filter(
              (entry) => entry.execution.childSessionId === job.sessionId,
            );
            if (candidates?.length !== 1) {
              childNavigation.current = undefined;
              throw new Error('background_child_target_unavailable');
            }
            job.executionId = candidates[0]!.execution.id;
            childNavigation.current = {
              scope: job.scope,
              sessionId: job.sessionId,
              executionId: job.executionId,
            };
          }
          if (!job.executionId) throw new Error('background_child_target_unavailable');
          const item = facts?.items.find(
            (entry) =>
              entry.execution.id === job.executionId &&
              entry.execution.childSessionId === job.sessionId,
          );
          if (!item || !facts || !bridge || !storeId || !rootSessionId || !viewSelection)
            throw new Error('background_child_unavailable');
          job.title = item.childSession?.title;
          job.directoryFacts = facts;
          if (job.queuedDirectoryFacts === facts) job.queued = false;
          if (!job.facts && !job.cached)
            job.cached = childCache.current.get(
              JSON.stringify([
                generation,
                historyEpoch,
                storeId,
                rootSessionId,
                job.sessionId,
                job.executionId,
              ]),
            )?.facts;
          if (!job.facts && job.cached) {
            const owner = new NativeMarkdownOwner(job.abort.signal);
            try {
              for (const entry of job.cached.modelOutputs) await owner.prepare(entry.snapshot);
              job.abort.signal.throwIfAborted();
              if (childJob.current !== job || live.current !== job.scope || !readable.current) {
                owner.dispose();
                return;
              }
            } catch (cause) {
              owner.dispose();
              throw cause;
            }
            job.markdown?.dispose();
            job.markdown = owner;
            job.facts = job.cached;
            setChild({
              scope: job.scope,
              sessionId: job.sessionId,
              executionId: job.executionId,
              title: job.title,
              loading: true,
              facts: job.cached,
            });
          }
          const result = await readNativeBackgroundChild({
            bridge,
            generation,
            storeId,
            observationId: facts.observationId,
            item,
            signal: job.abort.signal,
            isCurrent: () =>
              readable.current && live.current === job.scope && childJob.current === job,
            environment: { rootSessionId, viewSelection },
            incremental: !full,
            previous: !full ? job.facts : undefined,
          });
          const owner = new NativeMarkdownOwner(job.abort.signal);
          try {
            for (const entry of result.modelOutputs) await owner.prepare(entry.snapshot);
            job.abort.signal.throwIfAborted();
          } catch (cause) {
            owner.dispose();
            throw cause;
          }
          if (
            !readable.current ||
            job.abort.signal.aborted ||
            live.current !== job.scope ||
            childJob.current !== job
          ) {
            owner.dispose();
            return;
          }
          job.markdown?.dispose();
          job.markdown = owner;
          job.facts = result;
          job.cached = undefined;
          const key = JSON.stringify([
            generation,
            historyEpoch,
            storeId,
            rootSessionId,
            job.sessionId,
            job.executionId,
          ]);
          // Bound all retained strings and metadata, including tool arguments and
          // source IDs, without serializing full bodies or allocating wire copies.
          const bytes = estimateNativeSnapshotBytes(result);
          childCache.current.delete(key);
          if (bytes <= 16 * 1024 * 1024) childCache.current.set(key, { facts: result, bytes });
          let total = [...childCache.current.values()].reduce((sum, entry) => sum + entry.bytes, 0);
          while (childCache.current.size > 12 || total > 64 * 1024 * 1024) {
            const oldest = childCache.current.keys().next().value!;
            total -= childCache.current.get(oldest)!.bytes;
            childCache.current.delete(oldest);
          }
          setChild({
            scope: job.scope,
            sessionId: job.sessionId,
            executionId: job.executionId,
            title: job.title,
            loading: false,
            facts: result,
          });
        } catch (cause) {
          // A failed full calibration cannot turn cached data into a verified
          // prefix for this visit. The next revision must retry the whole read.
          if (full) job.full = true;
          if (
            readable.current &&
            !job.abort.signal.aborted &&
            live.current === job.scope &&
            childJob.current === job
          )
            setChild({
              scope: job.scope,
              sessionId: job.sessionId,
              executionId: job.executionId,
              title: job.title,
              loading: false,
              facts: job.facts,
              error: safeError(cause),
            });
        }
      }
    } finally {
      job.running = false;
    }
  }
  function openChild(sessionId: string, executionId?: string) {
    if (!bridge || !scope || !storeId || !rootSessionId || !viewSelection || unavailable || paused)
      return;
    childNavigation.current = { scope, sessionId, executionId };
    childRead.current?.abort();
    const abort = new AbortController();
    childRead.current = abort;
    const job: ChildJob = {
      scope,
      sessionId,
      executionId,
      title:
        latest.current?.scope === scope && executionId
          ? latest.current.facts?.items.find(
              (item) =>
                item.execution.id === executionId && item.execution.childSessionId === sessionId,
            )?.childSession?.title
          : undefined,
      targetResolved: executionId !== undefined,
      abort,
      running: false,
      queued: true,
      full: true,
    };
    childJob.current = job;
    setChild({ scope, sessionId, executionId, title: job.title, loading: true });
    void runChild(job);
  }
  // A completed directory revision queues one tail read; changes during a read coalesce.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The owned job captures its exact navigation scope.
  useEffect(() => {
    if (unavailable || paused) {
      childRead.current?.abort();
      childJob.current = undefined;
      setChild((previous) =>
        previous && previous.scope === scope
          ? {
              ...previous,
              loading: paused && !previous.error,
              error: paused ? previous.error : 'environment_unavailable',
            }
          : previous,
      );
      return;
    }
    if (!view?.facts || view.busy) return;
    const job = childJob.current;
    const navigation = childNavigation.current;
    if (!job && navigation && navigation.scope === scope) {
      openChild(navigation.sessionId, navigation.executionId);
      return;
    }
    if (!job || job.scope !== scope || job.directoryFacts === view.facts) return;
    job.queuedDirectoryFacts = view.facts;
    job.queued = true;
    void runChild(job);
  }, [view?.facts, scope, unavailable, paused]);

  const current = view?.scope === scope ? view : undefined,
    display = current?.display ?? (cacheKey ? cache.current.get(cacheKey) : undefined),
    stale = !!current?.error || (!paused && unavailable),
    busy = !stale && (paused || !current?.facts || current.busy || controlUnavailable);
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
      busy ||
      !facts ||
      !item ||
      !execution.canStop ||
      blocked.has(execution.executionId) ||
      stopBusy.current?.scope === scope
    )
      return;
    const stoppingJob = { scope, wait: new AbortController() };
    stopBusy.current = stoppingJob;
    const commandId = crypto.randomUUID();
    setStopping(execution.executionId);
    setStopNotice('');
    let submitted = false;
    try {
      // Freeze only this scope's directory observation until Main has completed
      // its fresh prepare/submit checks. Existing reads retain their own owner.
      const reading = pendingRead.current;
      const fresh =
        reading?.scope === scope
          ? await waitForNativeDirectory(reading.promise, stoppingJob.wait.signal)
          : latest.current?.scope === scope
            ? latest.current.facts
            : undefined;
      if (live.current !== scope || stoppingJob.wait.signal.aborted) return;
      if (
        control.current.unavailable ||
        control.current.controlUnavailable ||
        !fresh ||
        !environmentDisplay(fresh.items, storeId!).rows.some(
          (row) => row.executionId === execution.executionId && row.canStop,
        )
      ) {
        setStopNotice('停止尚未提交：执行状态或权限已变化，请刷新后核实。');
        return;
      }
      submitted = true;
      const result = await bridge.request({
        method: 'background.stop',
        surface: 'environment',
        generation,
        observationId: fresh.observationId,
        executionId: execution.executionId,
        commandId,
      });
      if (live.current !== scope || stoppingJob.wait.signal.aborted) return;
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
      if (live.current === scope && !stoppingJob.wait.signal.aborted)
        setStopNotice(
          submitted
            ? `原停止申请 ${commandId}：${safeError(cause)}。请在原申请面板核实。`
            : `停止尚未提交：${safeError(cause)}。`,
        );
    } finally {
      if (stopBusy.current === stoppingJob) stopBusy.current = undefined;
      if (live.current === scope && !stoppingJob.wait.signal.aborted) {
        setStopping(undefined);
        setRefresh((value) => value + 1);
        void onChanged();
      }
    }
  }

  const visibleChild = child?.scope === scope ? child : undefined;
  return {
    child: visibleChild,
    childScope: scope,
    childReadAvailable: !!bridge && !!scope && !unavailable && !paused,
    openChild,
    closeChild: () => {
      childNavigation.current = undefined;
      childRead.current?.abort();
      childJob.current = undefined;
      setChild(undefined);
    },
    refreshChild: () => {
      if (visibleChild)
        void openChild(
          visibleChild.sessionId,
          visibleChild.executionId ?? visibleChild.facts?.item.execution.id,
        );
    },
    card: scope ? (
      <>
        <BackgroundExecutions
          id="session-environment-information"
          executions={
            display?.rows.map((row) => ({
              ...row,
              ...(visibleChild?.facts?.item.execution.id === row.executionId &&
              !visibleChild.loading &&
              !visibleChild.error
                ? { activity: nativeChildActivity(visibleChild.facts) }
                : {}),
              canStop: row.canStop && !blocked.has(row.executionId),
            })) ?? []
          }
          currentOnly
          stale={stale}
          busy={busy}
          stoppingExecutionId={stopping}
          onStop={!stale ? (execution) => void stop(execution) : undefined}
          subagentDetails={{
            sessionIdsByExecutionId: display?.children ?? new Map(),
            loading: !display && (current?.busy ?? true),
            error: current?.error,
            onOpen: (sessionId, executionId) => {
              if (!onOpenChild) return void openChild(sessionId, executionId);
              if (!bridge || !scope || unavailable || paused || !executionId) return;
              const title = display?.rows.find(
                (row) => row.executionId === executionId,
              )?.displayName;
              onOpenChild(sessionId, executionId, title ?? '子 Agent');
            },
            onRefresh: () => setRefresh((value) => value + 1),
          }}
        />
        {stopNotice && <p role="status">{stopNotice}</p>}
      </>
    ) : undefined,
  };
}
