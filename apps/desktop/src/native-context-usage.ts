import type { Message } from '@kite-ai/client';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { NativeDisplayCache } from './native-display-cache';
import { nativeReadDeadline } from './native-read-deadline';
import { modelUsageMessageKey, type NativeContextUsage } from './tool-messages-bridge';

type RequestTarget = {
  messageId: string;
  messageKey: string;
  content: string;
  highWaterSeq: string;
};

type Snapshot = {
  modelRevision?: number;
  context: NativeContextUsage;
  target: RequestTarget;
  basis: string;
};

function sameMessage(left?: RequestTarget, right?: RequestTarget) {
  return (
    !!left && !!right && left.messageKey === right.messageKey && left.content === right.content
  );
}

function sameTarget(left?: RequestTarget, right?: RequestTarget) {
  return sameMessage(left, right) && left?.highWaterSeq === right?.highWaterSeq;
}

const contextRetryDelays = [500, 1000, 2000, 4000, 8000, 16000, 30000] as const;

/** Current-context forecast only; cache-hit and cumulative token counts never enter this ratio. */
export function useNativeContextUsage({
  bridge,
  generation,
  selection,
  historyEpoch,
  messages,
  historyComplete,
  modelId,
  modelRevision,
  suspended = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  historyComplete: boolean;
  modelId?: string;
  modelRevision?: number;
  suspended?: boolean;
}) {
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId,
    contextSelectionId = selection?.session.contextSelectionId,
    viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const boundary = JSON.stringify([generation, historyEpoch]);
  const snapshots = useRef({
    bridge,
    boundary,
    storeId,
    cache: new NativeDisplayCache<Snapshot>(),
  });
  if (
    snapshots.current.bridge !== bridge ||
    snapshots.current.boundary !== boundary ||
    (storeId && snapshots.current.storeId !== storeId)
  ) {
    snapshots.current = { bridge, boundary, storeId, cache: new NativeDisplayCache<Snapshot>() };
  }
  if (storeId) snapshots.current.storeId = storeId;
  const cache = snapshots.current.cache;
  const displayKey = JSON.stringify([sessionId, workspaceId, contextSelectionId]);
  const { candidate, highWaterSeq } = useMemo(() => {
    let latest: Message | undefined;
    let latestSeq = -1n;
    let upper = 0n;
    for (const message of messages) {
      if (message.sessionId !== sessionId || message.status !== 'complete') continue;
      const seq = BigInt(message.seq);
      if (seq > upper) upper = seq;
      if (
        seq > latestSeq &&
        message.role === 'assistant' &&
        !message.originMessage &&
        !message.compression &&
        message.contentFormat !== 'unsupported' &&
        message.runId &&
        message.sourceIds?.length === 1
      ) {
        latest = message;
        latestSeq = seq;
      }
    }
    return { candidate: latest, highWaterSeq: String(upper) };
  }, [messages, sessionId]);
  const target = useMemo(
    () =>
      candidate && {
        messageId: candidate.id,
        messageKey: modelUsageMessageKey(candidate),
        content: candidate.content,
        highWaterSeq,
      },
    [candidate, highWaterSeq],
  );
  const basis = JSON.stringify([
    boundary,
    storeId,
    displayKey,
    viewSelection,
    modelId,
    modelRevision,
  ]);
  const readable =
    !suspended &&
    !!selection &&
    // Main marks actions unavailable during same-selection View refresh, too.
    !(selection.permissionUnavailable && !selection.viewLoading) &&
    selection.canReadContext !== false &&
    selection.canReadModelInput !== false;
  const canStart = readable && historyComplete && !selection?.viewLoading;

  const [observation, setObservation] = useState<{
    basis: string;
    cache: NativeDisplayCache<Snapshot>;
    target: RequestTarget;
    waitingForEvidence: boolean;
  }>();
  const latestVerified = useRef<{ cache: NativeDisplayCache<Snapshot>; value: Snapshot }>(
    undefined,
  );
  const current = useRef({ basis, target, cache, canStart });
  const reader = useRef<{
    basis: string;
    cache: NativeDisplayCache<Snapshot>;
    advance: () => void;
  }>(undefined);
  // The current read survives soft refreshes, which pause new reads until the View catches up.
  useLayoutEffect(() => {
    current.current = { basis, target, cache, canStart };
    if (suspended) {
      cache.clear();
      latestVerified.current = undefined;
    } else if (!readable && sessionId) {
      cache.delete(displayKey);
      latestVerified.current = undefined;
    }
    const owner = reader.current;
    if (owner?.basis === basis && owner.cache === cache) owner.advance();
  }, [basis, cache, canStart, displayKey, readable, sessionId, suspended, target]);

  useLayoutEffect(() => {
    if (
      !bridge ||
      !readable ||
      !storeId ||
      !sessionId ||
      !workspaceId ||
      !contextSelectionId ||
      viewSelection === undefined
    )
      return;
    let active = true;
    let pendingReadId: string | undefined;
    let attempted: RequestTarget | undefined;
    let awaitingEvidence: RequestTarget | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = (readId: string) =>
      bridge.request({ method: 'toolMessages.close', generation, readId }).catch(() => {});

    const isCurrent = () =>
      active && current.current.basis === basis && current.current.cache === cache;
    const advance = () => {
      const next = current.current.target;
      if (
        !isCurrent() ||
        !current.current.canStart ||
        pendingReadId ||
        !next ||
        sameTarget(next, attempted)
      )
        return;
      const local = latestVerified.current;
      const previous =
        local?.cache === cache && local.value.basis === basis ? local.value : cache.get(displayKey);
      // An already sealed original cannot acquire newly recorded tool-image evidence.
      if (
        sameMessage(awaitingEvidence, next) ||
        (previous?.basis === basis &&
          previous.context.totalInputTokens === undefined &&
          sameMessage(previous.target, next))
      )
        return;
      clearTimeout(timer);
      attempted = next;
      void read(next, 0);
    };
    const read = async (requested: RequestTarget, attempt: number) => {
      const readId = crypto.randomUUID();
      pendingReadId = readId;
      try {
        const page = await nativeReadDeadline(
          bridge.request({
            method: 'toolMessages.contextUsage',
            generation,
            viewSelection,
            historyEpoch,
            readId,
            messageIds: [requested.messageId],
          }),
        );
        if (!isCurrent()) return;
        if (
          !page ||
          !('kind' in page) ||
          page.kind !== 'toolMessages.contextUsage' ||
          !('readId' in page) ||
          !('scope' in page) ||
          page.readId !== readId ||
          page.scope.generation !== generation ||
          page.scope.storeId !== storeId ||
          page.scope.sessionId !== sessionId ||
          page.scope.workspaceId !== workspaceId ||
          page.scope.viewSelection !== viewSelection ||
          page.scope.historyEpoch !== historyEpoch
        )
          throw Error('context_usage_identity_mismatch');
        const context = page.context;
        if (!context) throw Error('context_usage_missing');
        if (
          context.contextSelectionId !== contextSelectionId ||
          (context.totalInputTokens !== undefined &&
            (!Number.isSafeInteger(context.totalInputTokens) || context.totalInputTokens < 0)) ||
          !context.modelId ||
          (context.contextWindowTokens !== undefined &&
            (!Number.isSafeInteger(context.contextWindowTokens) ||
              context.contextWindowTokens <= 0))
        )
          throw Error('context_usage_identity_mismatch');
        const newest = current.current.target;
        const waitingForEvidence = context.totalInputTokens === undefined;
        if (
          !sameTarget(requested, newest) &&
          !(waitingForEvidence && sameMessage(requested, newest))
        )
          return;
        if (waitingForEvidence) awaitingEvidence = requested;
        if (!modelId || context.modelId === modelId) {
          const previous = cache.get(displayKey);
          const previousWindow =
            waitingForEvidence &&
            context.contextWindowTokens === undefined &&
            previous?.modelRevision === modelRevision &&
            previous?.context.modelId === context.modelId
              ? previous.context.contextWindowTokens
              : undefined;
          const value = {
            basis,
            target: requested,
            modelRevision,
            context:
              previousWindow === undefined
                ? context
                : { ...context, contextWindowTokens: previousWindow },
          };
          latestVerified.current = { cache, value };
          cache.set(displayKey, value);
        } else {
          cache.delete(displayKey);
          latestVerified.current = undefined;
        }
        setObservation({ basis, cache, target: requested, waitingForEvidence });
      } catch (error) {
        if (isCurrent() && error instanceof Error && error.message === 'native_read_timeout')
          await nativeReadDeadline(close(readId)).catch(() => {});
        if (!isCurrent() || !sameTarget(requested, current.current.target)) return;
        setObservation({ basis, cache, target: requested, waitingForEvidence: false });
        const delay = contextRetryDelays[attempt];
        if (delay !== undefined)
          timer = setTimeout(() => {
            if (!isCurrent() || !sameTarget(requested, current.current.target)) return;
            if (current.current.canStart) void read(requested, attempt + 1);
            else attempted = undefined;
          }, delay);
      } finally {
        pendingReadId = undefined;
        advance();
      }
    };
    const owner = { basis, cache, advance };
    reader.current = owner;
    advance();
    return () => {
      active = false;
      if (reader.current === owner) reader.current = undefined;
      clearTimeout(timer);
      if (pendingReadId) void close(pendingReadId);
    };
  }, [
    bridge,
    readable,
    basis,
    cache,
    displayKey,
    generation,
    storeId,
    sessionId,
    workspaceId,
    contextSelectionId,
    viewSelection,
    historyEpoch,
    modelId,
    modelRevision,
  ]);

  const local = latestVerified.current;
  const snapshot = readable
    ? local?.cache === cache && local.value.basis === basis
      ? local.value
      : cache.get(displayKey)
    : undefined;
  const compatible =
    snapshot?.modelRevision === modelRevision && (!modelId || snapshot?.context.modelId === modelId)
      ? snapshot
      : undefined;
  const context = compatible?.context;
  const hasExactEstimate = sameTarget(compatible?.target, target);
  const waitingForEvidence =
    observation?.cache === cache &&
    observation.basis === basis &&
    observation.waitingForEvidence &&
    sameMessage(observation.target, target);
  const metrics = useMemo(
    () =>
      hasExactEstimate || !context
        ? context
        : context.contextWindowTokens === undefined
          ? undefined
          : {
              modelId: context.modelId,
              contextSelectionId: context.contextSelectionId,
              contextWindowTokens: context.contextWindowTokens,
            },
    [context, hasExactEstimate],
  );
  const checked =
    observation?.cache === cache &&
    observation.basis === basis &&
    sameTarget(observation.target, target);
  return {
    metrics,
    pending:
      !!bridge &&
      readable &&
      !waitingForEvidence &&
      (!historyComplete || (!!target && !checked && metrics?.totalInputTokens === undefined)),
  };
}
