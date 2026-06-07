import React, { useReducer, useCallback, useMemo, useRef, type Dispatch, type ReactNode } from "react";
import { Box, Text } from "ink";
import { ScrollList } from "ink-scroll-list";
import type { McpManager } from "@/core/mcp";
import type { TuiState } from "./types";
import OutputArea, { useStaticContent } from "./OutputArea";
import ApprovalBlock from "./components/ApprovalBlock";
import InputBlock from "./components/InputBlock";
import HelpPanel from "./components/HelpPanel";
import McpPanel from "./components/McpPanel";
import CheckpointSelector from "./components/CheckpointSelector";
import ModelSelector from "./components/ModelSelector";
import SessionSelector from "./components/SessionSelector.js";

import Header from "./Header";
import Footer from "./Footer";
import { useGlobalKeys } from "./hooks/useGlobalKeys";
import { useTheme } from "./theme";
import { useOverlayHeight } from "./hooks/useOverlayHeight";

const MemoHeader = React.memo(Header);

import { eventReducer, type Action } from './reducers';
export { eventReducer };
export type { Action } from './reducers';


const initialState: TuiState = {
  sessions: [],
  activeSessionId: null,
  turns: [],
  nextBlockId: 1,
  interrupt: null,
  status: {
    phase: "building",
    plan: null,
    authorization: "default",
    workspaceAccess: "write",
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelProvider: "",
    modelName: "deepseek-v4",
    thinkingMode: "max",
  },
  exited: false,
  running: false,
  compacting: false,
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
  blockIndex: {},
  sessionKey: 0,
  exitRequested: false,
  editorRequested: false,
  sessionError: false,
  loadingSession: false,
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
  provider: import("./provider").TuiUserInputProvider;
  onCompactRequest?: () => void;
  mcpManager?: McpManager;
  availableModels?: import("@/core/config").AvailableModel[];
  slashSuggestion?: import("./components/InputLine").SlashSuggestionData | null;
  children?: ReactNode;
}

export function useTuiState(initialModelName?: string): { state: TuiState; dispatch: Dispatch<Action>; onToggleReason: (id: number) => void } {
  const initState = initialModelName
    ? { ...initialState, status: { ...initialState.status, modelName: initialModelName } }
    : initialState;
  const [state, dispatch] = useReducer(eventReducer, initState);
  const onToggleReason = useCallback((id: number) => dispatch({ type: "TOGGLE_REASON", id }), [dispatch]);
  return { state, dispatch, onToggleReason };
}

