import type { Dispatch } from 'react';
import React from 'react';
import { defaultCheckpointPath } from '@/core/config/paths';
import { loadSession } from '@/core/persistence/sessions';
import {
  type FileRestoreOutcome,
  type FileRestorePreview,
  previewFilesToCheckpoint,
  restoreFilesToCheckpoint,
} from '@/core/runtime/file-checkpoints';
import { createRuntimeStore } from '@/core/runtime/store';
import type { Action } from '../reducers/actions';
import { sessionDataToUI } from '../replay-blocks';
import type { SessionManager } from '../session-manager';
import type { RewindScope } from '../types';

export interface RewindDeps {
  dispatch: Dispatch<Action>;
  sessionManager: SessionManager;
  workspace: string;
  threadIdRef: React.MutableRefObject<string>;
}

interface RewindNote {
  text: string;
  isError?: boolean;
}

export function rewindFileOutcomeNotes(
  scope: RewindScope,
  fileOutcome: FileRestoreOutcome,
): RewindNote[] {
  const notes: RewindNote[] = [];
  const fileCount = fileOutcome.restored.length + fileOutcome.deleted.length;
  const skippedCount = fileOutcome.failed.length + fileOutcome.conflicts.length;
  if (fileCount > 0) {
    notes.push({
      text:
        scope === 'code_only'
          ? `已恢复 ${fileCount} 个文件，会话内容未更改。`
          : `已从检查点创建新会话，并恢复 ${fileCount} 个文件。`,
    });
  } else if (skippedCount > 0) {
    notes.push({
      text:
        scope === 'code_only'
          ? '未恢复任何文件，会话内容未更改。'
          : '已从检查点创建新会话；未恢复任何文件。',
    });
  } else {
    notes.push({
      text:
        scope === 'code_only'
          ? '没有需要恢复的已记录文件，会话内容未更改。'
          : '已从检查点创建新会话；没有需要恢复的已记录文件。',
    });
  }
  if (fileOutcome.failed.length > 0) {
    notes.push({
      isError: true,
      text: `部分文件恢复失败：${fileOutcome.failed.map((file) => file.path).join('、')}`,
    });
  }
  if (fileOutcome.conflicts.length > 0) {
    notes.push({
      isError: true,
      text: `为保护后续修改，已跳过冲突文件：${fileOutcome.conflicts
        .map((file) => file.path)
        .join('、')}`,
    });
  }
  return notes;
}

function storePath(): string {
  return `${defaultCheckpointPath().replace(/\.sqlite$/, '')}.runtime.db`;
}

export function isRewindCheckpointAvailable(
  store: {
    getNamedSnapshotEntry: (threadId: string, snapshotId: string) => { snapshotId: string } | null;
    loadNamedSnapshot: (threadId: string, snapshotId: string) => unknown;
  },
  threadId: string,
  snapshotId: string,
): boolean {
  if (!store.getNamedSnapshotEntry(threadId, snapshotId)) return false;
  const snapshot = store.loadNamedSnapshot(threadId, snapshotId);
  return typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot);
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

export function useRunRewind(deps: RewindDeps) {
  const rewindInProgressRef = React.useRef(false);
  const previewRewind = React.useCallback(
    (snapshotId: string): FileRestorePreview | null => {
      const threadId = deps.threadIdRef.current;
      if (!threadId) return null;
      const store = createRuntimeStore(storePath());
      try {
        if (!isRewindCheckpointAvailable(store, threadId, snapshotId)) return null;
        return previewFilesToCheckpoint(store, threadId, snapshotId, deps.workspace);
      } finally {
        store.close();
      }
    },
    [deps.threadIdRef, deps.workspace],
  );
  const runRewind = React.useCallback(
    async (scope: RewindScope, snapshotId: string) => {
      const sourceThreadId = deps.threadIdRef.current;
      const runtime = deps.sessionManager.getRuntime(sourceThreadId);
      if (!sourceThreadId || runtime?.agentLoopActive || rewindInProgressRef.current) return;
      rewindInProgressRef.current = true;
      let store: ReturnType<typeof createRuntimeStore> | null = null;
      let targetThreadId = sourceThreadId;
      let recoveredData: Awaited<ReturnType<typeof loadSession>> = null;
      const localNotes: RewindNote[] = [];
      try {
        store = createRuntimeStore(storePath());
        const restoresConversation =
          scope === 'code_and_conversation' || scope === 'conversation_only';
        const restoresCode = scope === 'code_and_conversation' || scope === 'code_only';
        if (!isRewindCheckpointAvailable(store, sourceThreadId, snapshotId)) {
          throw new Error('Recovery point is unavailable or corrupted.');
        }

        if (restoresConversation) {
          targetThreadId = `tui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          if (!store.forkSession(sourceThreadId, snapshotId, targetThreadId)) {
            throw new Error('Recovery point is unavailable or corrupted.');
          }
          recoveredData = await loadSession(defaultCheckpointPath(), targetThreadId);
          if (!recoveredData) throw new Error('Recovered session could not be loaded.');
        }

        if (restoresCode) {
          const fileOutcome = restoreFilesToCheckpoint(
            store,
            sourceThreadId,
            snapshotId,
            deps.workspace,
          );
          localNotes.push(...rewindFileOutcomeNotes(scope, fileOutcome));
        }

        if (scope === 'conversation_only') {
          localNotes.push({ text: '已从检查点创建新会话，工作区代码未更改。' });
        }

        if (restoresConversation) {
          const data = recoveredData;
          if (!data) throw new Error('Recovered session could not be loaded.');
          const fork = deps.sessionManager.registerSession(targetThreadId, deps.workspace);
          fork.setForeground(true);
          deps.sessionManager.switchSession(sourceThreadId, targetThreadId);
          deps.threadIdRef.current = targetThreadId;
          deps.dispatch({ type: 'SET_SESSIONS', sessions: deps.sessionManager.getSnapshot() });

          const ui = sessionDataToUI(data);
          deps.dispatch({
            type: 'LOAD_SESSION',
            threadId: targetThreadId,
            blocks: ui.blocks,
            interrupt: ui.interrupt,
            pendingToolCalls: ui.pendingToolCalls,
            modelProvider: data.modelProvider,
            modelName: data.modelName,
            thinkingLevel: data.thinkingLevel,
          });
          deps.dispatch({ type: 'SET_EXITED' });
        }

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
        store?.close();
        rewindInProgressRef.current = false;
      }
    },
    [deps],
  );

  return { runRewind, previewRewind };
}
