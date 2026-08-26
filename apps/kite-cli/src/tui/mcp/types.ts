import type {
  McpAuthResult,
  McpControlSnapshot,
  McpProviderDirectoryStatus,
  McpProviderRecoveryAction,
  McpServerConfig,
  McpServerKey,
} from '@kite-ai/builtin-runtime/mcp';
import type { McpWritableScope } from '#kite-cli/config';

export interface McpControllerSnapshot {
  control: McpControlSnapshot;
  message?: string;
}

export interface McpController {
  getSnapshot(): McpControllerSnapshot;
  subscribe(listener: () => void): () => void;
  decide(key: McpServerKey, decision: 'approved' | 'rejected'): Promise<boolean>;
  login(key: McpServerKey): Promise<McpAuthResult | null>;
  cancelAuth(flowId: string): Promise<void>;
  retry(key: McpServerKey): Promise<boolean>;
  setEnabled(key: McpServerKey, expectedRevision: string, enabled: boolean): Promise<boolean>;
  add(input: {
    scope: Extract<McpWritableScope, 'project' | 'user'>;
    name: string;
    config: Pick<McpServerConfig, 'type' | 'url' | 'command'>;
  }): Promise<McpServerKey | null>;
  remove(key: McpServerKey, expectedRevision: string): Promise<boolean>;
  recover?(
    providerId: string,
    action: McpProviderRecoveryAction,
  ): Promise<{
    outcome: 'completed' | 'failed';
    providerDirectoryRevision: string;
    providerStatus?: McpProviderDirectoryStatus;
    diagnosticCode?: string;
  }>;
}
