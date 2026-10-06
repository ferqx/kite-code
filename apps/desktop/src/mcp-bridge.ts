import type {
  McpAuthResult,
  McpAuthStatus,
  McpCommandRequest,
  McpConnectionFact,
  McpManagementSnapshot,
  McpReconnectionFact,
  McpSourceEntryPreview,
  McpSourceItem,
  McpSourceMutationResult,
  McpSourceResult,
  McpToolsPage,
  McpToolsSnapshot,
} from '@kite-ai/client';

/** Renderer requests contain finite edits, never a raw command, read-set or credential. */
export type NativeMcpOperation =
  | { kind: 'select'; serverId: string; enabled: boolean; scope: 'user' | 'workspace' }
  | { kind: 'connect' | 'approve'; serverId: string }
  | { kind: 'refresh' | 'reconnect'; serverId: string; commandId: string }
  | { kind: 'bind'; serverId: string; expiresAt: number }
  | { kind: 'login' | 'authRefresh' | 'clear' | 'revoke'; serverId: string }
  | {
      kind: 'add';
      scope: 'user' | 'workspace';
      name: string;
      entry: { type: 'http'; url: string } | { type: 'stdio'; command: string };
    }
  | { kind: 'remove'; serverId: string; scope: 'user' | 'workspace' };

export type NativeMcpPhase =
  | 'submitting'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

export type NativeMcpSubmission = {
  kind: 'settings.mcp.submission';
  commandId: string;
  storeId: string;
  sessionId: string;
  workspaceId: string;
  actionId: McpCommandRequest['actionId'];
  serverId: string | null;
  name: string | null;
  phase: NativeMcpPhase;
  association: 'current' | 'unavailable';
  bodySha256: string;
  requestSha256: string;
  executionId?: string;
  error?: string;
  summary?: string;
  fact?:
    | McpConnectionFact
    | McpReconnectionFact
    | McpSourceResult
    | McpSourceMutationResult
    | McpAuthResult;
};

export type NativeMcpFacts = {
  kind: 'settings.mcp';
  observationId: number;
  storeId: string;
  sessionId: string;
  workspaceId: string;
  canWrite: boolean;
  errors: string[];
  servers: McpManagementSnapshot['items'];
  sources: readonly McpSourceItem[];
  nextAfterId: string | null;
  snapshots: readonly McpToolsSnapshot[];
  nextAfterKey: string | null;
};
export type NativeMcpSources = {
  kind: 'settings.mcp.sources';
  observationId: number;
  sources: readonly McpSourceItem[];
  nextAfterId: string | null;
};
export type NativeMcpSnapshots = {
  kind: 'settings.mcp.snapshots';
  observationId: number;
  snapshots: readonly McpToolsSnapshot[];
  nextAfterKey: string | null;
};
export type NativeMcpAuthFacts = {
  kind: 'settings.mcp.auth';
  observationId: number;
  status: McpAuthStatus;
};
export type NativeMcpRemovalPreview = {
  kind: 'settings.mcp.removePreview';
  observationId: number;
  serverId: string;
  scope: 'user' | 'workspace';
  preview: McpSourceEntryPreview;
};
export type NativeMcpTools = {
  kind: 'settings.mcp.tools';
  observationId: number;
  page: McpToolsPage;
};
export type NativeMcpDescriptorOpen = {
  kind: 'settings.mcp.descriptor';
  readId: string;
  bodySha256: string;
  bodyBytes: number;
};
export type NativeMcpDescriptorChunk = {
  kind: 'settings.mcp.descriptor.chunk';
  readId: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  data: string;
};

export type NativeMcpRequest =
  | { method: 'settings.mcp.read' | 'settings.mcp.close'; generation: number }
  | { method: 'settings.mcp.sources'; generation: number; observationId: number; afterId: string }
  | {
      method: 'settings.mcp.snapshots';
      generation: number;
      observationId: number;
      afterKey: string;
    }
  | { method: 'settings.mcp.auth'; generation: number; observationId: number; serverId: string }
  | {
      method: 'settings.mcp.removePreview';
      generation: number;
      observationId: number;
      serverId: string;
      scope: 'user' | 'workspace';
    }
  | {
      method: 'settings.mcp.submit';
      generation: number;
      observationId: number;
      operation: NativeMcpOperation;
    }
  | {
      method: 'settings.mcp.lookup' | 'settings.mcp.cancel' | 'settings.mcp.clear';
      generation: number;
      commandId: string;
    }
  | {
      method: 'settings.mcp.tools';
      generation: number;
      observationId: number;
      recordKey: string;
      startIndex: number;
    }
  | {
      method: 'settings.mcp.descriptor';
      generation: number;
      observationId: number;
      recordKey: string;
      index: number;
      readId: string;
    }
  | {
      method: 'settings.mcp.descriptor.read';
      generation: number;
      readId: string;
      offset: number;
      limit: number;
    }
  | { method: 'settings.mcp.descriptor.close'; generation: number; readId: string };
export type NativeMcpResult =
  | NativeMcpFacts
  | NativeMcpSources
  | NativeMcpSnapshots
  | NativeMcpAuthFacts
  | NativeMcpRemovalPreview
  | NativeMcpSubmission
  | NativeMcpTools
  | NativeMcpDescriptorOpen
  | NativeMcpDescriptorChunk;
