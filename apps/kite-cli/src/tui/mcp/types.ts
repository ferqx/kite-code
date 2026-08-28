import type {
  AppMcpServer,
  AppMcpServerKey,
  AppMcpSnapshot,
  AppMcpTransport,
} from '@kite-ai/kite-app-contract';

export type McpServerControlState = AppMcpServer;
export type McpServerKey = AppMcpServerKey;
export type McpControlSnapshot = AppMcpSnapshot;
export type McpWritableScope = 'project' | 'user';

export interface McpControllerSnapshot {
  control: McpControlSnapshot;
  message?: string;
}

export interface McpController {
  getSnapshot(): McpControllerSnapshot;
  subscribe(listener: () => void): () => void;
  decide(key: McpServerKey, decision: 'approved' | 'rejected'): Promise<boolean>;
  login(key: McpServerKey): Promise<void>;
  cancelAuth(flowId: string): Promise<void>;
  retry(key: McpServerKey): Promise<boolean>;
  setEnabled(key: McpServerKey, expectedRevision: string, enabled: boolean): Promise<boolean>;
  add(input: {
    scope: Extract<McpWritableScope, 'project' | 'user'>;
    name: string;
    config: {
      type: AppMcpTransport;
      url?: string;
      command?: string;
    };
  }): Promise<McpServerKey | null>;
  remove(key: McpServerKey, expectedRevision: string): Promise<boolean>;
}
