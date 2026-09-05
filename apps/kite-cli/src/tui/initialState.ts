/**
 * TUI 初始状态 / Initial TUI state
 *
 * 从 App.tsx 抽出，独立于 React 组件树，供 replay-blocks.ts 等非 React 模块安全引用。
 * Extracted from App.tsx so non-React modules (replay-blocks.ts) can import without
 * pulling in React/Ink dependencies.
 */
import type { TuiState } from './types.js';

export const initialState: TuiState = {
  sessions: [],
  presentationMode: 'live',
  requestAssemblies: new Map(),
  requestAssemblyIncomplete: new Set(),
  presentationTimeline: { renderEpoch: 0, items: [] },
  activeSessionId: null,
  turns: [],
  nextBlockId: 1,
  interrupt: null,
  status: {
    phase: 'building',
    plan: null,
    pendingPlan: null,
    workspaceAccess: 'write',
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelProvider: '',
    modelName: 'deepseek-v4',
    thinkingMode: 'max',
    reasoningEnabled: true,
    retryState: null,
  },
  exited: false,
  runCount: 0,
  currentRunReasonId: undefined,
  showHelp: false,
  showModelSelector: false,
  showPermissionSelector: false,
  showEffortSelector: false,
  showThemeSelector: false,
  showLanguageSelector: false,
  showSessions: false,
  showMcp: false,
  showRewind: false,
  checkpoints: [],
  ctrlCPressed: false,
  sessionKey: 0,
  exitRequested: false,
  sessionError: false,
  loadingSessionId: null,
  sessionServiceUnavailable: false,
  explorationSummaryIds: {},
  presentationGroupSummaryIds: {},
  pendingToolCalls: {},
  pendingSubagentTerminals: new Map(),
  acceptedEphemeralSequences: new Map(),
  closedRunIds: new Set(),
  currentThoughtSummaryId: undefined,
  currentModelRequestId: undefined,
  toolBearingModelRequestId: undefined,
  toolBearingPresentationGroupId: undefined,
  currentModelReasoningStreamed: false,
  currentModelReasoningText: undefined,
  currentModelReasoningRequestId: undefined,
  settledModelRequestIds: new Set(),
  interactionMode: 'auto',
  sessionCommandGrants: new Map(),
  sessionCommandGrantGeneration: 0,
  sessionCommandGrantRevision: 0,
  skillManifests: [],
};

export function createInitialState(): TuiState {
  return {
    ...initialState,
    turns: [],
    interrupt: null,
    pendingToolCalls: {},
    presentationTimeline: { renderEpoch: 0, items: [] },
  };
}
