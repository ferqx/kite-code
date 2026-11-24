import type { Message } from '@kite-ai/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { NativeDisplayCache } from './native-display-cache';
import { modelUsageMessageKey, type NativeContextUsage } from './tool-messages-bridge';

type Receipt = {
  messageKey: string;
  content: string;
  context?: NativeContextUsage;
  modelId?: string;
};
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
  suspended = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  historyComplete: boolean;
  modelId?: string;
  suspended?: boolean;
}) {
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId,
    contextSelectionId = selection?.session.contextSelectionId,
    viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const boundary = JSON.stringify([generation, historyEpoch]);
  const snapshots = useRef({ boundary, storeId, cache: new NativeDisplayCache<Receipt>() });
  if (
    snapshots.current.boundary !== boundary ||
    (storeId && snapshots.current.storeId !== storeId)
  ) {
    snapshots.current = { boundary, storeId, cache: new NativeDisplayCache<Receipt>() };
  }
  if (storeId) snapshots.current.storeId = storeId;
  const displayKey = JSON.stringify([sessionId, workspaceId, contextSelectionId]);
  const candidate = useMemo(() => {
    let latest: Message | undefined;
    for (const message of messages) {
      if (
        message.sessionId !== sessionId ||
        message.role !== 'assistant' ||
        message.status !== 'complete' ||
        message.originMessage ||
        message.compression ||
        message.contentFormat === 'unsupported' ||
        !message.runId ||
        message.sourceIds?.length !== 1
      )
        continue;
      if (!latest || BigInt(message.seq) > BigInt(latest.seq)) latest = message;
    }
    return latest;
  }, [messages, sessionId]);
  const highWaterSeq = useMemo(
    () =>
      messages.reduce(
        (upper, message) =>
          message.sessionId === sessionId &&
          message.status === 'complete' &&
          BigInt(message.seq) > BigInt(upper)
            ? message.seq
            : upper,
        '0',
      ),
    [messages, sessionId],
  );
  const messageId = candidate?.id,
    messageKey = candidate && modelUsageMessageKey(candidate),
    content = candidate?.content;
  const basis = JSON.stringify([boundary, storeId, displayKey, viewSelection, modelId]);
  const [state, setState] = useState<{
    basis: string;
    scope: string;
    highWaterSeq: string;
    receipt: Receipt;
    waitingForEvidence?: boolean;
  }>();
  // Later tool messages cannot add evidence to an already sealed original request.
  const waitingForEvidence =
    !!state?.waitingForEvidence &&
    state.basis === basis &&
    state.receipt.messageKey === messageKey &&
    state.receipt.content === content;
  const readHighWaterSeq = waitingForEvidence ? state.highWaterSeq : highWaterSeq;
  const scope = JSON.stringify([basis, readHighWaterSeq]);
  const readable =
    !suspended &&
    !!selection &&
    selection.canReadContext !== false &&
    selection.canReadModelInput !== false;
  const available =
    readable && historyComplete && !selection?.viewLoading && !selection?.permissionUnavailable;
  useEffect(() => {
    if (
      !bridge ||
      !available ||
      waitingForEvidence ||
      !storeId ||
      !sessionId ||
      !workspaceId ||
      !contextSelectionId ||
      viewSelection === undefined ||
      !messageId ||
      !messageKey ||
      content === undefined
    )
      return;
    const cache = snapshots.current.cache;
    let active = true;
    let pendingReadId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (attempt: number) => {
      const readId = crypto.randomUUID();
      pendingReadId = readId;
      try {
        const page = await bridge.request({
          method: 'toolMessages.contextUsage',
          generation,
          viewSelection,
          historyEpoch,
          readId,
          messageIds: [messageId],
        });
        if (!active || snapshots.current.cache !== cache) return;
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
        const receipt: Receipt = {
          messageKey,
          content,
          modelId,
          context: !modelId || context.modelId === modelId ? context : undefined,
        };
        cache.set(displayKey, receipt);
        setState({
          basis,
          scope,
          highWaterSeq: readHighWaterSeq,
          receipt,
          waitingForEvidence: context.totalInputTokens === undefined,
        });
      } catch {
        if (!active || snapshots.current.cache !== cache) return;
        const previous = cache.get(displayKey);
        const verified =
          previous?.messageKey === messageKey && previous.content === content
            ? previous.context
            : undefined;
        const receipt: Receipt = { messageKey, content, modelId };
        if (
          verified?.contextWindowTokens !== undefined &&
          (!modelId || modelId === verified.modelId)
        ) {
          const { totalInputTokens: _total, ...window } = verified;
          receipt.context = window;
        }
        cache.set(displayKey, receipt);
        setState({ basis, scope, highWaterSeq: readHighWaterSeq, receipt });
        const delay = contextRetryDelays[attempt];
        if (delay !== undefined) timer = setTimeout(() => void read(attempt + 1), delay);
      } finally {
        pendingReadId = undefined;
      }
    };
    void read(0);
    return () => {
      active = false;
      clearTimeout(timer);
      if (pendingReadId)
        void bridge
          .request({ method: 'toolMessages.close', generation, readId: pendingReadId })
          .catch(() => {});
    };
  }, [
    bridge,
    available,
    waitingForEvidence,
    basis,
    scope,
    readHighWaterSeq,
    generation,
    storeId,
    sessionId,
    workspaceId,
    contextSelectionId,
    viewSelection,
    historyEpoch,
    messageId,
    messageKey,
    content,
    displayKey,
    modelId,
  ]);
  const displayed =
    state?.scope === scope ? state.receipt : snapshots.current.cache.get(displayKey);
  const observed =
    candidate &&
    displayed &&
    displayed.messageKey === messageKey &&
    displayed.content === content &&
    (displayed.context
      ? !modelId || displayed.context.modelId === modelId
      : !modelId || displayed.modelId === modelId);
  const metrics = readable && observed ? displayed.context : undefined;
  return {
    metrics,
    pending:
      !!bridge &&
      readable &&
      !observed &&
      (!historyComplete || (available && !!candidate && state?.scope !== scope)),
  };
}
