import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { projectMcpConfigPath, userMcpConfigPath } from '@/core/config';
import type { McpServerControlState } from '@/core/mcp';
import { OverlayDetailList, OverlayMessage, OverlaySection } from '../components/OverlayPrimitives';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useTheme } from '../theme';
import McpSelect from './McpSelect';
import type { McpSelectOption, McpServerAction } from './model';
import { derivePrimaryStatus, statusLabel } from './model';

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
      <OverlayDetailList
        items={[
          {
            label: 'Status:',
            value:
              statusMessage ??
              `${connected ? '✔' : primaryStatus === 'connecting' ? '◌' : '✘'} ${statusLabel(server).toLowerCase()}`,
            valueColor: statusMessage?.includes('ing.')
              ? t.warning
              : connected
                ? t.success
                : primaryStatus === 'connecting'
                  ? t.warning
                  : t.error,
          },
          ...(command ? [{ label: 'Command:', value: command }] : []),
          ...(argumentCount !== undefined
            ? [
                {
                  label: 'Args:',
                  value: `${argumentCount} configured argument${argumentCount === 1 ? '' : 's'}`,
                },
              ]
            : []),
          ...(endpoint ? [{ label: 'Endpoint:', value: endpoint }] : []),
          { label: 'Config location:', value: server.sourcePath, truncate: true },
          {
            label: 'Capabilities:',
            value: capabilities.length > 0 ? capabilities.join(', ') : '—',
          },
          { label: 'Tools:', value: server.toolCount > 0 ? `${server.toolCount} tools` : '—' },
        ]}
      />
      <OverlaySection>Actions</OverlaySection>
      <McpSelect options={options} selectedId={selectedId} numbered />
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
          label: 'Status:',
          value: `Adding and connecting${animatedDots(dotCount)}`,
          valueColor: t.warning,
        },
        {
          label: draft.transport === 'http' ? 'Endpoint:' : 'Command:',
          value:
            draft.transport === 'http'
              ? (displayEndpoint(draft.target) ?? draft.target)
              : draft.target,
        },
        {
          label: 'Config location:',
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
      <Text color={useTheme().muted}>
        {options.length} tools for {server.key.name}
      </Text>
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
          {target ? (draft.transport === 'http' ? 'MCP server URL' : 'Command') : 'Server name'}
        </Text>
        <TextInput
          value={target ? draft.target : draft.name}
          onChange={target ? onTargetChange : onNameChange}
          onSubmit={onSubmit}
        />
        {!target && <Text color={t.dim}>Letters, numbers, ".", "-" and "_" only.</Text>}
        {inputError && <OverlayMessage tone="error">{inputError}</OverlayMessage>}
      </Box>
    );
  }
  if (step === 'review')
    return (
      <Box flexDirection="column">
        <OverlayDetailList
          items={[
            { label: 'Name:', value: draft.name },
            {
              label: draft.transport === 'http' ? 'Endpoint:' : 'Command:',
              value:
                draft.transport === 'http'
                  ? (displayEndpoint(draft.target) ?? draft.target)
                  : draft.target,
            },
            { label: 'Available:', value: draft.scope === 'project' ? 'Project' : 'User' },
            {
              label: 'Config location:',
              value: draft.scope === 'project' ? projectMcpConfigPath() : userMcpConfigPath(),
              truncate: true,
            },
          ]}
        />
        <OverlaySection>Action</OverlaySection>
        <McpSelect options={addOptions(step, draft)} selectedId={selectedId} />
      </Box>
    );
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
      ? `${server.key.name} requires authentication.`
      : phase === 'waiting'
        ? 'Complete sign-in in your browser.'
        : phase === 'success'
          ? 'Authentication complete.'
          : `Authentication failed${server.authErrorCode ? `: ${server.authErrorCode}` : '.'}`;
  return (
    <Box flexDirection="column">
      <OverlayMessage tone={phase === 'failed' ? 'error' : phase === 'waiting' ? 'busy' : 'info'}>
        {message}
      </OverlayMessage>
      {phase === 'waiting' && server.authErrorCode && (
        <OverlayMessage tone="error">Authentication warning: {server.authErrorCode}</OverlayMessage>
      )}
      <OverlaySection>Action</OverlaySection>
      <McpSelect options={authOptions(server, starting)} selectedId={selectedId} />
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
          { label: 'Name:', value: server.key.name },
          ...(command ? [{ label: 'Command:', value: command }] : []),
          ...(endpoint ? [{ label: 'Endpoint:', value: endpoint }] : []),
          { label: 'Source:', value: 'Project' },
          { label: 'Config location:', value: server.sourcePath, truncate: true },
        ]}
      />
      <OverlaySection>Decision</OverlaySection>
      <OverlayMessage tone="warning">Only approve projects you trust.</OverlayMessage>
      <McpSelect options={approvalOptions} selectedId={selectedId} />
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
  return (
    <Box flexDirection="column">
      <Text bold>
        {action === 'disable' ? 'Disable' : 'Remove'} "{server.key.name}"?
      </Text>
      <OverlayMessage tone={action === 'remove' ? 'warning' : 'info'}>
        {action === 'disable'
          ? 'The configuration and credentials will be kept. Its tools will no longer be available to the agent.'
          : 'This removes the selected configuration and stored credentials.'}
      </OverlayMessage>
      {action === 'remove' && server.fallbackSource && (
        <OverlayMessage tone="warning">
          A {sourceLabel(server.fallbackSource)} configuration with the same name may become active.
        </OverlayMessage>
      )}
      <OverlaySection>Decision</OverlaySection>
      <McpSelect options={confirmOptions(action)} selectedId={selectedId} />
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
      { id: 'project', label: 'Project', description: projectMcpConfigPath() },
      { id: 'user', label: 'User', description: userMcpConfigPath() },
    ];
  if (step === 'review') return [{ id: 'add', label: 'Add and connect' }];
  return [{ id: draft.transport, label: draft.transport.toUpperCase() }];
}

export function authOptions(
  server: Readonly<McpServerControlState> | undefined,
  starting: boolean,
): McpSelectOption[] {
  if (!server || server.authStatus === 'authenticated') return [];
  if (server.authStatus === 'authorizing' || starting)
    return [{ id: 'cancel_auth', label: 'Cancel authentication' }];
  if (server.authStatus === 'error') return [{ id: 'retry', label: 'Try again' }];
  return [{ id: 'open_browser', label: 'Open browser' }];
}

export const approvalOptions: McpSelectOption[] = [
  { id: 'later', label: 'Decide later' },
  { id: 'approve', label: 'Approve and connect' },
  { id: 'reject', label: 'Reject server', destructive: true },
];
export function confirmOptions(action: 'disable' | 'remove'): McpSelectOption[] {
  return [
    { id: 'cancel', label: 'Cancel' },
    {
      id: 'confirm',
      label: action === 'disable' ? 'Disable server' : 'Remove server',
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
function sourceLabel(source: string): string {
  if (source === 'project') return 'Current project';
  if (source === 'local') return 'Legacy local';
  if (source === 'user') return 'All projects';
  if (source.startsWith('project')) return 'Project configuration';
  return source;
}
