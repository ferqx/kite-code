import { Box, useWindowSize } from 'ink';
import React, {
  type Dispatch,
  type ReactNode,
  useCallback,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { saveModelSelection } from '@/core/config';
import type { SandboxBackend } from '@/core/sandbox';
import ApprovalBlock from './components/ApprovalBlock';
import CheckpointSelector from './components/CheckpointSelector';
import HelpPanel from './components/HelpPanel';
import InputBlock from './components/InputBlock';
import ModelSelector from './components/ModelSelector';
import PlanReviewBlock from './components/PlanReviewBlock';
import SessionSelector from './components/SessionSelector.js';
import SlashSuggestionOverlay from './components/SlashSuggestionOverlay';
import Footer from './Footer';
import Header from './Header';
import { useGlobalKeys } from './hooks/useGlobalKeys';
import { useOverlayHeight } from './hooks/useOverlayHeight';
import { createInitialState, initialState } from './initialState';
import McpOverlay from './mcp/McpOverlay';
import type { McpController } from './mcp/types';
import OutputArea, { useStaticContent } from './OutputArea';
import { type Action, eventReducer } from './reducers';
import { deriveRunStatusSnapshot } from './run-status';
import type { TuiState } from './types';

export type { Action } from './reducers';
export { createInitialState, eventReducer };

const MemoHeader = React.memo(Header);

export function shouldShowRunStatus(state: TuiState): boolean {
  if (state.interrupt) return false;
  if (state.status.currentNode?.startsWith('context_')) {
    return state.compactionProgress?.placement !== 'inline';
  }
  if (!state.running) return false;
  if (state.status.retryState) return true;
  return true;
}

export interface AppProps {
  state: TuiState;
  dispatch: Dispatch<Action>;
  onToggleReason: (id: number) => void;
  provider: import('./provider').TuiUserInputProvider;
  workspace?: string;
  mcpController?: McpController;
  availableModels?: import('@/core/config').AvailableModel[];
  persistModelSelection?: (provider: string, modelName: string) => boolean;
  slashSuggestion?: import('./hooks/useSlashSuggestions').SlashSuggestionData | null;
  sandboxBackend?: SandboxBackend;
  onTogglePlanMode?: () => void;
  getRewindPreview?: (
    checkpointId: string,
  ) => import('@/core/runtime/file-checkpoints').FileRestorePreview | null;
  resizeGeneration?: number;
  children?: ReactNode;
}

export function useTuiState(
  initialModelName?: string,
  initialProviderName?: string,
  initialThinkingMode?: string | null,
  initialInteractionMode?: 'accept_edits' | 'auto' | 'full',
): { state: TuiState; dispatch: Dispatch<Action>; onToggleReason: (id: number) => void } {
  const statusOverrides: Partial<TuiState['status']> = {};
  if (initialModelName) statusOverrides.modelName = initialModelName;
  if (initialProviderName) statusOverrides.modelProvider = initialProviderName;
  if (initialThinkingMode) statusOverrides.thinkingMode = initialThinkingMode;
  const initState = { ...initialState };
  if (Object.keys(statusOverrides).length > 0) {
    initState.status = { ...initialState.status, ...statusOverrides };
  }
  if (initialInteractionMode) {
    initState.interactionMode = initialInteractionMode;
  }
  const [state, dispatch] = useReducer(eventReducer, initState);
  const onToggleReason = useCallback((id: number) => dispatch({ type: 'TOGGLE_REASON', id }), []);
  return { state, dispatch, onToggleReason };
}

export default function App({
  state,
  dispatch,
  onToggleReason,
  provider,
  workspace = process.cwd(),
  mcpController,
  availableModels,
  persistModelSelection = saveModelSelection,
  slashSuggestion,
  sandboxBackend = 'none',
  onTogglePlanMode,
  getRewindPreview,
  resizeGeneration,
  children,
}: AppProps) {
  const slashListHeight = useOverlayHeight(7);
  const { columns } = useWindowSize();
  const overlayOrInterrupt =
    state.showHelp ||
    state.showModelSelector ||
    state.showSessions ||
    state.showMcp ||
    state.showRewind ||
    !!state.interrupt;
  const supplementEscRef = useRef(false);
  const wizardEscBackRef = useRef(false);
  const layeredOverlayEscRef = useRef(false);
  useGlobalKeys(
    dispatch,
    overlayOrInterrupt,
    supplementEscRef,
    wizardEscBackRef,
    layeredOverlayEscRef,
    onTogglePlanMode,
  );

  // Stabilized callbacks for React.memo children
  const hideHelp = useCallback(() => dispatch({ type: 'HIDE_HELP' }), [dispatch]);
  const hideModelSelector = useCallback(
    () => dispatch({ type: 'HIDE_MODEL_SELECTOR' }),
    [dispatch],
  );
  const selectModel = useCallback(
    (model: import('@/core/config').AvailableModel) => {
      const persisted = persistModelSelection(model.provider, model.name);
      dispatch({ type: 'SELECT_MODEL', provider: model.provider, modelName: model.name });
      if (!persisted) {
        dispatch({
          type: 'LOCAL_TEXT',
          text: '模型已切换，但无法保存为下次启动的默认模型。',
          isError: true,
        });
      }
    },
    [dispatch, persistModelSelection],
  );
  const hideSessions = useCallback(() => dispatch({ type: 'HIDE_SESSIONS' }), [dispatch]);
  const hideMcp = useCallback(() => dispatch({ type: 'HIDE_MCP' }), [dispatch]);
  const hideRewind = useCallback(() => dispatch({ type: 'HIDE_REWIND' }), [dispatch]);
  const executeRewind = useCallback(
    (checkpointId: string, scope: import('./types').RewindScope) =>
      dispatch({ type: 'EXECUTE_REWIND', checkpointId, scope }),
    [dispatch],
  );
  const onToggleToolExpand = useCallback(
    (id: number) => dispatch({ type: 'TOGGLE_TOOL_EXPAND', id }),
    [dispatch],
  );
  const onToggleSubagentExpand = useCallback(
    (id: number) => dispatch({ type: 'TOGGLE_SUBAGENT_EXPAND', id }),
    [dispatch],
  );
  const selectSession = useCallback(
    (threadId: string) => {
      // 派发 SWITCH_SESSION，由 dispatchSessionLoad 拦截器判断：
      // - dormancy → 重定向到 LOAD_SESSION_PENDING（从 DB 加载）
      // - 非 dormancy → 内存切换 + 缓冲事件回放
      dispatch({ type: 'SWITCH_SESSION', threadId });
    },
    [dispatch],
  );
  const deleteSessionAction = useCallback(
    (threadId: string) => {
      dispatch({ type: 'DELETE_SESSION', threadId });
    },
    [dispatch],
  );

  const interruptBlock = useMemo(() => {
    if (!state.interrupt) return undefined;
    if (state.interrupt.kind === 'plan_review' || state.interrupt.kind === 'approval') {
      return undefined;
    }
    const blockId = state.interrupt.blockId;
    for (const turn of state.turns) {
      const found = turn.blocks.find((b) => b.id === blockId);
      if (found) return found;
    }
    return undefined;
  }, [state.interrupt, state.turns]);

  const awaitingApproval = state.interrupt?.kind === 'approval';
  const awaitingInput = state.interrupt?.kind === 'input';
  const activeApproval = useMemo(() => {
    if (state.interrupt?.kind !== 'approval') return undefined;
    if (state.interrupt.approval) return state.interrupt.approval;
    const blockId = state.interrupt.blockId;
    if (blockId == null) return undefined;
    for (const turn of state.turns) {
      const block = turn.blocks.find((candidate) => candidate.id === blockId);
      if (block?.kind === 'approval' && !block.resolved) return block.approval;
    }
    return undefined;
  }, [state.interrupt, state.turns]);

  const resolveApproval = useCallback(
    (action: string, grant?: string) => {
      if (state.interrupt?.kind !== 'approval') return;
      dispatch({
        type: 'RESOLVE_INTERRUPT',
        blockId: state.interrupt.blockId,
        resolution: { action, grant },
      });
    },
    [dispatch, state.interrupt],
  );

  const resolveInput = useCallback(
    (answer: string, answers?: Record<string, string>) => {
      if (!interruptBlock) return;
      dispatch({
        type: 'RESOLVE_INTERRUPT',
        blockId: interruptBlock.id,
        resolution: answers ? { action: 'input', text: answer, answers } : answer,
      });
    },
    [dispatch, interruptBlock],
  );

  const resolvePlanReview = useCallback(
    (action: string, feedback?: string) => {
      dispatch({
        type: 'RESOLVE_PLAN_REVIEW',
        resolution: { action, feedback },
      });
    },
    [dispatch],
  );

  // ── Static content computation ──
  // <Static> is rendered at ROOT LEVEL (outside any layout Box) so its
  // scrollback writes never compete with the dynamic tree's Yoga layout.
  const activeWorkspace =
    state.sessions.find((session) => session.threadId === state.activeSessionId)?.workspace ??
    workspace;
  const headerSnapshotRef = useRef({
    sessionKey: state.sessionKey,
    modelName: state.status.modelName,
    thinkingMode: state.status.thinkingMode,
    workspace: activeWorkspace,
  });
  if (headerSnapshotRef.current.sessionKey !== state.sessionKey) {
    headerSnapshotRef.current = {
      sessionKey: state.sessionKey,
      modelName: state.status.modelName,
      thinkingMode: state.status.thinkingMode,
      workspace: activeWorkspace,
    };
  }
  const headerSnapshot = headerSnapshotRef.current;
  const header = useMemo(
    () => (
      <MemoHeader
        modelName={headerSnapshot.modelName}
        thinkingMode={headerSnapshot.thinkingMode}
        workspace={headerSnapshot.workspace}
        columns={columns}
      />
    ),
    [columns, headerSnapshot],
  );

  const {
    staticItems,
    staticKey,
    header: staticHeader,
    mergedStaticBlocks,
    activeDynamicBlocks,
  } = useStaticContent({
    turns: state.turns,
    running: state.running,
    sessionKey: state.sessionKey,
    header,
    resizeGeneration,
  });

  const overlayActive =
    state.showHelp ||
    state.showModelSelector ||
    state.showSessions ||
    state.showMcp ||
    state.showRewind;
  const showRunStatus = shouldShowRunStatus(state);
  const runStatus = showRunStatus ? deriveRunStatusSnapshot(state) : undefined;

  return (
    <Box flexDirection="column">
      {/* ── Body: OutputArea ── */}
      <OutputArea
        staticItems={staticItems}
        staticKey={staticKey}
        staticHeader={staticHeader}
        activeDynamicBlocks={activeDynamicBlocks}
        mergedStaticBlocks={mergedStaticBlocks}
        onToggleReason={onToggleReason}
        onToggleToolExpand={onToggleToolExpand}
        onToggleSubagentExpand={onToggleSubagentExpand}
        overlayActive={overlayActive}
        awaitingApproval={awaitingApproval}
        awaitingInput={awaitingInput}
        columns={columns}
        inlineCompactionPhase={
          state.compactionProgress?.placement === 'inline'
            ? state.compactionProgress.phase
            : undefined
        }
      />

      {/* ── Footer: 3-row interaction zone ── */}
      <Footer
        status={state.status}
        runStatus={runStatus}
        running={showRunStatus}
        timerKey={state.runCount}
        interactionMode={state.interactionMode}
        hideGlobalStatus={Boolean(state.interrupt)}
      >
        {/* Interaction row: input line or approval/input UI, mutually exclusive */}
        {!state.interrupt && children}
        {activeApproval && (
          <ApprovalBlock
            approval={activeApproval}
            provider={provider}
            onResolved={resolveApproval}
          />
        )}
        {interruptBlock?.kind === 'question' && !interruptBlock.resolved && (
          <InputBlock
            question={interruptBlock.question}
            provider={provider}
            onResolved={resolveInput}
            wizardEscBackRef={wizardEscBackRef}
          />
        )}
        {state.interrupt?.kind === 'plan_review' && state.interrupt.plan && (
          <PlanReviewBlock
            plan={state.interrupt.plan}
            artifact={state.interrupt.artifact}
            provider={provider}
            onResolved={resolvePlanReview}
            supplementEscRef={supplementEscRef}
          />
        )}
      </Footer>

      {/* ── Overlay: panels below Footer ── */}
      {state.showHelp && <HelpPanel onClose={hideHelp} sandboxBackend={sandboxBackend} />}
      {state.showSessions && (
        <SessionSelector
          onSelect={selectSession}
          onClose={hideSessions}
          onDelete={deleteSessionAction}
          layeredEscRef={layeredOverlayEscRef}
          loadingSessionId={state.loadingSessionId}
          activeSessionId={state.activeSessionId}
        />
      )}
      {state.showModelSelector && (
        <ModelSelector
          currentModel={state.status.modelName}
          currentProvider={state.status.modelProvider}
          models={availableModels}
          onSelect={selectModel}
          onClose={hideModelSelector}
        />
      )}
      {state.showMcp && mcpController && (
        <McpOverlay
          controller={mcpController}
          layeredEscRef={layeredOverlayEscRef}
          onClose={hideMcp}
        />
      )}
      {state.showRewind && (
        <CheckpointSelector
          checkpoints={state.checkpoints}
          onConfirm={executeRewind}
          onClose={hideRewind}
          getRewindPreview={getRewindPreview}
          layeredEscRef={layeredOverlayEscRef}
        />
      )}
      {slashSuggestion && (
        <SlashSuggestionOverlay
          suggestion={slashSuggestion}
          maxVisibleItems={slashListHeight}
          width={columns}
        />
      )}
    </Box>
  );
}
