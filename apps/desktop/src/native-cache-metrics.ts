import type { Message } from '@kite-ai/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { NativeDisplayCache } from './native-display-cache';
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
  suspended = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  historyComplete: boolean;
  observationRevision: number;
  suspended?: boolean;
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
  const boundary = JSON.stringify([generation, historyEpoch]);
  const snapshots = useRef({
    boundary,
    storeId,
    version: 0,
    cache: new NativeDisplayCache<readonly (readonly [string, Receipt])[]>(),
  });
  if (
    snapshots.current.boundary !== boundary ||
    (storeId && snapshots.current.storeId !== storeId)
  ) {
    snapshots.current.cache.clear();
    snapshots.current.boundary = boundary;
    snapshots.current.version++;
  }
  if (storeId) snapshots.current.storeId = storeId;
  const version = snapshots.current.version;
  const displayKey = JSON.stringify([storeId, sessionId, workspaceId]);
  const candidates = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.sessionId === sessionId &&
          message.role === 'assistant' &&
          message.status === 'complete' &&
          message.contentFormat !== 'unsupported' &&
          (message.originMessage?.runId ?? message.runId) &&
          message.sourceIds?.length === 1,
      ),
    [messages, sessionId],
  );
  // Stable observation input prevents a failed GET from retrying on an unrelated render.
  const observation = useMemo(
    () =>
      JSON.stringify({
        revision: observationRevision,
        messages: candidates.map((message) => ({
          id: message.id,
          key: modelUsageMessageKey(message),
          content: message.content,
          executionId: message.sourceIds![0]!,
          originStoreId: message.originMessage?.storeId,
        })),
      }),
    [candidates, observationRevision],
  );
  const [retryRevision, setRetryRevision] = useState(0);
  const cache = useRef({ scope, version, retryRevision, read: new Map<string, Receipt>() });
  const [state, setState] = useState({
    scope,
    version,
    read: new Map<string, Receipt>(),
    error: '',
  });
  const available =
    !suspended &&
    historyComplete &&
    !!selection &&
    !selection.viewLoading &&
    !selection.permissionUnavailable;
  useEffect(() => {
    if (
      cache.current.scope !== scope ||
      cache.current.version !== version ||
      cache.current.retryRevision !== retryRevision
    )
      cache.current = { scope, version, retryRevision, read: new Map() };
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
      if (active && pending.length) {
        snapshots.current.cache.set(displayKey, [...current.read]);
        setState({ scope, version, read: new Map(current.read), error: '' });
      }
    })().catch(() => {
      if (active)
        setState((previous) => ({
          scope,
          version,
          read:
            previous.scope === scope && previous.version === version
              ? previous.read
              : new Map(snapshots.current.cache.get(displayKey)),
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
    displayKey,
    version,
  ]);
  const retained = snapshots.current.cache.get(displayKey);
  const displayed = useMemo(
    () => (state.scope === scope && state.version === version ? state.read : new Map(retained)),
    [state, scope, version, retained],
  );
  let metrics: { cacheHitTokens: number; cacheMissTokens: number } | undefined;
  const executions = new Set<string>();
  // A history/View refresh only gates new reads. Previously verified, unchanged
  // receipts remain displayable while the next round's usage is being checked.
  if (!suspended)
    for (const message of candidates) {
      const receipt = displayed.get(message.id);
      if (receipt?.key !== modelUsageMessageKey(message) || receipt.content !== message.content)
        continue;
      const sample = receipt.sample;
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
    error:
      state.scope === scope && state.version === version
        ? state.error || (overflow ? '缓存指标超出可核实范围。' : '')
        : '',
    retry: () => setRetryRevision((value) => value + 1),
  };
}
