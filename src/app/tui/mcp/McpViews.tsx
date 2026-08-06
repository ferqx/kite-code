import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { projectMcpConfigPath, userMcpConfigPath } from '@/core/config';
import type { McpServerControlState } from '@/core/mcp';
import {
  OverlayDetailList,
  OverlayImpactNotice,
  OverlayMessage,
  OverlaySection,
  OverlaySummary,
} from '../components/OverlayPrimitives';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useTheme } from '../theme';
import McpSelect from './McpSelect';
import type { McpSelectOption, McpServerAction } from './model';
import { derivePrimaryStatus } from './model';

export type AddStep = 'transport' | 'name' | 'target' | 'scope' | 'review';
export interface AddDraft {
  transport: 'http' | 'stdio';
  name: string;
  target: string;
  scope: 'project' | 'user';
}

export function ServerDetail({
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
  const primaryStatus = derivePrimaryStatus(server);
  const connected = primaryStatus === 'ready';
  const capabilities = [
    server.toolCount > 0 && 'tools',
    server.resourceCount > 0 && 'resources',
    server.promptCount > 0 && 'prompts',
  ].filter(Boolean);
  return (
    <Box flexDirection="column">
      <OverlayDetailList
        items={[
          {
            label: '状态',
            value:
              statusMessage ??
              `${connected ? '●' : primaryStatus === 'connecting' ? '◌' : '●'} ${localizedStatus(server)}`,
            valueColor: statusMessage?.includes('ing.')
              ? t.warning
              : connected
                ? t.success
                : primaryStatus === 'connecting'
                  ? t.warning
                  : t.error,
          },
          { label: '传输方式', value: server.transport },
          {
            label: '能力',
            value: capabilitySummary(server, capabilities),
          },
          { label: '配置位置', value: server.sourcePath, truncate: true },
        ]}
      />
      <OverlaySection>操作</OverlaySection>
      <McpSelect
        options={localizeActions(options)}
        selectedId={selectedId}
        selectionBackground={false}
      />
      {selectedId && actionImpact(server, selectedId) && (
        <OverlayImpactNotice tone={selectedId === 'remove' ? 'warning' : 'info'}>
          {actionImpact(server, selectedId)}
        </OverlayImpactNotice>
      )}
    </Box>
  );
}

export function AddingServerView({
  draft,
  dotCount,
}: {
  draft: Readonly<AddDraft>;
  dotCount: number;
}) {
  const t = useTheme();
  return (
    <OverlayDetailList
      items={[
        {
          label: '状态',
          value: `正在添加并连接${animatedDots(dotCount)}`,
          valueColor: t.warning,
        },
        {
          label: draft.transport === 'http' ? '端点' : '命令',
          value:
            draft.transport === 'http'
              ? (displayEndpoint(draft.target) ?? draft.target)
              : draft.target,
        },
        {
          label: '配置位置',
          value: draft.scope === 'project' ? projectMcpConfigPath() : userMcpConfigPath(),
          truncate: true,
        },
      ]}
    />
  );
}

export function ServerTools({
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
  return (
    <Box flexDirection="column">
      <OverlaySummary left={`${options.length} 个工具`} right={server.key.name} />
      <McpSelect
        options={options.slice(start, start + visibleCount)}
        selectedId={selectedId}
        numbered
      />
    </Box>
  );
}

export function ToolDetail({
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
  if (!tool) return <OverlayMessage tone="error">Tool is no longer available.</OverlayMessage>;
  const visibleCount = Number.isFinite(maxHeight)
    ? Math.max(1, Math.floor(maxHeight))
    : tool.parameters.length;
  const maxOffset = Math.max(0, tool.parameters.length - visibleCount);
  const visible = tool.parameters.slice(
    Math.min(offset, maxOffset),
    Math.min(offset, maxOffset) + visibleCount,
  );
  return (
    <Box flexDirection="column">
      <OverlayDetailList
        items={[
          { label: 'Server:', value: server.key.name },
          { label: 'Tool name:', value: tool.name },
          { label: 'Full name:', value: `mcp__${server.key.name}__${tool.name}` },
        ]}
      />
      <OverlaySection>Description</OverlaySection>
      <Box paddingX={1}>
        <Text wrap="wrap">{tool.description ?? 'No description provided.'}</Text>
      </Box>
      <OverlaySection>Parameters</OverlaySection>
      <Box flexDirection="column" paddingX={1}>
        {tool.parameters.length === 0 ? (
          <Text color={t.muted}>No parameters.</Text>
        ) : (
          visible.map((parameter) => (
            <Box key={parameter.name}>
              <Text>
                ● {parameter.name}
                {parameter.required ? ' (required)' : ''}: {parameter.type}
                {parameter.description ? ` - ${parameter.description}` : ''}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

export function AddServer({
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
          {target ? (draft.transport === 'http' ? 'MCP 服务器 URL' : '命令') : '服务器名称'}
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={target ? draft.target : draft.name}
            onChange={target ? onTargetChange : onNameChange}
            onSubmit={onSubmit}
          />
        </Box>
        {!target && <Text color={t.dim}>仅支持字母、数字、点、连字符和下划线。</Text>}
        {inputError && <OverlayMessage tone="error">{inputError}</OverlayMessage>}
      </Box>
    );
  }
  if (step === 'review')
    return (
      <Box flexDirection="column">
        <OverlayDetailList
          items={[
            { label: '名称', value: draft.name },
            {
              label: draft.transport === 'http' ? '端点' : '命令',
              value:
                draft.transport === 'http'
                  ? (displayEndpoint(draft.target) ?? draft.target)
                  : draft.target,
            },
            { label: '可用范围', value: draft.scope === 'project' ? '当前项目' : '所有项目' },
            {
              label: '配置位置',
              value: draft.scope === 'project' ? projectMcpConfigPath() : userMcpConfigPath(),
              truncate: true,
            },
          ]}
        />
        <OverlaySection>操作</OverlaySection>
        <McpSelect
          options={addOptions(step, draft)}
          selectedId={selectedId}
          selectionBackground={false}
        />
        <OverlayImpactNotice>
          将把“{draft.name}”写入{draft.scope === 'project' ? '当前项目' : '用户'}配置并立即连接。
          远程服务端数据不会改变。
        </OverlayImpactNotice>
      </Box>
    );
  return (
    <Box flexDirection="column">
      <Text bold>{step === 'transport' ? '服务器如何运行？' : '服务器应在哪些范围可用？'}</Text>
      <Box marginTop={1}>
        <McpSelect options={addOptions(step, draft)} selectedId={selectedId} />
      </Box>
    </Box>
  );
}

export function AuthenticationView({
  server,
  starting,
  selectedId,
}: {
  server: Readonly<McpServerControlState>;
  starting: boolean;
  selectedId?: string;
}) {
  const phase =
    server.authStatus === 'authenticated'
      ? 'success'
      : server.authStatus === 'error'
        ? 'failed'
        : server.authStatus === 'authorizing' || starting
          ? 'waiting'
          : 'prompt';
  const message =
    phase === 'prompt'
      ? `${server.key.name} 需要认证。`
      : phase === 'waiting'
        ? '请在浏览器中完成登录。'
        : phase === 'success'
          ? '认证完成。'
          : `认证失败${server.authErrorCode ? `：${server.authErrorCode}` : '。'}`;
  return (
    <Box flexDirection="column">
      <OverlayMessage tone={phase === 'failed' ? 'error' : phase === 'waiting' ? 'busy' : 'info'}>
        {message}
      </OverlayMessage>
      {phase === 'waiting' && server.authErrorCode && (
        <OverlayMessage tone="error">认证警告：{server.authErrorCode}</OverlayMessage>
      )}
      <OverlaySection>操作</OverlaySection>
      <McpSelect
        options={authOptions(server, starting)}
        selectedId={selectedId}
        selectionBackground={false}
      />
      {selectedId === 'open_browser' && (
        <OverlayImpactNotice>
          将在浏览器中授权“{server.key.name}”。Kite Code 不会读取或保存你的登录密码。
        </OverlayImpactNotice>
      )}
    </Box>
  );
}

export function ProjectApprovalView({
  server,
  selectedId,
}: {
  server: Readonly<McpServerControlState>;
  selectedId?: string;
}) {
  const command = server.configuration.command ?? server.approval?.review.command;
  const endpoint = displayEndpoint(
    server.configuration.endpoint ?? server.approval?.review.endpoint,
  );
  return (
    <Box flexDirection="column">
      <OverlayDetailList
        items={[
          { label: '名称', value: server.key.name },
          ...(command ? [{ label: '命令', value: command }] : []),
          ...(endpoint ? [{ label: '端点', value: endpoint }] : []),
          { label: '来源', value: '项目' },
          { label: '配置位置', value: server.sourcePath, truncate: true },
        ]}
      />
      <OverlaySection>决定</OverlaySection>
      <OverlayMessage tone="warning" callout>
        只批准你信任的项目。
      </OverlayMessage>
      <Box marginTop={1}>
        <McpSelect options={approvalOptions} selectedId={selectedId} selectionBackground={false} />
      </Box>
      {selectedId && (
        <OverlayImpactNotice tone={selectedId === 'reject' ? 'warning' : 'info'}>
          {selectedId === 'approve'
            ? `将批准并连接“${server.key.name}”。该项目声明的 MCP 进程或端点将获得运行权限。`
            : selectedId === 'reject'
              ? `将拒绝“${server.key.name}”。项目配置不会被删除，服务器也不会连接。`
              : '将保留待审核状态并返回。不会连接或修改服务器配置。'}
        </OverlayImpactNotice>
      )}
    </Box>
  );
}

export function ConfirmView({
  server,
  action,
  selectedId,
}: {
  server: Readonly<McpServerControlState>;
  action: 'disable' | 'remove';
  selectedId?: string;
}) {
  const remove = action === 'remove';
  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <OverlayMessage tone={remove ? 'warning' : 'info'} callout>
          {remove
            ? `将从${sourceDescription(server.source)}中移除“${server.key.name}”。此操作不会删除远程数据。`
            : `将禁用“${server.key.name}”。配置和凭据会保留，但工具将不再可用。`}
        </OverlayMessage>
      </Box>
      {remove && server.fallbackSource && (
        <Box marginTop={1}>
          <OverlayMessage tone="warning" callout>
            同名的{sourceDescription(server.fallbackSource)}可能随后生效。
          </OverlayMessage>
        </Box>
      )}
      <Box marginTop={1}>
        <McpSelect
          options={confirmOptions(action)}
          selectedId={selectedId}
          selectionBackground={false}
        />
      </Box>
    </Box>
  );
}

export function addOptions(step: AddStep, draft: AddDraft): McpSelectOption[] {
  if (step === 'transport')
    return [
      { id: 'http', label: 'HTTP' },
      { id: 'stdio', label: 'STDIO' },
    ];
  if (step === 'scope')
    return [
      { id: 'project', label: '当前项目', description: projectMcpConfigPath() },
      { id: 'user', label: '所有项目', description: userMcpConfigPath() },
    ];
  if (step === 'review') return [{ id: 'add', label: '添加并连接' }];
  return [{ id: draft.transport, label: draft.transport.toUpperCase() }];
}

export function authOptions(
  server: Readonly<McpServerControlState> | undefined,
  starting: boolean,
): McpSelectOption[] {
  if (!server || server.authStatus === 'authenticated') return [];
  if (server.authStatus === 'authorizing' || starting)
    return [{ id: 'cancel_auth', label: '取消认证' }];
  if (server.authStatus === 'error') return [{ id: 'retry', label: '重试' }];
  return [{ id: 'open_browser', label: '打开浏览器' }];
}

export const approvalOptions: McpSelectOption[] = [
  { id: 'later', label: '稍后决定' },
  { id: 'approve', label: '批准并连接' },
  { id: 'reject', label: '拒绝服务器', destructive: true },
];
export function confirmOptions(action: 'disable' | 'remove'): McpSelectOption[] {
  return [
    { id: 'cancel', label: '取消' },
    {
      id: 'confirm',
      label: action === 'disable' ? '禁用服务器' : '移除服务器',
      destructive: true,
    },
  ];
}
export function displayEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
export function animatedDots(count: number): string {
  return `${'.'.repeat(count)}${' '.repeat(3 - count)}`;
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

function capabilitySummary(
  server: Readonly<McpServerControlState>,
  capabilities: readonly unknown[],
): string {
  const parts = [
    server.toolCount > 0 ? `${server.toolCount} 个工具` : undefined,
    server.resourceCount > 0 ? `${server.resourceCount} 个资源` : undefined,
    server.promptCount > 0 ? `${server.promptCount} 个提示词` : undefined,
  ].filter(Boolean);
  return parts.length > 0
    ? parts.join(' · ')
    : capabilities.length > 0
      ? `${capabilities.length} 项`
      : '—';
}

function localizeActions(
  options: readonly McpSelectOption<McpServerAction>[],
): McpSelectOption<McpServerAction>[] {
  const labels: Record<McpServerAction, string> = {
    view_tools: '查看工具',
    connect: '连接',
    reconnect: '重新连接',
    retry: '重试连接',
    authenticate: '认证',
    enable: '启用服务器',
    disable: '禁用服务器',
    remove: '移除服务器',
    review_project_server: '审核服务器',
    review_decision: '查看审核决定',
  };
  return options.map((option, index) => ({
    ...option,
    label: labels[option.id],
    separatorBefore:
      option.separatorBefore ||
      ((option.id === 'disable' || option.id === 'remove') &&
        index > 0 &&
        options[index - 1]?.id !== 'disable'),
  }));
}

function sourceDescription(source: string): string {
  if (source === 'user' || source.includes('user')) return '用户配置';
  if (source.startsWith('project')) return '项目配置';
  if (source === 'local') return '旧版本地配置';
  return '配置';
}

function actionImpact(
  server: Readonly<McpServerControlState>,
  action: McpServerAction,
): string | undefined {
  switch (action) {
    case 'reconnect':
      return `将断开并重新连接“${server.key.name}”。正在进行的工具调用可能中断。`;
    case 'connect':
    case 'retry':
      return `将连接“${server.key.name}”并重新发现能力。现有配置不会改变。`;
    case 'authenticate':
      return `将开始“${server.key.name}”的认证流程。Kite Code 不会读取或保存你的登录密码。`;
    case 'enable':
      return `将启用并连接“${server.key.name}”。现有配置和凭据会继续使用。`;
    case 'disable':
      return `将禁用“${server.key.name}”。配置和凭据会保留，可随时重新启用。`;
    case 'remove':
      return `将从${sourceDescription(server.source)}中移除“${server.key.name}”。此操作不会删除远程数据。`;
    case 'review_project_server':
    case 'review_decision':
      return '将打开服务器审核信息。确认前不会连接或修改配置。';
    case 'view_tools':
      return undefined;
  }
}
