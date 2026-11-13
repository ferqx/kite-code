import type { OutputFilesPage, OutputFileTarget } from '@kite-ai/client';
import {
  type OutputFileSummary,
  OutputFiles,
  OutputReferences,
  type SessionFileTabRequest,
} from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import { NativeFilePreview } from './native-file-preview';
import type { OfficeEditContext, OfficeRequestOutcome } from './output-files-bridge';

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
  turnLabel: (runId: string) => string;
}) {
  const [request, setRequest] = useState<SessionFileTabRequest>();
  const sequence = useRef(0);
  const actions = {
    onOpen: (file: OutputFileSummary) =>
      setRequest({ target: target(file), title: file.name, requestId: ++sequence.current }),
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
  const key = JSON.stringify([input.generation, input.storeId, input.sessionId]);
  return {
    request:
      request &&
      request.target.storeId === input.storeId &&
      request.target.sessionId === input.sessionId
        ? request
        : undefined,
    references: (
      <>
        <OutputFileReader key={key} {...input} actions={actions} />
        {error && <p role="alert">{error}</p>}
      </>
    ),
    renderTurnOutputs: ({ turnId }: { turnId: string }) => {
      const runId = nativeOutputRunId(turnId, input.storeId, input.sessionId);
      return runId ? (
        <OutputFileReader key={`${key}/${turnId}`} {...input} runId={runId} actions={actions} />
      ) : null;
    },
    renderFile: ({ target: source }: { target: OutputFileTarget }) => (
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
function OutputFileReader(input: {
  bridge?: NativeBridge;
  generation: number;
  storeId?: string;
  sessionId?: string;
  revision: number;
  runId?: string;
  actions: React.ComponentProps<typeof OutputFiles> extends infer P
    ? Omit<Extract<P, object>, 'items' | 'collections'>
    : never;
}) {
  const [page, setPage] = useState<OutputFilesPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [read, setRead] = useState<{ kind: 'files' | 'collections'; cursor?: string }>({
    kind: 'files',
  });
  const [retryRevision, setRetryRevision] = useState(0);
  const retryPending = useRef(false);
  const lastRevision = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!input.bridge || !input.storeId || !input.sessionId) return;
    let cancelled = false;
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
        .then((result) => {
          if (cancelled) return;
          if (
            !result ||
            !('page' in result) ||
            !('kind' in result) ||
            result.kind !== 'outputs.page' ||
            result.page.scope.storeId !== input.storeId ||
            result.page.scope.sessionId !== input.sessionId
          )
            throw Error('output_scope_changed');
          setPage((previous) =>
            previous
              ? {
                  ...result.page,
                  // A refreshed head may have an unseen gap before the retained tail.
                  // Follow its cursor and deduplicate, never skip to the old tail cursor.
                  nextCursor: collectionCursor ? previous.nextCursor : result.page.nextCursor,
                  nextCollectionCursor: readCursor
                    ? previous.nextCollectionCursor
                    : result.page.nextCollectionCursor,
                  collections: collectionCursor
                    ? mergeCollections(previous.collections, result.page.collections)
                    : readCursor
                      ? previous.collections
                      : result.page.collections,
                  items: readCursor
                    ? [
                        ...previous.items,
                        ...result.page.items.filter(
                          (item) => !previous.items.some((old) => old.fileId === item.fileId),
                        ),
                      ]
                    : [
                        ...result.page.items,
                        ...previous.items.filter(
                          (item) => !result.page.items.some((head) => head.fileId === item.fileId),
                        ),
                      ],
                }
              : result.page,
          );
          setError('');
        })
        .catch(() => {
          if (!cancelled) setError('读取文件失败');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      cancelled = true;
    };
  }, [
    input.bridge,
    input.generation,
    input.storeId,
    input.sessionId,
    input.runId,
    input.revision,
    retryRevision,
    read,
  ]);
  return input.runId ? (
    <>
      <OutputFiles
        {...input.actions}
        items={page?.items ?? []}
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
      items={page?.items ?? []}
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
