import {
  type TrajectoryEvidenceSource,
  TrajectoryReplayController,
  type TrajectoryReplaySource,
} from '@kite-ai/client';
import {
  parseDecimal64,
  type TrajectoryProjection,
  trajectorySnapshotSchema,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import {
  Button,
  initialTrajectoryViewState,
  TrajectoryPanel,
  type TrajectoryViewState,
} from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type { NativeTrajectoryFileBridge } from './native-trajectory-file-bridge';
import { useTrajectoryMaterials } from './trajectory-materials';
import { mergeTrajectoryPresentation } from './trajectory-presentation-state';
import { readNativeTrajectoryView } from './trajectory-view';

function code(cause: unknown) {
  return cause instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(cause.message)
    ? cause.message
    : 'trajectory_bundle_unavailable';
}
export function offlineTrajectoryEvidenceSource(
  files: NativeTrajectoryFileBridge,
  bundleId: string,
): TrajectoryEvidenceSource {
  return {
    async openTrajectoryEvidence(request, options) {
      options?.signal?.throwIfAborted();
      const result = await files.request({ method: 'evidence.open', bundleId, request });
      if (result?.kind !== 'trajectory.evidence.opened')
        throw Error('trajectory_bundle_evidence_invalid');
      // Late opens are returned so the reader can close this original bundle's lease.
      return result.trajectory;
    },
    async readTrajectoryEvidenceChunk(request, options) {
      options?.signal?.throwIfAborted();
      const result = await files.request({
        method: 'evidence.read',
        bundleId,
        readId: request.readId,
        offset: request.offset,
        limit: request.limit,
      });
      options?.signal?.throwIfAborted();
      if (result?.kind !== 'trajectory.evidence.chunk')
        throw Error('trajectory_bundle_evidence_invalid');
      return result.trajectory;
    },
    closeTrajectoryEvidence(request) {
      return files.request({ method: 'evidence.close', bundleId, readId: request.readId });
    },
  };
}
/** This viewer receives only the local file port; no NativeCaller/Runtime/HTTP connection is accepted. */
export function OfflineTrajectoryViewer({ files }: { files: NativeTrajectoryFileBridge }) {
  const [view, setView] = useState(initialTrajectoryViewState());
  const state = useRef(view);
  const [projection, setProjection] = useState<TrajectoryProjection | null>(null);
  const [evidenceSource, setEvidenceSource] = useState<TrajectoryEvidenceSource | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [playing, setPlaying] = useState(false);
  const source = useRef<TrajectoryReplaySource | null>(null),
    player = useRef<TrajectoryReplayController | null>(null),
    bundleId = useRef<string | null>(null);
  const selected = useRef(0),
    reading = useRef(0),
    alive = useRef(true);
  const picking = useRef(false),
    detailReading = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const current = useRef({ rebuild: (_after?: string) => {} });
  const materialOwner = useTrajectoryMaterials({
    source: projection ? evidenceSource : null,
    snapshot: view.descriptor,
    cursor: view.cursor,
    ownerKey: bundleId.current ?? 'no_bundle',
  });
  const loopMaterialOwner = useTrajectoryMaterials({
    source: projection ? evidenceSource : null,
    snapshot: view.descriptor,
    cursor: view.cursor,
    ownerKey: `${bundleId.current ?? 'no_bundle'}:visible-agent-loops`,
    retainCommon: true,
  });
  const save = (value: TrajectoryViewState) => {
    state.current = value;
    if (alive.current) setView(value);
  };
  async function rebuild(after?: string) {
    const local = source.current,
      controller = player.current;
    if (!local || !controller) return;
    abort.current?.abort();
    const task = new AbortController();
    abort.current = task;
    const epoch = ++reading.current,
      selection = selected.current;
    detailReading.current = true;
    setLoading(true);
    try {
      const rendered = state.current;
      const result = await readNativeTrajectoryView(
        local,
        controller.state.cursor,
        undefined,
        task.signal,
        rendered.selectedNodeId ?? 'session',
        rendered.listMode,
        { treeOnly: true },
      );
      if (!alive.current || epoch !== reading.current || selection !== selected.current) return;
      setProjection(result.projection);
      const latest = state.current;
      save({
        ...latest,
        cursor: controller.state.cursor,
        mode: controller.state.mode,
        pageAfterCursor: result.navigation.after,
        selectedNodeId: latest.selectedNodeId,
        ...(after !== undefined && after !== state.current.pageAfterCursor
          ? { readingAnchor: { eventId: null, offset: 0, scrollTop: 0 } }
          : {}),
      });
      setError('');
    } catch (cause) {
      if (alive.current && !task.signal.aborted && epoch === reading.current) setError(code(cause));
    } finally {
      if (epoch === reading.current) {
        detailReading.current = false;
        if (alive.current) setLoading(picking.current);
      }
    }
  }
  current.current.rebuild = (after) => {
    void rebuild(after);
  };
  async function pick() {
    player.current?.pause();
    abort.current?.abort();
    const selection = ++selected.current;
    picking.current = true;
    setLoading(true);
    setError('');
    try {
      const value = await files.request({ method: 'pick' });
      if (!alive.current || selection !== selected.current) {
        if (value?.kind === 'trajectory.bundle.opened')
          await files.request({ method: 'close', bundleId: value.bundleId });
        return;
      }
      if (!value) return;
      if (value.kind !== 'trajectory.bundle.opened') throw Error('trajectory_bundle_reply_invalid');
      const snapshot = trajectorySnapshotSchema.parse(value.snapshot);
      if (parseDecimal64(value.minimumCursor) > parseDecimal64(snapshot.upperCursor))
        throw Error('trajectory_bundle_range_invalid');
      const id = value.bundleId;
      const local: TrajectoryReplaySource = {
        snapshot,
        offline: true,
        minimumCursor: value.minimumCursor,
        async readEvents(request, signal) {
          signal?.throwIfAborted();
          const result = await files.request({ method: 'events', bundleId: id, request });
          signal?.throwIfAborted();
          if (result?.kind !== 'trajectory.page') throw Error('trajectory_bundle_page_invalid');
          return verifyTrajectoryPage(result.trajectory, request);
        },
      };
      unsubscribe.current?.();
      const previousPlayer = player.current;
      player.current = null;
      previousPlayer?.close();
      // Main returns a new bundle only after retiring its previous file owner.
      // Closing that old id here would race the new viewer and report a false scope error.
      bundleId.current = id;
      setEvidenceSource(offlineTrajectoryEvidenceSource(files, id));
      source.current = local;
      const controller = new TrajectoryReplayController(local);
      player.current = controller;
      save({ ...initialTrajectoryViewState(snapshot), mode: 'replay' });
      setProjection(null);
      unsubscribe.current = controller.subscribe((value) => {
        if (!alive.current || player.current !== controller) return;
        setPlaying(value.playing);
        if (value.cursor !== state.current.cursor) {
          save({
            ...state.current,
            pageAfterCursor: undefined,
          });
          current.current.rebuild();
        } else if (value.mode !== state.current.mode) save({ ...state.current, mode: value.mode });
      });
      await rebuild();
    } catch (cause) {
      if (alive.current && selection === selected.current) {
        setError(code(cause));
        setProjection(null);
      }
    } finally {
      if (alive.current && selection === selected.current) {
        picking.current = false;
        if (!detailReading.current) setLoading(false);
      }
    }
  }
  // The window was opened by a file/menu action; Main consumes a preselected OS path or asks explicitly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: This dedicated window owns one immutable file port.
  useEffect(() => {
    void pick();
    return () => {
      alive.current = false;
      selected.current++;
      reading.current++;
      abort.current?.abort();
      unsubscribe.current?.();
      const closed = player.current;
      player.current = null;
      closed?.close();
      const id = bundleId.current;
      bundleId.current = null;
      if (id) void files.request({ method: 'close', bundleId: id }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      void player.current?.tick().catch((cause) => {
        if (alive.current) setError(code(cause));
      });
    }, 800);
    return () => clearInterval(timer);
  }, [playing]);
  useEffect(() => {
    const visibility = () => {
      player.current?.setVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  return (
    <main className="kite-client trajectory-offline-window">
      <header className="trajectory-offline-heading">
        <h1>离线执行轨迹</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void pick();
          }}
          disabled={loading}
        >
          选择轨迹文件
        </Button>
        <p>仅查看所选包中的已保存记录，不连接模型或恢复执行。</p>
      </header>
      <TrajectoryPanel
        offline
        state={view}
        onStateChange={(update) => {
          const previous = state.current;
          const merged = mergeTrajectoryPresentation(previous, view, update);
          if (merged === previous) return;
          save(merged);
        }}
        {...materialOwner}
        loopMaterials={loopMaterialOwner.materials}
        onLoopMaterialsChange={loopMaterialOwner.onMaterialsChange}
        onLoopMaterialsRetry={loopMaterialOwner.onMaterialsRetry}
        events={[]}
        projection={projection}
        integrity={
          projection?.integrity ?? {
            facts: 'unknown',
            identityConfidence: 'verified_origin',
            reasons: [],
          }
        }
        mode={view.mode ?? 'replay'}
        playing={playing}
        loading={loading}
        exhausted={projection !== null}
        errorCode={error || undefined}
        onRetry={() => current.current.rebuild()}
        onSeek={(cursor) => {
          try {
            player.current?.seek(cursor);
          } catch (cause) {
            setError(code(cause));
          }
        }}
        onStep={(direction) => {
          void player.current?.step(direction).catch((cause) => setError(code(cause)));
        }}
        onPlay={() => player.current?.play()}
        onPause={() => player.current?.pause()}
        onReturnToLatest={() => {
          const before = state.current.cursor;
          save({ ...state.current, pageAfterCursor: undefined });
          void player.current
            ?.returnToLatest()
            .then(() => {
              if (state.current.cursor === before) current.current.rebuild();
            })
            .catch((cause) => setError(code(cause)));
        }}
        onOpenOffline={() => {
          void pick();
        }}
      />
    </main>
  );
}
