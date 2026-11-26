import type { Message } from '@kite-ai/client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeFileChange } from './file-changes-bridge';
import type { NativeBridge, NativeResult, NativeSelection } from './native-bridge';
import { nativeReadDeadline } from './native-read-deadline';
import { sameToolReceipt } from './native-tool-messages';

type FileTargetRead = { receipt: Message; entry?: NativeFileChange };
type VerifiedFileTargetRead = { receipt: Message; entry: NativeFileChange };

/** Both retained file consumers read the same exact metadata; bodies remain lazy. */
export function useNativeFileTargets({
  bridge,
  generation,
  selection,
  historyEpoch,
  messages,
  includeRead = false,
  suspended = false,
  historyPending = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  includeRead?: boolean;
  suspended?: boolean;
  historyPending?: boolean;
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
  const verified = useMemo(() => {
    const originals = new Map(candidates.map((receipt) => [receipt.id, receipt]));
    const checked = new Set<string>();
    const reads = !sameScope
      ? []
      : state.reads.flatMap(({ receipt, entry }) => {
          const original = originals.get(receipt.id);
          if (!original || !sameToolReceipt(receipt, original)) return [];
          checked.add(receipt.id);
          return entry ? [{ receipt, entry }] : [];
        });
    return { reads, checked, entries: reads.map(({ entry }) => entry) };
  }, [sameScope, candidates, state.reads]);
  const displayScope =
    includeRead && hasSelection
      ? JSON.stringify([generation, storeId, sessionId, workspaceId])
      : undefined;
  const displayed = useRef<
    { owner: string; bridge?: NativeBridge; reads: VerifiedFileTargetRead[] } | undefined
  >(undefined);
  const displayReads = useMemo(() => {
    const prior = displayed.current;
    if (!displayScope || prior?.owner !== displayScope || prior.bridge !== bridge)
      return verified.reads;
    const originals = new Map(messages.map((message) => [message.id, message]));
    const current = new Set(verified.reads.map(({ receipt }) => receipt.id));
    const retained = prior.reads.filter(({ receipt }) => {
      const original = originals.get(receipt.id);
      return (
        !current.has(receipt.id) &&
        (original ? sameToolReceipt(receipt, original) : historyPending) &&
        (historyPending || !verified.checked.has(receipt.id))
      );
    });
    return retained.length ? [...verified.reads, ...retained] : verified.reads;
  }, [displayScope, bridge, verified, messages, historyPending]);
  // A superseded observation withdraws action authority immediately. The same
  // conversation can keep its exact prior target while fresh metadata is pending.
  useLayoutEffect(() => {
    displayed.current = displayScope
      ? { owner: displayScope, bridge, reads: displayReads }
      : undefined;
  }, [displayScope, bridge, displayReads]);
  const displayEntries = useMemo(
    () =>
      displayReads === verified.reads ? verified.entries : displayReads.map(({ entry }) => entry),
    [displayReads, verified],
  );
  return {
    entries: verified.entries,
    displayEntries,
    loading: !sameScope || state.loading,
    error: sameScope ? state.error : undefined,
    retry: () => setRevision((value) => value + 1),
  };
}
