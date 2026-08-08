// ── 会话管理（登录/切换/删除）、用户消息、模型选择 ──
import type { OutputBlock, SessionSnapshot, TuiState } from '../types';
import type { Action } from './actions';
import { appendBlock, maxBlockIdInTurns, reconstructTurns } from './helpers';

export function sessionReducer(state: TuiState, action: Action): TuiState | null {
  switch (action.type) {
    case 'NEW_SESSION': {
      // Save current session turns/status/interrupt/running to outgoing snapshot
      const newSessions = state.sessions.map((s) =>
        s.threadId === state.activeSessionId
          ? {
              ...s,
              turns: state.turns,
              status: state.status,
              interrupt: state.interrupt,
              running: state.running,
              pendingToolCalls: state.pendingToolCalls,
              active: false,
            }
          : s,
      );
      // A new TUI session owns a fresh Runtime whose durable phase starts in
      // building. Do not inherit the outgoing session's planning projection:
      // Shift+Tab would otherwise try to exit planning in a Runtime that was
      // never in planning mode and receive no transition event.
      const newStatus = {
        ...state.status,
        phase: 'building' as const,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalTokens: 0,
        cacheHitRate: 0,
        contextSnapshot: undefined,
        currentNode: null,
        plan: null,
        pendingPlan: null,
        retryState: null,
      };
      const newSnapshot: SessionSnapshot = {
        threadId: action.threadId,
        name: action.threadId,
        workspace:
          state.sessions.find((s) => s.threadId === state.activeSessionId)?.workspace ?? '',
        active: true,
        running: false,
        pendingInterrupt: false,
        interrupt: null,
        plan: null,
        status: newStatus,
        turns: [],
        pendingToolCalls: {},
      };
      return {
        ...state,
        sessions: [...newSessions, newSnapshot],
        activeSessionId: action.threadId,
        turns: [],
        nextBlockId: 0,
        toolStartTimes: undefined,
        pendingToolCalls: {},
        interrupt: null,
        exited: false,
        running: false,
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        loadingSessionId: null,
        sessionServiceUnavailable: false,
        showHelp: false,
        showModelSelector: false,
        showSessions: false,
        showMcp: false,
        currentRunReasonId: undefined,
        currentThoughtSummaryId: undefined,
        thoughtPhaseStatus: undefined,
        currentModelRequestId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
        sessionKey: state.sessionKey + 1,
        status: newStatus,
      };
    }
    case 'LOAD_SESSION_PENDING':
      return { ...state, loadingSessionId: action.threadId };
    case 'LOAD_SESSION': {
      // Save outgoing session's turns/status/interrupt/running before overwriting
      const sessionsWithSaved = state.sessions.map((s) =>
        s.threadId === state.activeSessionId
          ? {
              ...s,
              turns: state.turns,
              status: state.status,
              interrupt: state.interrupt,
              running: state.running,
              pendingToolCalls: state.pendingToolCalls,
              active: false,
            }
          : s,
      );
      const sessions = sessionsWithSaved.map((s) =>
        s.threadId === action.threadId
          ? {
              ...s,
              active: true,
              status: {
                ...s.status,
                modelProvider: action.modelProvider || s.status.modelProvider,
                modelName: action.modelName || s.status.modelName,
                thinkingMode: action.thinkingLevel || s.status.thinkingMode,
                contextSnapshot: undefined,
              },
            }
          : s,
      );
      const target = sessions.find((s) => s.threadId === action.threadId);
      const loadedTurns = reconstructTurns(action.blocks);
      const nextId = Math.max(state.nextBlockId, maxBlockIdInTurns(loadedTurns) + 1);
      return {
        ...state,
        sessions,
        activeSessionId: action.threadId,
        turns: loadedTurns,
        nextBlockId: nextId,
        toolStartTimes: undefined,
        pendingToolCalls: action.pendingToolCalls ?? target?.pendingToolCalls ?? {},
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
        currentThoughtSummaryId: undefined,
        thoughtPhaseStatus: undefined,
        currentModelRequestId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
        loadingSessionId: null,
        sessionServiceUnavailable: false,
        sessionKey: state.sessionKey + 1,
        sessionError: false,
        ctrlCPressed: false,
        exitRequested: false,
        status: {
          ...(target?.status ?? state.status),
          // 恢复 pendingPlan 以便 Footer PlanReviewBlock 读取 / Restore pendingPlan for Footer PlanReviewBlock
          pendingPlan:
            action.interrupt?.kind === 'plan_review' ? (action.interrupt.plan ?? null) : null,
          modelProvider:
            action.modelProvider || target?.status.modelProvider || state.status.modelProvider,
          modelName: action.modelName || target?.status.modelName || state.status.modelName,
          thinkingMode:
            action.thinkingLevel || target?.status.thinkingMode || state.status.thinkingMode,
          contextSnapshot: undefined,
        },
      };
    }
    case 'SWITCH_SESSION': {
      const sessions = state.sessions.map((s) =>
        s.threadId === state.activeSessionId
          ? {
              ...s,
              turns: state.turns,
              status: state.status,
              interrupt: state.interrupt,
              running: state.running,
              pendingToolCalls: state.pendingToolCalls,
              active: false,
            }
          : s.threadId === action.threadId
            ? { ...s, active: true }
            : s,
      );
      const target = sessions.find((s) => s.threadId === action.threadId);
      const targetTurns = target?.turns ?? [];
      return {
        ...state,
        sessions,
        activeSessionId: action.threadId,
        turns: targetTurns,
        nextBlockId: Math.max(state.nextBlockId, maxBlockIdInTurns(targetTurns) + 1),
        status: target?.status ?? state.status,
        interrupt: target?.interrupt ?? null,
        toolStartTimes: undefined,
        pendingToolCalls: target?.pendingToolCalls ?? {},
        exited: false,
        running: target?.running ?? false,
        currentRunReasonId: undefined,
        currentThoughtSummaryId: undefined,
        thoughtPhaseStatus: undefined,
        currentModelRequestId: undefined,
        currentModelReasoningStreamed: false,
        currentModelReasoningText: undefined,
        sessionKey: state.sessionKey + 1,
        ctrlCPressed: false,
        exitRequested: false,
        sessionError: false,
        loadingSessionId: null,
        sessionServiceUnavailable: false,
        showHelp: false,
        showModelSelector: false,
        showSessions: false,
        showMcp: false,
        showRewind: false,
        checkpoints: [],
      };
    }
    case 'SET_SESSIONS': {
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
            pendingToolCalls: isActive ? state.pendingToolCalls : existing.pendingToolCalls,
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
    case 'SET_SESSION_SERVICE_UNAVAILABLE':
      return { ...state, sessionServiceUnavailable: action.unavailable };
    case 'SESSION_INTERRUPT_PENDING': {
      const sessions = state.sessions.map((s) =>
        s.threadId === action.threadId ? { ...s, pendingInterrupt: true } : s,
      );
      return { ...state, sessions };
    }
    case 'DELETE_SESSION':
      return { ...state, showSessions: false };
    case 'SET_THINKING_LEVEL':
      return {
        ...state,
        status: { ...state.status, thinkingMode: action.level },
      };
    case 'SELECT_MODEL': {
      return {
        ...state,
        showModelSelector: false,
        status: {
          ...state.status,
          modelName: action.modelName,
          modelProvider: action.provider,
          contextSnapshot: undefined,
        },
      };
    }
    case 'USER_MESSAGE': {
      const block: OutputBlock = { id: state.nextBlockId, kind: 'user', content: action.text };
      return appendBlock(state, block);
    }
    default:
      return null;
  }
}
