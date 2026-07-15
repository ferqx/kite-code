import type { McpServerConfigInput, McpWritableScope } from '@/core/config';
import type { McpControlSnapshot, McpServerControlState, McpServerKey } from '@/core/mcp';

export type McpMutationAction = 'enable' | 'disable' | 'remove' | 'migrate';

export type McpRouteKind =
  | 'detail'
  | 'tools'
  | 'resources'
  | 'prompts'
  | 'error'
  | 'approval'
  | 'add'
  | 'confirm';

export type McpRoute = { kind: 'list' } | { kind: McpRouteKind; serverId: string };

export interface McpOverlayState {
  route: McpRoute;
  selectedIndex: number;
  search: string;
  searchActive: boolean;
  pendingDecision?: 'approved' | 'rejected';
  pendingMutation?: McpMutationAction;
}

export interface McpControllerSnapshot {
  control: McpControlSnapshot;
  message?: string;
}

export interface McpController {
  getSnapshot(): McpControllerSnapshot;
  subscribe(listener: () => void): () => void;
  retry(key: McpServerKey): Promise<void>;
  retryByName(name: string): Promise<void>;
  reload(): Promise<void>;
  add(scope: McpWritableScope, name: string, config: McpServerConfigInput): Promise<boolean>;
  setEnabled(server: Readonly<McpServerControlState>, enabled: boolean): Promise<boolean>;
  remove(server: Readonly<McpServerControlState>): Promise<boolean>;
  migrate(server: Readonly<McpServerControlState>): Promise<boolean>;
  decide(key: McpServerKey, decision: 'approved' | 'rejected'): Promise<void>;
}

export function mcpServerId(server: Pick<McpServerControlState, 'key'>): string {
  return `${server.key.source}:${server.key.name}`;
}
