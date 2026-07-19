import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { projectMcpConfigPath, userMcpConfigPath, validateMcpServerName } from '@/core/config';
import type { McpServerControlState, McpServerKey } from '@/core/mcp';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useTheme } from '../theme';
import McpSelect from './McpSelect';
import {
  buildServerActions,
  derivePrimaryStatus,
  type McpSelectOption,
  type McpServerAction,
  moveSelection,
  serverIdentity,
  statusLabel,
  validSelection,
} from './model';
import type { McpController } from './types';

export interface McpOverlayProps {
  controller: McpController;
  layeredEscRef?: MutableRefObject<boolean>;
  onClose: () => void;
}

type AddStep = 'transport' | 'name' | 'target' | 'scope' | 'review';
interface AddDraft {
  transport: 'http' | 'stdio';
  name: string;
  target: string;
  scope: 'project' | 'user';
}

type View =
  | { kind: 'server_list' }
  | { kind: 'server_detail'; key: McpServerKey }
  | { kind: 'server_tools'; key: McpServerKey }
  | { kind: 'tool_detail'; key: McpServerKey; toolName: string }
  | { kind: 'adding_server'; draft: AddDraft }
  | { kind: 'add_server'; step: AddStep }
  | { kind: 'authenticate'; key: McpServerKey }
  | { kind: 'project_approval'; key: McpServerKey }
  | { kind: 'confirm'; action: 'disable' | 'remove'; key: McpServerKey };

const INITIAL_DRAFT: AddDraft = {
  transport: 'http',
  name: '',
  target: '',
  scope: 'project',
};
const MIN_OPERATION_VISIBLE_MS = 600;

