import { createHash } from 'node:crypto';
import { resolveConfiguration } from './effective';
import { type ConfigurationEdit, readConfigurationFile, updateConfigurationFile } from './files';
import { ConfigurationError, type JsonObject } from './types';

export const mcpCanonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(mcpCanonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${mcpCanonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
export interface McpRegistry {
  revision: string;
  servers: readonly {
    id: string;
    configDigest: string;
    transport: 'http' | 'stdio';
    source: { kind: 'programmatic' | 'user' | 'workspace'; id: string; revision: string };
    admitted: boolean;
  }[];
}
export interface McpSelectionReadSet {
  userEtag: string;
  workspaceEtag: string | null;
  explicitDigest: string;
  registryDigest: string;
  registryRevision: string;
  scopeDigest: string;
}
/** Host-only source snapshots. No transport, secret lookup, or implicit registration. */
export function readMcpSelection(options: {
  userPath: string;
  workspacePath?: string;
  sourceIdentity: string;
  validateSource?: () => void;
  explicit: () => JsonObject;
  registry: () => McpRegistry;
}) {
  const explicit = structuredClone(options.explicit());
  const registry = structuredClone(options.registry());
  const user = readConfigurationFile({ path: options.userPath, windowsPathPolicy: 'private' });
  const workspace = options.workspacePath
    ? readConfigurationFile({ path: options.workspacePath })
    : undefined;
  if (
    !registry.revision ||
    registry.revision.length > 4096 ||
    Object.keys(registry).some((key) => !['revision', 'servers'].includes(key)) ||
    registry.servers.length > 32 ||
    new Set(registry.servers.map((server) => server.id)).size !== registry.servers.length ||
    registry.servers.some(
      (server) =>
        Object.keys(server).some(
          (key) => !['id', 'configDigest', 'transport', 'source', 'admitted'].includes(key),
        ) ||
        Object.keys(server.source).some((key) => !['kind', 'id', 'revision'].includes(key)) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(server.id) ||
        !/^[a-f0-9]{64}$/.test(server.configDigest) ||
        !['http', 'stdio'].includes(server.transport) ||
        typeof server.admitted !== 'boolean' ||
        !server.source.id ||
        server.source.id.length > 4096 ||
        !server.source.revision ||
        server.source.revision.length > 4096 ||
        !['programmatic', 'user', 'workspace'].includes(server.source.kind),
    )
  )
    throw new ConfigurationError('mcp_registry_invalid');
  const hash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
  const readSet: McpSelectionReadSet = {
    userEtag: user.etag,
    workspaceEtag: workspace?.etag ?? null,
    explicitDigest: hash(explicit),
    registryDigest: hash(registry),
    registryRevision: registry.revision,
    scopeDigest: hash(options.sourceIdentity),
  };
  const effective = resolveConfiguration({
    defaults: { mcp: [] },
    user: user.value,
    ...(workspace ? { workspace: workspace.value } : {}),
    explicit,
  });
  return { user, workspace, explicit, registry, readSet, effective };
}
/** Exact source/registry read-set is checked again under the target file lock at publication. */
export function updateMcpSelection(
  options: Parameters<typeof readMcpSelection>[0] & {
    scope: 'user' | 'workspace';
    serverId: string;
    enabled: boolean;
    expectedReadSet: McpSelectionReadSet;
  },
) {
  const observe = () => {
    options.validateSource?.();
    const state = readMcpSelection(options);
    if (mcpCanonical(state.readSet) !== mcpCanonical(options.expectedReadSet))
      throw new ConfigurationError('configuration_read_set_conflict');
    const server = state.registry.servers.find((server) => server.id === options.serverId);
    if (!server?.admitted) throw new ConfigurationError('mcp_server_not_admitted');
    return { state, server };
  };
  const { state, server } = observe();
  const has = (value: JsonObject) =>
    Array.isArray(value.mcp) &&
    value.mcp.some(
      (item) => !!item && typeof item === 'object' && !Array.isArray(item) && item.id === server.id,
    );
  if (
    has(state.explicit) ||
    (options.scope === 'user' && state.workspace && has(state.workspace.value))
  )
    throw new ConfigurationError('mcp_selection_overridden');
  const target = options.scope === 'user' ? state.user : state.workspace;
  if (!target) throw new ConfigurationError('workspace_missing');
  const values = target.value.mcp;
  const index = Array.isArray(values)
    ? values.findIndex(
        (item) =>
          !!item && typeof item === 'object' && !Array.isArray(item) && item.id === server.id,
      )
    : -1;
  const existing = index >= 0 ? (values as JsonObject[])[index] : undefined;
  if (
    options.enabled &&
    existing &&
    ((existing.configDigest !== undefined && existing.configDigest !== server.configDigest) ||
      (existing.definitionVersion !== undefined &&
        existing.definitionVersion !== server.configDigest))
  )
    throw new ConfigurationError('mcp_definition_version_unavailable');
  const edit: ConfigurationEdit =
    index >= 0
      ? { kind: 'set', path: ['mcp', index, 'enabled'], value: options.enabled }
      : Array.isArray(values)
        ? {
            kind: 'set',
            path: ['mcp', values.length],
            value: { id: server.id, enabled: options.enabled, configDigest: server.configDigest },
          }
        : {
            kind: 'set',
            path: ['mcp'],
            value: [{ id: server.id, enabled: options.enabled, configDigest: server.configDigest }],
          };
  return updateConfigurationFile({
    path: target.path,
    windowsPathPolicy: options.scope === 'user' ? 'private' : 'scope',
    ifMatch: target.etag,
    operations: [edit],
    validatePublication: () => {
      observe();
    },
  });
}
