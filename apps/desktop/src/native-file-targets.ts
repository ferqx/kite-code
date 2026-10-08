import type { Message } from '@kite-ai/client';
import { useEffect, useRef, useState } from 'react';
import type { NativeFileChange } from './file-changes-bridge';
import type { NativeBridge, NativeSelection } from './native-bridge';

/** Both retained file consumers read the same exact metadata; bodies remain lazy. */
export function useNativeFileTargets({
  bridge,
  generation,
  selection,
  historyEpoch,
  messages,
  includeRead = false,
}: {
  bridge?: NativeBridge;
  generation: number;
  selection?: NativeSelection;
  historyEpoch: number;
  messages: readonly Message[];
  includeRead?: boolean;
}) {
  const storeId = selection?.storeId,
    sessionId = selection?.session.id,
    workspaceId = selection?.session.workspaceId;
  const viewSelection = selection?.viewSelection ?? selection?.viewGeneration;
  const scope = JSON.stringify([
    generation,
    selection?.storeId,
    selection?.session.id,
    viewSelection,
    historyEpoch,
    includeRead,
  ]);
  const ids = selection
    ? messages
        .filter((message) => {
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
        .map((message) => message.id)
        .join(',')
    : '';
  const [revision, setRevision] = useState(0);
  const cache = useRef({
    scope,
    revision,
    read: new Set<string>(),
    entries: new Map<string, NativeFileChange>(),
  });
  const [state, setState] = useState<{
    scope: string;
    entries: NativeFileChange[];
    loading: boolean;
    error?: string;
  }>({ scope, entries: [], loading: true });
  useEffect(() => {
    if (cache.current.scope !== scope || cache.current.revision !== revision)
      cache.current = { scope, revision, read: new Set(), entries: new Map() };
    const current = cache.current;
    let active = true,
      readId: string | undefined;
    const publish = (loading: boolean, error?: string) =>
      setState({ scope, entries: [...current.entries.values()], loading, error });
    if (!bridge || !storeId || !sessionId || !workspaceId || viewSelection === undefined) {
      publish(false);
      return;
    }
    publish(true);
    void (async () => {
      const pending = ids ? ids.split(',').filter((id) => !current.read.has(id)) : [];
      for (let index = 0; index < pending.length; index += 32) {
        const batch = pending.slice(index, index + 32);
        readId = crypto.randomUUID();
        const page = await bridge.request({
          method: includeRead ? 'fileTargets.list' : 'fileChanges.list',
          generation,
          viewSelection,
          historyEpoch,
          readId,
          messageIds: batch,
        });
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
          page.entries.some((entry) => !batch.includes(entry.messageId))
        )
          throw Error('file_change_identity_mismatch');
        for (const id of batch) current.read.add(id);
        for (const entry of page.entries) current.entries.set(entry.messageId, entry);
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
    ids,
    revision,
    generation,
    historyEpoch,
    storeId,
    sessionId,
    workspaceId,
    viewSelection,
    includeRead,
  ]);
  return {
    entries: state.scope === scope ? state.entries : [],
    loading: state.loading,
    error: state.scope === scope ? state.error : undefined,
    retry: () => setRevision((value) => value + 1),
  };
}
