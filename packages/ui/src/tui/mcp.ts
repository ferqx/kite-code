import type {
  Command,
  Execution,
  McpToolMetadata,
  McpToolsBinding,
  McpToolsEntry,
  McpToolsPage,
  McpToolsSnapshot,
  McpToolsSnapshots,
  QueryResponse,
} from '@kite-ai/client';
import type { TuiMcpConnectionPort } from './mcp-connection';
import type { TuiMcpSourceApprovalPort } from './mcp-source';

export type TuiMcpReadSet = {
  userEtag: string;
  workspaceEtag: string | null;
  explicitDigest: string;
  registryDigest: string;
  registryRevision: string;
  scopeDigest: string;
};
export interface TuiMcpSnapshot {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  workspacePath: string;
  registryRevision: string;
  readSet: TuiMcpReadSet;
  items: readonly {
    id: string;
    configDigest: string;
    transport: 'http' | 'stdio';
    source: { kind: 'programmatic' | 'user' | 'workspace'; id: string; revision: string };
    admitted: boolean;
    selected: boolean;
    available: boolean;
    reason: string | null;
  }[];
}
export interface TuiMcpIntent {
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  request: {
    expectedStoreId: string;
    commandId: string;
    kind: 'extension.invoke';
    extensionId: 'builtin.mcp.management';
    actionId: 'mcp.server.select';
    definitionVersion: '1';
    input: {
      serverId: string;
      enabled: boolean;
      scope: 'user' | 'workspace';
      expectedReadSet: TuiMcpReadSet;
    };
  };
}
export interface TuiMcpOutcome {
  intent: TuiMcpIntent;
  phase: 'pending' | 'applied' | 'failed' | 'outcome_unknown';
  command?: Command;
  execution?: Execution;
}
export interface TuiMcpPort {
  connection?: TuiMcpConnectionPort;
  source?: TuiMcpSourceApprovalPort;
  readToolsSnapshots?(
    sessionId: string,
    signal: AbortSignal,
    options?: { serverId?: string; afterKey?: string },
  ): Promise<McpToolsSnapshots>;
  readToolsPage?(
    sessionId: string,
    snapshot: McpToolsSnapshot,
    signal: AbortSignal,
    options?: { afterIndex?: number; indexDigest?: string },
  ): Promise<McpToolsPage>;
  readToolDescriptor?(
    sessionId: string,
    binding: McpToolsBinding,
    entry: McpToolsEntry,
    signal: AbortSignal,
  ): Promise<McpToolMetadata>;
  list?(): Promise<TuiMcpOutcome[]>;
  read(sessionId: string, signal: AbortSignal): Promise<TuiMcpSnapshot>;
  submit(intent: TuiMcpIntent): Promise<TuiMcpOutcome>;
  lookup(intent: TuiMcpIntent, signal: AbortSignal): Promise<TuiMcpOutcome>;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('mcp_directory_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== [...keys].sort().join(','))
    throw Error('mcp_directory_invalid');
  return row;
}
const text = (value: unknown, maximum = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** One finite fixed Query, including every registered Server; reading does not connect. */
export function decodeTuiMcpSnapshot(result: QueryResponse): TuiMcpSnapshot {
  if (!Array.isArray(result)) throw Error('mcp_directory_invalid');
  const display = result[0];
  if (display)
    object(display, [
      'extensionId',
      'contentType',
      'contentVersion',
      'summary',
      'payload',
      'actions',
      'artifactRefs',
    ]);
  if (
    result.length !== 1 ||
    !display ||
    display.extensionId !== 'builtin.mcp.management' ||
    display.contentType !== 'builtin.mcp.servers' ||
    display.contentVersion !== 1 ||
    typeof display.summary !== 'string' ||
    !Array.isArray(display.actions) ||
    !Array.isArray(display.artifactRefs) ||
    display.actions.length !== 0 ||
    display.artifactRefs.length !== 0
  )
    throw Error('mcp_directory_invalid');
  const row = object(display.payload, [
    'storeId',
    'sessionId',
    'workspaceId',
    'workspaceIdentity',
    'workspacePath',
    'registryRevision',
    'readSet',
    'items',
  ]);
  if (
    !text(row.storeId) ||
    !text(row.sessionId) ||
    !text(row.workspaceId) ||
    !text(row.workspaceIdentity, 16384) ||
    !text(row.workspacePath, 32760) ||
    !text(row.registryRevision) ||
    !Array.isArray(row.items) ||
    row.items.length > 32
  )
    throw Error('mcp_directory_invalid');
  const readSet = object(row.readSet, [
    'userEtag',
    'workspaceEtag',
    'explicitDigest',
    'registryDigest',
    'registryRevision',
    'scopeDigest',
  ]);
  if (
    !hash(readSet.userEtag) ||
    !(readSet.workspaceEtag === null || hash(readSet.workspaceEtag)) ||
    !hash(readSet.explicitDigest) ||
    !hash(readSet.registryDigest) ||
    !hash(readSet.scopeDigest) ||
    readSet.registryRevision !== row.registryRevision
  )
    throw Error('mcp_directory_invalid');
  const ids = new Set<string>();
  for (const value of row.items) {
    const server = object(value, [
      'id',
      'configDigest',
      'transport',
      'source',
      'admitted',
      'selected',
      'available',
      'reason',
    ]);
    const source = object(server.source, ['kind', 'id', 'revision']);
    if (
      typeof server.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(server.id) ||
      ids.has(server.id) ||
      !hash(server.configDigest) ||
      typeof server.transport !== 'string' ||
      !['http', 'stdio'].includes(server.transport) ||
      typeof source.kind !== 'string' ||
      !['programmatic', 'user', 'workspace'].includes(source.kind) ||
      !text(source.id) ||
      !text(source.revision) ||
      ['admitted', 'selected', 'available'].some((key) => typeof server[key] !== 'boolean') ||
      !(server.reason === null || text(server.reason))
    )
      throw Error('mcp_directory_invalid');
    ids.add(server.id);
  }
  return structuredClone(row) as unknown as TuiMcpSnapshot;
}
