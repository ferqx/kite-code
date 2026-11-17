import type { Message } from '@kite-ai/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeFileChange } from './file-changes-bridge';
import type { NativeBridge, NativeResult, NativeSelection } from './native-bridge';
import { nativeReadDeadline } from './native-read-deadline';
import { sameToolReceipt } from './native-tool-messages';

type FileTargetRead = { receipt: Message; entry?: NativeFileChange };

/** Both retained file consumers read the same exact metadata; bodies remain lazy. */
export function useNativeFileTargets({
  bridge,
  generation,
  selection,
  historyEpoch,
  messages,
  includeRead = false,
  suspended = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  includeRead?: boolean;
  suspended?: boolean;
}) {
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId;
  const viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const hasSelection = !!selection;
  const scope = JSON.stringify([
    generation,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    historyEpoch,
    includeRead,
  ]);
  const receipts = useMemo(
    () =>
      hasSelection
        ? messages.filter((message) => {
            if (
              message.role !== 'tool' ||
              message.status !== 'complete' ||
              message.sourceIds?.length !== 1
            )
              return false;
            if (!includeRead) return true;
            // This is only a request filter. Main verifies the original Files definition and result.
            try {
              return typeof JSON.parse(message.content)?.path === 'string';
            } catch {
              return false;
            }
          })
        : [],
    [hasSelection, messages, includeRead],
  );
  const eligible = useRef(receipts);
  if (
    eligible.current.length !== receipts.length ||
    receipts.some((receipt, index) => !sameToolReceipt(receipt, eligible.current[index]!))
  )
    eligible.current = receipts;
  const candidates = eligible.current;
  const [revision, setRevision] = useState(0);
  const cache = useRef({
    scope,
    bridge,
    read: new Map<string, FileTargetRead>(),
  });
  const [state, setState] = useState<{
    scope: string;
    bridge?: NativeBridge;
    reads: FileTargetRead[];
    loading: boolean;
    error?: string;
  }>({ scope, bridge, reads: [], loading: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry restarts only unresolved receipts in the current scope.
  useEffect(() => {
    if (cache.current.scope !== scope || cache.current.bridge !== bridge)
      cache.current = { scope, bridge, read: new Map() };
    const current = cache.current;
    // A retry of unresolved receipts does not withdraw another tool's confirmed target.
    const ids = new Set(candidates.map((receipt) => receipt.id));
    for (const id of current.read.keys()) if (!ids.has(id)) current.read.delete(id);
    let active = true,
      readId: string | undefined;
    const publish = (loading: boolean, error?: string) =>
      setState({ scope, bridge, reads: [...current.read.values()], loading, error });
    if (!bridge || !storeId || !sessionId || !workspaceId || viewSelection === undefined) {
      publish(false);
      return;
    }
    if (suspended) return;
    publish(true);
    void (async () => {
      const pending = candidates.filter((receipt) => {
        const previous = current.read.get(receipt.id);
        return !previous || !sameToolReceipt(receipt, previous.receipt);
      });
      for (let index = 0; index < pending.length; index += 32) {
        const batch = pending.slice(index, index + 32);
        const messageIds = batch.map((receipt) => receipt.id);
        readId = crypto.randomUUID();
        const page: NativeResult = await nativeReadDeadline(
          bridge.request({
            method: includeRead ? 'fileTargets.list' : 'fileChanges.list',
            generation,
            viewSelection,
            historyEpoch,
            readId,
            messageIds,
          }),
        );
        if (!active) return;
        if (
          !page ||
          !('entries' in page) ||
          !('kind' in page) ||
          page.kind !== (includeRead ? 'fileTargets.page' : 'fileChanges.page') ||
          page.readId !== readId ||
          page.scope.generation !== generation ||
          page.scope.storeId !== storeId ||
          page.scope.sessionId !== sessionId ||
          page.scope.viewSelection !== viewSelection ||
          page.scope.historyEpoch !== historyEpoch ||
          page.scope.workspaceId !== workspaceId ||
          page.entries.some((entry) => !messageIds.includes(entry.messageId))
        )
          throw Error('file_change_identity_mismatch');
        for (const receipt of batch)
          current.read.set(receipt.id, {
            receipt,
            entry: page.entries.find((entry) => entry.messageId === receipt.id),
          });
        publish(true);
      }
      if (active) publish(false);
    })().catch(() => {
      if (active) publish(false, '部分工具记录目前不可读，尚无法确认全部文件操作。');
    });
    return () => {
      active = false;
      if (readId)
        void bridge.request({ method: 'fileChanges.close', generation, readId }).catch(() => {});
    };
  }, [
    bridge,
    scope,
    candidates,
    revision,
    generation,
    historyEpoch,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    includeRead,
    suspended,
  ]);
  const sameScope = state.scope === scope && state.bridge === bridge;
  const entries = useMemo(() => {
    if (!sameScope) return [];
    const originals = new Map(candidates.map((receipt) => [receipt.id, receipt]));
    return state.reads.flatMap(({ receipt, entry }) => {
      const original = originals.get(receipt.id);
      return entry && original && sameToolReceipt(receipt, original) ? [entry] : [];
    });
  }, [sameScope, candidates, state.reads]);
  return {
    entries,
    loading: !sameScope || state.loading,
    error: sameScope ? state.error : undefined,
    retry: () => setRevision((value) => value + 1),
  };
}
