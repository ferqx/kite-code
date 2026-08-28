import { Box, useInput } from 'ink';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import OverlayFrame, { type OverlayShortcut, OverlayShortcutBar } from '../components/OverlayFrame';
import { OverlayEmptyState, OverlayMessage, OverlaySummary } from '../components/OverlayPrimitives';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import McpSelect from './McpSelect';
import {
  type AddDraft,
  AddingServerView,
  AddServer,
  type AddStep,
  AuthenticationView,
  addOptions,
  animatedDots,
  approvalOptions,
  authOptions,
  ConfirmView,
  confirmOptions,
  ProjectApprovalView,
  ServerDetail,
  ServerTools,
  ToolDetail,
} from './McpViews';
import {
  buildServerActions,
  derivePrimaryStatus,
  type McpSelectOption,
  type McpServerAction,
  moveSelection,
  serverIdentity,
  validateMcpServerName,
  validSelection,
} from './model';
import type { McpController, McpServerControlState, McpServerKey } from './types';

export interface McpOverlayProps {
  controller: McpController;
  layeredEscRef?: MutableRefObject<boolean>;
  onClose: () => void;
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

  const returnToDetail = useCallback((key: McpServerKey) => {
    setView({ kind: 'server_detail', key });
    setSelectSelectedId(undefined);
    setAuthStarting(false);
  }, []);