export default function McpOverlay({ controller, layeredEscRef, onClose }: McpOverlayProps) {
  const t = useTheme();
  const maxListHeight = useOverlayHeight(8);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const servers = useMemo(
    () => snapshot.control.servers.filter((server) => server.effective),
    [snapshot.control.servers],
  );
  const [view, setView] = useState<View>({ kind: 'server_list' });
  const [listSelectedId, setListSelectedId] = useState(() =>
    servers[0] ? serverIdentity(servers[0].key) : 'add',
  );
  const [detailSelectedId, setDetailSelectedId] = useState<McpServerAction>();
  const [toolSelectedId, setToolSelectedId] = useState<string>();
  const [toolDetailOffset, setToolDetailOffset] = useState(0);
  const [heldDetailActions, setHeldDetailActions] = useState<
    readonly McpSelectOption<McpServerAction>[] | undefined
  >();
  const [heldDetailServer, setHeldDetailServer] = useState<Readonly<McpServerControlState>>();
  const [selectSelectedId, setSelectSelectedId] = useState<string>();
  const [draft, setDraft] = useState<AddDraft>(INITIAL_DRAFT);
  const [inputError, setInputError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<
    'connect' | 'disable' | 'remove' | 'add'
  >();
  const [activityDotCount, setActivityDotCount] = useState(3);
  const [authStarting, setAuthStarting] = useState(false);

  const currentServer =
    'key' in view
      ? servers.find((server) => serverIdentity(server.key) === serverIdentity(view.key))
      : undefined;
  const listOptions = useMemo<McpSelectOption[]>(
    () => [
      ...serverListOptions(servers, animatedDots(activityDotCount)),
      {
        id: 'add',
        label: '＋ Add MCP server',
        separatorBefore: servers.length > 0,
      },
    ],
    [activityDotCount, servers],
  );
  const hasActivity =
    busy ||
    view.kind === 'adding_server' ||
    servers.some((server) => derivePrimaryStatus(server) === 'connecting');

  useEffect(() => {
    if (!hasActivity) {
      setActivityDotCount(3);
      return;
    }
    const timer = setInterval(() => {
      setActivityDotCount((current) => (current % 3) + 1);
    }, 300);
    return () => clearInterval(timer);
  }, [hasActivity]);
  const visibleListCount = Number.isFinite(maxListHeight)
    ? Math.max(1, Math.floor(maxListHeight) - (servers.length > 0 ? 3 : 0))
    : listOptions.length;
  const selectedListIndex = Math.max(
    0,
    listOptions.findIndex((option) => option.id === listSelectedId),
  );
  const listStart = Math.min(
    Math.max(0, selectedListIndex - Math.floor(visibleListCount / 2)),
    Math.max(0, listOptions.length - visibleListCount),
  );
  const visibleListOptions = listOptions.slice(listStart, listStart + visibleListCount);
  const liveDetailActions = currentServer ? buildServerActions(currentServer) : [];
  const detailActions = heldDetailActions ?? liveDetailActions;
  const toolOptions = currentServer
    ? currentServer.tools
        .filter((tool) => tool.discovered)
        .map((tool) => ({ id: tool.name, label: tool.name }))
    : [];
  const genericOptions = useMemo(() => {
    if (view.kind === 'add_server') return addOptions(view.step, draft);
    if (view.kind === 'authenticate') return authOptions(currentServer, authStarting);
    if (view.kind === 'project_approval') return approvalOptions;
    if (view.kind === 'confirm') return confirmOptions(view.action);
    return [];
  }, [authStarting, currentServer, draft, view]);
  const inputActive =
    view.kind === 'add_server' && (view.step === 'name' || view.step === 'target');

  if (layeredEscRef) layeredEscRef.current = true;

  useEffect(
    () => () => {
      if (layeredEscRef) layeredEscRef.current = false;
    },
    [layeredEscRef],
  );

  useEffect(() => {
    setListSelectedId((current) => validSelection(listOptions, current) ?? 'add');
  }, [listOptions]);

  useEffect(() => {
    if ('key' in view && !currentServer) {
      setView({ kind: 'server_list' });
      setSelectSelectedId(undefined);
      setDetailSelectedId(undefined);
    }
  }, [currentServer, view]);

  useEffect(() => {
    if (view.kind !== 'server_detail') return;
    setDetailSelectedId((current) => validSelection(detailActions, current));
  }, [detailActions, view.kind]);

  useEffect(() => {
    if (genericOptions.length === 0) return;
    setSelectSelectedId((current) => validSelection(genericOptions, current));
  }, [genericOptions]);

  const returnToDetail = useCallback((key: McpServerKey) => {
    setView({ kind: 'server_detail', key });
    setSelectSelectedId(undefined);
    setAuthStarting(false);
  }, []);

  const back = useCallback(() => {
    if (busy) return;
    switch (view.kind) {
      case 'server_list':
        onClose();
        break;
      case 'server_detail':
        setView({ kind: 'server_list' });
        break;
      case 'server_tools':
        returnToDetail(view.key);
        break;
      case 'tool_detail':
        setToolSelectedId(view.toolName);
        setToolDetailOffset(0);
        setView({ kind: 'server_tools', key: view.key });
        break;
      case 'adding_server':
        break;
      case 'authenticate':
        if (currentServer?.authStatus === 'authorizing' && currentServer.authFlowId) {
          setBusy(true);
          void controller.cancelAuth(currentServer.authFlowId).finally(() => {
            setBusy(false);
            returnToDetail(view.key);
          });
        } else {
          returnToDetail(view.key);
        }
        break;
      case 'project_approval':
      case 'confirm':
        returnToDetail(view.key);
        break;
      case 'add_server': {
        const previous: Record<AddStep, AddStep | undefined> = {
          transport: undefined,
          name: 'transport',
          target: 'name',
          scope: 'target',
          review: 'scope',
        };
        const step = previous[view.step];
        if (step) {
          setView({ kind: 'add_server', step });
          setInputError(undefined);
          setSelectSelectedId(undefined);
        } else {
          setView({ kind: 'server_list' });
          setDraft(INITIAL_DRAFT);
        }
        break;
      }
    }
  }, [busy, controller, currentServer, onClose, returnToDetail, view]);

  const runDetailAction = useCallback(
    (action: McpServerAction) => {
      if (!currentServer || busy) return;
      switch (action) {
        case 'view_tools':
          setToolSelectedId(currentServer.tools[0]?.name);
          setView({ kind: 'server_tools', key: currentServer.key });
          return;
        case 'authenticate':
          setSelectSelectedId('open_browser');
          setView({ kind: 'authenticate', key: currentServer.key });
          return;
        case 'review_project_server':
        case 'review_decision':
          setSelectSelectedId('later');
          setView({ kind: 'project_approval', key: currentServer.key });
          return;
        case 'disable':
        case 'remove':
          setSelectSelectedId('cancel');
          setView({ kind: 'confirm', action, key: currentServer.key });
          return;
        case 'enable': {
          const startedAt = Date.now();
          setPendingOperation('connect');
          setBusy(true);
          void controller
            .setEnabled(currentServer.key, currentServer.revision, true)
            .finally(async () => {
              await waitForMinimumOperationTime(startedAt);
              setBusy(false);
              setPendingOperation(undefined);
            });
          return;
        }
        case 'connect':
        case 'reconnect':
        case 'retry': {
          const startedAt = Date.now();
          setPendingOperation('connect');
          setHeldDetailActions(detailActions);
          setHeldDetailServer(currentServer);
          setBusy(true);
          void controller.retry(currentServer.key).finally(async () => {
            await waitForMinimumOperationTime(startedAt);
            setBusy(false);
            setPendingOperation(undefined);
            setHeldDetailActions(undefined);
            setHeldDetailServer(undefined);
          });
          return;
        }
      }
    },
    [busy, controller, currentServer, detailActions],
  );

  const confirmAddInput = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (view.kind !== 'add_server') return;
      if (view.step === 'name') {
        try {
          validateMcpServerName(trimmed);
        } catch (error) {
          setInputError(error instanceof Error ? error.message : 'Invalid server name.');
          return;
        }
        setDraft((current) => ({ ...current, name: trimmed }));
        setInputError(undefined);
        setView({ kind: 'add_server', step: 'target' });
        return;
      }
      if (view.step === 'target') {
        if (draft.transport === 'http') {
          try {
            const url = new URL(trimmed);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
              throw new Error('MCP server URL must use HTTP or HTTPS.');
            }
          } catch (error) {
            setInputError(error instanceof Error ? error.message : 'Invalid MCP server URL.');
            return;
          }
        } else if (!trimmed) {
          setInputError('Command is required.');
          return;
        }
        setDraft((current) => ({ ...current, target: trimmed }));
        setInputError(undefined);
        setSelectSelectedId(draft.scope);
        setView({ kind: 'add_server', step: 'scope' });
      }
    },
    [draft.scope, draft.transport, view],
  );

  useInput((_input, key) => {
    if (inputActive) {
      if (key.escape) back();
      return;
    }
    if (key.escape) {
      back();
      return;
    }
    if (busy) return;
    const direction = key.upArrow ? 'up' : key.downArrow ? 'down' : undefined;
    if (view.kind === 'server_list') {
      if (direction)
        setListSelectedId((current) => moveSelection(listOptions, current, direction)!);
      if (key.return) {
        if (listSelectedId === 'add') {
          setDraft(INITIAL_DRAFT);
          setSelectSelectedId('http');
          setView({ kind: 'add_server', step: 'transport' });
        } else {
          const server = servers.find(
            (candidate) => serverIdentity(candidate.key) === listSelectedId,
          );
          if (server) {
            setDetailSelectedId(buildServerActions(server)[0]?.id);
            setView({ kind: 'server_detail', key: server.key });
          }
        }
      }
      return;
    }
    if (view.kind === 'server_detail') {
      if (direction) {
        setDetailSelectedId((current) => moveSelection(detailActions, current, direction));
      }
      if (key.return && detailSelectedId) runDetailAction(detailSelectedId);
      return;
    }
    if (view.kind === 'server_tools') {
      if (direction) {
        setToolSelectedId((current) => moveSelection(toolOptions, current, direction));
      }
      if (key.return && toolSelectedId) {
        setToolDetailOffset(0);
        setView({ kind: 'tool_detail', key: view.key, toolName: toolSelectedId });
      }
      return;
    }
    if (view.kind === 'tool_detail') {
      const tool = currentServer?.tools.find((candidate) => candidate.name === view.toolName);
      if (key.upArrow) setToolDetailOffset((current) => Math.max(0, current - 1));
      if (key.downArrow) {
        setToolDetailOffset((current) =>
          Math.min(Math.max(0, (tool?.parameters.length ?? 1) - 1), current + 1),
        );
      }
      return;
    }
    if (view.kind === 'add_server') {
      const options = addOptions(view.step, draft);
      if (direction) {
        setSelectSelectedId((current) => moveSelection(options, current, direction));
      }
      if (!key.return || !selectSelectedId) return;
      if (view.step === 'transport') {
        setDraft((current) => ({
          ...current,
          transport: selectSelectedId as 'http' | 'stdio',
          target: '',
        }));
        setView({ kind: 'add_server', step: 'name' });
      } else if (view.step === 'scope') {
        setDraft((current) => ({
          ...current,
          scope: selectSelectedId as 'project' | 'user',
        }));
        setSelectSelectedId('add');
        setView({ kind: 'add_server', step: 'review' });
      } else if (view.step === 'review') {
        if (selectSelectedId === 'add') {
          const startedAt = Date.now();
          setBusy(true);
          setPendingOperation('add');
          setView({ kind: 'adding_server', draft: { ...draft } });
          void controller
            .add({
              scope: draft.scope,
              name: draft.name,
              config:
                draft.transport === 'http'
                  ? { type: 'http', url: draft.target }
                  : { type: 'stdio', command: draft.target },
            })
            .then((serverKey) => {
              if (serverKey) {
                setListSelectedId(serverIdentity(serverKey));
                setDetailSelectedId(undefined);
                setView({ kind: 'server_detail', key: serverKey });
                setDraft(INITIAL_DRAFT);
              } else {
                setSelectSelectedId('add');
                setView({ kind: 'add_server', step: 'review' });
              }
            })
            .catch(() => {
              setSelectSelectedId('add');
              setView({ kind: 'add_server', step: 'review' });
            })
            .finally(async () => {
              await waitForMinimumOperationTime(startedAt);
              setBusy(false);
              setPendingOperation(undefined);
            });
        }
      }
      return;
    }
    if (view.kind === 'authenticate') {
      const options = authOptions(currentServer, authStarting);
      if (direction) {
        setSelectSelectedId((current) => moveSelection(options, current, direction));
      }
      if (!key.return || !selectSelectedId) return;
      if (selectSelectedId === 'open_browser' || selectSelectedId === 'retry') {
        setAuthStarting(true);
        void controller.login(view.key).finally(() => setAuthStarting(false));
      } else if (selectSelectedId === 'cancel_auth' && currentServer?.authFlowId) {
        setBusy(true);
        void controller.cancelAuth(currentServer.authFlowId).finally(() => {
          setBusy(false);
          returnToDetail(view.key);
        });
      }
      return;
    }
    if (view.kind === 'project_approval') {
      const options = approvalOptions;
      if (direction) {
        setSelectSelectedId((current) => moveSelection(options, current, direction));
      }
      if (!key.return || !selectSelectedId) return;
      if (selectSelectedId === 'later') {
        returnToDetail(view.key);
      } else {
        setBusy(true);
        void controller
          .decide(view.key, selectSelectedId === 'approve' ? 'approved' : 'rejected')
          .finally(() => {
            setBusy(false);
            returnToDetail(view.key);
          });
      }
      return;
    }
    if (view.kind === 'confirm') {
      const options = confirmOptions(view.action);
      if (direction) {
        setSelectSelectedId((current) => moveSelection(options, current, direction));
      }
      if (!key.return || !selectSelectedId) return;
      if (selectSelectedId === 'cancel') {
        returnToDetail(view.key);
      } else if (currentServer) {
        const startedAt = Date.now();
        setBusy(true);
        setPendingOperation(view.action);
        const command =
          view.action === 'disable'
            ? controller.setEnabled(currentServer.key, currentServer.revision, false)
            : controller.remove(currentServer.key, currentServer.revision);
        void command
          .then((completed) => {
            if (completed) {
              if (view.action === 'remove') setView({ kind: 'server_list' });
              else returnToDetail(view.key);
            }
          })
          .finally(async () => {
            await waitForMinimumOperationTime(startedAt);
            setBusy(false);
            setPendingOperation(undefined);
          });
      }
    }
  });

  const title =
    view.kind === 'server_detail' && currentServer
      ? `${currentServer.key.name} MCP Server`
      : view.kind === 'tool_detail'
        ? view.toolName
        : view.kind === 'adding_server'
          ? `${view.draft.name} MCP Server`
          : overlayTitle(view);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.primary}>
        {title}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {view.kind === 'server_list' && (
          <>
            {servers.length === 0 && <Text color={t.muted}>No MCP servers configured.</Text>}
            {servers.length > 0 && (
              <Text color={t.muted}>
                {servers.length} {servers.length === 1 ? 'server' : 'servers'}
              </Text>
            )}
            <Box marginTop={servers.length > 0 ? 1 : 0}>
              <McpSelect options={visibleListOptions} selectedId={listSelectedId} />
            </Box>
          </>
        )}
        {view.kind === 'server_detail' && currentServer && (
          <ServerDetail
            server={heldDetailServer ?? currentServer}
            options={detailActions}
            selectedId={detailSelectedId}
            statusMessage={
              busy ? operationMessage(pendingOperation, activityDotCount) : snapshot.message
            }
          />
        )}
        {view.kind === 'server_tools' && currentServer && (
          <ServerTools server={currentServer} options={toolOptions} selectedId={toolSelectedId} />
        )}
        {view.kind === 'tool_detail' && currentServer && (
          <ToolDetail
            server={currentServer}
            tool={currentServer.tools.find((tool) => tool.name === view.toolName)}
            offset={toolDetailOffset}
          />
        )}
        {view.kind === 'adding_server' && (
          <AddingServerView draft={view.draft} dotCount={activityDotCount} />
        )}
        {view.kind === 'add_server' && (
          <AddServer
            step={view.step}
            draft={draft}
            selectedId={selectSelectedId}
            inputError={inputError}
            onNameChange={(name) => {
              setDraft((current) => ({ ...current, name }));
              setInputError(undefined);
            }}
            onTargetChange={(target) => {
              setDraft((current) => ({ ...current, target }));
              setInputError(undefined);
            }}
            onSubmit={confirmAddInput}
          />
        )}
        {view.kind === 'authenticate' && currentServer && (
          <AuthenticationView
            server={currentServer}
            starting={authStarting}
            selectedId={selectSelectedId}
          />
        )}
        {view.kind === 'project_approval' && currentServer && (
          <ProjectApprovalView server={currentServer} selectedId={selectSelectedId} />
        )}
        {view.kind === 'confirm' && currentServer && (
          <ConfirmView server={currentServer} action={view.action} selectedId={selectSelectedId} />
        )}
      </Box>
      <Text color={busy ? t.warning : t.muted}>
        {view.kind === 'server_detail' ||
        view.kind === 'server_list' ||
        view.kind === 'server_tools' ||
        view.kind === 'tool_detail' ||
        view.kind === 'adding_server'
          ? ' '
          : busy
            ? operationMessage(pendingOperation, activityDotCount)
            : (snapshot.message ?? ' ')}
      </Text>
      <Text color={t.dim}>
        {footer(view, inputActive, detailActions.length, genericOptions.length)}
      </Text>
    </Box>
  );
}

