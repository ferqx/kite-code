import type { McpConfigSourceKind } from '@/core/config/mcp-config';
import type { McpDiagnostic } from './diagnostics';
import type { McpHealthState, McpPrompt, McpResource, McpTransportType } from './types';

export interface McpServerKey {
  name: string;
  source: McpConfigSourceKind;
}

export type McpConfigStatus =
  | 'configured'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'invalid'
  | 'store_corrupt'
  | 'store_unavailable'
  | 'shadowed'
  | 'disabled';

export type McpAuthStatus = 'not_required';

export interface McpToolControlState {
  name: string;
  description?: string;
  available: boolean;
  diagnostic?: McpDiagnostic;
}

export interface McpApprovalControlState {
  configDigest: string;
  review: Readonly<{
    command?: string;
    argumentCount?: number;
    endpoint?: string;
  }>;
}

export interface McpServerControlState {
  key: Readonly<McpServerKey>;
  effective: boolean;
  configStatus: McpConfigStatus;
  authStatus: McpAuthStatus;
  health: McpHealthState;
  transport: McpTransportType;
  source: McpConfigSourceKind;
  sourcePath: string;
  capabilityRevision?: string;
  toolCount: number;
  availableToolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: readonly Readonly<McpToolControlState>[];
  resources: readonly Readonly<McpResource>[];
  prompts: readonly Readonly<McpPrompt>[];
  approval?: Readonly<McpApprovalControlState>;
  retryAt?: number;
  lastAttemptAt?: string;
  diagnostic?: McpDiagnostic;
}

export interface McpControlSnapshot {
  revision: string;
  generation: number;
  servers: readonly Readonly<McpServerControlState>[];
}
