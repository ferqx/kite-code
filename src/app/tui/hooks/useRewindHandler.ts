// ── Rewind（会话回溯）：checkpoint 面板 + revert/fork 执行 ──

import type { Dispatch } from 'react';
import React from 'react';
import type { AgentConfig } from '@/core/config/index';
import { defaultCheckpointPath } from '@/core/config/paths';
import type { McpManager } from '@/core/mcp';
import { BunSqliteSaver } from '@/core/persistence/checkpoint';
import { forkFromCheckpoint, isRecoverableError, revertToCheckpoint } from '@/core/runner';
import { createSandboxExecutor } from '@/core/sandbox/index';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { Action } from '../reducers/actions';
import { buildForkParams, buildRevertParams } from '../run-agent';
import type { SessionManager } from '../session-manager';
import type { TuiState } from '../types';

export interface RewindDeps {
  dispatch: Dispatch<Action>;
  provider: import('../provider').TuiUserInputProvider;
  config: AgentConfig;
  workspace: string;
  sessionManager: SessionManager;
  threadIdRef: React.MutableRefObject<string>;
  loadGenerationRef: React.MutableRefObject<number>;
  conversationHistoryRef: React.MutableRefObject<string[]>;
  thinkingLevelRef: React.MutableRefObject<string | null>;
  skillManifestsRef: React.MutableRefObject<SkillManifest[]>;
  skillOptionsRef: React.MutableRefObject<SkillScanOptions | null>;
  mcpManagerRef: React.MutableRefObject<McpManager | null>;
  agentLoopActiveRef: React.MutableRefObject<boolean>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  stateRef: React.MutableRefObject<TuiState>;
}

/** Load checkpoint list when Rewind panel is opened */
export function useRewindCheckpoints(
  state: { showRewind: boolean },
  dispatch: Dispatch<Action>,
  threadIdRef: React.MutableRefObject<string>,
) {
  React.useEffect(() => {
    if (!state.showRewind || !threadIdRef.current) return;

    let disposed = false;
    const checkpointPath = defaultCheckpointPath();
    let saver: BunSqliteSaver | null = null;
    try {
      saver = new BunSqliteSaver(checkpointPath);
      saver
        .listCheckpoints(threadIdRef.current)
        .then((cps) => {
          if (disposed) return;
          dispatch({ type: 'SET_CHECKPOINTS', checkpoints: cps });
        })
        .catch(() => {
          if (disposed) return;
          dispatch({ type: 'SET_CHECKPOINTS', checkpoints: [] });
        })
        .finally(() => {
          saver?.close();
        });
    } catch {
      dispatch({ type: 'SET_CHECKPOINTS', checkpoints: [] });
      saver?.close();
    }
    return () => {
      disposed = true;
      try {
        saver?.close();
      } catch {
        /* already closed */
      }
    };
  }, [state.showRewind, dispatch, threadIdRef.current]);
}

