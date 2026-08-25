import type { McpServerControlState, McpServerKey } from '@kite-ai/builtin-runtime/mcp';

export type McpPrimaryStatus =
  | 'approval_required'
  | 'rejected'
  | 'disabled'
  | 'configuration_unavailable'
  | 'authenticating'
  | 'login_required'
  | 'auth_failed'
  | 'connecting'
  | 'ready'
  | 'failed'
  | 'disconnected';

export type McpServerAction =
  | 'view_tools'
  | 'connect'
  | 'reconnect'
  | 'retry'
  | 'authenticate'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'review_project_server'
  | 'review_decision';

export interface McpSelectOption<T extends string = string> {
  id: T;
  label: string;
  heading?: boolean;
  separatorBefore?: boolean;
  description?: string;
  disabled?: boolean;
  destructive?: boolean;
  trailing?: string;
  trailingTone?: 'success' | 'warning' | 'error' | 'muted';
  action?: boolean;
}

export function serverIdentity(key: Readonly<McpServerKey>): string {
  return `${key.source}:${key.name}`;
}

export function derivePrimaryStatus(server: Readonly<McpServerControlState>): McpPrimaryStatus {
  if (server.configStatus === 'pending_approval') return 'approval_required';
  if (server.configStatus === 'rejected') return 'rejected';
  if (server.configStatus === 'disabled' || !server.enabled) return 'disabled';
  if (
    server.configStatus === 'invalid' ||
    server.configStatus === 'store_corrupt' ||
    server.configStatus === 'store_unavailable' ||
    server.health === 'quarantined'
  ) {
    return 'configuration_unavailable';
  }
  if (server.authStatus === 'authorizing' || server.authStatus === 'refreshing') {
    return 'authenticating';
  }
  if (server.authStatus === 'login_required' || server.authStatus === 'reauth_required') {
    return 'login_required';
  }
  if (server.authStatus === 'error') return 'auth_failed';
  if (server.health === 'connecting' || server.health === 'discovering') return 'connecting';
  if (server.health === 'ready') return 'ready';
  if (
    server.health === 'degraded' ||
    server.health === 'half_open' ||
    server.health === 'circuit_open' ||
    server.diagnostic
  ) {
    return 'failed';
  }
  return 'disconnected';
}

export function statusLabel(server: Readonly<McpServerControlState>): string {
  switch (derivePrimaryStatus(server)) {
    case 'approval_required':
      return 'Approval required';
    case 'rejected':
      return 'Rejected';
    case 'disabled':
      return 'Disabled';
    case 'configuration_unavailable':
      return 'Configuration unavailable';
    case 'authenticating':
      return 'Authenticating...';
    case 'login_required':
      return 'Login required';
    case 'auth_failed':
      return 'Authentication failed';
    case 'connecting':
      return 'Connecting...';
    case 'ready':
      return 'Connected';
    case 'failed':
      return 'Connection failed';
    case 'disconnected':
      return 'Disconnected';
  }
}

export function buildServerActions(
  server: Readonly<McpServerControlState>,
): McpSelectOption<McpServerAction>[] {
  const remove = writableSource(server.source)
    ? [
        {
          id: 'remove' as const,
          label: 'Remove server',
          destructive: true,
        },
      ]
    : [];
  switch (derivePrimaryStatus(server)) {
    case 'approval_required':
      return [{ id: 'review_project_server', label: 'Review server' }];
    case 'rejected':
      return [{ id: 'review_decision', label: 'Review decision' }, ...remove];
    case 'disabled':
      return [{ id: 'enable', label: 'Enable server' }, ...remove];
    case 'configuration_unavailable':
      return [...remove];
    case 'authenticating':
    case 'connecting':
      return [];
    case 'login_required':
    case 'auth_failed':
      return [
        { id: 'authenticate', label: 'Authenticate' },
        ...(writableSource(server.source)
          ? [{ id: 'disable' as const, label: 'Disable server' }]
          : []),
        ...remove,
      ];
    case 'ready':
      return [
        ...(server.toolCount > 0 ? [{ id: 'view_tools' as const, label: 'View tools' }] : []),
        { id: 'reconnect', label: 'Reconnect' },
        ...(writableSource(server.source)
          ? [{ id: 'disable' as const, label: 'Disable server' }]
          : []),
        ...remove,
      ];
    case 'failed':
      return [
        ...(server.diagnostic?.retryable
          ? [{ id: 'retry' as const, label: 'Retry connection' }]
          : []),
        ...(writableSource(server.source)
          ? [{ id: 'disable' as const, label: 'Disable server' }]
          : []),
        ...remove,
      ];
    case 'disconnected':
      return [
        { id: 'connect', label: 'Connect' },
        ...(writableSource(server.source)
          ? [{ id: 'disable' as const, label: 'Disable server' }]
          : []),
        ...remove,
      ];
  }
}

export function writableSource(source: string): source is 'project' | 'user' {
  return source === 'project' || source === 'user';
}

export function moveSelection<T extends string>(
  options: readonly McpSelectOption<T>[],
  selectedId: T | undefined,
  direction: 'up' | 'down',
): T | undefined {
  const enabled = options.filter((option) => !option.disabled && !option.heading);
  if (enabled.length === 0) return undefined;
  const current = Math.max(
    0,
    enabled.findIndex((option) => option.id === selectedId),
  );
  const next =
    direction === 'up' ? Math.max(0, current - 1) : Math.min(enabled.length - 1, current + 1);
  return enabled[next]?.id;
}

export function validSelection<T extends string>(
  options: readonly McpSelectOption<T>[],
  selectedId: T | undefined,
): T | undefined {
  const selected = options.find(
    (option) => option.id === selectedId && !option.disabled && !option.heading,
  );
  return selected?.id ?? options.find((option) => !option.disabled && !option.heading)?.id;
}