function serverListOptions(
  servers: readonly Readonly<McpServerControlState>[],
  dots: string,
): McpSelectOption[] {
  const groups = [
    {
      id: 'project',
      title: 'Project MCPs',
      servers: servers.filter((server) => server.source.startsWith('project')),
    },
    {
      id: 'user',
      title: 'User MCPs',
      servers: servers.filter((server) => !server.source.startsWith('project')),
    },
  ];
  return groups.flatMap((group) => {
    if (group.servers.length === 0) return [];
    const paths = [...new Set(group.servers.map((server) => server.sourcePath))];
    const pathLabel = paths.length === 1 ? ` (${paths[0]})` : '';
    return [
      {
        id: `heading:${group.id}`,
        label: `${group.title}${pathLabel}`,
        heading: true,
        disabled: true,
      },
      ...group.servers.map((server) => {
        const status = derivePrimaryStatus(server);
        const icon = status === 'ready' ? '✔' : status === 'connecting' ? '◌' : '✘';
        const statusText =
          status === 'connecting' ? `connecting${dots}` : statusLabel(server).toLowerCase();
        return {
          id: serverIdentity(server.key),
          label: `${server.key.name} · ${icon} ${statusText}${
            server.toolCount > 0 ? ` · ${server.toolCount} tools` : ''
          }`,
        };
      }),
    ];
  });
}

