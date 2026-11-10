import { type TrajectoryEvidenceSource, TrajectoryReplayController } from '@kite-ai/client';
import {
  parseDecimal64,
  type TrajectoryProjection,
  type TrajectorySnapshot,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import {
  initialTrajectoryViewState,
  TrajectoryPanel,
  type TrajectoryViewState,
} from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import {
  loadNativeTrajectory,
  type NativeTrajectoryLoaded,
  openNativeTrajectorySnapshot,
} from './trajectory-bridge';
import { useTrajectoryMaterials } from './trajectory-materials';
import { mergeTrajectoryPresentation } from './trajectory-presentation-state';
import {
  type RelatedTrajectoryScope,
  type RelatedTrajectoryTarget,
  useRelatedTrajectories,
} from './trajectory-related';
import { readNativeTrajectoryView } from './trajectory-view';

export interface NativeTrajectoryProps {
  bridge: NativeBridge;
  generation: number;
  storeId: string;
  sessionId: string;
  selection?: number;
  stateCache: {
    get(key: string): TrajectoryViewState | undefined;
    set(key: string, state: TrajectoryViewState): void;
  };
}
function errorCode(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : '';
  return /^[a-z][a-z0-9_]{0,100}$/.test(value) ? value : 'trajectory_unavailable';
}
function pageRequest(snapshot: TrajectorySnapshot, afterCursor: string, limit = 200) {
  return {
    storeId: snapshot.storeId,
    sessionId: snapshot.sessionId,
    ...(snapshot.runId ? { runId: snapshot.runId } : {}),
    ...(snapshot.executionId ? { executionId: snapshot.executionId } : {}),
    ...(snapshot.eventKinds ? { eventKinds: snapshot.eventKinds } : {}),
    afterCursor,
    upperCursor: snapshot.upperCursor,
    limit,
  };
}
/** Online tree loading and local replay have separate lifetimes. */
export function NativeTrajectory(props: NativeTrajectoryProps) {
  const ownerKey = JSON.stringify([
    props.generation,
    props.storeId,
    props.sessionId,
    props.selection ?? null,
  ]);
  return <TrajectoryOwner key={ownerKey} {...props} />;
}
function TrajectoryOwner({
  bridge,
  generation,
  storeId,
  sessionId,
  stateCache,
}: NativeTrajectoryProps) {
  const cacheKey = JSON.stringify([storeId, sessionId]);
  const [view, setView] = useState<TrajectoryViewState>(() =>
    structuredClone(
      stateCache.get(cacheKey) ?? { ...initialTrajectoryViewState(), mode: 'history' },
    ),
  );
  const viewRef = useRef(view);
  const [projection, setProjection] = useState<TrajectoryProjection | null>(null);
  const [loading, setLoading] = useState(true),
    [failure, setFailure] = useState('');
  const [playing, setPlaying] = useState(false),
    [newEvents, setNewEvents] = useState(false);
  const loaded = useRef<NativeTrajectoryLoaded | null>(null),
    controller = useRef<TrajectoryReplayController | null>(null);
  const connectionLive = useRef(true);
  const connectionEpoch = useRef(0);
  const alive = useRef(true),
    epoch = useRef(0),
    viewEpoch = useRef(0);
  const loaderAbort = useRef<AbortController | null>(null),
    viewAbort = useRef<AbortController | null>(null);
  const wakeBusy = useRef(false),
    viewReading = useRef(false);
  const pendingWake = useRef(false),
    busy = useRef(false),
    sawInitial = useRef(false),
    hintedThrough = useRef('0');
  const removeControllerListener = useRef<(() => void) | null>(null);
  const operations = useRef({
    wake: () => {},
    reload: () => {},
    rebuild: (_after?: string) => {},
  });
  const evidenceSource = useMemo<TrajectoryEvidenceSource>(
    () => ({
      async openTrajectoryEvidence(request, options) {
        options?.signal?.throwIfAborted();
        const value = await bridge.request({
          method: 'trajectory.evidence.open',
          generation,
          request,
        });
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'trajectory.evidence.opened' ||
          !('trajectory' in value)
        )
          throw Error('trajectory_evidence_reply_invalid');
        // Even an aborted late open must reach the reader's finally/close path.
        return value.trajectory;
      },
      async readTrajectoryEvidenceChunk(request, options) {
        options?.signal?.throwIfAborted();
        const value = await bridge.request({
          method: 'trajectory.evidence.read',
          generation,
          request,
        });
        options?.signal?.throwIfAborted();
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'trajectory.evidence.chunk' ||
          !('trajectory' in value)
        )
          throw Error('trajectory_evidence_reply_invalid');
        return value.trajectory;
      },
      closeTrajectoryEvidence(request) {
        return bridge.request({ method: 'trajectory.evidence.close', generation, request });
      },
    }),
    [bridge, generation],
  );
  const [childTargets, setChildTargets] = useState<readonly RelatedTrajectoryTarget[]>([]);
  const onExpandedChildrenChange = useCallback(
    (targets: readonly RelatedTrajectoryTarget[]) =>
      setChildTargets((previous) =>
        JSON.stringify(previous) === JSON.stringify(targets) ? previous : targets,
      ),
    [],
  );
  const related = useRelatedTrajectories({
    bridge,
    generation,
    snapshot: view.descriptor,
    cursor: view.cursor,
    targets: childTargets,
    enabled: !!projection && connectionLive.current,
  });
  // Retain already-read metadata through disconnection; it never grants a material read.
  const relatedCache = useRef<{
    bridge: NativeBridge;
    key: string;
    scopes: Map<string, RelatedTrajectoryScope>;
  }>({
    bridge,
    key: '',
    scopes: new Map(),
  });
  const relatedKey = JSON.stringify([
    storeId,
    sessionId,
    view.descriptor?.upperCursor,
    view.cursor,
  ]);
  if (relatedCache.current.bridge !== bridge || relatedCache.current.key !== relatedKey)
    relatedCache.current = { bridge, key: relatedKey, scopes: new Map() };
  for (const scope of related.scopes)
    if (scope.projection) relatedCache.current.scopes.set(scope.parentNodeId, scope);
  for (const parent of relatedCache.current.scopes.keys())
    if (!childTargets.some((target) => target.parentNodeId === parent))
      relatedCache.current.scopes.delete(parent);
  // biome-ignore lint/correctness/useExhaustiveDependencies: relatedKey also invalidates the retained metadata cache.
  const relatedDisplay = useMemo(
    () =>
      childTargets.flatMap((target) => {
        const current = related.scopes.find((scope) => scope.parentNodeId === target.parentNodeId);
        if (current?.projection) return [current];
        const retained = relatedCache.current.scopes.get(target.parentNodeId);
        return retained
          ? [{ ...retained, status: current?.status ?? ('unavailable' as const) }]
          : current
            ? [current]
            : [];
      }),
    [related.scopes, childTargets, relatedKey],
  );
  const materialOwner = useTrajectoryMaterials({
    source: projection && connectionLive.current ? evidenceSource : null,
    snapshot: view.descriptor,
    cursor: view.cursor,
    ownerKey: JSON.stringify([generation, storeId, sessionId]),
    relatedSnapshots: related.snapshots,
  });
  const loopMaterialOwner = useTrajectoryMaterials({
    source: projection && connectionLive.current ? evidenceSource : null,
    snapshot: view.descriptor,
    cursor: view.cursor,
    ownerKey: JSON.stringify([generation, storeId, sessionId, 'visible-agent-loops']),
    relatedSnapshots: related.snapshots,
    retainCommon: true,
  });
  const save = (state: TrajectoryViewState) => {
    viewRef.current = state;
    stateCache.set(cacheKey, structuredClone(state));
    if (alive.current) setView(state);
  };
  async function rebuild(windowAfter?: string) {
    const source = loaded.current?.source,
      player = controller.current;
    if (!source || !player) return;
    viewAbort.current?.abort();
    const abort = new AbortController();
    viewAbort.current = abort;
    const current = ++viewEpoch.current;
    const state = viewRef.current;
    const cursor = player.state.cursor;
    viewReading.current = true;
    if (alive.current) setLoading(true);
    try {
      const result = await readNativeTrajectoryView(
        source,
        cursor,
        undefined,
        abort.signal,
        state.selectedNodeId ?? 'session',
        state.listMode,
        { treeOnly: true },
      );
      if (!alive.current || current !== viewEpoch.current || abort.signal.aborted) return;
      setProjection(result.projection);
      const latest = viewRef.current;
      save({
        ...latest,
        cursor,
        descriptor: source.snapshot,
        pageAfterCursor: result.navigation.after,
        selectedNodeId: latest.selectedNodeId,
        mode: player.state.mode,
        ...(windowAfter !== undefined && windowAfter !== state.pageAfterCursor
          ? { readingAnchor: { eventId: null, offset: 0, scrollTop: 0 } }
          : {}),
      });
      setFailure('');
    } catch (cause) {
      if (alive.current && !abort.signal.aborted && current === viewEpoch.current)
        setFailure(errorCode(cause));
    } finally {
      if (current === viewEpoch.current) {
        viewReading.current = false;
        if (alive.current) setLoading(busy.current);
      }
    }
  }
  operations.current.rebuild = (after) => {
    void rebuild(after);
  };
  async function load(latest: boolean) {
    if (!connectionLive.current) return;
    if (busy.current) {
      pendingWake.current = true;
      return;
    }
    busy.current = true;
    loaderAbort.current?.abort();
    const abort = new AbortController();
    loaderAbort.current = abort;
    const current = ++epoch.current;
    if (alive.current) {
      setLoading(true);
      setFailure('');
    }
    controller.current?.pause();
    try {
      const now = await openNativeTrajectorySnapshot(
        bridge,
        generation,
        { storeId, sessionId },
        abort.signal,
      );
      const retained = !latest ? viewRef.current.descriptor : null;
      if (retained && parseDecimal64(retained.upperCursor) > parseDecimal64(now.upperCursor))
        throw Error('history_unavailable');
      const snapshot: TrajectorySnapshot = retained
        ? {
            ...now,
            upperCursor: retained.upperCursor,
            historyCoverage: { ...now.historyCoverage, upperCursor: retained.upperCursor },
          }
        : now;
      const previous = loaded.current;
      const fresh = await loadNativeTrajectory({
        bridge,
        generation,
        snapshot,
        previous: previous?.source,
        signal: abort.signal,
      });
      if (!alive.current || current !== epoch.current || abort.signal.aborted) {
        await fresh.close();
        return;
      }
      removeControllerListener.current?.();
      controller.current?.close();
      loaded.current = fresh;
      const mode = latest ? 'live' : (viewRef.current.mode ?? 'history');
      const cursor = latest || !retained ? snapshot.upperCursor : viewRef.current.cursor;
      const player = new TrajectoryReplayController(
        { ...fresh.source, offline: false },
        { mode, cursor },
      );
      controller.current = player;
      player.setVisible(document.visibilityState !== 'hidden');
      save({
        ...viewRef.current,
        ...(latest ? { pageAfterCursor: undefined } : {}),
      });
      removeControllerListener.current = player.subscribe((state) => {
        if (!alive.current || controller.current !== player) return;
        setPlaying(state.playing);
        if (state.cursor !== viewRef.current.cursor) {
          save({
            ...viewRef.current,
            pageAfterCursor: undefined,
          });
          operations.current.rebuild();
        } else if (state.mode !== viewRef.current.mode)
          save({ ...viewRef.current, mode: state.mode });
      });
      await rebuild(latest ? undefined : viewRef.current.pageAfterCursor);
      if (previous) await previous.close();
      if (alive.current && current === epoch.current) {
        setNewEvents(false);
        hintedThrough.current = snapshot.upperCursor;
      }
    } catch (cause) {
      if (alive.current && !abort.signal.aborted && current === epoch.current) {
        setFailure(errorCode(cause));
        setProjection(null);
        controller.current?.close();
        controller.current = null;
      }
    } finally {
      busy.current = false;
      if (alive.current && current === epoch.current && !viewReading.current) setLoading(false);
      if (alive.current && !sawInitial.current) {
        sawInitial.current = true;
        pendingWake.current = true;
      }
      if (alive.current && pendingWake.current) {
        pendingWake.current = false;
        operations.current.wake();
      }
    }
  }
  operations.current.reload = () => {
    void load(true);
  };
  async function wake() {
    if (!alive.current || !connectionLive.current) return;
    if (busy.current || wakeBusy.current) {
      pendingWake.current = true;
      return;
    }
    if (!loaded.current || !controller.current) return;
    wakeBusy.current = true;
    const snapshot = loaded.current.source.snapshot;
    const expected = epoch.current;
    const expectedConnection = connectionEpoch.current;
    const admitted = () =>
      alive.current &&
      connectionLive.current &&
      epoch.current === expected &&
      connectionEpoch.current === expectedConnection;
    try {
      const now = await openNativeTrajectorySnapshot(bridge, generation, { storeId, sessionId });
      if (!admitted()) return;
      if (parseDecimal64(now.upperCursor) <= parseDecimal64(snapshot.upperCursor)) {
        setFailure('');
        return;
      }
      if (controller.current.state.mode === 'live') {
        await load(true);
        return;
      }
      if (newEvents) return;
      let after =
        parseDecimal64(hintedThrough.current) > parseDecimal64(snapshot.upperCursor)
          ? hintedThrough.current
          : snapshot.upperCursor;
      while (parseDecimal64(after) < parseDecimal64(now.upperCursor)) {
        const request = pageRequest(now, after, 1);
        const value = await bridge.request({ method: 'trajectory.events', generation, request });
        if (!admitted()) return;
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'trajectory.page' ||
          !('trajectory' in value)
        )
          throw Error('trajectory_page_invalid');
        const page = verifyTrajectoryPage(value.trajectory, request);
        if (page.events.length) {
          setNewEvents(true);
          return;
        }
        after = page.scannedThrough;
      }
      hintedThrough.current = now.upperCursor;
    } catch (cause) {
      if (admitted()) {
        setFailure(errorCode(cause));
      }
    } finally {
      wakeBusy.current = false;
      if (alive.current && pendingWake.current && !busy.current) {
        pendingWake.current = false;
        operations.current.wake();
      }
    }
  }
  operations.current.wake = () => {
    void wake();
  };
  // The local watcher is installed before open; the extra wake after loading closes the open/subscribe race.
  // biome-ignore lint/correctness/useExhaustiveDependencies: This keyed owner fixes bridge/source/generation for its complete lifetime.
  useEffect(() => {
    alive.current = true;
    const unwatch = bridge.watch((event) => {
      if (event.kind === 'lifecycle' && event.phase === 'quitting') {
        connectionEpoch.current++;
        connectionLive.current = false;
        loaderAbort.current?.abort();
        viewAbort.current?.abort();
        controller.current?.pause();
        setFailure('trajectory_connection_unavailable');
      } else if (event.kind === 'lifecycle') {
        connectionLive.current = true;
        if (!loaded.current || !controller.current) void load(false);
        else operations.current.wake();
      } else if (event.generation === generation) operations.current.wake();
    });
    void load(false);
    return () => {
      alive.current = false;
      epoch.current++;
      viewEpoch.current++;
      unwatch();
      loaderAbort.current?.abort();
      viewAbort.current?.abort();
      removeControllerListener.current?.();
      const closed = controller.current;
      controller.current = null;
      closed?.close();
      const old = loaded.current;
      loaded.current = null;
      void old?.close().catch(() => {});
      void bridge.request({ method: 'trajectory.cancel', generation }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      void controller.current?.tick().catch((cause) => {
        if (alive.current) setFailure(errorCode(cause));
      });
    }, 800);
    return () => clearInterval(timer);
  }, [playing]);
  useEffect(() => {
    const visibility = () => controller.current?.setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  return (
    <TrajectoryPanel
      state={view}
      onStateChange={(update) => {
        const current = viewRef.current;
        const merged = mergeTrajectoryPresentation(current, view, update);
        if (merged === current) return;
        const readingDetail =
          merged.detailOpen &&
          (merged.selectedNodeId !== current.selectedNodeId ||
            merged.selectedRequestId !== current.selectedRequestId ||
            merged.requestTab !== current.requestTab ||
            merged.workbenchTab !== current.workbenchTab ||
            merged.detailOpen !== current.detailOpen);
        const readingHistory = merged.readingAnchor.scrollTop !== current.readingAnchor.scrollTop;
        if ((readingDetail || readingHistory) && controller.current?.state.mode === 'live')
          controller.current.setMode('history');
        save({ ...merged, mode: controller.current?.state.mode ?? merged.mode });
      }}
      {...materialOwner}
      loopMaterials={loopMaterialOwner.materials}
      onLoopMaterialsChange={loopMaterialOwner.onMaterialsChange}
      onLoopMaterialsRetry={loopMaterialOwner.onMaterialsRetry}
      relatedTrajectories={relatedDisplay}
      onExpandedChildrenChange={onExpandedChildrenChange}
      events={[]}
      projection={projection}
      integrity={
        projection?.integrity ?? {
          facts: 'unknown',
          identityConfidence: 'verified_origin',
          reasons: [],
        }
      }
      mode={view.mode ?? 'live'}
      playing={playing}
      loading={loading}
      exhausted={loaded.current !== null}
      newEventsAvailable={newEvents}
      errorCode={failure || undefined}
      onRetry={() => {
        void load(false);
      }}
      onSeek={(cursor) => {
        try {
          controller.current?.seek(cursor);
        } catch (cause) {
          setFailure(errorCode(cause));
        }
      }}
      onStep={(direction) => {
        void controller.current?.step(direction).catch((cause) => setFailure(errorCode(cause)));
      }}
      onPlay={() => controller.current?.play()}
      onPause={() => controller.current?.pause()}
      onReturnToLatest={() => operations.current.reload()}
      onOpenOffline={
        bridge.trajectoryFiles
          ? () => {
              void bridge
                .trajectoryFiles!.request({ method: 'pick' })
                .catch((cause) => setFailure(errorCode(cause)));
            }
          : undefined
      }
      onExport={
        bridge.trajectoryFiles && view.descriptor
          ? (includeEvidence) => {
              void bridge
                .trajectoryFiles!.request({
                  method: 'export',
                  generation,
                  snapshot: view.descriptor!,
                  includeEvidence,
                })
                .catch((cause) => setFailure(errorCode(cause)));
            }
          : undefined
      }
    />
  );
}
