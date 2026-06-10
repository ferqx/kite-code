// ── 会话管理（登录/切换/删除）、用户消息、模型选择 ──

import type { Action } from "./actions";
import type { TuiState, OutputBlock, SessionSnapshot, Turn } from "../types";
import { reconstructTurns, appendBlock, buildBlockIndex } from "./helpers";

/** Compute nextBlockId from turns (max block ID + 1, or 0 if empty) */
function maxBlockIdInTurns(turns: Turn[]): number {
  let max = 0;
  for (const turn of turns) {
    for (const b of turn.blocks) {
      if (b.id >= max) max = b.id;
    }
  }
  return max;
}

export function sessionReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case "NEW_SESSION": {
      // Save current session turns/status/interrupt/running to outgoing snapshot
      const newSessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, turns: state.turns, status: state.status, interrupt: state.interrupt, running: state.running, active: false }
          : s
      );
      const newSnapshot: SessionSnapshot = {
        threadId: action.threadId,
        name: action.threadId,
        workspace: state.sessions.find(s => s.threadId === state.activeSessionId)?.workspace ?? "",
        active: true,
        running: false,
        pendingInterrupt: false,
        interrupt: null,
        plan: null,
        status: { ...state.status, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0, cacheHitRate: 0, currentNode: null, plan: null },
        turns: [],
      };
      return {
        ...state,
        sessions: [...newSessions, newSnapshot],
        activeSessionId: action.threadId,
        turns: [],
        nextBlockId: 0,
        toolStartTimes: undefined,
        blockIndex: {},
        interrupt: null,
        exited: false,
        running: false,
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        loadingSessionId: null,
        showHelp: false,
        showModelSelector: false,
        showSessions: false,
        showMcp: false,
        rewindCounter: 0,
        currentRunReasonId: undefined,
        sessionKey: state.sessionKey + 1,
        status: { ...state.status, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0, cacheHitRate: 0, currentNode: null, plan: null },
      };
    }
    case "LOAD_SESSION_PENDING":
      return { ...state, loadingSessionId: action.threadId };
    case "LOAD_SESSION": {
      // Save outgoing session's turns/status/interrupt/running before overwriting
      const sessionsWithSaved = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, turns: state.turns, status: state.status, interrupt: state.interrupt, running: state.running, active: false }
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
      const target = sessions.find(s => s.threadId === action.threadId);
      const loadedTurns = reconstructTurns(action.blocks);
      return {
        ...state,
        sessions,
        activeSessionId: action.threadId,
        turns: loadedTurns,
        blockIndex: buildBlockIndex(loadedTurns),
        toolStartTimes: undefined,
        interrupt: action.interrupt,
        showHelp: false,
        showSessions: false,
        showModelSelector: false,
        showMcp: false,
        showRewind: false,
        checkpoints: [],
        exited: false,
        running: false,
        currentRunReasonId: undefined,
        loadingSessionId: null,
        sessionKey: state.sessionKey + 1,
        sessionError: false,
        ctrlCPressed: false,
        exitRequested: false,
        editorRequested: false,
        status: {
          ...(target?.status ?? state.status),
          modelProvider: action.modelProvider || target?.status.modelProvider || state.status.modelProvider,
          modelName: action.modelName || target?.status.modelName || state.status.modelName,
          thinkingMode: action.thinkingLevel || target?.status.thinkingMode || state.status.thinkingMode,
        },
      };
    }
    case "SWITCH_SESSION": {
      const sessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, turns: state.turns, status: state.status, interrupt: state.interrupt, running: state.running, active: false }
          : s.threadId === action.threadId
            ? { ...s, active: true }
            : s
      );
      const target = sessions.find(s => s.threadId === action.threadId);
      const targetTurns = target?.turns ?? [];
      return {
        ...state,
        sessions,
        activeSessionId: action.threadId,
        turns: targetTurns,
        blockIndex: buildBlockIndex(targetTurns),
        nextBlockId: Math.max(state.nextBlockId, maxBlockIdInTurns(targetTurns) + 1),
        status: target?.status ?? state.status,
        interrupt: target?.interrupt ?? null,
        toolStartTimes: undefined,
        exited: false,
        running: target?.running ?? false,
        currentRunReasonId: undefined,
        sessionKey: state.sessionKey + 1,
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        loadingSessionId: null,
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
      // Merge: preserve existing turns/status for sessions already in state.
      // For the currently active session, use state.status (live cache metrics etc.)
      // instead of the snapshot's stale zero-value status.
      const mergedSessions = action.sessions.map((incoming) => {
        const existing = state.sessions.find((s) => s.threadId === incoming.threadId);
        const isActive = incoming.threadId === state.activeSessionId;
        if (existing) {
          return {
            ...incoming,
            turns: existing.turns,
            status: isActive ? state.status : existing.status,
          };
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
    case "SET_THINKING_LEVEL":
      return {
        ...state,
        status: { ...state.status, thinkingMode: action.level },
      };
    case "SELECT_MODEL":
      return {
        ...state,
        showModelSelector: false,
        status: { ...state.status, modelName: action.modelId },
      };
    case "USER_MESSAGE": {
      const block: OutputBlock = { id: state.nextBlockId, kind: "user", content: action.text };
      return appendBlock(state, block);
    }
    default:
      return null;
  }
}
