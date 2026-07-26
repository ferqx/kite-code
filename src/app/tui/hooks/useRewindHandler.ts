import type { Dispatch } from 'react';
import React from 'react';
import { defaultCheckpointPath } from '@/core/config/paths';
import { loadSession } from '@/core/persistence/sessions';
import { restoreFilesToCheckpoint } from '@/core/runtime/file-checkpoints';
import { createRuntimeStore } from '@/core/runtime/store';
import type { Action } from '../reducers/actions';
import { sessionDataToUI } from '../replay-blocks';
import type { SessionManager } from '../session-manager';

export interface RewindDeps {
  dispatch: Dispatch<Action>;
  sessionManager: SessionManager;
  workspace: string;
  threadIdRef: React.MutableRefObject<string>;
}

function storePath(): string {
  return defaultCheckpointPath().replace(/\.sqlite$/, '') + '.runtime.db';
}

/** RuntimeStore-backed recovery-point list. */
export function useRewindCheckpoints(
  state: { showRewind: boolean },
  dispatch: Dispatch<Action>,
  threadIdRef: React.MutableRefObject<string>,
) {
  React.useEffect(() => {
    if (!state.showRewind || !threadIdRef.current) return;
    const store = createRuntimeStore(storePath());
    try {
      dispatch({
        type: 'SET_CHECKPOINTS',
        checkpoints: store.listNamedSnapshots(threadIdRef.current),
      });
    } finally {
      store.close();
    }
  }, [state.showRewind, dispatch, threadIdRef]);
}

export function useRunRewind(state: { rewindCounter: number }, deps: RewindDeps) {
  const previous = React.useRef(0);
  const pending = React.useRef<{ type: 'revert' | 'fork'; snapshotId: string } | null>(null);

  const dispatchSessionLoadInterceptor = React.useCallback((action: Action) => {
    if (action.type === 'REVERT_TO_CHECKPOINT')
      pending.current = { type: 'revert', snapshotId: action.checkpointId };
    if (action.type === 'FORK_FROM_CHECKPOINT')
      pending.current = { type: 'fork', snapshotId: action.checkpointId };
  }, []);

  const runRewind = React.useCallback(
    async (type: 'revert' | 'fork', snapshotId: string) => {
      const sourceThreadId = deps.threadIdRef.current;
      const runtime = deps.sessionManager.getRuntime(sourceThreadId);
      if (!sourceThreadId || runtime?.agentLoopActive) return;
      const store = createRuntimeStore(storePath());
      let targetThreadId = sourceThreadId;
      const localNotes: Array<{ text: string; isError?: boolean }> = [];
      try {
        if (type === 'revert') {
          // ADR-0025 §4：先恢复工作区文件到检查点时刻的状态，再截断会话。
          // 顺序不可颠倒：restoreNamedSnapshot 会清掉检查点之后的文件原像。
          const fileOutcome = restoreFilesToCheckpoint(
            store,
            sourceThreadId,
            snapshotId,
            deps.workspace,
          );
          if (!store.restoreNamedSnapshot(sourceThreadId, snapshotId)) {
            throw new Error('Recovery point is unavailable or corrupted.');
          }
          const fileCount = fileOutcome.restored.length + fileOutcome.deleted.length;
          if (fileCount > 0) {
            localNotes.push({
              text: `已恢复 ${fileCount} 个文件到检查点 / Restored ${fileCount} file(s) to checkpoint.`,
            });
          }
          if (fileOutcome.failed.length > 0) {
            localNotes.push({
              isError: true,
              text: `部分文件恢复失败 / Failed to restore: ${fileOutcome.failed.map((f) => f.path).join(', ')}`,
            });
          }
        } else {
          targetThreadId = `tui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          if (!store.forkSession(sourceThreadId, snapshotId, targetThreadId)) {
            throw new Error('Recovery point is unavailable or corrupted.');
          }
          const fork = deps.sessionManager.registerSession(targetThreadId, deps.workspace);
          fork.setForeground(true);
          deps.sessionManager.switchSession(sourceThreadId, targetThreadId);
          deps.threadIdRef.current = targetThreadId;
        }
        const data = await loadSession(defaultCheckpointPath(), targetThreadId);
        if (!data) throw new Error('Recovered session could not be loaded.');
        const ui = sessionDataToUI(data);
        deps.dispatch({
          type: 'LOAD_SESSION',
          threadId: targetThreadId,
          blocks: ui.blocks,
          interrupt: ui.interrupt,
          modelProvider: data.modelProvider,
          modelName: data.modelName,
          thinkingLevel: data.thinkingLevel,
        });
        deps.dispatch({ type: 'SET_EXITED' });
        for (const note of localNotes) {
          deps.dispatch({ type: 'LOCAL_TEXT', text: note.text, isError: note.isError });
        }
      } catch (error) {
        deps.dispatch({
          type: 'RUNTIME_EVENT',
          event: {
            type: 'run.error',
            message: error instanceof Error ? error.message : String(error),
            recoverable: true,
          },
        });
      } finally {
        store.close();
      }
    },
    [deps],
  );

  React.useEffect(() => {
    if (state.rewindCounter === previous.current) return;
    previous.current = state.rewindCounter;
    const action = pending.current;
    pending.current = null;
    if (action) void runRewind(action.type, action.snapshotId);
  }, [state.rewindCounter, runRewind]);

  return { runRewind, dispatchSessionLoadInterceptor };
}
