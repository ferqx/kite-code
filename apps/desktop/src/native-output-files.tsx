import type { OutputFilesPage, OutputFileTarget } from '@kite-ai/client';
import {
  ConversationTurnElementContext,
  InitialTurnOutputPresentationContext,
  type OutputFileSummary,
  OutputFiles,
  type OutputFilesProps,
  OutputReferences,
  type SessionFileTabRequest,
  type SessionFileTarget,
  useConversationReadActive,
} from '@kite-ai/ui/desktop';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { NativeBridge } from './native-bridge';
import { NativeFilePreview } from './native-file-preview';
import { NativeLocalFilePreview } from './native-local-file-preview';
import { NativeOutputReadCache } from './native-output-read-cache';
import type {
  LocalOfficeRequest,
  NativeOutputDisplayState,
  NativeOutputSource,
  OfficeEditContext,
  OfficeRequestOutcome,
} from './output-files-bridge';

function target(file: OutputFileTarget): OutputFileTarget {
  return {
    storeId: file.storeId,
    sessionId: file.sessionId,
    fileId: file.fileId,
    locator: file.locator,
  };
}
export function nativeOutputRunId(
  turnId: string,
  storeId: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  try {
    const value: unknown = JSON.parse(turnId);
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      value[0] === 'native-run' &&
      value[1] === storeId &&
      value[2] === sessionId &&
      typeof value[3] === 'string'
    )
      return value[3];
  } catch {}
  return undefined;
}
export function useNativeOutputFiles(input: {
  bridge?: NativeBridge;
  generation: number;
  storeId?: string;
  sessionId?: string;
  revision: number;
  pendingReading?: { storeId: string; sessionId: string };
  display?: NativeOutputDisplayState;
  available?: boolean;
  onError?: (message: string) => void;
  onEdit: (file: OutputFileSummary, context?: OfficeEditContext) => Promise<void>;
  onRequestEdit?: (
    file: OutputFileSummary,
    context: OfficeEditContext,
    prompt: string,
  ) => Promise<OfficeRequestOutcome>;
  onRequestLocalEdit?: (
    target: Extract<SessionFileTarget, { kind: 'local-preview' }>,
    request: LocalOfficeRequest,
  ) => Promise<OfficeRequestOutcome>;
  turnLabel: (runId: string) => string;
}) {
  const [request, setRequest] = useState<{
    scope: string;
    value: SessionFileTabRequest;
    ownerRunId?: string;
  }>();
  const scopeKey = JSON.stringify([input.generation, input.storeId, input.sessionId]);
  // A pending session can retain covered display while Main prepares its active selection.
  const displayStoreId = input.storeId ?? input.pendingReading?.storeId;
  const displaySessionId = input.sessionId ?? input.pendingReading?.sessionId;
  const display = input.display?.storeId === displayStoreId ? input.display : undefined;
  const displayRevision = display?.roots.find(
    (root) => root.sessionId === displaySessionId,
  )?.revision;
  const authority = JSON.stringify([
    input.generation,
    displayStoreId,
    display?.subjectId,
    display?.epoch,
    // Without Main's live invalidation coverage, sharing is limited to this selection.
    displayRevision === undefined ? scopeKey : undefined,
    input.available === false,
  ]);
  const key = JSON.stringify([scopeKey, authority]);
  const retained = useRef<
    | {
        bridge?: NativeBridge;
        authority: string;
        cache: NativeOutputReadCache;
      }
    | undefined
  >(undefined);
  const retired = useRef<NativeOutputReadCache[]>([]);
  if (retained.current?.bridge !== input.bridge || retained.current?.authority !== authority) {
    if (retained.current) {
      retained.current.cache.cover([]);
      retired.current.push(retained.current.cache);
    }
    retained.current = { bridge: input.bridge, authority, cache: new NativeOutputReadCache() };
  }
  const cache = retained.current.cache;
  const activation = cache.select(key);
  const sourceRevision = displayRevision ?? input.revision;
  const rootKey = JSON.stringify([key, sourceRevision]);
  cache.cover(
    input.available === false
      ? []
      : displayRevision === undefined
        ? [rootKey]
        : display!.roots.map((root) =>
            JSON.stringify([
              JSON.stringify([
                JSON.stringify([input.generation, displayStoreId, root.sessionId]),
                authority,
              ]),
              root.revision,
            ]),
          ),
  );
  useLayoutEffect(() => {
    for (const previous of retired.current.splice(0)) previous.publish();
    cache.publish();
  });
  const reader = {
    cache,
    rootKey,
    available: input.available,
    strict: displayRevision !== undefined,
  };
  const currentKey = useRef(key);
  currentKey.current = key;
  const [sourceState, setSourceState] = useState<{
    key: string;
    sources: NativeOutputSource[];
    revision: number;
    activation: number;
  }>();
  const [failedSourceRead, setFailedSourceRead] = useState<string>();
  const sourceReadKey = JSON.stringify([rootKey, activation]);
  const observedSources =
    input.available === false
      ? undefined
      : sourceState?.key === key &&
          sourceState.activation === activation &&
          (displayRevision === undefined || sourceState.revision === displayRevision)
        ? sourceState.sources
        : cache.get<NativeOutputSource[]>(`sources/${rootKey}`);
  const sources = observedSources ?? [];
  const sourcesChecked = observedSources !== undefined || failedSourceRead === sourceReadKey;
  useEffect(() => {
    if (input.available === false || !input.bridge || !input.storeId || !input.sessionId) return;
    const cached = cache.get<NativeOutputSource[]>(`sources/${rootKey}`);
    if (cached) {
      setSourceState({
        key,
        sources: cached,
        revision: sourceRevision,
        activation,
      });
      return;
    }
    let cancelled = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await input.bridge!.request({
          method: 'outputs.sources',
          generation: input.generation,
          scope: { storeId: input.storeId!, sessionId: input.sessionId! },
        });
        if (cancelled) return;
        if (
          !result ||
          !('kind' in result) ||
          !('scope' in result) ||
          !('sources' in result) ||
          result.kind !== 'outputs.sources' ||
          result.scope.storeId !== input.storeId ||
          result.scope.sessionId !== input.sessionId
        )
          throw Error('output_sources_scope_changed');
        cache.set(`sources/${rootKey}`, result.sources);
        setSourceState({
          key,
          sources: result.sources,
          revision: sourceRevision,
          activation,
        });
      } catch {
        if (cancelled) return;
        setFailedSourceRead(sourceReadKey);
        retry = setTimeout(
          () => {
            void read();
          },
          500 * 2 ** Math.min(failures++, 4),
        );
      }
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [
    input.bridge,
    input.generation,
    input.storeId,
    input.sessionId,
    rootKey,
    key,
    cache,
    input.available,
    activation,
    sourceRevision,
    sourceReadKey,
  ]);
  useEffect(() => {
    setRequest((previous) => (previous?.scope === key ? previous : undefined));
  }, [key]);
  const sequence = useRef(0);
  const actions = {
    onOpen: (file: OutputFileSummary) => {
      if (currentKey.current !== key || !cache.valid(rootKey)) return;
      setRequest({
        scope: key,
        ownerRunId: file.ownerRunId,
        value: { target: target(file), title: file.name, requestId: ++sequence.current },
      });
    },
    onSave: (file: OutputFileSummary) => {
      if (currentKey.current !== key || !cache.valid(rootKey)) return;
      void input.bridge
        ?.request({ method: 'outputs.save', generation: input.generation, target: target(file) })
        .catch(() => input.onError?.('另存失败，请重试'));
    },
    onReveal: async (file: OutputFileSummary) => {
      if (currentKey.current !== key || !cache.valid(rootKey)) return;
      try {
        await input.bridge?.request({
          method: 'outputs.reveal',
          generation: input.generation,
          target: target(file),
        });
      } catch {
        if (currentKey.current === key && cache.valid(rootKey))
          input.onError?.('无法在资源管理器中显示文件，请重试');
      }
    },
    onEdit: (file: OutputFileSummary, context?: OfficeEditContext) => {
      if (currentKey.current !== key || !cache.valid(rootKey)) return;
      void input.onEdit(file, context).catch(() => input.onError?.('无法附加文件，请重试'));
    },
  };
  const readable = !!(
    input.bridge &&
    input.storeId &&
    input.sessionId &&
    input.available !== false
  );
  const cachedWindow = (window: string) =>
    cache.valid(rootKey) ? cache.peek<FilePage>(`window/${window}`) : undefined;
  const hasCards = (window: string) => !!cachedWindow(window)?.items.length;
  return {
    closeFile: (file: SessionFileTarget) => {
      if ('handleId' in file)
        void input.bridge
          ?.request({
            method: 'localPreview.release',
            generation: input.generation,
            handleId: file.handleId,
          })
          .catch(() => {});
    },
    openLocal: (file: Extract<SessionFileTarget, { kind: 'local-preview' }>) => {
      if (file.storeId !== input.storeId || file.sessionId !== input.sessionId) return;
      setRequest({
        scope: key,
        value: { target: file, title: file.name, requestId: ++sequence.current },
      });
    },
    request:
      request &&
      request.scope === key &&
      request.value.target.storeId === input.storeId &&
      (request.value.target.sessionId === input.sessionId ||
        (!('handleId' in request.value.target) &&
          sources.some(
            (source) =>
              source.sessionId === request.value.target.sessionId &&
              source.runId === request.ownerRunId,
          )))
        ? request.value
        : undefined,
    references: (
      <OutputReferenceReaders
        key={key}
        {...input}
        {...reader}
        sources={sources}
        actions={actions}
      />
    ),
    renderTurnOutputs: ({ turnId }: { turnId: string }) => {
      const runId = nativeOutputRunId(turnId, input.storeId, input.sessionId);
      if (!runId) return null;
      const childSources = sources.filter((source) => source.parentRunId === runId);
      const windows = [
        outputWindowKey(rootKey, input.sessionId, runId),
        ...childSources.map((source) => outputWindowKey(rootKey, source.sessionId, source.runId)),
      ];
      return (
        <TurnOutputSlot
          key={`${key}/${turnId}`}
          readable={readable}
          hasCards={() => windows.some(hasCards)}
          ready={(checked) =>
            sourcesChecked && windows.every((window) => checked.has(window) || cachedWindow(window))
          }
        >
          <OutputFileReader {...input} {...reader} runId={runId} actions={actions} />
          {childSources.map((source) => (
            <OutputFileReader
              key={`${key}/${source.sessionId}/${source.runId}`}
              {...input}
              {...reader}
              sessionId={source.sessionId}
              runId={source.runId}
              sourceLabel={`来自子 Agent · ${source.name} · ${input.turnLabel(source.runId)}`}
              actions={actions}
            />
          ))}
        </TurnOutputSlot>
      );
    },
    renderChildTurnOutputs: (sessionId: string, { turnId }: { turnId: string }) => {
      const runId = nativeOutputRunId(turnId, input.storeId, sessionId);
      if (!runId) return null;
      const admitted = sources.some(
        (source) => source.sessionId === sessionId && source.runId === runId,
      );
      if (!admitted && sourcesChecked) return null;
      const window = outputWindowKey(rootKey, sessionId, runId);
      return (
        <TurnOutputSlot
          key={`${key}/${sessionId}/${runId}`}
          readable={readable}
          hasCards={() => admitted && hasCards(window)}
          ready={(checked) => sourcesChecked && (checked.has(window) || !!cachedWindow(window))}
        >
          {admitted && (
            <OutputFileReader
              {...input}
              {...reader}
              sessionId={sessionId}
              runId={runId}
              actions={actions}
            />
          )}
        </TurnOutputSlot>
      );
    },
    renderFile: ({ target: source }: { target: SessionFileTarget }) =>
      'handleId' in source ? (
        <NativeLocalFilePreview
          key={source.handleId}
          bridge={input.bridge}
          generation={input.generation}
          target={source}
          onRequestEdit={
            input.onRequestLocalEdit
              ? (request) => input.onRequestLocalEdit!(source, request)
              : undefined
          }
        />
      ) : (
        <NativeFilePreview
          bridge={input.bridge}
          generation={input.generation}
          target={source}
          onEdit={actions.onEdit}
          onRequestEdit={input.onRequestEdit}
          onSave={actions.onSave}
        />
      ),
  };
}
// Share an observer for the existing turn boxes within this reading viewport.
const turnObservers = new WeakMap<Element, IntersectionObserver>();
const turnReaders = new WeakMap<Element, (nearby: boolean) => void>();
const TurnOutputReadContext = createContext(true);
const TurnOutputCheckContext = createContext<((window: string) => void) | undefined>(undefined);

