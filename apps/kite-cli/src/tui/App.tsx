import type { ProviderModelRoute, ProviderModelSnapshot } from '@kite-ai/kite-app-contract';
import { Box, Text, useWindowSize } from 'ink';
import React, {
  type Dispatch,
  type ReactNode,
  useCallback,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import type { LanguagePreference } from '#kite-cli/preferences';
import type { SandboxBackend } from './client-types';
import ApprovalBlock from './components/ApprovalBlock';
import CheckpointSelector from './components/CheckpointSelector';
import HelpPanel from './components/HelpPanel';
import InputBlock from './components/InputBlock';
import ModelSelector, { type ModelOption } from './components/ModelSelector';
import PermissionSelector from './components/PermissionSelector';
import PlanReviewBlock from './components/PlanReviewBlock';
import PreferenceSelector from './components/PreferenceSelector';
import SessionSelector from './components/SessionSelector.js';
import SlashSuggestionOverlay from './components/SlashSuggestionOverlay';
import Footer from './Footer';
import Header from './Header';
import { useGlobalKeys } from './hooks/useGlobalKeys';
import { useOverlayHeight } from './hooks/useOverlayHeight';
import { useI18n } from './i18n';
import { createInitialState, initialState } from './initialState';
import McpOverlay from './mcp/McpOverlay';
import type { McpController } from './mcp/types';
import OutputArea, { useStaticContent } from './OutputArea';
import { type Action, eventReducer } from './reducers';
import { deriveRunStatusSnapshot } from './run-status';
import type { ThemePreset } from './theme';
import { useTheme } from './theme';
import type { OutputBlock, TuiPendingApproval, TuiState } from './types';

type SafeApprovalEntry = TuiPendingApproval & {
  readonly clientInteraction?: Extract<
    import('@kite-ai/runtime-contract').RuntimeClientInteraction,
    { readonly kind: 'approval' }
  >;
};

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
  providerModelSnapshot?: ProviderModelSnapshot;
  availableModels?: readonly ProviderModelRoute[];
  onModelSelect?: (model: ModelOption) => Promise<boolean> | boolean;
  slashSuggestion?: import('./hooks/useSlashSuggestions').SlashSuggestionData | null;
  sandboxBackend?: SandboxBackend;
  onTogglePlanMode?: () => void;
  onInteractionModeChange?: (mode: 'accept_edits' | 'auto' | 'full') => void;
  sessionGrantCount?: number;
  onClearSessionGrants?: () => void;
  themePreset?: ThemePreset;
  onThemeSelect?: (preset: ThemePreset) => void;
  languagePreference?: LanguagePreference;
  onLanguageSelect?: (language: LanguagePreference) => void;
  /** Abort the foreground runtime synchronously before reducer-only cancel actions. */
  onAbort?: () => void;
  getRewindPreview?: (
    checkpointId: string,
  ) => Promise<import('./runtime-presentation').RewindFilePreview | null>;
  resizeGeneration?: number;
  loadSessions?: (query: string) => Promise<import('#kite-cli/session-types').SessionInfo[]>;
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
  providerModelSnapshot,
  availableModels,
  onModelSelect,
  slashSuggestion,
  sandboxBackend = 'none',
  onTogglePlanMode,
  onInteractionModeChange,
  sessionGrantCount,
  onClearSessionGrants,
  themePreset,
  onThemeSelect,
  languagePreference = 'system',
  onLanguageSelect,
  onAbort,
  getRewindPreview,
  resizeGeneration,
  loadSessions = () => Promise.reject(new Error('Session storage is unavailable.')),
  children,
}: AppProps) {
  const t = useTheme();
  const { language, t: translate } = useI18n();
  const slashListHeight = useOverlayHeight(7);
  const { columns, rows } = useWindowSize();
  const modalOverlayActive =
    state.showHelp ||
    state.showModelSelector ||
    state.showPermissionSelector ||
    state.showEffortSelector ||
    state.showThemeSelector ||
    state.showLanguageSelector ||
    state.showSessions ||
    state.showMcp ||
    state.showRewind;
  const activeApprovalEntry = useMemo(() => {
    if (state.activeApprovalId == null) return undefined;
    const pending = state.pendingApprovals?.get(state.activeApprovalId);
    if (!pending || !['queued_user', 'awaiting_user'].includes(pending.status)) {
      return undefined;
    }
    return pending;
  }, [state.activeApprovalId, state.pendingApprovals]);
  // A pending approval may remain durable while an input or plan-review
  // interaction owns the visible surface. Do not let an off-screen queue
  // steal Esc/focus from those older interaction semantics.
  const focusedApprovalEntry =
    state.interrupt && state.interrupt.kind !== 'approval' ? undefined : activeApprovalEntry;
  const safeFocusedApprovalEntry = focusedApprovalEntry as SafeApprovalEntry | undefined;
  const approvalQueueActive = safeFocusedApprovalEntry?.clientInteraction != null;
  const overlayOrInterrupt = modalOverlayActive || !!state.interrupt || approvalQueueActive;
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
      const approvalInteractionId = focusedApprovalEntry?.interactionId;
      if (approvalInteractionId) {
        const approvalGeneration = focusedApprovalEntry.generation;
        if (approvalGeneration == null) return false;
        void provider
          .submitActionAsync({
            type: 'reject',
            interactionId: approvalInteractionId,
            generation: approvalGeneration,
          })
          .then((accepted) => {
            if (!accepted) throw new Error('Approval rejection was not accepted.');
          })
          .catch(() => {
            dispatch({
              type: 'LOCAL_TEXT',
              text: 'Confirmation was not accepted. Press Esc to retry.',
              isError: true,
            });
          });
        return true;
      } else if (state.interrupt) {
        void provider
          .submitActionAsync({
            type: 'cancel',
            interactionId: state.interrupt.interactionId,
          })
          .then((accepted) => {
            if (!accepted) throw new Error('Interaction cancellation was not accepted.');
          })
          .catch(() => {
            dispatch({
              type: 'LOCAL_TEXT',
              text: 'Confirmation was not accepted. Press Esc to retry.',
              isError: true,
            });
          });
        return true;
      }
      return false;
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
  const hideLanguageSelector = useCallback(
    () => dispatch({ type: 'HIDE_LANGUAGE_SELECTOR' }),
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
    async (model: ModelOption) => {
      const selected = (await onModelSelect?.(model)) === true;
      if (selected) {
        dispatch({
          type: 'SELECT_MODEL',
          provider: model.provider,
          modelName: model.name,
        });
      } else {
        dispatch({
          type: 'LOCAL_TEXT',
          text: '无法切换模型；请刷新模型状态后重试。',
          isError: true,
        });
      }
    },
    [dispatch, onModelSelect],
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

  const awaitingApproval = state.interrupt?.kind === 'approval' || approvalQueueActive;
  const awaitingInput = state.interrupt?.kind === 'input';
  const activeApproval = safeFocusedApprovalEntry?.clientInteraction;

  const resolveApproval = useCallback(
    (action: string, grant?: string) => {
      // Runtime remains the durable source of truth. ApprovalBlock invokes this
      // callback only after respond_interaction has an accepted receipt. Project
      // that acknowledgement immediately so a suspended child does not keep saying
      // "Awaiting your approval" until the continuation emits its next event.
      // Rejections stay durable-event-driven because approval.rejected owns the
      // terminal projection for the interrupted turn.
      if (action !== 'approve') return;
      const suspendedSubagents = state.turns.flatMap((turn) =>
        turn.blocks.filter(
          (block): block is Extract<OutputBlock, { kind: 'subagent' }> =>
            block.kind === 'subagent' && block.status === 'suspended',
        ),
      );
      const approvalInterrupt = state.interrupt?.kind === 'approval' ? state.interrupt : undefined;
      const identityTarget =
        approvalInterrupt?.toolCallId == null
          ? undefined
          : suspendedSubagents.find(
              (block) => block.parentToolCallId === approvalInterrupt.toolCallId,
            );
      const awaitingUserTargets = suspendedSubagents.filter(
        (block) =>
          block.approvalState === 'awaiting_user' ||
          (block.approvalState == null && block.awaitingApproval === true),
      );
      const approvalTarget =
        identityTarget ?? (awaitingUserTargets.length === 1 ? awaitingUserTargets[0] : undefined);
      dispatch({
        type: 'RESOLVE_INTERRUPT',
        ...(approvalTarget == null
          ? {}
          : {
              approvalTarget: {
                subagentId: approvalTarget.subagentId,
                ...(approvalTarget.parentToolCallId == null
                  ? {}
                  : { parentToolCallId: approvalTarget.parentToolCallId }),
              },
            }),
        resolution: {
          action: 'approved',
          ...(grant === undefined ? {} : { grant }),
        },
      });
    },
    [dispatch, state.interrupt, state.turns],
  );

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
    presentationKey: language,
  });

  // Runtime decisions supersede any stale local selector state while the
  // reducer transitions the UI to its single interrupt surface.
  const overlayActive = modalOverlayActive && !state.interrupt && !approvalQueueActive;
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
        // Footer interactions own Enter/Escape while visible. Passing the
        // complete capture boundary prevents the approval-confirming Enter
        // from also toggling the last dynamic tool/Subagent card.
        overlayActive={overlayOrInterrupt}
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
          hideGlobalStatus={Boolean(state.interrupt) || approvalQueueActive}
        >
          {/* Interaction row: input line or approval/input UI, mutually exclusive */}
          {!state.interrupt && !approvalQueueActive && (
            <>
              {state.sessionServiceUnavailable && !state.showSessions && (
                <Text color={t.warning}>{translate('session.serviceUnavailable')}</Text>
              )}
              {children}
            </>
          )}
          {activeApproval && (
            <ApprovalBlock
              key={`${state.interrupt?.interactionId ?? 'legacy'}:${activeApproval.generation}`}
              approval={activeApproval}
              provider={provider}
              onResolved={resolveApproval}
              queueEntry={focusedApprovalEntry}
            />
          )}
          {interruptBlock?.kind === 'question' && !interruptBlock.resolved && (
            <InputBlock
              interactionId={state.interrupt?.interactionId}
              question={interruptBlock.question}
              provider={provider}
              onResolved={resolveInput}
              wizardEscBackRef={wizardEscBackRef}
            />
          )}
          {state.interrupt?.kind === 'plan_review' && state.interrupt.plan && (
            <PlanReviewBlock
              interactionId={state.interrupt.interactionId}
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
          loadSessions={loadSessions}
        />
      )}
      {!state.interrupt && state.showModelSelector && (
        <ModelSelector
          currentModel={state.status.modelName}
          currentProvider={state.status.modelProvider}
          snapshot={providerModelSnapshot}
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
          sessionGrantCount={sessionGrantCount ?? state.sessionCommandGrants?.size ?? 0}
          onClearSessionGrants={onClearSessionGrants}
        />
      )}
      {!state.interrupt && state.showEffortSelector && (
        <PreferenceSelector
          title={translate('effort.title')}
          currentValue={state.status.thinkingMode}
          options={[
            {
              value: 'low',
              label: translate('effort.low'),
              description: translate('effort.lowDescription'),
            },
            {
              value: 'medium',
              label: translate('effort.medium'),
              description: translate('effort.mediumDescription'),
            },
            {
              value: 'high',
              label: translate('effort.high'),
              description: translate('effort.highDescription'),
            },
            {
              value: 'max',
              label: translate('effort.max'),
              description: translate('effort.maxDescription'),
            },
          ]}
          onSelect={(level) => dispatch({ type: 'SET_THINKING_LEVEL', level })}
          onClose={hideEffortSelector}
        />
      )}
      {!state.interrupt && state.showThemeSelector && (
        <PreferenceSelector
          title={translate('theme.title')}
          currentValue={themePreset ?? 'teal'}
          options={[
            {
              value: 'teal',
              label: translate('theme.teal'),
              description: translate('theme.tealDescription'),
            },
            {
              value: 'blue',
              label: translate('theme.blue'),
              description: translate('theme.blueDescription'),
            },
            {
              value: 'purple',
              label: translate('theme.purple'),
              description: translate('theme.purpleDescription'),
            },
            {
              value: 'cyan',
              label: translate('theme.cyan'),
              description: translate('theme.cyanDescription'),
            },
            {
              value: 'mono',
              label: translate('theme.mono'),
              description: translate('theme.monoDescription'),
            },
          ]}
          onSelect={(preset) => onThemeSelect?.(preset as ThemePreset)}
          onClose={hideThemeSelector}
        />
      )}
      {!state.interrupt && state.showLanguageSelector && (
        <PreferenceSelector
          title={translate('language.title')}
          currentValue={languagePreference}
          options={[
            {
              value: 'system',
              label: translate('language.system'),
              description: translate('language.systemDescription'),
            },
            {
              value: 'zh-CN',
              label: translate('language.zhCN'),
              description: translate('language.zhCNDescription'),
            },
            {
              value: 'en-US',
              label: translate('language.enUS'),
              description: translate('language.enUSDescription'),
            },
          ]}
          onSelect={(next) => onLanguageSelect?.(next as LanguagePreference)}
          onClose={hideLanguageSelector}
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
