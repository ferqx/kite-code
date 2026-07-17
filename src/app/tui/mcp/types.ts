import type {
  McpControlSnapshot,
  McpProviderDirectoryStatus,
  McpProviderRecoveryAction,
  McpServerKey,
} from '@/core/mcp';

export interface McpControllerSnapshot {
  control: McpControlSnapshot;
  message?: string;
}

export interface McpController {
  getSnapshot(): McpControllerSnapshot;
  subscribe(listener: () => void): () => void;
  decide(key: McpServerKey, decision: 'approved' | 'rejected'): Promise<boolean>;
  login(key: McpServerKey): Promise<boolean>;
  cancelAuth(flowId: string): Promise<void>;
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
