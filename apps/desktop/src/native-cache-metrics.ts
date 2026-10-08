import type { Message } from '@kite-ai/client';
import { useEffect, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { modelUsageMessageKey, type NativeModelUsageFact } from './tool-messages-bridge';

type Receipt = { key: string; content: string; sample?: NativeModelUsageFact };
type ObservedMessage = {
  id: string;
  key: string;
  content: string;
  executionId: string;
  originStoreId?: string;
};

/** Exact terminal Model receipts contribute once, including admitted sealed historical sources. */
export function useNativeCacheMetrics({
  bridge,
  generation,
  selection,
  historyEpoch,
  messages,
  historyComplete,
  observationRevision,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  historyComplete: boolean;
  observationRevision: number;
}) {
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId,
    viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const scope = JSON.stringify([
    generation,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    historyEpoch,
  ]);
  const candidates = messages.filter(
    (message) =>
      message.sessionId === sessionId &&
      message.role === 'assistant' &&
      message.status === 'complete' &&
      message.contentFormat !== 'unsupported' &&
      (message.originMessage?.runId ?? message.runId) &&
      message.sourceIds?.length === 1,
  );
  // Stable observation input prevents a failed GET from retrying on an unrelated render.
  const observation = JSON.stringify({
    revision: observationRevision,
    messages: candidates.map((message) => ({
      id: message.id,
      key: modelUsageMessageKey(message),
      content: message.content,
      executionId: message.sourceIds![0]!,
      originStoreId: message.originMessage?.storeId,
    })),
  });
  const [retryRevision, setRetryRevision] = useState(0);
  const cache = useRef({ scope, retryRevision, read: new Map<string, Receipt>() });
  const [state, setState] = useState({ scope, read: new Map<string, Receipt>(), error: '' });
  const available =
    historyComplete && !!selection && !selection.viewLoading && !selection.permissionUnavailable;
  useEffect(() => {
    if (cache.current.scope !== scope || cache.current.retryRevision !== retryRevision)
      cache.current = { scope, retryRevision, read: new Map() };
    if (
      !bridge ||
      !storeId ||
      !sessionId ||
      !workspaceId ||
      viewSelection === undefined ||
      !available
    )
      return;
    const current = cache.current;
    const pending = (JSON.parse(observation) as { messages: ObservedMessage[] }).messages.filter(
      (message) => {
        const receipt = current.read.get(message.id);
        return receipt?.key !== message.key || receipt.content !== message.content;
      },
    );
    let active = true,
      readId: string | undefined;
    void (async () => {
      for (let index = 0; index < pending.length; index += 32) {
        const batch = pending.slice(index, index + 32);
        readId = crypto.randomUUID();
        const page = await bridge.request({
          method: 'toolMessages.usage',
          generation,
          viewSelection,
          historyEpoch,
          readId,
          messageIds: batch.map((message) => message.id),
        });
        if (!active) return;
        if (
          !page ||
          !('kind' in page) ||
          page.kind !== 'toolMessages.usage' ||
          !('scope' in page) ||
          !('entries' in page) ||
          page.readId !== readId ||
          page.scope.generation !== generation ||
          page.scope.viewSelection !== viewSelection ||
          page.scope.historyEpoch !== historyEpoch ||
          page.scope.storeId !== storeId ||
          page.scope.sessionId !== sessionId ||
          page.scope.workspaceId !== workspaceId ||
          new Set(page.entries.map((entry) => entry.messageId)).size !== page.entries.length ||
          page.entries.some(
            (entry) =>
              !batch.some(
                (message) =>
                  message.id === entry.messageId &&
                  message.executionId === entry.executionId &&
                  (!message.originStoreId || message.originStoreId === entry.originStoreId),
              ) ||
              typeof entry.originStoreId !== 'string' ||
              !entry.originStoreId ||
              !Number.isSafeInteger(entry.cacheHitTokens) ||
              entry.cacheHitTokens < 0 ||
              !Number.isSafeInteger(entry.cacheMissTokens) ||
              entry.cacheMissTokens < 0 ||
              !Number.isSafeInteger(entry.cacheHitTokens + entry.cacheMissTokens),
          )
        )
          throw Error('model_usage_identity_mismatch');
        for (const message of batch)
          current.read.set(message.id, {
            key: message.key,
            content: message.content,
            sample: page.entries.find((entry) => entry.messageId === message.id),
          });
      }
      if (active && pending.length) setState({ scope, read: new Map(current.read), error: '' });
    })().catch(() => {
      if (active)
        setState((previous) => ({
          scope,
          read: previous.scope === scope ? previous.read : new Map(),
          error: '缓存指标未更新；只保留已核实的原样本。',
        }));
    });
    return () => {
      active = false;
      if (readId)
        void bridge.request({ method: 'toolMessages.close', generation, readId }).catch(() => {});
    };
  }, [
    bridge,
    scope,
    observation,
    generation,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    historyEpoch,
    available,
    retryRevision,
  ]);
  let metrics: { cacheHitTokens: number; cacheMissTokens: number } | undefined;
  const executions = new Set<string>();
  const complete =
    available &&
    state.scope === scope &&
    candidates.every((message) => {
      const receipt = state.read.get(message.id);
      return receipt?.key === modelUsageMessageKey(message) && receipt.content === message.content;
    });
  if (complete)
    for (const message of candidates) {
      const sample = state.read.get(message.id)?.sample;
      const origin = sample && JSON.stringify([sample.originStoreId, sample.executionId]);
      if (!sample || !origin || executions.has(origin)) continue;
      executions.add(origin);
      metrics ??= { cacheHitTokens: 0, cacheMissTokens: 0 };
      metrics.cacheHitTokens += sample.cacheHitTokens;
      metrics.cacheMissTokens += sample.cacheMissTokens;
    }
  const overflow =
    metrics && !Number.isSafeInteger(metrics.cacheHitTokens + metrics.cacheMissTokens);
  return {
    metrics: overflow ? undefined : metrics,
    error: state.scope === scope ? state.error || (overflow ? '缓存指标超出可核实范围。' : '') : '',
    retry: () => setRetryRevision((value) => value + 1),
  };
}