function ServerDetail({
  server,
  options,
  selectedId,
  statusMessage,
}: {
  server: Readonly<McpServerControlState>;
  options: readonly McpSelectOption<McpServerAction>[];
  selectedId?: McpServerAction;
  statusMessage?: string;
}) {
  const t = useTheme();
  const command = server.configuration.command ?? server.approval?.review.command;
  const endpoint = displayEndpoint(
    server.configuration.endpoint ?? server.approval?.review.endpoint,
  );
  const argumentCount = server.configuration.argumentCount ?? server.approval?.review.argumentCount;
  const primaryStatus = derivePrimaryStatus(server);
  const connected = primaryStatus === 'ready';
  const capabilities = [
    server.toolCount > 0 && 'tools',
    server.resourceCount > 0 && 'resources',
    server.promptCount > 0 && 'prompts',
  ].filter(Boolean);
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" paddingLeft={2}>
        <DetailRow
          label="Status:"
          value={
            statusMessage ??
            `${connected ? '✔' : primaryStatus === 'connecting' ? '◌' : '✘'} ${statusLabel(server).toLowerCase()}`
          }
          valueColor={
            statusMessage?.includes('ing.')
              ? t.warning
              : connected
                ? t.success
                : primaryStatus === 'connecting'
                  ? t.warning
                  : t.error
          }
        />
        {command && <DetailRow label="Command:" value={command} />}
        {argumentCount !== undefined && (
          <DetailRow
            label="Args:"
            value={`${argumentCount} configured argument${argumentCount === 1 ? '' : 's'}`}
          />
        )}
        {endpoint && <DetailRow label="Endpoint:" value={endpoint} />}
        <DetailRow label="Config location:" value={server.sourcePath} singleLine />
        <DetailRow
          label="Capabilities:"
          value={capabilities.length > 0 ? capabilities.join(', ') : '—'}
        />
        <DetailRow
          label="Tools:"
          value={server.toolCount > 0 ? `${server.toolCount} tools` : '—'}
        />
      </Box>

      <Box marginTop={1} paddingLeft={2} flexDirection="column">
        <McpSelect options={options} selectedId={selectedId} numbered />
      </Box>
    </Box>
  );
}

