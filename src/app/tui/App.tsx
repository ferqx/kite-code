import { Box, Text, useWindowSize } from 'ink';
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
import PermissionSelector from './components/PermissionSelector';
import PlanReviewBlock from './components/PlanReviewBlock';
import PreferenceSelector from './components/PreferenceSelector';
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
import type { ThemePreset } from './theme';
import { useTheme } from './theme';
import type { TuiState } from './types';

export type { Action } from './reducers';
export { createInitialState, eventReducer };

const MemoHeader = React.memo(Header);

export function shouldShowRunStatus(state: TuiState): boolean {
  if (state.interrupt) return false;
  if (state.compactionProgress?.source === 'manual') return false;
  if (!state.running) return false;
  if (state.status.retryState) return true;
  return true;
}

/** Compaction is non-modal; only an active interaction owns the prompt surface. */
export function shouldDisablePromptInput(state: Pick<TuiState, 'interrupt'>): boolean {
  return Boolean(state.interrupt);
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
  onInteractionModeChange?: (mode: 'accept_edits' | 'auto' | 'full') => void;
  themePreset?: ThemePreset;
  onThemeSelect?: (preset: ThemePreset) => void;
  /** Abort the foreground runtime synchronously before reducer-only cancel actions. */
  onAbort?: () => void;
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
  initialReasoningEnabled?: boolean,
): {
  state: TuiState;
  dispatch: Dispatch<Action>;
  onToggleReason: (id: number) => void;
} {
  const statusOverrides: Partial<TuiState['status']> = {};
  if (initialModelName) statusOverrides.modelName = initialModelName;
  if (initialProviderName) statusOverrides.modelProvider = initialProviderName;
  if (initialThinkingMode) statusOverrides.thinkingMode = initialThinkingMode;
  if (initialReasoningEnabled !== undefined) {
    statusOverrides.reasoningEnabled = initialReasoningEnabled;
  }
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
  onInteractionModeChange,
  themePreset,
  onThemeSelect,
  onAbort,
  getRewindPreview,
  resizeGeneration,
  children,
}: AppProps) {
  const t = useTheme();
  const slashListHeight = useOverlayHeight(7);
  const { columns, rows } = useWindowSize();
  const modalOverlayActive =
    state.showHelp ||
    state.showModelSelector ||
    state.showPermissionSelector ||
    state.showEffortSelector ||
    state.showThemeSelector ||
    state.showSessions ||
    state.showMcp ||
    state.showRewind;
  const overlayOrInterrupt = modalOverlayActive || !!state.interrupt;
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
    () => {
      if (state.interrupt) provider.submitAction({ type: 'cancel' });
    },
    onAbort,
  );

  // Stabilized callbacks for React.memo children
  const hideHelp = useCallback(() => dispatch({ type: 'HIDE_HELP' }), [dispatch]);
  const hideModelSelector = useCallback(
    () => dispatch({ type: 'HIDE_MODEL_SELECTOR' }),
    [dispatch],
  );
  const hidePermissionSelector = useCallback(
    () => dispatch({ type: 'HIDE_PERMISSION_SELECTOR' }),
    [dispatch],
  );
  const hideEffortSelector = useCallback(
    () => dispatch({ type: 'HIDE_EFFORT_SELECTOR' }),
    [dispatch],
  );
  const hideThemeSelector = useCallback(
    () => dispatch({ type: 'HIDE_THEME_SELECTOR' }),
    [dispatch],
  );
  const selectInteractionMode = useCallback(
    (mode: 'accept_edits' | 'auto' | 'full') => {
      onInteractionModeChange?.(mode);
      dispatch({ type: 'SET_INTERACTION_MODE', mode });
    },
    [dispatch, onInteractionModeChange],
  );
  const selectModel = useCallback(
    (model: import('@/core/config').AvailableModel) => {
      const persisted = persistModelSelection(model.provider, model.name);
      dispatch({
        type: 'SELECT_MODEL',
        provider: model.provider,
        modelName: model.name,
      });
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
  const onSessionAvailabilityChange = useCallback(
    (available: boolean) => {
      dispatch({
        type: 'SET_SESSION_SERVICE_UNAVAILABLE',
        unavailable: !available,
      });
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

  const resolveApproval = useCallback((_action: string, _grant?: string) => undefined, []);

  const resolveInput = useCallback(
    (_answer: string, _answers?: Record<string, string>) => undefined,
    [],
  );

  const resolvePlanReview = useCallback((_action: string, _feedback?: string) => undefined, []);

  // ── Static content computation ──
  // <Static> is rendered at ROOT LEVEL (outside any layout Box) so its
  // scrollback writes never compete with the dynamic tree's Yoga layout.
  const activeWorkspace =
    state.sessions.find((session) => session.threadId === state.activeSessionId)?.workspace ??
    workspace;
  const header = useMemo(
    () => (
      <MemoHeader
        modelName={state.status.modelName}
        thinkingMode={state.status.thinkingMode}
        reasoningEnabled={state.status.reasoningEnabled}
        workspace={activeWorkspace}
        columns={columns}
      />
    ),
    [
      activeWorkspace,
      columns,
      state.status.modelName,
      state.status.reasoningEnabled,
      state.status.thinkingMode,
    ],
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

  // Runtime decisions supersede any stale local selector state while the
  // reducer transitions the UI to its single interrupt surface.
  const overlayActive = modalOverlayActive && !state.interrupt;
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
        rows={rows}
        compactionPhase={state.compactionProgress?.phase}
      />

      {/* ── Footer: 3-row interaction zone ── */}
      {!overlayActive && (
        <Footer
          status={state.status}
          runStatus={runStatus}
          running={showRunStatus}
          timerKey={state.runCount}
          interactionMode={state.interactionMode}
          hideGlobalStatus={Boolean(state.interrupt)}
        >
          {/* Interaction row: input line or approval/input UI, mutually exclusive */}
          {!state.interrupt && (
            <>
              {state.sessionServiceUnavailable && !state.showSessions && (
                <Text color={t.warning}>历史会话服务不可用，请输入 /sessions 重试。</Text>
              )}
              {children}
            </>
          )}
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
      )}

      {/* ── Overlay: panels below Footer ── */}
      {!state.interrupt && state.showHelp && (
        <HelpPanel onClose={hideHelp} sandboxBackend={sandboxBackend} />
      )}
      {!state.interrupt && state.showSessions && (
        <SessionSelector
          onSelect={selectSession}
          onClose={hideSessions}
          onDelete={deleteSessionAction}
          layeredEscRef={layeredOverlayEscRef}
          loadingSessionId={state.loadingSessionId}
          activeSessionId={state.activeSessionId}
          onAvailabilityChange={onSessionAvailabilityChange}
        />
      )}
      {!state.interrupt && state.showModelSelector && (
        <ModelSelector
          currentModel={state.status.modelName}
          currentProvider={state.status.modelProvider}
          models={availableModels}
          onSelect={selectModel}
          onClose={hideModelSelector}
        />
      )}
      {!state.interrupt && state.showPermissionSelector && (
        <PermissionSelector
          currentMode={state.interactionMode}
          sandboxBackend={sandboxBackend}
          onSelect={selectInteractionMode}
          onClose={hidePermissionSelector}
        />
      )}
      {!state.interrupt && state.showEffortSelector && (
        <PreferenceSelector
          title="选择推理深度"
          currentValue={state.status.thinkingMode}
          options={[
            { value: 'low', label: '低', description: '更快地完成简单任务' },
            { value: 'medium', label: '中', description: '平衡速度与推理深度' },
            { value: 'high', label: '高', description: '为复杂任务投入更多推理' },
            { value: 'max', label: '最大', description: '使用可用的最高推理深度' },
          ]}
          onSelect={(level) => dispatch({ type: 'SET_THINKING_LEVEL', level })}
          onClose={hideEffortSelector}
        />
      )}
      {!state.interrupt && state.showThemeSelector && (
        <PreferenceSelector
          title="选择色彩主题"
          currentValue={themePreset ?? 'teal'}
          options={[
            { value: 'teal', label: '青绿', description: '默认深色主题' },
            { value: 'blue', label: '蓝', description: '蓝色强调主题' },
            { value: 'purple', label: '紫', description: '紫色强调主题' },
            { value: 'cyan', label: '青', description: '青色强调主题' },
            { value: 'mono', label: '单色', description: '低饱和单色主题' },
          ]}
          onSelect={(preset) => onThemeSelect?.(preset as ThemePreset)}
          onClose={hideThemeSelector}
        />
      )}
      {!state.interrupt && state.showMcp && mcpController && (
        <McpOverlay
          controller={mcpController}
          layeredEscRef={layeredOverlayEscRef}
          onClose={hideMcp}
        />
      )}
      {!state.interrupt && state.showRewind && (
        <CheckpointSelector
          checkpoints={state.checkpoints}
          onConfirm={executeRewind}
          onClose={hideRewind}
          getRewindPreview={getRewindPreview}
          layeredEscRef={layeredOverlayEscRef}
        />
      )}
      {!overlayActive && !state.interrupt && slashSuggestion && (
        <SlashSuggestionOverlay
          suggestion={slashSuggestion}
          maxVisibleItems={slashListHeight}
          width={columns}
        />
      )}
    </Box>
  );
}
