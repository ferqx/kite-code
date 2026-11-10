import { readTrajectoryEvidence, type TrajectoryEvidenceSource } from '@kite-ai/client';
import { canonicalSerialize, parseDecimal64, type TrajectorySnapshot } from '@kite-ai/trajectory';
import type { TrajectoryEvidenceView, TrajectoryMaterialTarget } from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeTrajectoryEvidence } from './trajectory-evidence-view';

const emptyTargets: readonly TrajectoryMaterialTarget[] = [];
function targetKey(target: TrajectoryMaterialTarget) {
  return canonicalSerialize({
    event: target.event,
    reference: target.reference,
  });
}
function identity(target: TrajectoryMaterialTarget): TrajectoryEvidenceView {
  return {
    eventId: target.event.eventId,
    evidenceId: target.reference.evidenceId,
    contentVersion: target.reference.contentVersion,
    kind: target.reference.kind,
    mediaType: target.reference.mediaType,
    status: 'loading',
  };
}
export function materialTargetsKey(targets: readonly TrajectoryMaterialTarget[]): string {
  return canonicalSerialize(targets.map(targetKey));
}

/** Revalidate the selected original ref; this is not a permission or source lookup. */
export function trajectoryMaterialRequest(
  snapshot: TrajectorySnapshot,
  cursor: string,
  target: TrajectoryMaterialTarget,
) {
  const { event, reference } = target;
  if (
    event.sessionId !== snapshot.sessionId ||
    (snapshot.runId !== undefined && event.runId !== snapshot.runId) ||
    (snapshot.executionId !== undefined && event.executionId !== snapshot.executionId) ||
    parseDecimal64(event.sequence) > parseDecimal64(cursor) ||
    parseDecimal64(cursor) > parseDecimal64(snapshot.upperCursor) ||
    !event.evidenceRefs.some(
      (candidate) => canonicalSerialize(candidate) === canonicalSerialize(reference),
    )
  )
    throw Error('trajectory_evidence_identity_mismatch');
  return {
    storeId: snapshot.storeId,
    sessionId: snapshot.sessionId,
    upperCursor: snapshot.upperCursor,
    atCursor: event.sequence,
    eventId: event.eventId,
    evidenceId: reference.evidenceId,
    contentVersion: reference.contentVersion,
  };
}

