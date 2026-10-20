import type { Message } from '@kite-ai/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { NativeDisplayCache } from './native-display-cache';
import { modelUsageMessageKey, type NativeContextUsage } from './tool-messages-bridge';

type Receipt = { messageKey: string; content: string; context: NativeContextUsage };

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
    snapshots.current.cache.clear();
    snapshots.current.boundary = boundary;
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
  const scope = JSON.stringify([boundary, storeId, displayKey, viewSelection, highWaterSeq]);
  const messageId = candidate?.id,
    messageKey = candidate && modelUsageMessageKey(candidate),
    content = candidate?.content;
  const [state, setState] = useState<{ scope: string; receipt?: Receipt; failed?: boolean }>();
  const available =
    !suspended &&
    historyComplete &&
    !!selection &&
    !selection.viewLoading &&
    !selection.permissionUnavailable &&
    selection.canReadContext !== false &&
    selection.canReadModelInput !== false;
  useEffect(() => {
    if (
      !bridge ||
      !available ||
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
    let active = true;
    const readId = crypto.randomUUID();
    void bridge
      .request({
        method: 'toolMessages.contextUsage',
        generation,
        viewSelection,
        historyEpoch,
        readId,
        messageIds: [messageId],
      })
      .then((page) => {
        if (!active) return;
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
        if (
          context &&
          (context.contextSelectionId !== contextSelectionId ||
            !Number.isSafeInteger(context.totalInputTokens) ||
            context.totalInputTokens < 0 ||
            !context.modelId ||
            (context.contextWindowTokens !== undefined &&
              (!Number.isSafeInteger(context.contextWindowTokens) ||
                context.contextWindowTokens <= 0)))
        )
          throw Error('context_usage_identity_mismatch');
        const receipt =
          context && (!modelId || context.modelId === modelId)
            ? { messageKey, content, context }
            : undefined;
        if (receipt) snapshots.current.cache.set(displayKey, receipt);
        else snapshots.current.cache.delete(displayKey);
        setState({ scope, receipt });
      })
      .catch(() => {
        if (active) {
          snapshots.current.cache.delete(displayKey);
          setState({ scope, failed: true });
        }
      });
    return () => {
      active = false;
      void bridge.request({ method: 'toolMessages.close', generation, readId }).catch(() => {});
    };
  }, [
    bridge,
    available,
    scope,
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
  const metrics =
    !suspended &&
    candidate &&
    displayed &&
    displayed.messageKey === messageKey &&
    displayed.content === content &&
    (!modelId || displayed.context.modelId === modelId)
      ? displayed.context
      : undefined;
  return { metrics };
}