function AddingServerView({ draft, dotCount }: { draft: Readonly<AddDraft>; dotCount: number }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <AnimatedAddingStatus dotCount={dotCount} />
      {draft.transport === 'http' ? (
        <DetailRow label="Endpoint:" value={displayEndpoint(draft.target) ?? draft.target} />
      ) : (
        <DetailRow label="Command:" value={draft.target} />
      )}
      <DetailRow
        label="Config location:"
        value={draft.scope === 'project' ? projectMcpConfigPath() : userMcpConfigPath()}
        singleLine
      />
    </Box>
  );
}

function ServerTools({
  server,
  options,
  selectedId,
}: {
  server: Readonly<McpServerControlState>;
  options: readonly McpSelectOption[];
  selectedId?: string;
}) {
  const maxHeight = useOverlayHeight(10);
  const visibleCount = Number.isFinite(maxHeight)
    ? Math.max(1, Math.floor(maxHeight))
    : options.length;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selectedId),
  );
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(visibleCount / 2)),
    Math.max(0, options.length - visibleCount),
  );
  const visibleOptions = options.slice(start, start + visibleCount);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text bold>Tools for {server.key.name}</Text>
      <Text>{options.length} tools</Text>
      <Box marginTop={1}>
        <McpSelect options={visibleOptions} selectedId={selectedId} numbered />
      </Box>
    </Box>
  );
}

