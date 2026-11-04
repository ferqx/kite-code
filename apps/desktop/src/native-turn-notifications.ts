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
  useLayoutEffect(() => {
    if (!directory || directory.unavailable || !seen || !visible) return;
    const source = directory.sessions.find((session) => session.id === reading?.session.id);
    const run = source?.activity?.run;
    const turn = terminalTurn(run);
    if (
      !source ||
      !run ||
      !turn ||
      reading?.storeId !== directory.storeId ||
      reading.viewLoading ||
      reading.permissionUnavailable ||
      !reading.runs.some((run) => terminalTurn(run) === turn) ||
      seen.get(source.id) === turn ||
      local?.get(source.id) === turn
    )
      return;
    const key = JSON.stringify([generation, directory.storeId, source.id, turn]);
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
      })
      .finally(() => pending.current.delete(key));
  }, [bridge, generation, directory, reading, visible, seen, local]);
  const unreadKey = JSON.stringify(
    directory?.sessions.flatMap((session) => {
      const turn = terminalTurn(session.activity?.run);
      return seen && turn && seen.get(session.id) !== turn && local?.get(session.id) !== turn
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