/** One selected material set only. No bodies survive a scope/selection/visibility replacement. */
export function useTrajectoryMaterials({
  source,
  snapshot,
  cursor,
  ownerKey,
  relatedSnapshots = [],
  retainCommon = false,
}: {
  source: TrajectoryEvidenceSource | null;
  snapshot: TrajectorySnapshot | null;
  cursor: string;
  ownerKey: string;
  relatedSnapshots?: readonly TrajectorySnapshot[];
  /** Visible Agent loops may share exact refs while the viewport adds a neighboring loop. */
  retainCommon?: boolean;
}) {
  const [request, setRequest] = useState<{
    key: string;
    targets: readonly TrajectoryMaterialTarget[];
    source: TrajectoryEvidenceSource | null;
    scopeKey: string;
  }>({ key: '', targets: emptyTargets, source: null, scopeKey: '' });
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    source: TrajectoryEvidenceSource | null;
    key: string;
    scopeKey: string;
    revision: number;
    targetKeys: readonly string[];
    materials: readonly TrajectoryEvidenceView[];
  }>({ source: null, key: '', scopeKey: '', revision: 0, targetKeys: [], materials: [] });
  const resultRef = useRef(result);
  resultRef.current = result;
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  const alive = useRef(true);
  const epoch = useRef(0);
  const snapshotKey = snapshot
    ? canonicalSerialize({
        storeId: snapshot.storeId,
        sessionId: snapshot.sessionId,
        runId: snapshot.runId ?? null,
        executionId: snapshot.executionId ?? null,
        upperCursor: snapshot.upperCursor,
      })
    : '';
  const relatedScopeKey = canonicalSerialize(
    relatedSnapshots
      .filter((related) =>
        request.targets.some(
          (target) =>
            target.event.sessionId === related.sessionId &&
            related.runId !== undefined &&
            target.event.runId === related.runId,
        ),
      )
      .map((related) => ({
        storeId: related.storeId,
        sessionId: related.sessionId,
        runId: related.runId ?? null,
        executionId: related.executionId ?? null,
        upperCursor: related.upperCursor,
      }))
      .sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right))),
  );
  const scopeKey = canonicalSerialize({ snapshotKey, cursor, ownerKey, relatedScopeKey });
  const readKey = canonicalSerialize({
    scopeKey,
    requestKey: request.key,
    revision,
    documentVisible,
    retainCommon,
  });
  const requestCurrent = request.source === source && request.scopeKey === scopeKey;
  const reusable = (target: TrajectoryMaterialTarget, previous = resultRef.current) =>
    retainCommon &&
    previous.source === source &&
    previous.scopeKey === scopeKey &&
    previous.revision === revision
      ? previous.materials.find(
          (view, index) =>
            previous.targetKeys[index] === targetKey(target) &&
            view.eventId === target.event.eventId &&
            view.evidenceId === target.reference.evidenceId &&
            view.contentVersion === target.reference.contentVersion &&
            !view.imageUrl &&
            ['available', 'partial', 'truncated'].includes(view.status),
        )
      : undefined;
  const onMaterialsChange = useCallback(
    (targets: readonly TrajectoryMaterialTarget[]) => {
      if (!alive.current) return;
      const unique = [...new Map(targets.map((target) => [targetKey(target), target])).values()];
      const key = materialTargetsKey(unique);
      setRequest((prior) =>
        prior.key === key && prior.source === source && prior.scopeKey === scopeKey
          ? prior
          : { key, targets: unique, source, scopeKey },
      );
    },
    [source, scopeKey],
  );
  const onMaterialsRetry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  // All source and observation identities are values in the dependency key; snapshot is immutable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: readKey captures immutable scope, cursor, owner and requested refs.
  useEffect(() => {
    const current = ++epoch.current;
    const task = new AbortController();
    const urls = new Set<string>();
    if (!source || !snapshot || !requestCurrent || !request.targets.length || !documentVisible) {
      setResult((prior) =>
        prior.materials.length
          ? { source, key: readKey, scopeKey, revision, targetKeys: [], materials: [] }
          : prior,
      );
      return () => task.abort();
    }
    const views = request.targets.map((target) => reusable(target) ?? identity(target));
    const targetKeys = request.targets.map(targetKey);
    setResult({ source, key: readKey, scopeKey, revision, targetKeys, materials: views });
    let next = 0;
    const commit = (index: number, value: TrajectoryEvidenceView) => {
      if (!alive.current || epoch.current !== current || task.signal.aborted) return;
      views[index] = value;
      setResult({ source, key: readKey, scopeKey, revision, targetKeys, materials: [...views] });
    };
    const worker = async () => {
      for (;;) {
        const index = next++;
        const target = request.targets[index];
        if (!target || task.signal.aborted) return;
        if (views[index]?.status !== 'loading') continue;
        const base = identity(target);
        if (
          ['missing', 'unavailable', 'redacted', 'empty'].includes(target.reference.availability)
        ) {
          commit(index, { ...base, status: target.reference.availability });
          continue;
        }
        try {
          const targetSnapshot =
            target.event.sessionId === snapshot.sessionId
              ? snapshot
              : relatedSnapshots.find(
                  (related) =>
                    related.storeId === snapshot.storeId &&
                    related.sessionId === target.event.sessionId &&
                    related.runId !== undefined &&
                    related.runId === target.event.runId &&
                    related.upperCursor === cursor,
                );
          if (!targetSnapshot) throw Error('trajectory_evidence_identity_mismatch');
          const input = trajectoryMaterialRequest(targetSnapshot, cursor, target);
          const result = await readTrajectoryEvidence(source, input, { signal: task.signal });
          task.signal.throwIfAborted();
          const decoded = decodeTrajectoryEvidence(
            target.reference.kind,
            result.descriptor.mediaType,
            result.content,
          );
          let imageUrl: string | undefined;
          if (/^image\/(?:png|jpeg|webp|gif)(?:;|$)/i.test(result.descriptor.mediaType)) {
            imageUrl = URL.createObjectURL(
              new Blob([Uint8Array.from(result.content)], { type: result.descriptor.mediaType }),
            );
            urls.add(imageUrl);
          }
          commit(index, {
            ...base,
            ...decoded,
            status: result.descriptor.availability,
            mediaType: result.descriptor.mediaType,
            ...(imageUrl ? { imageUrl } : {}),
          });
        } catch (cause) {
          if (task.signal.aborted || epoch.current !== current) return;
          const reason =
            cause instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(cause.message)
              ? cause.message
              : 'trajectory_evidence_unavailable';
          commit(index, {
            ...base,
            status: 'unavailable',
            notice: `材料读取未完成（${reason}）。`,
          });
        }
      }
    };
    void Promise.allSettled(Array.from({ length: Math.min(2, request.targets.length) }, worker));
    return () => {
      task.abort();
      epoch.current++;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [source, readKey, requestCurrent]);
  // Hide the prior authorization/source in the replacement render, before effect cleanup.
  const materials =
    !source && snapshot && documentVisible && requestCurrent
      ? request.targets.map((target) => ({
          ...identity(target),
          status: 'unavailable' as const,
          notice: '原材料来源当前不可读取。',
        }))
      : source &&
          snapshot &&
          requestCurrent &&
          documentVisible &&
          result.source === source &&
          (result.key === readKey || retainCommon)
        ? result.key === readKey
          ? result.materials
          : request.targets.map((target) => reusable(target) ?? identity(target))
        : [];
  return { materials, onMaterialsChange, onMaterialsRetry };
}