  const currentServer =
    'key' in view
      ? servers.find((server) => serverIdentity(server.key) === serverIdentity(view.key))
      : undefined;
  const listOptions = useMemo<McpSelectOption[]>(
    () => [
      ...serverListOptions(servers, animatedDots(activityDotCount)),
      {
        id: 'add',
        label: '＋ 添加 MCP 服务器',
        action: true,
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
    if (view.kind === 'add_server')
      return addOptions(view.step, draft, snapshot.control.sourcePaths);
    if (view.kind === 'authenticate') return authOptions(currentServer, authStarting);
    if (view.kind === 'project_approval') return approvalOptions;
    if (view.kind === 'confirm') return confirmOptions(view.action);
    return [];
  }, [authStarting, currentServer, draft, snapshot.control.sourcePaths, view]);
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
    if (view.kind !== 'authenticate') return;
    if (!currentServer) return;
    if (currentServer.authStatus === 'authenticated') {
      returnToDetail(view.key);
    }
  }, [currentServer, returnToDetail, view]);

  useEffect(() => {
    if (genericOptions.length === 0) return;
    setSelectSelectedId((current) => validSelection(genericOptions, current));
  }, [genericOptions]);

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
      const options = addOptions(view.step, draft, snapshot.control.sourcePaths);
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
      ? currentServer.key.name
      : view.kind === 'tool_detail'
        ? view.toolName
        : view.kind === 'adding_server'
          ? view.draft.name
          : overlayTitle(view);
  return (
    <OverlayFrame
      title={title}
      meta={overlayMeta(view, servers, listSelectedId)}
      message={
        view.kind === 'add_server' && (busy || snapshot.message) ? (
          <OverlayMessage tone={busy ? 'busy' : 'info'}>
            {busy ? operationMessage(pendingOperation, activityDotCount) : snapshot.message}
          </OverlayMessage>
        ) : undefined
      }
      footer={
        <OverlayShortcutBar
          shortcuts={footer(view, inputActive, detailActions.length, genericOptions.length)}
        />
      }
    >
      <Box flexDirection="column">
        {view.kind === 'server_list' && (
          <>
            <OverlaySummary
              left={`${servers.length} 个服务器`}
              right={serverScopeSummary(servers)}
            />
            {servers.length === 0 && <OverlayEmptyState>尚未配置 MCP 服务器。</OverlayEmptyState>}
            <McpSelect options={visibleListOptions} selectedId={listSelectedId} />
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
          <AddingServerView
            draft={view.draft}
            dotCount={activityDotCount}
            sourcePaths={snapshot.control.sourcePaths}
          />
        )}
        {view.kind === 'add_server' && (
          <AddServer
            step={view.step}
            draft={draft}
            sourcePaths={snapshot.control.sourcePaths}
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
    </OverlayFrame>
  );
}

function serverListOptions(
  servers: readonly Readonly<McpServerControlState>[],
  dots: string,
): McpSelectOption[] {
  const groups = [
    {
      id: 'project',
      title: '项目',
      servers: servers.filter((server) => server.key.source.startsWith('project')),
    },
    {
      id: 'user',
      title: '用户',
      servers: servers.filter((server) => !server.key.source.startsWith('project')),
    },
  ];
  return groups.flatMap((group) => {
    if (group.servers.length === 0) return [];
    return [
      {
        id: `heading:${group.id}`,
        label: group.title,
        heading: true,
        disabled: true,
      },
      ...group.servers.map((server) => {
        const status = derivePrimaryStatus(server);
        const icon = status === 'ready' ? '●' : status === 'connecting' ? '◌' : '●';
        const statusText = status === 'connecting' ? `连接中${dots}` : localizedStatus(server);
        return {
          id: serverIdentity(server.key),
          label: server.key.name,
          trailing: `${icon} ${statusText}`,
          trailingTone:
            status === 'ready'
              ? ('success' as const)
              : status === 'connecting'
                ? ('warning' as const)
                : ('error' as const),
          description: `${server.sourcePath}${server.toolCount > 0 ? ` · ${server.toolCount} 个工具` : ''}`,
        };
      }),
    ];
  });
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
      ? '正在禁用'
      : operation === 'remove'
        ? '正在移除'
        : operation === 'add'
          ? '正在添加并连接'
          : operation === 'connect'
            ? '正在连接'
            : '处理中';
  return `${verb}${animatedDots(dotCount)}`;
}

function overlayMeta(
  view: View,
  servers: readonly Readonly<McpServerControlState>[],
  selectedId: string,
): string | undefined {
  if (view.kind === 'server_detail') return 'MCP 服务器';
  if (view.kind !== 'server_list' || servers.length === 0) return undefined;
  const selected = servers.findIndex((server) => serverIdentity(server.key) === selectedId);
  return `${selected < 0 ? servers.length : selected + 1} / ${servers.length}`;
}

function serverScopeSummary(servers: readonly Readonly<McpServerControlState>[]): string {
  const hasProject = servers.some((server) => server.key.source.startsWith('project'));
  const hasUser = servers.some((server) => !server.key.source.startsWith('project'));
  if (hasProject && hasUser) return '项目与用户配置';
  if (hasProject) return '项目配置';
  if (hasUser) return '用户配置';
  return '无配置';
}

function localizedStatus(server: Readonly<McpServerControlState>): string {
  switch (derivePrimaryStatus(server)) {
    case 'approval_required':
      return '需要审批';
    case 'rejected':
      return '已拒绝';
    case 'disabled':
      return '已禁用';
    case 'configuration_unavailable':
      return '配置不可用';
    case 'authenticating':
      return '认证中';
    case 'login_required':
      return '需要登录';
    case 'auth_failed':
      return '认证失败';
    case 'connecting':
      return '连接中';
    case 'ready':
      return '已连接';
    case 'failed':
      return '连接失败';
    case 'disconnected':
      return '未连接';
  }
}

function overlayTitle(view: View): string {
  switch (view.kind) {
    case 'server_list':
      return 'MCP 服务器';
    case 'server_detail':
      return 'MCP 服务器';
    case 'server_tools':
      return 'MCP 工具';
    case 'tool_detail':
      return 'MCP 工具';
    case 'adding_server':
      return '添加 MCP 服务器';
    case 'add_server': {
      const order: AddStep[] = ['transport', 'name', 'target', 'scope', 'review'];
      return `添加 MCP 服务器 · ${order.indexOf(view.step) + 1}/5`;
    }
    case 'authenticate':
      return '认证 MCP 服务器';
    case 'project_approval':
      return '审核项目 MCP 服务器';
    case 'confirm':
      return `${view.action === 'disable' ? '禁用' : '移除'} MCP 服务器`;
  }
}

function footer(
  view: View,
  inputActive: boolean,
  detailActionCount: number,
  genericActionCount: number,
): OverlayShortcut[] {
  if (inputActive) {
    return [
      { keys: 'Enter', label: '继续' },
      { keys: 'Esc', label: '返回' },
    ];
  }
  if (view.kind === 'server_list') {
    return [
      { keys: '↑↓', label: '导航' },
      { keys: 'Enter', label: '打开' },
      { keys: 'Esc', label: '关闭' },
    ];
  }
  if (view.kind === 'adding_server') return [{ keys: '', label: '请稍候' }];
  if (view.kind === 'server_tools') {
    return [
      { keys: '↑↓', label: '导航' },
      { keys: 'Enter', label: '选择' },
      { keys: 'Esc', label: '返回' },
    ];
  }
  if (view.kind === 'tool_detail') {
    return [
      { keys: '↑↓', label: '滚动' },
      { keys: 'Esc', label: '返回' },
    ];
  }
  if (view.kind === 'server_detail') {
    if (detailActionCount === 0) return [{ keys: 'Esc', label: '返回' }];
    return [
      { keys: '↑↓', label: '导航' },
      { keys: 'Enter', label: '选择' },
      { keys: 'Esc', label: '返回' },
    ];
  }
  if (view.kind === 'authenticate' && genericActionCount === 0) {
    return [{ keys: 'Esc', label: '返回' }];
  }
  return [
    { keys: '↑↓', label: '导航' },
    { keys: 'Enter', label: '确认' },
    { keys: 'Esc', label: '返回' },
  ];
}
