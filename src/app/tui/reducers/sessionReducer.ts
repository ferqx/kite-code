// ── 会话管理（登录/切换/删除）、用户消息、模型选择 ──

import type { Action } from "./actions";
import type { TuiState, OutputBlock, SessionSnapshot } from "../types";

export function sessionReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case "NEW_SESSION": {
      // Save current session blocks/status to outgoing snapshot
      const newSessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, blocks: state.blocks, status: state.status, active: false }
          : s
      );
      const newSnapshot: SessionSnapshot = {
        threadId: action.threadId,
        name: action.threadId,
        workspace: state.sessions.find(s => s.threadId === state.activeSessionId)?.workspace ?? "",
        active: true,
        running: false,
        pendingInterrupt: false,
        plan: null,
        status: { ...state.status, totalTokens: 0, cacheHitRate: 0, currentNode: null, plan: null },
        blocks: [],
      };
      return {
        ...state,
        sessions: [...newSessions, newSnapshot],
        activeSessionId: action.threadId,
        blocks: [],
        toolStartTimes: undefined,
        interrupt: null,
        exited: false,
        running: false,
        compacting: false,
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        loadingSession: false,
        showHelp: false,
        showModelSelector: false,
        showSessions: false,
        showMcp: false,
        rewindCounter: 0,
        currentRunReasonId: undefined,
        sessionKey: state.sessionKey + 1,
        status: { ...state.status, totalTokens: 0, cacheHitRate: 0, currentNode: null, plan: null },
      };
    }
    case "LOAD_SESSION_PENDING":
      return { ...state, loadingSession: true };
    case "LOAD_SESSION": {
      const sessions = state.sessions.map(s =>
        s.threadId === action.threadId
          ? { ...s, status: { ...s.status, modelName: action.modelName || s.status.modelName, thinkingMode: action.thinkingLevel || s.status.thinkingMode } }
          : s
      );
      return {
        ...state,
        sessions,
        blocks: action.blocks,
        interrupt: action.interrupt,
        showSessions: false,
        showRewind: false,
        checkpoints: [],
        exited: false,
        running: false,
        compacting: false,
        currentRunReasonId: undefined,
        loadingSession: false,
        status: {
          ...state.status,
          modelName: action.modelName || state.status.modelName,
          thinkingMode: action.thinkingLevel || state.status.thinkingMode,
        },
      };
    }
    case "SWITCH_SESSION": {
      const sessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, blocks: state.blocks, status: state.status, active: false }
          : s.threadId === action.threadId
            ? { ...s, active: true }
            : s
      );
      const target = sessions.find(s => s.threadId === action.threadId);
      return {
        ...state,
        sessions,
        activeSessionId: action.threadId,
        blocks: target?.blocks ?? [],
        status: target?.status ?? state.status,
        interrupt: target?.pendingInterrupt ? state.interrupt : null,
        exited: false,
        running: target?.running ?? false,
        compacting: false,
        currentRunReasonId: undefined,
        sessionKey: state.sessionKey + 1,
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        loadingSession: false,
        editorRequested: false,
        showHelp: false,
        showModelSelector: false,
        showSessions: false,
        showMcp: false,
        showRewind: false,
        checkpoints: [],
      };
    }
    case "SET_SESSIONS": {
      // Merge: preserve existing blocks/status for sessions already in state
      const mergedSessions = action.sessions.map((incoming) => {
        const existing = state.sessions.find((s) => s.threadId === incoming.threadId);
        if (existing) {
          return { ...incoming, blocks: existing.blocks, status: existing.status };
        }
        return incoming;
      });
      const activeIncoming = action.sessions.find((s) => s.active);
      return {
        ...state,
        sessions: mergedSessions,
        activeSessionId: activeIncoming?.threadId ?? state.activeSessionId,
      };
    }
    case "SESSION_INTERRUPT_PENDING": {
      const sessions = state.sessions.map(s =>
        s.threadId === action.threadId ? { ...s, pendingInterrupt: true } : s
      );
      return { ...state, sessions };
    }
    case "DELETE_SESSION":
      // Actual deletion happens in dispatchSessionLoad interceptor (index.tsx).
      // The reducer just closes the selector.
      return { ...state, showSessions: false };
    case "SELECT_MODEL":
      return {
        ...state,
        showModelSelector: false,
        status: { ...state.status, modelName: action.modelId },
      };
    case "USER_MESSAGE": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "user", content: action.text };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    default:
      return null;
  }
}
