import type { McpControlSnapshot, McpServerControlState, McpServerKey } from '@/core/mcp';

export type McpRouteKind = 'detail' | 'tools' | 'resources' | 'prompts' | 'error' | 'approval';

export type McpRoute = { kind: 'list' } | { kind: McpRouteKind; serverId: string };

export interface McpOverlayState {
  route: McpRoute;
  selectedIndex: number;
  search: string;
  searchActive: boolean;
  pendingDecision?: 'approved' | 'rejected';
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
  decide(key: McpServerKey, decision: 'approved' | 'rejected'): Promise<void>;
}

export function mcpServerId(server: Pick<McpServerControlState, 'key'>): string {
  return `${server.key.source}:${server.key.name}`;
}
