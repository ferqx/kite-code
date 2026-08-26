import type {
  RuntimeCheckpointProjection,
  RuntimeRewindPreviewProjection,
} from '@kite-ai/runtime-contract';
import type { Dispatch } from 'react';
import React from 'react';
import type { TuiRuntimeClientFacade as SessionManager } from '../../adapters/tui/session-adapter';
import type { Action } from '../reducers/actions';
import { sessionDataToUI } from '../replay-blocks';
import type { RewindFileOutcome, RewindFilePreview } from '../runtime-presentation';
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
  fileOutcome: RewindFileOutcome,
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

function checkpointEntry(checkpoint: RuntimeCheckpointProjection) {
  return {
    snapshotId: checkpoint.checkpointId,
    eventPosition: checkpoint.eventPosition,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.targetMessage === undefined ? {} : { targetMessage: checkpoint.targetMessage }),
    ...(checkpoint.targetMessageCreatedAt === undefined
      ? {}
      : { targetMessageCreatedAt: checkpoint.targetMessageCreatedAt }),
    affectedFileCount: checkpoint.affectedFileCount,
  };
}

function rewindFilePreview(preview: RuntimeRewindPreviewProjection): RewindFilePreview {
  return {
    files: preview.files,
    lineStatsAvailable: preview.lineStatsAvailable,
    addedLines: preview.addedLines,
    removedLines: preview.removedLines,
    conflictCount: preview.conflictCount,
    failureCount: preview.failureCount,
  };
}

/** RuntimeStore-backed recovery-point list. */
export function useRewindCheckpoints(
  state: { showRewind: boolean },
  dispatch: Dispatch<Action>,
  threadIdRef: React.MutableRefObject<string>,
  sessionManager: SessionManager,
) {
  React.useEffect(() => {
    if (!state.showRewind || !threadIdRef.current) return;
    const sessionId = threadIdRef.current;
    let cancelled = false;
    void sessionManager
      .listRewindCheckpoints(sessionId)
      .then((checkpoints) => {
        if (!cancelled && threadIdRef.current === sessionId) {
          dispatch({ type: 'SET_CHECKPOINTS', checkpoints: checkpoints.map(checkpointEntry) });
        }
      })
      .catch(() => {
        if (!cancelled && threadIdRef.current === sessionId) {
          dispatch({ type: 'SET_CHECKPOINTS', checkpoints: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [state.showRewind, dispatch, threadIdRef, sessionManager]);
}

export function useRunRewind(deps: RewindDeps) {
  const rewindInProgressRef = React.useRef(false);
  const previewRewind = React.useCallback(
    async (snapshotId: string): Promise<RewindFilePreview | null> => {
      const threadId = deps.threadIdRef.current;
      if (!threadId) return null;
      const preview = await deps.sessionManager.previewRewind(threadId, snapshotId);
      return preview ? rewindFilePreview(preview) : null;
    },
    [deps.threadIdRef, deps.sessionManager],
  );
  const runRewind = React.useCallback(
    async (scope: RewindScope, snapshotId: string) => {
      const sourceThreadId = deps.threadIdRef.current;
      const runtime = deps.sessionManager.getRuntime(sourceThreadId);
      if (!sourceThreadId || runtime?.agentLoopActive || rewindInProgressRef.current) return;
      rewindInProgressRef.current = true;
      let targetThreadId = sourceThreadId;
      const localNotes: RewindNote[] = [];
      try {
        const restoresConversation =
          scope === 'code_and_conversation' || scope === 'conversation_only';
        const result = await deps.sessionManager.executeRewind({
          sourceThreadId,
          snapshotId,
          scope,
          workspace: deps.workspace,
        });
        targetThreadId = result.targetThreadId;
        if (result.fileOutcome) {
          localNotes.push(...rewindFileOutcomeNotes(scope, result.fileOutcome));
        }

        if (scope === 'conversation_only') {
          localNotes.push({ text: '已从检查点创建新会话，工作区代码未更改。' });
        }

        if (restoresConversation) {
          const data = result.recoveredData;
          if (!data) throw new Error('Recovered session could not be loaded.');
          const fork = deps.sessionManager.registerSession(targetThreadId, deps.workspace);
          const resumedRoute = deps.sessionManager.applyPersistedModelRoute(
            targetThreadId,
            data.modelProvider,
            data.modelName,
          );
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
            modelProvider: resumedRoute.provider,
            modelName: resumedRoute.name,
            thinkingLevel: data.thinkingLevel,
            reasoningEnabled: resumedRoute.reasoningEnabled,
          });
          deps.dispatch({ type: 'SET_EXITED' });
        }

        for (const note of localNotes) {
          deps.dispatch({ type: 'LOCAL_TEXT', text: note.text, isError: note.isError });
        }
      } catch {
        deps.dispatch({
          type: 'RUNTIME_EVENT',
          event: { type: 'unavailable', reason: 'unknown_event' },
        });
      } finally {
        rewindInProgressRef.current = false;
      }
    },
    [deps],
  );

  return { runRewind, previewRewind };
}
