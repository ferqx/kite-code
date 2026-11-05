import type { WorkspaceSummary } from '@kite-ai/ui/desktop';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge, NativeDirectory, NativeSelection } from './native-bridge';

function terminalTurn(run: { id: string; status: string; isActive: boolean } | null | undefined) {
  return run &&
    !run.isActive &&
    ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
    ? JSON.stringify([run.id, run.status])
    : undefined;
}

/** Main owns durable receipts; rendering only acknowledges a committed local write. */
export function useNativeTurnNotifications(
  bridge: NativeBridge,
  generation: number,
  directory: NativeDirectory | undefined,
  workspaces: readonly WorkspaceSummary[],
  reading?: NativeSelection,
): readonly WorkspaceSummary[] {
  const currentStore = directory?.storeId;
  const receipts = useRef<{ storeId?: string; turns?: ReadonlyMap<string, string> }>({});
  if (receipts.current.storeId !== currentStore) receipts.current = { storeId: currentStore };
  if (directory?.readTurns) receipts.current.turns = new Map(directory.readTurns);
  const seen = receipts.current.turns;
  const store = useRef(currentStore);
  store.current = currentStore;
  const [acknowledged, setAcknowledged] = useState<{
    storeId: string;
    turns: ReadonlyMap<string, string>;
  }>();
  const pending = useRef(new Set<string>());
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useLayoutEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const local =
    acknowledged && acknowledged.storeId === currentStore ? acknowledged.turns : undefined;
  const source = directory?.sessions.find((session) => session.id === reading?.session.id);
  const run = source?.activity?.run;
  const turn = terminalTurn(run);
  const key = source && turn && JSON.stringify([generation, currentStore, source.id, turn]);
  const watching = useRef<string | undefined>(undefined);
  const [failedWrite, setFailedWrite] = useState<string>();
  const watchingKey =
    directory &&
    !directory.unavailable &&
    seen &&
    visible &&
    reading &&
    reading.storeId === currentStore &&
    (!reading.permissionUnavailable || reading.viewLoading) &&
    source &&
    run &&
    reading.runs.some((value) => value.id === run.id)
      ? JSON.stringify([generation, currentStore, source.id, run.id])
      : undefined;
  useLayoutEffect(() => {
    if (watching.current !== watchingKey) watching.current = undefined;
    if (
      watchingKey &&
      run?.isActive &&
      !reading?.viewLoading &&
      !reading?.permissionUnavailable &&
      reading?.runs.some((value) => value.id === run.id && value.isActive)
    )
      watching.current = watchingKey;
  }, [watchingKey, run, reading]);
  // An on-screen completion need not flash while its receipt commits. This is not a receipt:
  // leaving the page, losing the read, or failing the write restores the durable unread fact.
  const savingViewedTurn =
    key && watchingKey && watching.current === watchingKey && key !== failedWrite;
  useLayoutEffect(() => {
    if (!directory || directory.unavailable || !seen || !visible) return;
    if (
      !source ||
      !run ||
      !turn ||
      !key ||
      reading?.storeId !== directory.storeId ||
      reading.viewLoading ||
      reading.permissionUnavailable ||
      !reading.runs.some((run) => terminalTurn(run) === turn) ||
      seen.get(source.id) === turn ||
      local?.get(source.id) === turn
    )
      return;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    void bridge
      .request({
        method: 'session.markRead',
        generation,
        expectedStoreId: directory.storeId,
        sessionId: source.id,
        runId: run.id,
        status: run.status as 'completed' | 'failed' | 'cancelled' | 'interrupted',
      })
      .then(() => {
        if (store.current !== directory.storeId) return;
        setAcknowledged((previous) => ({
          storeId: directory.storeId,
          turns: new Map(previous?.storeId === directory.storeId ? previous.turns : []).set(
            source.id,
            turn,
          ),
        }));
      })
      .catch(() => {
        // A failed write does not consume the reminder; a later observation may retry.
        if (watching.current === watchingKey) setFailedWrite(key);
      })
      .finally(() => pending.current.delete(key));
  }, [
    bridge,
    generation,
    directory,
    reading,
    visible,
    seen,
    local,
    source,
    run,
    turn,
    key,
    watchingKey,
  ]);
  const unreadKey = JSON.stringify(
    directory?.sessions.flatMap((session) => {
      const turn = terminalTurn(session.activity?.run);
      return seen &&
        turn &&
        seen.get(session.id) !== turn &&
        local?.get(session.id) !== turn &&
        !(savingViewedTurn && session.id === source?.id)
        ? [session.id]
        : [];
    }) ?? [],
  );
  return useMemo(() => {
    const unread = new Set<string>(JSON.parse(unreadKey));
    return workspaces.map((workspace) => {
      let changed = false;
      const sessions = workspace.sessions.map((session) => {
        if (!unread.has(session.sessionId)) return session;
        changed = true;
        return { ...session, hasUnreadTurn: true };
      });
      return changed ? { ...workspace, sessions } : workspace;
    });
  }, [workspaces, unreadKey]);
}
