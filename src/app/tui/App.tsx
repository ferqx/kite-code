import { Box, Text, useWindowSize } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import React, {
  type Dispatch,
  type ReactNode,
  useCallback,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import type { McpManager } from '@/core/mcp';
import ApprovalBlock from './components/ApprovalBlock';
import CheckpointSelector from './components/CheckpointSelector';
import HelpPanel from './components/HelpPanel';
import InputBlock from './components/InputBlock';
import McpPanel from './components/McpPanel';
import ModelSelector from './components/ModelSelector';
import PlanReviewBlock from './components/PlanReviewBlock';
import SessionSelector from './components/SessionSelector.js';
import { ACTIVE_DOT, INACTIVE_DOT } from './constants';
import Footer from './Footer';
import Header from './Header';
import { useGlobalKeys } from './hooks/useGlobalKeys';
import { useOverlayHeight } from './hooks/useOverlayHeight';
import OutputArea, { useStaticContent } from './OutputArea';
import { useTheme } from './theme';
import type { TuiState } from './types';

const MemoHeader = React.memo(Header);

import { type Action, eventReducer } from './reducers';

export type { Action } from './reducers';
export { eventReducer };

const initialState: TuiState = {
  sessions: [],
  activeSessionId: null,
  turns: [],
  nextBlockId: 1,
  interrupt: null,
  status: {
    phase: 'building',
    plan: null,
    pendingPlan: null,
    authorization: 'default',
    workspaceAccess: 'write',
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelProvider: '',
    modelName: 'deepseek-v4',
    thinkingMode: 'max',
    retryState: null,
  },
  exited: false,
  running: false,
  runCount: 0,
  currentRunReasonId: undefined,
  showHelp: false,
  showModelSelector: false,
  showSessions: false,
  showMcp: false,
  showRewind: false,
  checkpoints: [],
  rewindCounter: 0,
  ctrlCPressed: false,
  sessionKey: 0,
  exitRequested: false,
  sessionError: false,
  loadingSessionId: null,
  pendingSkills: [],
  skillManifests: [],
};

export function createInitialState(): TuiState {
  return { ...initialState, turns: [], interrupt: null };
}

export interface AppProps {
  state: TuiState;
  dispatch: Dispatch<Action>;
  onToggleReason: (id: number) => void;
  provider: import('./provider').TuiUserInputProvider;
  mcpManager?: McpManager;
  availableModels?: import('@/core/config').AvailableModel[];
  slashSuggestion?: import('./components/InputLine').SlashSuggestionData | null;
  resizeGeneration?: number;
  children?: ReactNode;
}

export function useTuiState(
  initialModelName?: string,
  initialProviderName?: string,
  initialThinkingMode?: string | null,
): { state: TuiState; dispatch: Dispatch<Action>; onToggleReason: (id: number) => void } {
  const statusOverrides: Partial<TuiState['status']> = {};
  if (initialModelName) statusOverrides.modelName = initialModelName;
  if (initialProviderName) statusOverrides.modelProvider = initialProviderName;
  if (initialThinkingMode) statusOverrides.thinkingMode = initialThinkingMode;
  const hasOverrides = Object.keys(statusOverrides).length > 0;
  const initState = hasOverrides
    ? { ...initialState, status: { ...initialState.status, ...statusOverrides } }
    : initialState;
  const [state, dispatch] = useReducer(eventReducer, initState);
  const onToggleReason = useCallback((id: number) => dispatch({ type: 'TOGGLE_REASON', id }), []);
  return { state, dispatch, onToggleReason };
}

export default function App({
  state,
  dispatch,
  onToggleReason,
  provider,
  mcpManager,
  slashSuggestion,
  resizeGeneration,
  children,
}: AppProps) {
  const theme = useTheme();
  const slashMaxHeight = useOverlayHeight(7);
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
  useGlobalKeys(dispatch, overlayOrInterrupt, supplementEscRef, wizardEscBackRef);

  // Stabilized callbacks for React.memo children
  const hideHelp = useCallback(() => dispatch({ type: 'HIDE_HELP' }), [dispatch]);
  const hideModelSelector = useCallback(
    () => dispatch({ type: 'HIDE_MODEL_SELECTOR' }),
    [dispatch],
  );
  const selectModel = useCallback(
    (modelId: string) => dispatch({ type: 'SELECT_MODEL', modelId }),
    [dispatch],
  );
  const hideSessions = useCallback(() => dispatch({ type: 'HIDE_SESSIONS' }), [dispatch]);
  const hideMcp = useCallback(() => dispatch({ type: 'HIDE_MCP' }), [dispatch]);
  const hideRewind = useCallback(() => dispatch({ type: 'HIDE_REWIND' }), [dispatch]);
  const handleRevert = useCallback(
    (checkpointId: string) => dispatch({ type: 'REVERT_TO_CHECKPOINT', checkpointId }),
    [dispatch],
  );
  const handleFork = useCallback(
    (checkpointId: string) => dispatch({ type: 'FORK_FROM_CHECKPOINT', checkpointId }),
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
    if (state.interrupt.kind === 'plan_review') return undefined; // plan_review 数据从 interrupt.plan 读取
    const blockId = state.interrupt.blockId;
    for (const turn of state.turns) {
      const found = turn.blocks.find((b) => b.id === blockId);
      if (found) return found;
    }
    return undefined;
  }, [state.interrupt, state.turns]);

  const awaitingApproval = state.interrupt?.kind === 'approval';

  const resolveApproval = useCallback(
    (action: string, grant?: string, pattern?: string) => {
      if (!interruptBlock) return;
      dispatch({
        type: 'RESOLVE_INTERRUPT',
        blockId: interruptBlock.id,
        resolution: { action, grant, pattern },
      });
    },
    [dispatch, interruptBlock],
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
  const header = useMemo(
    () => <MemoHeader running={state.running} error={state.sessionError} />,
    [state.running, state.sessionError],
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
        columns={columns}
      />

      {/* ── Footer: 3-row interaction zone ── */}
      <Footer
        status={state.status}
        running={state.running && !state.interrupt}
        timerKey={state.runCount}
      >
        {/* Interaction row: input line or approval/input UI, mutually exclusive */}
        {!state.interrupt && children}
        {interruptBlock?.kind === 'approval' && !interruptBlock.resolved && (
          <ApprovalBlock
            approval={interruptBlock.approval}
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
            provider={provider}
            onResolved={resolvePlanReview}
            supplementEscRef={supplementEscRef}
          />
        )}
      </Footer>

      {/* ── Overlay: panels below Footer ── */}
      {state.showHelp && <HelpPanel onClose={hideHelp} />}
      {state.showSessions && (
        <SessionSelector
          onSelect={selectSession}
          onClose={hideSessions}
          onDelete={deleteSessionAction}
          loadingSessionId={state.loadingSessionId}
          activeSessionId={state.activeSessionId}
        />
      )}
      {state.showModelSelector && (
        <ModelSelector
          currentModel={state.status.modelName}
          onSelect={selectModel}
          onClose={hideModelSelector}
        />
      )}
      {state.showMcp && mcpManager && <McpPanel manager={mcpManager} onClose={hideMcp} />}
      {state.showRewind && (
        <CheckpointSelector
          checkpoints={state.checkpoints}
          onRevert={handleRevert}
          onFork={handleFork}
          onClose={hideRewind}
        />
      )}
      {slashSuggestion &&
        (() => {
          const listHeight = Math.max(3, slashMaxHeight - 2);
          return (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={theme.primary}
              paddingX={1}
              marginTop={1}
            >
              <Text bold color={theme.primary}>
                {slashSuggestion.kind === 'model'
                  ? `模型匹配 "${slashSuggestion.partial}"`
                  : slashSuggestion.kind === 'effort'
                    ? `推理深度匹配 "${slashSuggestion.partial}"`
                    : slashSuggestion.kind === 'theme'
                      ? `主题匹配 "${slashSuggestion.partial}"`
                      : `命令匹配 /${slashSuggestion.partial}`}
              </Text>
              <Box height={Math.min(slashSuggestion.items.length, listHeight)}>
                <ScrollList selectedIndex={slashSuggestion.selectedIndex} scrollAlignment="auto">
                  {slashSuggestion.items.map((item, i) => {
                    const isSelected = i === slashSuggestion.selectedIndex;
                    const aliasStr =
                      slashSuggestion.kind === 'command' && item.aliases.length > 0
                        ? ` (${item.aliases.join(', ')})`
                        : '';
                    const argsStr = item.args ? ` ${item.args}` : '';
                    const activeDot = item.isActive ? ACTIVE_DOT : INACTIVE_DOT;
                    return (
                      <Box key={item.command}>
                        <Text color={isSelected ? theme.primary : theme.muted}>
                          {isSelected ? '❯' : ' '} {activeDot}/{item.command}
                          {argsStr}
                        </Text>
                        <Text color={theme.dim}>{aliasStr}</Text>
                        {item.description && <Text color={theme.dim}> — {item.description}</Text>}
                      </Box>
                    );
                  })}
                </ScrollList>
              </Box>
              <Text color={theme.dim}>↑↓ 导航 Tab/→ 补全 Enter 提交 Esc 关闭</Text>
            </Box>
          );
        })()}
    </Box>
  );
}
