import { Box, Text, useInput } from 'ink';
import {
  type MutableRefObject,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { McpServerControlState } from '@/core/mcp';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useTheme } from '../theme';
import McpErrorView from './McpErrorView';
import McpPromptList from './McpPromptList';
import McpResourceList from './McpResourceList';
import McpServerDetail from './McpServerDetail';
import McpServerList, { filterMcpServers } from './McpServerList';
import McpToolList from './McpToolList';
import { initialMcpOverlayState, mcpOverlayReducer } from './reducer';
import { type McpController, mcpServerId } from './types';

export interface McpOverlayProps {
  controller: McpController;
  initialServer?: string;
  layeredEscRef?: MutableRefObject<boolean>;
  onClose: () => void;
}

export default function McpOverlay({
  controller,
  initialServer,
  layeredEscRef,
  onClose,
}: McpOverlayProps) {
  const t = useTheme();
  const maxContentHeight = useOverlayHeight(8);
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [state, dispatch] = useReducer(mcpOverlayReducer, initialMcpOverlayState);
  const initialNavigationDone = useRef(false);
  const servers = view.control.servers;
  const filtered = useMemo(() => filterMcpServers(servers, state.search), [servers, state.search]);
  const routeServerId = state.route.kind === 'list' ? undefined : state.route.serverId;
  const routedServer = servers.find((server) => mcpServerId(server) === routeServerId);
  if (layeredEscRef) {
    layeredEscRef.current = state.searchActive || state.route.kind !== 'list';
  }

  useEffect(
    () => () => {
      if (layeredEscRef) layeredEscRef.current = false;
    },
    [layeredEscRef],
  );

  useEffect(() => {
    dispatch({ type: 'clamp', count: filtered.length });
  }, [filtered.length]);

  useEffect(() => {
    if (!initialServer || initialNavigationDone.current) return;
    const server = servers.find(
      (candidate) => candidate.effective && candidate.key.name === initialServer,
    );
    if (server) {
      initialNavigationDone.current = true;
      dispatch({ type: 'open', route: 'detail', serverId: mcpServerId(server) });
    }
  }, [initialServer, servers]);

  useInput((input, key) => {
    if (state.searchActive) {
      if (key.escape) dispatch({ type: 'cancel_search' });
      else if (key.return) dispatch({ type: 'finish_search' });
      else if (key.backspace || key.delete) dispatch({ type: 'backspace_search' });
      else if (!key.ctrl && !key.meta && input) dispatch({ type: 'append_search', value: input });
      return;
    }

    if (key.escape) {
      if (state.route.kind === 'list') onClose();
      else dispatch({ type: 'back' });
      return;
    }

    if (state.route.kind === 'list') {
      if (key.upArrow) dispatch({ type: 'move', delta: -1, count: filtered.length });
      else if (key.downArrow) dispatch({ type: 'move', delta: 1, count: filtered.length });
      else if (input === '/') dispatch({ type: 'start_search' });
      else if (key.return) {
        const server = filtered[state.selectedIndex];
        if (server) dispatch({ type: 'open', route: 'detail', serverId: mcpServerId(server) });
      }
      return;
    }

    if (!routedServer) return;
    if (state.route.kind === 'approval') {
      const decision = input === 'a' ? 'approved' : input === 'r' ? 'rejected' : undefined;
      if (!decision) return;
      if (state.pendingDecision === decision) {
        dispatch({ type: 'set_pending_decision' });
        void controller.decide(routedServer.key, decision);
      } else {
        dispatch({ type: 'set_pending_decision', decision });
      }
      return;
    }
    if (input === 'r' && routedServer.diagnostic?.retryable) {
      void controller.retry(routedServer.key);
      return;
    }
    if (state.route.kind !== 'detail') return;
    if (input === 't') openRoute('tools', routedServer);
    else if (input === 'u') openRoute('resources', routedServer);
    else if (input === 'p') openRoute('prompts', routedServer);
    else if (input === 'e' && routedServer.diagnostic) openRoute('error', routedServer);
    else if (input === 'a' && routedServer.approval) openRoute('approval', routedServer);
  });

  function openRoute(
    route: 'tools' | 'resources' | 'prompts' | 'error' | 'approval',
    server: Readonly<McpServerControlState>,
  ): void {
    dispatch({ type: 'open', route, serverId: mcpServerId(server) });
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.primary}>
        {routeTitle(state.route.kind, routedServer)}
      </Text>
      <Box marginTop={1} flexDirection="column" maxHeight={maxContentHeight}>
        {state.route.kind === 'list' ? (
          <McpServerList
            servers={filtered}
            selectedIndex={state.selectedIndex}
            search={state.search}
            searchActive={state.searchActive}
          />
        ) : !routedServer ? (
          <Text color={t.error}>The selected MCP server is no longer available.</Text>
        ) : state.route.kind === 'detail' ? (
          <McpServerDetail server={routedServer} />
        ) : state.route.kind === 'tools' ? (
          <McpToolList tools={routedServer.tools} />
        ) : state.route.kind === 'resources' ? (
          <McpResourceList resources={routedServer.resources} />
        ) : state.route.kind === 'prompts' ? (
          <McpPromptList prompts={routedServer.prompts} />
        ) : state.route.kind === 'error' ? (
          <McpErrorView diagnostic={routedServer.diagnostic} />
        ) : (
          <ApprovalView server={routedServer} pendingDecision={state.pendingDecision} />
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={state.pendingDecision ? t.warning : t.dim}>
          {footerHint(state.route.kind, routedServer, state.pendingDecision)}
        </Text>
        {view.message && <Text color={t.muted}>{view.message}</Text>}
      </Box>
    </Box>
  );
}

function ApprovalView({
  server,
  pendingDecision,
}: {
  server: Readonly<McpServerControlState>;
  pendingDecision?: 'approved' | 'rejected';
}) {
  const t = useTheme();
  if (!server.approval) return <Text color={t.muted}>No approval action is available.</Text>;
  return (
    <Box flexDirection="column">
      <Text bold>{server.key.name}</Text>
      <Text>Status: {server.configStatus.replaceAll('_', ' ')}</Text>
      <Text color={t.dim}>Source: {server.sourcePath}</Text>
      <Text color={t.dim}>Digest: {server.approval.configDigest.slice(0, 12)}</Text>
      {server.transport === 'stdio' ? (
        <Text>
          Command: {server.approval.review.command ?? '(invalid)'} (
          {server.approval.review.argumentCount ?? 0} arguments)
        </Text>
      ) : (
        <Text>Endpoint: {server.approval.review.endpoint ?? '(invalid or redacted)'}</Text>
      )}
      {pendingDecision && (
        <Text color={t.warning}>
          Press {pendingDecision === 'approved' ? 'a' : 'r'} again to confirm.
        </Text>
      )}
    </Box>
  );
}

function routeTitle(route: string, server: Readonly<McpServerControlState> | undefined): string {
  if (route === 'list') return 'MCP Management';
  return `${server?.key.name ?? 'MCP'} / ${route}`;
}

function footerHint(
  route: string,
  server: Readonly<McpServerControlState> | undefined,
  pendingDecision?: 'approved' | 'rejected',
): string {
  if (pendingDecision) return 'Press the same key again to confirm; Esc cancels.';
  if (route === 'list') return 'Up/Down select  Enter details  / search  Esc close';
  if (route === 'detail') {
    return `t tools  u resources  p prompts${server?.diagnostic ? '  e error' : ''}${server?.approval ? '  a approval' : ''}${server?.diagnostic?.retryable ? '  r retry' : ''}  Esc back`;
  }
  if (route === 'approval') return 'a approve  r reject  Esc back';
  return `${server?.diagnostic?.retryable ? 'r retry  ' : ''}Esc back`;
}
