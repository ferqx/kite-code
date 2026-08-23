import type { McpServerConfig } from './types';

export type McpWritableScope = 'project' | 'user';
export type McpConfigSourceKind = McpWritableScope | 'explicit';
export type McpConfigApprovalStatus =
  | 'not_required'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'invalid'
  | 'store_corrupt'
  | 'store_unavailable';

export interface McpConfigSource {
  kind: McpConfigSourceKind;
  path: string;
  workspace: string;
}

export interface McpConfigDiagnostic {
  code: 'file_invalid' | 'server_invalid' | 'workspace_unavailable' | 'approval_store';
  message: string;
  sourcePath: string;
  serverName?: string;
}

export interface McpServerConfigEntry {
  name: string;
  source: McpConfigSource;
  rawConfig: Readonly<Record<string, unknown>>;
  normalizedConfig?: McpServerConfig;
  configDigest?: string;
  revision: string;
  providerConfigDigest: string;
  enabled: boolean;
  approvalStatus: McpConfigApprovalStatus;
  diagnostics: readonly McpConfigDiagnostic[];
  effective: boolean;
  shadowedBy?: McpConfigSourceKind;
}

export interface McpProjectServerApprovalView {
  name: string;
  sourceKind: Extract<McpConfigSourceKind, 'project'>;
  sourcePath: string;
  transport: 'stdio' | 'http';
  configDigest: string;
  status: Exclude<McpConfigApprovalStatus, 'not_required'>;
  review: Readonly<{ command?: string; argumentCount?: number; endpoint?: string }>;
  diagnostics: readonly string[];
}

export interface McpConfigCatalog {
  entries: readonly McpServerConfigEntry[];
  effective: ReadonlyMap<string, McpServerConfigEntry>;
  connectableServers: Readonly<Record<string, McpServerConfig>>;
  projectApprovals: readonly McpProjectServerApprovalView[];
  diagnostics: readonly McpConfigDiagnostic[];
  workspace: string;
  sourceRevisions: Readonly<Record<McpWritableScope, string>>;
}

export type McpServerConfigInput = Omit<McpServerConfig, 'providerVersion' | 'credentialHandle'>;
export type McpConfigPatch = Partial<McpServerConfigInput>;
export type McpConfigCommand =
  | {
      type: 'add';
      scope: McpWritableScope;
      name: string;
      config: McpServerConfigInput;
      expectedRevision: string;
    }
  | {
      type: 'update';
      key: { name: string; source: McpConfigSourceKind };
      expectedRevision: string;
      patch: McpConfigPatch;
    }
  | {
      type: 'remove';
      key: { name: string; source: McpConfigSourceKind };
      expectedRevision: string;
    }
  | {
      type: 'set_enabled';
      key: { name: string; source: McpConfigSourceKind };
      expectedRevision: string;
      enabled: boolean;
    };

export interface McpConfigRepository {
  load(workspace: string): Promise<McpConfigCatalog>;
  mutate(command: McpConfigCommand): Promise<McpConfigCatalog>;
  watch(workspace: string, listener: () => void): () => void;
}