function ToolDetail({
  server,
  tool,
  offset,
}: {
  server: Readonly<McpServerControlState>;
  tool: McpServerControlState['tools'][number] | undefined;
  offset: number;
}) {
  const t = useTheme();
  const maxHeight = useOverlayHeight(18);
  if (!tool) return <Text color={t.error}>Tool is no longer available.</Text>;
  const visibleParameterCount = Number.isFinite(maxHeight)
    ? Math.max(1, Math.floor(maxHeight))
    : tool.parameters.length;
  const maxOffset = Math.max(0, tool.parameters.length - visibleParameterCount);
  const visibleParameters = tool.parameters.slice(
    Math.min(offset, maxOffset),
    Math.min(offset, maxOffset) + visibleParameterCount,
  );
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color={t.muted}>{server.key.name}</Text>

      <Box marginTop={1} flexDirection="column">
        <DetailRow label="Tool name:" value={tool.name} />
        <DetailRow label="Full name:" value={`mcp__${server.key.name}__${tool.name}`} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Description:</Text>
        <Box marginTop={1} paddingLeft={2} width="100%">
          <Text wrap="wrap">{tool.description ?? 'No description provided.'}</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Parameters:</Text>
        <Box marginTop={1} flexDirection="column" paddingLeft={2}>
          {tool.parameters.length === 0 ? (
            <Text color={t.muted}>No parameters.</Text>
          ) : (
            visibleParameters.map((parameter) => (
              <Box key={parameter.name} width="100%">
                <Box width={2} flexShrink={0}>
                  <Text>● </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="wrap">
                    {parameter.name}
                    {parameter.required ? ' (required)' : ''}: {parameter.type}
                    {parameter.description ? ` - ${parameter.description}` : ''}
                  </Text>
                </Box>
              </Box>
            ))
          )}
        </Box>
      </Box>
    </Box>
  );
}

function AnimatedAddingStatus({ dotCount }: { dotCount: number }) {
  const t = useTheme();

  return (
    <Box width="100%">
      <Box width={18} flexShrink={0}>
        <Text color={t.dim}>Status:</Text>
      </Box>
      <Text color={t.warning}>Adding and connecting</Text>
      {[0, 1, 2].map((index) => (
        <Text key={index} color={index < dotCount ? t.warning : t.dim}>
          .
        </Text>
      ))}
    </Box>
  );
}

function animatedDots(count: number): string {
  return `${'.'.repeat(count)}${' '.repeat(3 - count)}`;
}