function TurnOutputSlot({
  children,
  readable,
  hasCards,
  ready,
}: {
  children: ReactNode;
  readable: boolean;
  hasCards: () => boolean;
  ready: (checked: ReadonlySet<string>) => boolean;
}) {
  const turn = useContext(ConversationTurnElementContext);
  // Undefined until the first visit. Afterwards retain the cards while new reads follow visibility.
  const [nearby, setNearby] = useState<boolean>();
  const active = useConversationReadActive();
  const release = useContext(InitialTurnOutputPresentationContext);
  const releaseRef = useRef(release);
  releaseRef.current = release;
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const markChecked = useCallback((window: string) => {
    setChecked((previous) => (previous.has(window) ? previous : new Set([...previous, window])));
  }, []);
  const pending = !!release && active && readable && !ready(checked);
  useLayoutEffect(() => {
    if (!pending) release?.();
  }, [pending, release]);
  useEffect(() => {
    if (!active) return;
    const target = turn?.current;
    const viewport = target?.closest('.conversation-viewport');
    const Observer = target?.ownerDocument.defaultView?.IntersectionObserver;
    if (!target || !viewport || !Observer) {
      setNearby(true);
      return;
    }
    let observer = turnObservers.get(viewport);
    if (!observer) {
      observer = new Observer(
        (entries) => {
          for (const entry of entries) turnReaders.get(entry.target)?.(entry.isIntersecting);
        },
        { root: viewport, rootMargin: '300px 0px' },
      );
      turnObservers.set(viewport, observer);
    }
    turnReaders.set(target, (visible) => {
      setNearby((previous) => (visible || previous !== undefined ? visible : undefined));
      if (!visible) releaseRef.current?.();
    });
    observer.observe(target);
    return () => {
      observer.unobserve(target);
      turnReaders.delete(target);
    };
  }, [active, turn]);
  // Keep the original reply mounted so releasing it preserves the reading geometry and identity.
  return (
    <>
      {pending && <span hidden data-turn-outputs-pending="" />}
      {(nearby !== undefined || hasCards()) && (
        <TurnOutputReadContext value={nearby === true}>
          <TurnOutputCheckContext value={pending ? markChecked : undefined}>
            {children}
          </TurnOutputCheckContext>
        </TurnOutputReadContext>
      )}
    </>
  );
}
function outputWindowKey(rootKey: string, sessionId?: string, runId?: string) {
  return JSON.stringify([rootKey, sessionId, runId]);
}
type FilePage = Pick<OutputFilesPage, 'items' | 'nextCursor' | 'revision'>;

