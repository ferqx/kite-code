import {
  canonicalSerialize,
  parseDecimal64,
  type TrajectoryProjection,
  type TrajectorySnapshot,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import { useEffect, useMemo, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import { loadNativeTrajectory, openNativeTrajectorySnapshot } from './trajectory-bridge';
import { readNativeTrajectoryView } from './trajectory-view';

export interface RelatedTrajectoryTarget {
  parentNodeId: string;
  sessionId: string;
  runId: string;
  /** Exact original carrier, used to revalidate Main after a hidden reader was released. */
  carrierExecutionId?: string;
}
export interface RelatedTrajectoryScope {
  parentNodeId: string;
  projection: TrajectoryProjection | null;
  snapshot?: TrajectorySnapshot;
  status?: 'loading' | 'unavailable';
}

function matches(scope: RelatedTrajectoryScope, target: RelatedTrajectoryTarget) {
  return (
    scope.parentNodeId === target.parentNodeId &&
    scope.snapshot?.sessionId === target.sessionId &&
    scope.snapshot.runId === target.runId
  );
}

/** Only explicitly expanded, proven child scopes. Each read retains the parent's exact as-of bound. */
export function useRelatedTrajectories({
  bridge,
  generation,
  snapshot,
  cursor,
  targets,
  enabled,
}: {
  bridge: NativeBridge;
  generation: number;
  snapshot: TrajectorySnapshot | null;
  cursor: string;
  targets: readonly RelatedTrajectoryTarget[];
  enabled: boolean;
}) {
  const sourceKey = canonicalSerialize({
    generation,
    store: snapshot?.storeId ?? null,
    session: snapshot?.sessionId ?? null,
    upper: snapshot?.upperCursor ?? null,
    cursor,
    enabled,
  });
  const key = canonicalSerialize({ sourceKey, targets });
  const [result, setResult] = useState<{
    bridge: NativeBridge;
    sourceKey: string;
    scopes: RelatedTrajectoryScope[];
  }>({ bridge, sourceKey: '', scopes: [] });
  const retained = result.bridge === bridge && result.sourceKey === sourceKey ? result.scopes : [];
  // The key includes every fixed source/target/as-of value; retained results must not restart a read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The immutable read contract is represented by key.
  useEffect(() => {
    const abort = new AbortController();
    if (!enabled || !snapshot || !targets.length) {
      setResult({ bridge, sourceKey, scopes: [] });
      return () => abort.abort();
    }
    const scopes: RelatedTrajectoryScope[] = targets.map(
      (target) =>
        retained.find((scope) => matches(scope, target)) ?? {
          parentNodeId: target.parentNodeId,
          projection: null,
          status: 'loading',
        },
    );
    setResult({ bridge, sourceKey, scopes: [...scopes] });
    let next = 0;
    const read = async () => {
      for (;;) {
        const index = next++,
          target = targets[index];
        if (!target || abort.signal.aborted) return;
        if (scopes[index]?.projection) continue;
        let loaded: Awaited<ReturnType<typeof loadNativeTrajectory>> | undefined;
        try {
          if (target.sessionId === snapshot.sessionId)
            throw Error('trajectory_child_scope_invalid');
          if (parseDecimal64(cursor) > parseDecimal64(snapshot.upperCursor))
            throw Error('trajectory_child_history_unavailable');
          if (target.carrierExecutionId) {
            let afterCursor = '0';
            for (;;) {
              abort.signal.throwIfAborted();
              const request = {
                storeId: snapshot.storeId,
                sessionId: snapshot.sessionId,
                executionId: target.carrierExecutionId,
                eventKinds: ['job'] as const,
                upperCursor: cursor,
                afterCursor,
                limit: 200,
              };
              const value = await bridge.request({
                method: 'trajectory.events',
                generation,
                request: { ...request, eventKinds: [...request.eventKinds] },
              });
              abort.signal.throwIfAborted();
              if (
                !value ||
                !('kind' in value) ||
                value.kind !== 'trajectory.page' ||
                !('trajectory' in value)
              )
                throw Error('trajectory_page_invalid');
              const page = verifyTrajectoryPage(value.trajectory, {
                ...request,
                eventKinds: [...request.eventKinds],
              });
              if (page.exhausted) break;
              afterCursor = page.scannedThrough;
            }
          }
          const now = await openNativeTrajectorySnapshot(
            bridge,
            generation,
            {
              storeId: snapshot.storeId,
              sessionId: target.sessionId,
              runId: target.runId,
            },
            abort.signal,
          );
          if (
            parseDecimal64(cursor) > parseDecimal64(now.upperCursor) ||
            parseDecimal64(cursor) > parseDecimal64(snapshot.upperCursor)
          )
            throw Error('trajectory_child_history_unavailable');
          const childSnapshot = {
            ...now,
            upperCursor: cursor,
            historyCoverage: { ...now.historyCoverage, upperCursor: cursor },
          };
          loaded = await loadNativeTrajectory({
            bridge,
            generation,
            snapshot: childSnapshot,
            signal: abort.signal,
          });
          const child = await readNativeTrajectoryView(
            loaded.source,
            cursor,
            undefined,
            abort.signal,
            'session',
            'key_steps',
            { treeOnly: true },
          );
          abort.signal.throwIfAborted();
          scopes[index] = {
            parentNodeId: target.parentNodeId,
            projection: child.projection,
            snapshot: childSnapshot,
          };
        } catch {
          if (abort.signal.aborted) return;
          scopes[index] = {
            parentNodeId: target.parentNodeId,
            projection: null,
            status: 'unavailable',
          };
        } finally {
          await loaded?.close().catch(() => {});
        }
        if (!abort.signal.aborted) setResult({ bridge, sourceKey, scopes: [...scopes] });
      }
    };
    void Promise.allSettled(Array.from({ length: Math.min(3, targets.length) }, read));
    return () => abort.abort();
  }, [bridge, key]);
  const scopes = useMemo(
    () =>
      enabled
        ? targets.map(
            (target) =>
              (result.bridge === bridge && result.sourceKey === sourceKey
                ? (result.scopes.find((scope) => matches(scope, target)) ??
                  result.scopes.find(
                    (scope) => scope.parentNodeId === target.parentNodeId && !scope.snapshot,
                  ))
                : undefined) ?? {
                parentNodeId: target.parentNodeId,
                projection: null,
                status: 'loading' as const,
              },
          )
        : [],
    [enabled, targets, result, bridge, sourceKey],
  );
  const snapshots = useMemo(
    () => scopes.flatMap((scope) => (scope.snapshot ? [scope.snapshot] : [])),
    [scopes],
  );
  return { scopes, snapshots };
}
