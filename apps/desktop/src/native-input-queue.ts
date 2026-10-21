import type { QueuedMessagesProps } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import type { NativeInputQueueObservation, NativeInputQueueSubmission } from './input-queue-bridge';
import type { NativeBridge, NativeSelection } from './native-bridge';

/** The renderer holds presentation only. Main owns observations, original requests and receipts. */
export function useNativeInputQueue({
  bridge,
  generation,
  selection,
  historyEpoch,
  available,
  onEditText,
}: {
  bridge: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  available: boolean;
  onEditText: (text: string) => boolean;
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
  const enabled = available && !!selection?.canReadInputQueue && !selection.session.parentSessionId;
  const latest = useRef({ scope, enabled, onEditText });
  latest.current = { scope, enabled, onEditText };
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{
    scope: string;
    observation?: NativeInputQueueObservation;
    loading: boolean;
    error?: string;
  }>({ scope, loading: false });
  const [operation, setOperation] = useState<{ scope: string; id: string }>();
  const lock = useRef(false);
  const delivered = useRef(new Set<string>());
  const observationRevision = selection?.viewGeneration;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Observed View changes and explicit retries re-read the actual pending queue.
  useEffect(() => {
    if (!enabled || !storeId || !sessionId || !workspaceId || viewSelection === undefined) return;
    let active = true;
    const readId = crypto.randomUUID();
    setState((previous) => ({
      scope,
      observation: previous.scope === scope ? previous.observation : undefined,
      loading: true,
    }));
    void bridge
      .request({ method: 'input.queue.read', generation, readId, viewSelection, historyEpoch })
      .then((result) => {
        if (!active || latest.current.scope !== scope) return;
        if (
          !result ||
          !('kind' in result) ||
          result.kind !== 'input.queue.observation' ||
          !('scope' in result) ||
          !('entries' in result) ||
          result.readId !== readId ||
          result.scope.generation !== generation ||
          result.scope.storeId !== storeId ||
          result.scope.sessionId !== sessionId ||
          result.scope.workspaceId !== workspaceId ||
          result.scope.viewSelection !== viewSelection ||
          result.scope.historyEpoch !== historyEpoch ||
          new Set(result.entries.map((item) => item.id)).size !== result.entries.length
        )
          throw Error('input_queue_identity_mismatch');
        setState({ scope, observation: result, loading: false });
      })
      .catch(() => {
        if (active && latest.current.scope === scope)
          setState((previous) => ({
            ...previous,
            scope,
            loading: false,
            error: '排队消息暂时无法核对，请重试读取。',
          }));
      });
    return () => {
      active = false;
      void bridge.request({ method: 'input.queue.close', generation, readId }).catch(() => {});
    };
  }, [
    bridge,
    enabled,
    generation,
    scope,
    historyEpoch,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    observationRevision,
    refresh,
  ]);

  const current = state.scope === scope ? state : undefined;
  const observation = current?.observation;
  const busy = operation?.scope === scope;
  const unresolved = observation?.submissions ?? [];
  const refreshQueue = () => setRefresh((value) => value + 1);
  async function accept(result: unknown, originalScope: string) {
    if (latest.current.scope !== originalScope || !latest.current.enabled) return;
    const submission = result as NativeInputQueueSubmission | undefined;
    if (
      submission?.kind !== 'input.queue.submission' ||
      submission.scope.storeId !== storeId ||
      submission.scope.sessionId !== sessionId ||
      submission.scope.workspaceId !== workspaceId
    )
      throw Error('input_queue_submission_mismatch');
    if (
      submission.phase === 'applied' &&
      submission.operation === 'edit' &&
      submission.text !== undefined
    ) {
      const key = JSON.stringify([storeId, sessionId, submission.commandId]);
      if (!delivered.current.has(key)) {
        if (!latest.current.onEditText(submission.text)) return;
        delivered.current.add(key);
      }
      await bridge.request({
        method: 'input.queue.ack',
        generation,
        commandId: submission.commandId,
      });
    }
    if (submission.phase === 'rejected')
      setState((previous) => ({ ...previous, error: '排队消息已变化，操作未生效。' }));
    refreshQueue();
  }
  async function perform(id: string, action: () => Promise<unknown>) {
    if (lock.current || !enabled) return;
    lock.current = true;
    const originalScope = scope;
    setOperation({ scope, id });
    try {
      await accept(await action(), originalScope);
    } catch {
      // A lost IPC reply can hide a committed mutation. The next read recovers its
      // durable original ID; neither this hook nor Main retries the mutation.
      if (latest.current.scope === originalScope) {
        setState((previous) => ({ ...previous, error: '队列操作结果尚未确认，请核对原操作。' }));
        refreshQueue();
      }
    } finally {
      lock.current = false;
      if (latest.current.scope === originalScope) setOperation(undefined);
    }
  }
  const blocked =
    !enabled ||
    !observation ||
    !!current?.loading ||
    !!current?.error ||
    busy ||
    unresolved.length > 0;
  const queue: QueuedMessagesProps | undefined = observation
    ? {
        items: observation.entries,
        disabled: blocked,
        pendingId: busy ? operation?.id : undefined,
        onEdit: (targetCommandId) => {
          if (
            blocked ||
            !observation.entries.some((item) => item.id === targetCommandId && item.editable)
          )
            return;
          return perform(targetCommandId, () =>
            bridge.request({
              method: 'input.queue.withdraw',
              generation,
              observationId: observation.observationId,
              targetCommandId,
              purpose: 'edit',
            }),
          );
        },
        onDelete: (targetCommandId) => {
          if (blocked || !observation.entries.some((item) => item.id === targetCommandId)) return;
          return perform(targetCommandId, () =>
            bridge.request({
              method: 'input.queue.withdraw',
              generation,
              observationId: observation.observationId,
              targetCommandId,
              purpose: 'delete',
            }),
          );
        },
        onReorder: (commandIds) => {
          if (
            blocked ||
            commandIds.length !== observation.entries.length ||
            new Set(commandIds).size !== commandIds.length ||
            commandIds.some((id) => !observation.entries.some((item) => item.id === id))
          )
            return;
          return perform('reorder', () =>
            bridge.request({
              method: 'input.queue.reorder',
              generation,
              observationId: observation.observationId,
              commandIds,
            }),
          );
        },
      }
    : undefined;
  return {
    queue,
    busy,
    error: enabled ? current?.error : undefined,
    submissions: enabled ? unresolved : [],
    retry: refreshQueue,
    lookup: (commandId: string) => {
      if (!unresolved.some((item) => item.commandId === commandId)) return;
      return perform(commandId, () =>
        bridge.request({ method: 'input.queue.lookup', generation, commandId }),
      );
    },
  };
}
