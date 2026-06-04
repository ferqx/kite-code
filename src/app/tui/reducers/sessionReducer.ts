// ── 会话管理（登录/切换/删除）、用户消息、模型选择 ──

import type { Action } from "./actions";
import type { TuiState, OutputBlock, SessionSnapshot, Turn } from "../types";
import { reconstructTurns } from "./helpers";

export function sessionReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case "NEW_SESSION": {
      // Save current session turns/status to outgoing snapshot
      const newSessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, turns: state.turns, status: state.status, active: false }
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
        status: { ...state.status, totalTokens: 0, cacheHitRate: 0,currentNode: null, plan: null },
        turns: [],
      };
      return {
        ...state,
        sessions: [...newSessions, newSnapshot],
        activeSessionId: action.threadId,
        turns: [],
        toolStartTimes: undefined,
        blockIndex: {},
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
        status: { ...state.status, totalTokens: 0, cacheHitRate: 0,currentNode: null, plan: null },
      };
    }
    case "LOAD_SESSION_PENDING":
      return { ...state, loadingSession: true };
    case "LOAD_SESSION": {
      // Save outgoing session's turns/status before overwriting (same pattern as SWITCH_SESSION / NEW_SESSION)
      const sessionsWithSaved = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, turns: state.turns, status: state.status, active: false }
          : s
      );
      const sessions = sessionsWithSaved.map(s =>
        s.threadId === action.threadId
          ? {
              ...s,
              active: true,
              status: {
                ...s.status,
                modelProvider: action.modelProvider || s.status.modelProvider,
                modelName: action.modelName || s.status.modelName,
                thinkingMode: action.thinkingLevel || s.status.thinkingMode,
              },
            }
          : s
      );
      return {
        ...state,
        sessions,
        activeSessionId: action.threadId,
        turns: reconstructTurns(action.blocks),
        blockIndex: {},
        toolStartTimes: undefined,
        interrupt: action.interrupt,
        showSessions: false,
        showRewind: false,
        checkpoints: [],
        exited: false,
        running: false,
        compacting: false,
        currentRunReasonId: undefined,
        loadingSession: false,
        sessionKey: state.sessionKey + 1,
        sessionError: false,
        ctrlCPressed: false,
        exitRequested: false,
        status: {
          ...state.status,
          modelProvider: action.modelProvider || state.status.modelProvider,
          modelName: action.modelName || state.status.modelName,
          thinkingMode: action.thinkingLevel || state.status.thinkingMode,
        },
      };
    }
    case "SWITCH_SESSION": {
      const sessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, turns: state.turns, status: state.status, active: false }
          : s.threadId === action.threadId
            ? { ...s, active: true }
            : s
      );
      const target = sessions.find(s => s.threadId === action.threadId);
      return {
        ...state,
        sessions,
        activeSessionId: action.threadId,
        turns: target?.turns ?? [],
        blockIndex: {},
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
      // Merge: preserve existing turns/status for sessions already in state
      const mergedSessions = action.sessions.map((incoming) => {
        const existing = state.sessions.find((s) => s.threadId === incoming.threadId);
        if (existing) {
          return { ...incoming, turns: existing.turns, status: existing.status };
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
      const newTurn: Turn = { blocks: [block] };
      return { ...state, turns: [...state.turns, newTurn], nextBlockId: id + 1 };
    }
    default:
      return null;
  }
}
