import type { OutputFilesPage, OutputFileTarget } from '@kite-ai/client';
import {
  type OutputFileSummary,
  OutputFiles,
  OutputReferences,
  type SessionFileTabRequest,
  type SessionFileTarget,
  useConversationReadActive,
} from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import { NativeFilePreview } from './native-file-preview';
import { NativeLocalFilePreview } from './native-local-file-preview';
import type {
  LocalOfficeRequest,
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
  const key = JSON.stringify([input.generation, input.storeId, input.sessionId]);
  const [sourceState, setSourceState] = useState<{
    key: string;
    sources: NativeOutputSource[];
    revision: number;
    error?: string;
  }>();
  const sources = sourceState?.key === key ? sourceState.sources : [];
  const sourceError = sourceState?.key === key ? sourceState.error : undefined;
  useEffect(() => {
    if (!input.bridge || !input.storeId || !input.sessionId) return;
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
        setSourceState({ key, sources: result.sources, revision: input.revision });
      } catch {
        if (cancelled) return;
        setSourceState((previous) => ({
          key,
          revision: input.revision,
          sources: previous?.key === key ? previous.sources : [],
          error: '子 Agent 文件暂时无法更新',
        }));
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
  }, [input.bridge, input.generation, input.storeId, input.sessionId, input.revision, key]);
  useEffect(() => {
    setRequest((previous) => (previous?.scope === key ? previous : undefined));
  }, [key]);
  const sequence = useRef(0);
  const actions = {
    onOpen: (file: OutputFileSummary) =>
      setRequest({
        scope: key,
        ownerRunId: file.ownerRunId,
        value: { target: target(file), title: file.name, requestId: ++sequence.current },
      }),
    onSave: (file: OutputFileSummary) => {
      void input.bridge
        ?.request({ method: 'outputs.save', generation: input.generation, target: target(file) })
        .catch(() => setError('另存失败，请重试'));
    },
    onEdit: (file: OutputFileSummary, context?: OfficeEditContext) => {
      void input.onEdit(file, context).catch(() => setError('无法附加文件，请重试'));
    },
    turnLabel: input.turnLabel,
  };
  const [error, setError] = useState('');
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
      <>
        <OutputReferenceReaders
          key={key}
          {...input}
          sources={sources}
          sourceError={sourceError}
          actions={actions}
        />
        {error && <p role="alert">{error}</p>}
      </>
    ),
    renderTurnOutputs: ({ turnId }: { turnId: string }) => {
      const runId = nativeOutputRunId(turnId, input.storeId, input.sessionId);
      return runId ? (
        <>
          <OutputFileReader key={`${key}/${turnId}`} {...input} runId={runId} actions={actions} />
          {sources
            .filter((source) => source.parentRunId === runId)
            .map((source) => (
              <OutputFileReader
                key={`${key}/${source.sessionId}/${source.runId}`}
                {...input}
                sessionId={source.sessionId}
                runId={source.runId}
                sourceLabel={`来自子 Agent · ${source.name} · ${input.turnLabel(source.runId)}`}
                actions={actions}
              />
            ))}
        </>
      ) : null;
    },
    renderChildTurnOutputs: (sessionId: string, { turnId }: { turnId: string }) => {
      const runId = nativeOutputRunId(turnId, input.storeId, sessionId);
      return runId &&
        sources.some((source) => source.sessionId === sessionId && source.runId === runId) ? (
        <OutputFileReader
          key={`${key}/${sessionId}/${runId}`}
          {...input}
          sessionId={sessionId}
          runId={runId}
          actions={actions}
        />
      ) : null;
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
type OutputReadState = {
  page?: OutputFilesPage;
  error: string;
  loading: boolean;
  more: () => void;
};
type OutputReaderInput = {
  bridge?: NativeBridge;
  generation: number;
  storeId?: string;
  sessionId?: string;
  revision: number;
  runId?: string;
  sourceLabel?: string;
  collect?: boolean;
  onState?: (state: OutputReadState) => void;
  actions: React.ComponentProps<typeof OutputFiles> extends infer P
    ? Omit<Extract<P, object>, 'items' | 'collections'>
    : never;
};
function OutputFileReader(input: OutputReaderInput) {
  const readActive = useConversationReadActive();
  const [page, setPage] = useState<OutputFilesPage>();
  const pageRef = useRef(page);
  pageRef.current = page;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [read, setRead] = useState<{ kind: 'files' | 'collections'; cursor?: string }>({
    kind: 'files',
  });
  const [retryRevision, setRetryRevision] = useState(0);
  const retryPending = useRef(false);
  const readFailures = useRef(0);
  const lastRevision = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!readActive || !input.bridge || !input.storeId || !input.sessionId) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const revision = `${input.revision}/${retryRevision}`;
    const continuation = lastRevision.current === revision;
    const readCursor = continuation && read.kind === 'files' ? read.cursor : undefined;
    const collectionCursor = continuation && read.kind === 'collections' ? read.cursor : undefined;
    lastRevision.current = revision;
    setLoading(true);
    const timer = setTimeout(() => {
      void input
        .bridge!.request({
          method: 'outputs.query',
          generation: input.generation,
          scope: { storeId: input.storeId!, sessionId: input.sessionId! },
          runId: input.runId,
          limit: 50,
          beforeKey: readCursor,
          collectionBeforeKey: collectionCursor,
        })
        .then(async (result) => {
          if (cancelled) return;
          if (
            !result ||
            !('page' in result) ||
            !('kind' in result) ||
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
          const previous = pageRef.current;
          if (
            (readCursor || collectionCursor) &&
            previous &&
            previous.revision !== result.page.revision
          ) {
            // Never merge a continuation from a different storage snapshot.
            setRetryRevision((value) => value + 1);
            return;
          }
          let incoming = result.page;
          if (!readCursor && !collectionCursor) {
            // Rebuild the loaded window atomically. Retaining an old tail can resurrect
            // a superseded delivery that the authoritative head no longer contains.
            const wanted = Math.max(50, previous?.items.length ?? 0);
            const seen = new Set<string>();
            while (incoming.nextCursor && incoming.items.length < wanted) {
              if (cancelled) return;
              const cursor = incoming.nextCursor;
              if (seen.has(cursor)) throw Error('output_cursor_repeated');
              seen.add(cursor);
              const next = await input.bridge!.request({
                method: 'outputs.query',
                generation: input.generation,
                scope: { storeId: input.storeId!, sessionId: input.sessionId! },
                runId: input.runId,
                limit: 50,
                beforeKey: cursor,
              });
              if (cancelled) return;
              if (
                !next ||
                !('kind' in next) ||
                !('page' in next) ||
                next.kind !== 'outputs.page' ||
                next.page.scope.storeId !== input.storeId ||
                next.page.scope.sessionId !== input.sessionId ||
                next.page.revision !== incoming.revision ||
                !outputPageMatches(next.page, {
                  storeId: input.storeId,
                  sessionId: input.sessionId,
                  runId: input.runId,
                })
              )
                throw Error('output_snapshot_changed');
              incoming = {
                ...incoming,
                nextCursor: next.page.nextCursor,
                items: [
                  ...incoming.items,
                  ...next.page.items.filter(
                    (item) =>
                      !incoming.items.some((old) => outputTargetKey(old) === outputTargetKey(item)),
                  ),
                ],
              };
            }
          }
          if (cancelled) return;
          setPage(
            previous && (readCursor || collectionCursor)
              ? {
                  ...incoming,
                  nextCursor: collectionCursor ? previous.nextCursor : incoming.nextCursor,
                  nextCollectionCursor: readCursor
                    ? previous.nextCollectionCursor
                    : incoming.nextCollectionCursor,
                  collections: collectionCursor
                    ? mergeCollections(previous.collections, incoming.collections)
                    : previous.collections,
                  items: readCursor
                    ? [
                        ...previous.items,
                        ...incoming.items.filter(
                          (item) =>
                            !previous.items.some(
                              (old) => outputTargetKey(old) === outputTargetKey(item),
                            ),
                        ),
                      ]
                    : previous.items,
                }
              : incoming,
          );
          readFailures.current = 0;
          setError('');
        })
        .catch(() => {
          if (cancelled) return;
          if (!input.runId || input.collect) setError('读取文件失败');
          retry = setTimeout(
            () => setRetryRevision((value) => value + 1),
            500 * 2 ** Math.min(readFailures.current++, 4),
          );
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      clearTimeout(retry);
      cancelled = true;
    };
  }, [
    input.bridge,
    input.generation,
    input.storeId,
    input.sessionId,
    input.runId,
    input.collect,
    input.revision,
    readActive,
    retryRevision,
    read,
  ]);
  const onState = useRef(input.onState);
  onState.current = input.onState;
  useEffect(() => {
    onState.current?.({
      page,
      error,
      loading,
      more: () => setRead({ kind: 'files', cursor: page?.nextCursor }),
    });
  }, [page, error, loading]);
  if (input.collect) return null;
  const items = (page?.items ?? []).map((file) =>
    input.sourceLabel ? { ...file, sourceLabel: input.sourceLabel } : file,
  );
  return input.runId ? (
    <>
      <OutputFiles
        {...input.actions}
        items={items}
        collections={page?.collections}
        onRetry={(collectionId) => {
          const collection = page?.collections.find((item) => item.collectionId === collectionId);
          if (
            !collection ||
            !input.bridge ||
            !input.storeId ||
            !input.sessionId ||
            retryPending.current
          )
            return;
          retryPending.current = true;
          void input.bridge
            .request({
              method: 'outputs.retry',
              generation: input.generation,
              scope: { storeId: input.storeId, sessionId: input.sessionId },
              collectionId,
              expectedRevision: collection.revision,
            })
            .then(() => {
              setError('');
              setRetryRevision((value) => value + 1);
            })
            .catch(() => setError('重试整理失败，请重新读取后重试'))
            .finally(() => {
              retryPending.current = false;
            });
        }}
      />
      {page?.nextCollectionCursor && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setRead({ kind: 'collections', cursor: page.nextCollectionCursor })}
        >
          更多整理状态
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {page?.nextCursor && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setRead({ kind: 'files', cursor: page.nextCursor })}
        >
          加载更多文件
        </button>
      )}
    </>
  ) : (
    <OutputReferences
      {...input.actions}
      items={items}
      hasMore={!!page?.nextCursor}
      onMore={() => setRead({ kind: 'files', cursor: page?.nextCursor })}
      loading={loading}
      error={error}
    />
  );
}