async function waitForMinimumOperationTime(startedAt: number): Promise<void> {
  const remaining = MIN_OPERATION_VISIBLE_MS - (Date.now() - startedAt);
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

function operationMessage(
  operation: 'connect' | 'disable' | 'remove' | 'add' | undefined,
  dotCount: number,
): string {
  const verb =
    operation === 'disable'
      ? 'Disabling'
      : operation === 'remove'
        ? 'Removing'
        : operation === 'add'
          ? 'Adding and connecting'
          : operation === 'connect'
            ? 'Connecting'
            : 'Working';
  return `${verb}${animatedDots(dotCount)}`;
}

function displayEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function DetailRow({
  label,
  value,
  valueColor,
  singleLine = false,
}: {
  label: string;
  value: string;
  valueColor?: string;
  singleLine?: boolean;
}) {
  const t = useTheme();
  return (
    <Box width="100%">
      <Box width={18} flexShrink={0}>
        <Text color={t.dim}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={valueColor} wrap={singleLine ? 'truncate-end' : 'wrap'}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

function AddServer({
  step,
  draft,
  selectedId,
  inputError,
  onNameChange,
  onTargetChange,
  onSubmit,
}: {
  step: AddStep;
  draft: AddDraft;
  selectedId?: string;
  inputError?: string;
  onNameChange(value: string): void;
  onTargetChange(value: string): void;
  onSubmit(value: string): void;
}) {
  const t = useTheme();
  if (step === 'name' || step === 'target') {
    const target = step === 'target';
    return (
      <Box flexDirection="column">
        <Text bold>
          {target ? (draft.transport === 'http' ? 'MCP server URL' : 'Command') : 'Server name'}
        </Text>
        <TextInput
          value={target ? draft.target : draft.name}
          onChange={target ? onTargetChange : onNameChange}
          onSubmit={onSubmit}
        />
        {!target && <Text color={t.dim}>Letters, numbers, ".", "-" and "_" only.</Text>}
        {inputError && <Text color={t.error}>{inputError}</Text>}
      </Box>
    );
  }
  if (step === 'review') {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <DetailRow label="Name:" value={draft.name} />
        {draft.transport === 'http' ? (
          <DetailRow label="Endpoint:" value={displayEndpoint(draft.target) ?? draft.target} />
        ) : (
          <DetailRow label="Command:" value={draft.target} />
        )}
        <DetailRow label="Available:" value={draft.scope === 'project' ? 'Project' : 'User'} />
        <DetailRow
          label="Config location:"
          value={draft.scope === 'project' ? projectMcpConfigPath() : userMcpConfigPath()}
          singleLine
        />
        <Box marginTop={1}>
          <McpSelect options={addOptions(step, draft)} selectedId={selectedId} />
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>
        {step === 'transport'
          ? 'How does the server run?'
          : 'Where should this server be available?'}
      </Text>
      <McpSelect options={addOptions(step, draft)} selectedId={selectedId} />
    </Box>
  );
}

function AuthenticationView({
  server,
  starting,
  selectedId,
}: {
  server: Readonly<McpServerControlState>;
  starting: boolean;
  selectedId?: string;
}) {
  const t = useTheme();
  const phase =
    server.authStatus === 'authenticated'
      ? 'success'
      : server.authStatus === 'error'
        ? 'failed'
        : server.authStatus === 'authorizing' || starting
          ? 'waiting'
          : 'prompt';
  return (
    <Box flexDirection="column">
      {phase === 'prompt' && <Text>{server.key.name} requires authentication.</Text>}
      {phase === 'waiting' && <Text>Complete sign-in in your browser.</Text>}
      {phase === 'waiting' && server.authErrorCode && (
        <Text color={t.error}>Authentication warning: {server.authErrorCode}</Text>
      )}
      {phase === 'success' && <Text color={t.success}>Authentication complete.</Text>}
      {phase === 'failed' && (
        <Text color={t.error}>
          Authentication failed{server.authErrorCode ? `: ${server.authErrorCode}` : '.'}
        </Text>
      )}
      <Box marginTop={1}>
        <McpSelect options={authOptions(server, starting)} selectedId={selectedId} />
      </Box>
    </Box>
  );
}

function ProjectApprovalView({
  server,
  selectedId,
}: {
  server: Readonly<McpServerControlState>;
  selectedId?: string;
}) {
  const t = useTheme();
  const command = server.configuration.command ?? server.approval?.review.command;
  const endpoint = displayEndpoint(
    server.configuration.endpoint ?? server.approval?.review.endpoint,
  );
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <DetailRow label="Name:" value={server.key.name} />
      {command && <DetailRow label="Command:" value={command} />}
      {endpoint && <DetailRow label="Endpoint:" value={endpoint} />}
      <DetailRow label="Source:" value="Project" />
      <DetailRow label="Config location:" value={server.sourcePath} singleLine />
      <Box marginTop={1}>
        <Text color={t.warning}>Only approve projects you trust.</Text>
      </Box>
      <Box marginTop={1}>
        <McpSelect options={approvalOptions} selectedId={selectedId} />
      </Box>
    </Box>
  );
}

function ConfirmView({
  server,
  action,
  selectedId,
}: {
  server: Readonly<McpServerControlState>;
  action: 'disable' | 'remove';
  selectedId?: string;
}) {
  const t = useTheme();
  return (
    <Box flexDirection="column">
      <Text bold>
        {action === 'disable' ? 'Disable' : 'Remove'} "{server.key.name}"?
      </Text>
      {action === 'disable' ? (
        <>
          <Text>The configuration and credentials will be kept.</Text>
          <Text>Its tools will no longer be available to the agent.</Text>
        </>
      ) : (
        <>
          <Text color={t.warning}>
            This removes the selected configuration and stored credentials.
          </Text>
          {server.fallbackSource && (
            <Text color={t.warning}>
              A {sourceLabel(server.fallbackSource)} configuration with the same name may become
              active.
            </Text>
          )}
        </>
      )}
      <Box marginTop={1}>
        <McpSelect options={confirmOptions(action)} selectedId={selectedId} />
      </Box>
    </Box>
  );
}

function addOptions(step: AddStep, draft: AddDraft): McpSelectOption[] {
  if (step === 'transport') {
    return [
      { id: 'http', label: 'HTTP' },
      { id: 'stdio', label: 'STDIO' },
    ];
  }
  if (step === 'scope') {
    return [
      { id: 'project', label: `Project  ${projectMcpConfigPath()}` },
      { id: 'user', label: `User     ${userMcpConfigPath()}` },
    ];
  }
  if (step === 'review') {
    return [{ id: 'add', label: 'Add and connect' }];
  }
  return [{ id: draft.transport, label: draft.transport.toUpperCase() }];
}

function authOptions(
  server: Readonly<McpServerControlState> | undefined,
  starting: boolean,
): McpSelectOption[] {
  if (!server) return [];
  if (server.authStatus === 'authenticated') return [];
  if (server.authStatus === 'authorizing' || starting) {
    return [{ id: 'cancel_auth', label: 'Cancel authentication' }];
  }
  if (server.authStatus === 'error') {
    return [{ id: 'retry', label: 'Try again' }];
  }
  return [{ id: 'open_browser', label: 'Open browser' }];
}

const approvalOptions: McpSelectOption[] = [
  { id: 'later', label: 'Decide later' },
  { id: 'approve', label: 'Approve and connect' },
  { id: 'reject', label: 'Reject server', destructive: true },
];

function confirmOptions(action: 'disable' | 'remove'): McpSelectOption[] {
  return [
    { id: 'cancel', label: 'Cancel' },
    {
      id: 'confirm',
      label: action === 'disable' ? 'Disable server' : 'Remove server',
      destructive: true,
    },
  ];
}

function overlayTitle(view: View): string {
  switch (view.kind) {
    case 'server_list':
      return 'MCP Servers';
    case 'server_detail':
      return 'MCP Server';
    case 'server_tools':
      return 'MCP Tools';
    case 'tool_detail':
      return 'MCP Tool';
    case 'adding_server':
      return 'Add MCP Server';
    case 'add_server': {
      const order: AddStep[] = ['transport', 'name', 'target', 'scope', 'review'];
      return `Add MCP Server · ${order.indexOf(view.step) + 1}/5`;
    }
    case 'authenticate':
      return 'Authenticate MCP Server';
    case 'project_approval':
      return 'Review Project MCP Server';
    case 'confirm':
      return `${view.action === 'disable' ? 'Disable' : 'Remove'} MCP Server`;
  }
}

function footer(
  view: View,
  inputActive: boolean,
  detailActionCount: number,
  genericActionCount: number,
): string {
  if (inputActive) return 'Enter Continue    Esc Back';
  if (view.kind === 'server_list') return '↑↓ Select    Enter Open    Esc Close';
  if (view.kind === 'adding_server') return 'Please wait';
  if (view.kind === 'server_tools') {
    return '↑/↓ to navigate · Enter to select · Esc to back';
  }
  if (view.kind === 'tool_detail') return '↑/↓ to scroll · Esc to go back';
  if (view.kind === 'server_detail') {
    if (detailActionCount === 0) return 'Esc to back';
    return '↑/↓ to navigate · Enter to select · Esc to back';
  }
  if (view.kind === 'authenticate' && genericActionCount === 0) return 'Esc to back';
  return '↑↓ Select    Enter Confirm    Esc Back';
}

function sourceLabel(source: string): string {
  if (source === 'project') return 'Current project';
  if (source === 'local') return 'Legacy local';
  if (source === 'user') return 'All projects';
  if (source.startsWith('project')) return 'Project configuration';
  return source;
}