/** Execute revert/fork when triggered by CheckpointSelector */
export function useRunRewind(state: { rewindCounter: number }, deps: RewindDeps) {
  const prevRewindCounterRef = React.useRef(0);
  const pendingRewindRef = React.useRef<
    { type: 'revert'; checkpointId: string } | { type: 'fork'; checkpointId: string } | null
  >(null);

  // Store pending rewind action (called from dispatchSessionLoad interceptor)
  const dispatchSessionLoadInterceptor = React.useCallback((action: any) => {
    if (action.type === 'REVERT_TO_CHECKPOINT') {
      pendingRewindRef.current = { type: 'revert', checkpointId: action.checkpointId };
    } else if (action.type === 'FORK_FROM_CHECKPOINT') {
      pendingRewindRef.current = { type: 'fork', checkpointId: action.checkpointId };
    }
  }, []);

  const runRewind = React.useCallback(
    async (type: 'revert' | 'fork', checkpointId: string) => {
      const {
        dispatch,
        provider,
        config,
        workspace,
        sessionManager,
        threadIdRef,
        conversationHistoryRef,
        thinkingLevelRef,
        skillManifestsRef,
        skillOptionsRef,
        mcpManagerRef,
        agentLoopActiveRef,
        abortControllerRef,
        stateRef,
      } = deps;

      if (agentLoopActiveRef.current) return;
      // Also check session runtime — normal agent loop sets rt.agentLoopActive,
      // which the local ref doesn't track. Prevents concurrent graph operations
      // on the same threadId (especially dangerous for revert, which reuses the
      // existing threadId).
      const rt = sessionManager.getRuntime(threadIdRef.current);
      if (rt?.agentLoopActive) return;

      dispatch({ type: 'SET_RUNNING' });

      const threadId = threadIdRef.current;
      if (!threadId) {
        provider.onEvent({
          type: 'error',
          data: { message: 'No active session. Start a conversation first.', recoverable: false },
        });
        dispatch({ type: 'SET_EXITED' });
        dispatch({ type: 'SET_IDLE' });
        return;
      }

      const shellExecutor = createSandboxExecutor({ enabled: true, workspace });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      agentLoopActiveRef.current = true;

      const baseRewindParams = {
        threadId,
        workspace,
        config,
        shellExecutor,
        signal: abortController.signal,
        thinkingLevel: thinkingLevelRef.current,
        skills: skillManifestsRef.current,
        skillOptions: skillOptionsRef.current,
        mcpManager: mcpManagerRef.current,
      };

      let generator: AsyncGenerator<any>;
      if (type === 'revert') {
        generator = revertToCheckpoint(
          provider,
          buildRevertParams({
            ...baseRewindParams,
            checkpointId,
          }),
        );
      } else {
        const newThreadId = `tui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const forkedRt = sessionManager.registerSession(newThreadId, workspace);
        // Flush token stats for the outgoing session before leaving it
        sessionManager.saveTokenStats(threadId, stateRef.current.status, true);
        sessionManager.switchSession(threadId, newThreadId);
        if (forkedRt) forkedRt.setForeground(true);
        forkedRt.thinkingLevel = thinkingLevelRef.current;
        forkedRt.conversationHistory = [...conversationHistoryRef.current];
        threadIdRef.current = newThreadId;
        sessionManager.onStatusChange(newThreadId);
        dispatch({ type: 'SET_SESSIONS', sessions: sessionManager.getSnapshot() });
        dispatch({ type: 'SWITCH_SESSION', threadId: newThreadId });
        generator = forkFromCheckpoint(
          provider,
          buildForkParams({
            ...baseRewindParams,
            oldThreadId: threadId,
            checkpointId,
            newThreadId,
          }),
        );
      }

      let aborted = false;
      try {
        for await (const _ of generator) {
          if (abortController.signal.aborted) {
            aborted = true;
            break;
          }
        }
        if (!aborted) dispatch({ type: 'SET_EXITED' });
      } catch (e: any) {
        provider.onEvent({
          type: 'error',
          data: { message: e?.message ?? String(e), recoverable: isRecoverableError(e) },
        });
        dispatch({ type: 'SET_EXITED' });
      } finally {
        abortControllerRef.current = null;
        agentLoopActiveRef.current = false;
        provider.reset();
        dispatch({ type: 'SET_IDLE' });
      }
    },
    [deps],
  );

  // Trigger runRewind when rewindCounter changes
  React.useEffect(() => {
    if (state.rewindCounter === prevRewindCounterRef.current) return;
    prevRewindCounterRef.current = state.rewindCounter;
    if (state.rewindCounter === 0) return;

    const pending = pendingRewindRef.current;
    pendingRewindRef.current = null;
    if (!pending) return;

    runRewind(pending.type, pending.checkpointId);
  }, [state.rewindCounter, runRewind]);

  return { runRewind, dispatchSessionLoadInterceptor };
}