function mergeCollections(
  previous: OutputFilesPage['collections'],
  incoming: OutputFilesPage['collections'],
) {
  const merged = new Map(previous.map((item) => [item.collectionId, item]));
  for (const item of incoming) {
    const old = merged.get(item.collectionId);
    if (!old || BigInt(item.revision) >= BigInt(old.revision)) merged.set(item.collectionId, item);
  }
  return [...merged.values()];
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
    sourceError?: string;
  },
) {
  const [states, setStates] = useState(new Map<string, OutputReadState>());
  const readers = [
    { sessionId: input.sessionId, runId: undefined, sourceLabel: undefined },
    ...input.sources.map((source) => ({
      sessionId: source.sessionId,
      runId: source.runId,
      sourceLabel: `来自子 Agent · ${source.name} · ${input.actions.turnLabel?.(source.runId) ?? source.runId}`,
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
          collect
          onState={(state) => setStates((previous) => new Map(previous).set(source.key, state))}
        />
      ))}
      <OutputReferences
        {...input.actions}
        items={items}
        hasMore={!!next}
        onMore={() => next?.state.more()}
        loading={active.length < unique.length || active.some(({ state }) => state.loading)}
        error={input.sourceError || active.find(({ state }) => state.error)?.state.error}
      />
    </>
  );
}