export default function App({ state, dispatch, onToggleReason, provider, onCompactRequest, mcpManager, slashSuggestion, children }: AppProps) {
  const theme = useTheme();
  const slashMaxHeight = useOverlayHeight(7);
  const overlayOrInterrupt = state.showHelp || state.showModelSelector || state.showSessions || state.showMcp || state.showRewind || !!state.interrupt;
  useGlobalKeys(dispatch, overlayOrInterrupt);

  // Stabilized callbacks for React.memo children
  const hideHelp = useCallback(() => dispatch({ type: "HIDE_HELP" }), [dispatch]);
  const hideModelSelector = useCallback(() => dispatch({ type: "HIDE_MODEL_SELECTOR" }), [dispatch]);
  const selectModel = useCallback((modelId: string) => dispatch({ type: "SELECT_MODEL", modelId }), [dispatch]);
  const hideSessions = useCallback(() => dispatch({ type: "HIDE_SESSIONS" }), [dispatch]);
  const hideMcp = useCallback(() => dispatch({ type: "HIDE_MCP" }), [dispatch]);
  const hideRewind = useCallback(() => dispatch({ type: "HIDE_REWIND" }), [dispatch]);
  const handleRevert = useCallback((checkpointId: string) => dispatch({ type: "REVERT_TO_CHECKPOINT", checkpointId }), [dispatch]);
  const handleFork = useCallback((checkpointId: string) => dispatch({ type: "FORK_FROM_CHECKPOINT", checkpointId }), [dispatch]);
  const onTogglePlan = useCallback((id: number) => dispatch({ type: "TOGGLE_PLAN", id }), [dispatch]);
  const onToggleToolExpand = useCallback((id: number) => dispatch({ type: "TOGGLE_TOOL_EXPAND", id }), [dispatch]);
  const onToggleSubagentExpand = useCallback((id: number) => dispatch({ type: "TOGGLE_SUBAGENT_EXPAND", id }), [dispatch]);
  const selectSession = useCallback(
    (threadId: string) => {
      // 派发 SWITCH_SESSION，由 dispatchSessionLoad 拦截器判断：
      // - dormancy → 重定向到 LOAD_SESSION_PENDING（从 DB 加载）
      // - 非 dormancy → 内存切换 + 缓冲事件回放
      dispatch({ type: "SWITCH_SESSION", threadId });
    },
    [dispatch],
  );
  const deleteSessionAction = useCallback(
    (threadId: string) => {
      dispatch({ type: "DELETE_SESSION", threadId });
    },
    [dispatch],
  );

  const interruptBlock = useMemo(() => {
    if (!state.interrupt) return undefined;
    for (const turn of state.turns) {
      const found = turn.blocks.find((b) => b.id === state.interrupt!.blockId);
      if (found) return found;
    }
    return undefined;
  }, [state.interrupt, state.turns]);

  const resolveApproval = useCallback(
    (action: string, grant?: string, pattern?: string) => {
      if (!interruptBlock) return;
      dispatch({ type: "RESOLVE_INTERRUPT", blockId: interruptBlock.id, resolution: { action, grant, pattern } });
    },
    [dispatch, interruptBlock]
  );

  const resolveInput = useCallback(
    (answer: string) => {
      if (!interruptBlock) return;
      dispatch({ type: "RESOLVE_INTERRUPT", blockId: interruptBlock.id, resolution: answer });
    },
    [dispatch, interruptBlock]
  );

  // ── Static content computation ──
  // <Static> is rendered at ROOT LEVEL (outside any layout Box) so its
  // scrollback writes never compete with the dynamic tree's Yoga layout.
  const header = useMemo(
    () => <MemoHeader running={state.running} error={state.sessionError} />,
    [state.running, state.sessionError],
  );

  const { staticItems, staticKey, header: staticHeader, mergedStaticBlocks, activeDynamicBlocks } = useStaticContent({
    turns: state.turns,
    running: state.running,
    sessionKey: state.sessionKey,
    header,
  });

  const overlayActive = state.showHelp || state.showModelSelector || state.showSessions || state.showMcp || state.showRewind;

  return (
    <Box flexDirection="column">
      {/* ── Body: OutputArea ── */}
      {state.loadingSession ? (
        <>
          <MemoHeader running={state.running} error={state.sessionError} />
          <Box paddingY={1}><Text dimColor>Loading session...</Text></Box>
        </>
      ) : (
        <OutputArea
          key={state.sessionKey}
          staticItems={staticItems}
          staticKey={staticKey}
          staticHeader={staticHeader}
          activeDynamicBlocks={activeDynamicBlocks}
          mergedStaticBlocks={mergedStaticBlocks}
          onToggleReason={onToggleReason}
          onTogglePlan={onTogglePlan}
          onToggleToolExpand={onToggleToolExpand}
          onToggleSubagentExpand={onToggleSubagentExpand}
          overlayActive={overlayActive}
        />
      )}

      {/* ── Footer: 3-row interaction zone ── */}
      <Footer
        status={state.status}
        running={state.running}
        compacting={state.compacting}
        timerKey={state.runCount}
      >
        {/* Interaction row: input line or approval/input UI, mutually exclusive */}
        {!state.interrupt && children}
        {interruptBlock?.kind === "approval" && !interruptBlock.resolved && (
          <ApprovalBlock
            approval={interruptBlock.approval}
            provider={provider}
            onResolved={resolveApproval}
          />
        )}
        {interruptBlock?.kind === "question" && !interruptBlock.resolved && (
          <InputBlock
            question={interruptBlock.question}
            provider={provider}
            onResolved={resolveInput}
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
        />
      )}
      {state.showModelSelector && (
        <ModelSelector
          currentModel={state.status.modelName}
          onSelect={selectModel}
          onClose={hideModelSelector}
        />
      )}
      {state.showMcp && mcpManager && (
        <McpPanel manager={mcpManager} onClose={hideMcp} />
      )}
      {state.showRewind && (
        <CheckpointSelector
          checkpoints={state.checkpoints}
          onRevert={handleRevert}
          onFork={handleFork}
          onClose={hideRewind}
        />
      )}
      {slashSuggestion && (() => {
        const listHeight = Math.max(3, slashMaxHeight - 2);
        return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1} marginTop={1} flexGrow={1} maxHeight={slashMaxHeight}>
          <Text bold color={theme.primary}>
            {slashSuggestion.kind === "model"
              ? `模型匹配 "${slashSuggestion.partial}"`
              : slashSuggestion.kind === "effort"
              ? `推理深度匹配 "${slashSuggestion.partial}"`
              : `命令匹配 /${slashSuggestion.partial}`}
          </Text>
          <Box flexGrow={1} maxHeight={listHeight}>
            <ScrollList selectedIndex={slashSuggestion.selectedIndex} scrollAlignment="auto">
              {slashSuggestion.items.map((item, i) => {
                const isSelected = i === slashSuggestion.selectedIndex;
                const aliasStr =
                  slashSuggestion.kind === "command" && item.aliases.length > 0
                    ? ` (${item.aliases.join(", ")})`
                    : "";
                const argsStr = item.args ? ` ${item.args}` : "";
                return (
                  <Box key={item.command}>
                    <Text color={isSelected ? theme.primary : theme.muted}>
                      {isSelected ? "❯ " : "  "}/{item.command}{argsStr}
                    </Text>
                    <Text color={theme.dim}>{aliasStr}</Text>
                    {item.description && (
                      <Text color={theme.dim}> — {item.description}</Text>
                    )}
                  </Box>
                );
              })}
            </ScrollList>
          </Box>
          <Text color={theme.dim}>↑↓ 导航  Tab/→ 补全  Enter 提交  Esc 关闭</Text>
        </Box>
        );
      })()}
    </Box>
  );
}
