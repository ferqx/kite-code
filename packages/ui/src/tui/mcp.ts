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
import type { TuiMcpReconnectionPort } from './mcp-reconnection';
import type { TuiMcpSourceApprovalPort, TuiMcpSourceSnapshot } from './mcp-source';
import type { TuiMcpSourceMutationPort } from './mcp-source-mutation';

export type TuiMcpReadSet = {
  userEtag: string;
  workspaceEtag: string | null;
  explicitDigest: string;
  registryDigest: string;
  registryRevision: string;
  scopeDigest: string;
};
export interface TuiMcpSnapshot {
  /** Exact read-only source labels; excluded from canonical settings, targets and intents. */
  labels?: Readonly<Record<string, string>>;
  /** Actual same-Session current catalogue observations; selection is not connection. */
  liveServerIds?: readonly string[];
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
export interface TuiMcpReadDirectory {
  readonly family: 'resources' | 'prompts';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly items: readonly {
    readonly key: string;
    readonly serverId: string;
    readonly configDigest: string;
    readonly generation: number;
    readonly live: boolean;
    readonly descriptors: readonly Readonly<Record<string, unknown>>[];
    readonly descriptorDigests: readonly string[];
  }[];
  readonly nextAfterKey: string | null;
}
export interface TuiMcpPort {
  readDirectory?(
    sessionId: string,
    family: 'resources' | 'prompts',
    signal: AbortSignal,
    options?: { serverId?: string; afterKey?: string },
  ): Promise<TuiMcpReadDirectory>;
  connection?: TuiMcpConnectionPort;
  reconnection?: TuiMcpReconnectionPort;
  source?: TuiMcpSourceApprovalPort;
  sourceMutation?: TuiMcpSourceMutationPort;
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

/** Join source names only to the exact public registry identity; this never grants capability. */
export function decodeTuiMcpLabels(
  snapshot: TuiMcpSnapshot,
  sources: TuiMcpSourceSnapshot,
): Readonly<Record<string, string>> {
  if (
    sources.storeId !== snapshot.storeId ||
    sources.sessionId !== snapshot.sessionId ||
    sources.workspaceId !== snapshot.workspaceId ||
    sources.workspaceIdentity !== snapshot.workspaceIdentity ||
    !sources.readSet ||
    !Array.isArray(sources.items) ||
    sources.items.length > 8192
  )
    throw Error('mcp_labels_scope_mismatch');
  const ids = new Set<string>();
  const labels = Object.create(null) as Record<string, string>;
  for (const item of sources.items) {
    if (
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.name)
    )
      throw Error('mcp_labels_invalid');
    ids.add(item.id);
    const server = snapshot.items.find((row) => row.id === item.id);
    if (!server || server.source.kind === 'programmatic') continue;
    const document =
      item.source.kind === 'workspace' ? sources.readSet.workspace : sources.readSet.user;
    if (
      !document ||
      document.error !== null ||
      document.etag === null ||
      document.identity.kind !== item.source.kind ||
      document.identity.pathDigest !== item.source.pathDigest ||
      document.identity.rootIdentity !== item.source.rootIdentity ||
      server.source.kind !== item.source.kind ||
      server.source.id !== item.source.pathDigest ||
      server.source.revision !== item.rawEntryDigest ||
      server.configDigest !== item.configDigest ||
      server.transport !== item.transport
    )
      continue;
    labels[server.id] = item.name;
  }
  return Object.freeze(labels);
}