type OutputReadState = {
  page?: FilePage;
  loading: boolean;
  more: () => void;
};
type OutputReaderInput = {
  cache: NativeOutputReadCache;
  rootKey: string;
  available?: boolean;
  strict?: boolean;
  bridge?: NativeBridge;
  generation: number;
  storeId?: string;
  sessionId?: string;
  runId?: string;
  sourceLabel?: string;
  onState?: (state: OutputReadState) => void;
  actions: Omit<OutputFilesProps, 'items'>;
};
function OutputFileReader(input: OutputReaderInput) {
  const active = useConversationReadActive();
  const nearby = useContext(TurnOutputReadContext);
  const readActive = active && nearby;
  const markChecked = useContext(TurnOutputCheckContext);
  const reportChecked = useRef(markChecked);
  reportChecked.current = markChecked;
  useSyncExternalStore(input.cache.subscribe, input.cache.snapshot, input.cache.snapshot);
  const scopeValid = input.cache.valid(input.rootKey);
  const windowKey = outputWindowKey(input.rootKey, input.sessionId, input.runId);
  const [saved, savePage] = useState(() => ({
    key: windowKey,
    cache: input.cache,
    page: input.available === false ? undefined : input.cache.get<FilePage>(`window/${windowKey}`),
  }));
  const page =
    !scopeValid ||
    input.available === false ||
    saved.cache !== input.cache ||
    (input.strict && saved.key !== windowKey)
      ? undefined
      : saved.page;
  // Revalidation replaces bytes atomically, but does not forget the reader's loaded window.
  const loadedCount = useRef(saved.page?.items.length ?? 50);
  if (saved.page) loadedCount.current = Math.max(50, saved.page.items.length);
  const setPage = useCallback(
    (page: FilePage) => savePage({ key: windowKey, cache: input.cache, page }),
    [windowKey, input.cache],
  );
  useLayoutEffect(() => {
    if (page && saved.key === windowKey) markChecked?.(windowKey);
  }, [markChecked, page, saved.key, windowKey]);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [loading, setLoading] = useState(false);
  const [read, setRead] = useState<{ cursor: string }>();
  const nextCursor = page?.nextCursor;
  const more = useCallback(() => {
    if (nextCursor) setRead({ cursor: nextCursor });
  }, [nextCursor]);
  const [retryRevision, setRetryRevision] = useState(0);
  const readFailures = useRef(0);
  const lastRevision = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      input.available === false ||
      !scopeValid ||
      !readActive ||
      !input.bridge ||
      !input.storeId ||
      !input.sessionId
    )
      return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const revision = `${windowKey}/${retryRevision}`;
    const continuation = lastRevision.current === revision;
    const readCursor = continuation ? read?.cursor : undefined;
    lastRevision.current = revision;
    if (!readCursor && retryRevision === 0) {
      const cached = input.cache.get<FilePage>(`window/${windowKey}`);
      if (cached) {
        setPage(cached);
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    const query = (beforeKey?: string) =>
      input.cache.read(JSON.stringify(['page', windowKey, retryRevision, beforeKey]), async () => {
        const result = await input.bridge!.request({
          method: 'outputs.query',
          generation: input.generation,
          scope: { storeId: input.storeId!, sessionId: input.sessionId! },
          runId: input.runId,
          limit: 50,
          beforeKey,
        });
        if (
          !result ||
          !('kind' in result) ||
          !('page' in result) ||
          result.kind !== 'outputs.page' ||
          result.page.scope.storeId !== input.storeId ||
          result.page.scope.sessionId !== input.sessionId ||
          !outputPageMatches(result.page, {
            storeId: input.storeId,
            sessionId: input.sessionId,
            runId: input.runId,
          })
        )
          throw Error('output_scope_changed');
        const { items, nextCursor, revision } = result.page;
        return { items, nextCursor, revision } satisfies FilePage;
      });
    void query(readCursor)
      .then(async (head) => {
        if (cancelled) return;
        const previous = pageRef.current;
        if (readCursor && previous && previous.revision !== head.revision) {
          // Never merge a continuation from a different storage snapshot.
          setRetryRevision((value) => value + 1);
          return;
        }
        let incoming = head;
        if (!readCursor) {
          // Rebuild the loaded window atomically. Retaining an old tail can resurrect
          // a superseded delivery that the authoritative head no longer contains.
          const wanted = Math.max(50, previous?.items.length ?? 0, loadedCount.current);
          const seen = new Set<string>();
          while (incoming.nextCursor && incoming.items.length < wanted) {
            if (cancelled) return;
            const cursor = incoming.nextCursor;
            if (seen.has(cursor)) throw Error('output_cursor_repeated');
            seen.add(cursor);
            const next = await query(cursor);
            if (cancelled) return;
            if (next.revision !== incoming.revision) throw Error('output_snapshot_changed');
            incoming = {
              ...incoming,
              nextCursor: next.nextCursor,
              items: [
                ...incoming.items,
                ...next.items.filter(
                  (item) =>
                    !incoming.items.some((old) => outputTargetKey(old) === outputTargetKey(item)),
                ),
              ],
            };
          }
        }
        if (cancelled) return;
        const updated =
          previous && readCursor
            ? {
                ...incoming,
                items: [
                  ...previous.items,
                  ...incoming.items.filter(
                    (item) =>
                      !previous.items.some((old) => outputTargetKey(old) === outputTargetKey(item)),
                  ),
                ],
              }
            : incoming;
        input.cache.set(`window/${windowKey}`, updated);
        setPage(updated);
        readFailures.current = 0;
      })
      .catch(() => {
        if (cancelled) return;
        reportChecked.current?.(windowKey);
        retry = setTimeout(
          () => setRetryRevision((value) => value + 1),
          500 * 2 ** Math.min(readFailures.current++, 4),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      clearTimeout(retry);
      cancelled = true;
    };
  }, [
    input.bridge,
    input.generation,
    input.storeId,
    input.sessionId,
    input.runId,
    windowKey,
    input.cache,
    input.available,
    readActive,
    retryRevision,
    read,
    setPage,
    scopeValid,
  ]);
  const onState = useRef(input.onState);
  onState.current = input.onState;
  useLayoutEffect(() => {
    onState.current?.({ page, loading, more });
  }, [page, loading, more]);
  if (input.onState) return null;
  const items = (page?.items ?? []).map((file) =>
    input.sourceLabel ? { ...file, sourceLabel: input.sourceLabel } : file,
  );
  return (
    <>
      <OutputFiles
        items={items}
        onOpen={input.actions.onOpen}
        onSave={input.actions.onSave}
        onReveal={input.actions.onReveal}
      />
      {nextCursor && (
        <button type="button" disabled={loading} onClick={more}>
          加载更多文件
        </button>
      )}
    </>
  );
}

function outputTargetKey(file: OutputFileTarget) {
  return JSON.stringify([
    file.storeId,
    file.sessionId,
    file.fileId,
    file.locator.kind,
    file.locator.kind === 'legacy-operation' ? file.locator.executionId : file.locator.key,
  ]);
}
function outputPageMatches(
  page: OutputFilesPage,
  input: Pick<OutputReaderInput, 'storeId' | 'sessionId' | 'runId'>,
) {
  return (
    page.items.every(
      (file) =>
        file.storeId === input.storeId &&
        file.sessionId === input.sessionId &&
        (!input.runId || file.ownerRunId === input.runId),
    ) &&
    page.collections.every((collection) => !input.runId || collection.ownerRunId === input.runId)
  );
}
/** Each source retains its own cursor/revision; combining references never changes ownership. */
function OutputReferenceReaders(
  input: OutputReaderInput & {
    sources: readonly NativeOutputSource[];
    turnLabel: (runId: string) => string;
  },
) {
  useSyncExternalStore(input.cache.subscribe, input.cache.snapshot, input.cache.snapshot);
  const scopeValid = input.cache.valid(input.rootKey);
  const [states, setStates] = useState(new Map<string, OutputReadState>());
  const readers = [
    { sessionId: input.sessionId, runId: undefined, sourceLabel: undefined },
    ...input.sources.map((source) => ({
      sessionId: source.sessionId,
      runId: source.runId,
      sourceLabel: `来自子 Agent · ${source.name} · ${input.turnLabel(source.runId)}`,
    })),
  ].map((source) => ({ ...source, key: JSON.stringify([source.sessionId, source.runId]) }));
  const unique = [...new Map(readers.map((source) => [source.key, source])).values()];
  const membership = JSON.stringify(unique.map((source) => source.key));
  useEffect(() => {
    const retained = new Set<string>(JSON.parse(membership));
    setStates((previous) =>
      [...previous.keys()].every((key) => retained.has(key))
        ? previous
        : new Map([...previous].filter(([key]) => retained.has(key))),
    );
  }, [membership]);
  const active = unique.flatMap((source) => {
    const state = states.get(source.key);
    return state ? [{ source, state }] : [];
  });
  const items = [
    ...new Map(
      active.flatMap(({ source, state }) =>
        (state.page?.items ?? []).map(
          (file) =>
            [
              outputTargetKey(file),
              source.sourceLabel ? { ...file, sourceLabel: source.sourceLabel } : file,
            ] as const,
        ),
      ),
    ).values(),
  ];
  const next = active.find(({ state }) => state.page?.nextCursor);
  return (
    <>
      {unique.map((source) => (
        <OutputFileReader
          key={source.key}
          {...input}
          sessionId={source.sessionId}
          runId={source.runId}
          onState={(state) => setStates((previous) => new Map(previous).set(source.key, state))}
        />
      ))}
      <OutputReferences
        onOpen={input.actions.onOpen}
        onReveal={input.actions.onReveal}
        items={scopeValid ? items : []}
        onMore={next?.state.more}
        moreDisabled={active.length < unique.length || active.some(({ state }) => state.loading)}
      />
    </>
  );
}
