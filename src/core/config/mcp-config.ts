import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ParseError, parse } from 'jsonc-parser';
import type { McpServerConfig } from '../mcp/types';
import {
  canonicalWorkspaceKey,
  computeProjectMcpConfigDigest,
  type McpProjectSourceKind,
  projectApprovalRecordId,
  readProjectMcpApprovalStore,
  sourcePathDigest,
} from './mcp-project-approvals';
import { mcpServerSchema, normalizeMcpServerConfig } from './mcp-server-config';
import { defaultConfigPath, projectConfigPath } from './paths';

export type McpConfigSourceKind = 'user' | McpProjectSourceKind | 'explicit';
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
  approvalStatus: McpConfigApprovalStatus;
  diagnostics: readonly McpConfigDiagnostic[];
  effective: boolean;
  shadowedBy?: McpConfigSourceKind;
}

/** Redacted control-plane projection safe for a frontend. */
export interface McpProjectServerApprovalView {
  name: string;
  sourceKind: McpProjectSourceKind;
  sourcePath: string;
  transport: 'stdio' | 'http';
  configDigest: string;
  status: Exclude<McpConfigApprovalStatus, 'not_required'>;
  review: Readonly<{
    command?: string;
    argumentCount?: number;
    endpoint?: string;
  }>;
  diagnostics: readonly string[];
}

export interface McpConfigCatalog {
  entries: readonly McpServerConfigEntry[];
  effective: ReadonlyMap<string, McpServerConfigEntry>;
  connectableServers: Readonly<Record<string, McpServerConfig>>;
  projectApprovals: readonly McpProjectServerApprovalView[];
  diagnostics: readonly McpConfigDiagnostic[];
  workspace: string;
}

export interface McpConfig {
  /** Compatibility connection projection. Project entries appear only after local approval. */
  servers: Record<string, McpServerConfig>;
  catalog: McpConfigCatalog;
}

interface SourceSpec {
  kind: McpConfigSourceKind;
  path: string;
  priority: number;
}

function readSource(
  spec: SourceSpec,
  workspace: string,
): { entries: McpServerConfigEntry[]; diagnostics: McpConfigDiagnostic[] } {
  if (!existsSync(spec.path)) return { entries: [], diagnostics: [] };
  let text: string;
  try {
    text = readFileSync(spec.path, 'utf8');
  } catch {
    return {
      entries: [],
      diagnostics: [
        {
          code: 'file_invalid',
          message: 'MCP configuration file is unreadable.',
          sourcePath: spec.path,
        },
      ],
    };
  }
  const parseErrors: ParseError[] = [];
  const parsed = parse(text, parseErrors) as unknown;
  if (parseErrors.length > 0 || !parsed || typeof parsed !== 'object') {
    return {
      entries: [],
      diagnostics: [
        {
          code: 'file_invalid',
          message: 'MCP configuration file is malformed.',
          sourcePath: spec.path,
        },
      ],
    };
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === undefined) return { entries: [], diagnostics: [] };
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return {
      entries: [],
      diagnostics: [
        {
          code: 'file_invalid',
          message: 'mcpServers must be an object.',
          sourcePath: spec.path,
        },
      ],
    };
  }

  const entries: McpServerConfigEntry[] = [];
  const diagnostics: McpConfigDiagnostic[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const entryDiagnostics: McpConfigDiagnostic[] = [];
    let normalizedConfig: McpServerConfig | undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      entryDiagnostics.push({
        code: 'server_invalid',
        message: 'MCP server declaration must be an object.',
        sourcePath: spec.path,
        serverName: name,
      });
    } else {
      const validation = mcpServerSchema.safeParse(value);
      if (!validation.success) {
        entryDiagnostics.push({
          code: 'server_invalid',
          message: 'MCP server declaration has invalid fields.',
          sourcePath: spec.path,
          serverName: name,
        });
      } else {
        normalizedConfig = normalizeMcpServerConfig(value as Record<string, unknown>);
        if (
          (normalizedConfig.type === 'stdio' && !normalizedConfig.command) ||
          (normalizedConfig.type === 'http' && !normalizedConfig.url)
        ) {
          normalizedConfig = undefined;
          entryDiagnostics.push({
            code: 'server_invalid',
            message:
              validation.data.type === 'http'
                ? 'HTTP MCP server requires a URL.'
                : 'Stdio MCP server requires a command.',
            sourcePath: spec.path,
            serverName: name,
          });
        }
      }
    }
    diagnostics.push(...entryDiagnostics);
    const rawConfig =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const configDigest =
      spec.kind === 'project_kite_code' || spec.kind === 'project_mcp_json'
        ? computeProjectMcpConfigDigest({
            serverName: name,
            sourceKind: spec.kind,
            rawConfig,
          })
        : undefined;
    entries.push({
      name,
      source: { kind: spec.kind, path: spec.path, workspace },
      rawConfig,
      normalizedConfig,
      configDigest,
      approvalStatus: normalizedConfig ? 'not_required' : 'invalid',
      diagnostics: entryDiagnostics,
      effective: false,
    });
  }
  return { entries, diagnostics };
}

function isProjectEntry(entry: McpServerConfigEntry): entry is McpServerConfigEntry & {
  source: McpConfigSource & { kind: McpProjectSourceKind };
  configDigest: string;
} {
  return (
    (entry.source.kind === 'project_kite_code' || entry.source.kind === 'project_mcp_json') &&
    typeof entry.configDigest === 'string'
  );
}

function conservativeProjectConfig(config: McpServerConfig): McpServerConfig {
  return { ...config, trust: 'untrusted', tools: undefined };
}

function approvalReview(
  rawConfig: Readonly<Record<string, unknown>>,
): McpProjectServerApprovalView['review'] {
  if (rawConfig.type !== 'http') {
    return {
      ...(typeof rawConfig.command === 'string' ? { command: rawConfig.command } : {}),
      argumentCount: Array.isArray(rawConfig.args) ? rawConfig.args.length : 0,
    };
  }
  if (typeof rawConfig.url !== 'string') return {};
  try {
    const endpoint = new URL(rawConfig.url);
    return { endpoint: endpoint.origin };
  } catch {
    return {};
  }
}

/**
 * Load a provenance-preserving MCP catalog. Existing precedence remains:
 * project .kite-code > user kite-code > project .mcp.json.
 */
export function loadMcpConfigCatalog(
  options: { workspace?: string; configPath?: string } = {},
): McpConfigCatalog {
  const workspace = resolve(options.workspace ?? process.cwd());
  const specs: SourceSpec[] = options.configPath
    ? [{ kind: 'explicit', path: resolve(options.configPath), priority: 100 }]
    : [
        { kind: 'project_mcp_json', path: resolve(workspace, '.mcp.json'), priority: 10 },
        { kind: 'user', path: defaultConfigPath(), priority: 20 },
        { kind: 'project_kite_code', path: projectConfigPath(workspace), priority: 30 },
      ];

  const priority = new Map(specs.map((spec) => [spec.kind, spec.priority]));
  const entries: McpServerConfigEntry[] = [];
  const diagnostics: McpConfigDiagnostic[] = [];
  for (const spec of specs) {
    const loaded = readSource(spec, workspace);
    entries.push(...loaded.entries);
    diagnostics.push(...loaded.diagnostics);
  }

  const winners = new Map<string, McpServerConfigEntry>();
  for (const entry of entries) {
    const current = winners.get(entry.name);
    if (!current || priority.get(entry.source.kind)! > priority.get(current.source.kind)!) {
      winners.set(entry.name, entry);
    }
  }
  for (const entry of entries) {
    const winner = winners.get(entry.name)!;
    entry.effective = entry === winner;
    if (!entry.effective) entry.shadowedBy = winner.source.kind;
  }

  const store = readProjectMcpApprovalStore();
  let workspaceKey: string | undefined;
  try {
    workspaceKey = canonicalWorkspaceKey(workspace);
  } catch {
    diagnostics.push({
      code: 'workspace_unavailable',
      message: 'Workspace identity is unavailable; project MCP servers are blocked.',
      sourcePath: workspace,
    });
  }

  const connectableServers: Record<string, McpServerConfig> = {};
  const projectApprovals: McpProjectServerApprovalView[] = [];
  for (const entry of winners.values()) {
    if (!entry.normalizedConfig) {
      entry.approvalStatus = 'invalid';
    } else if (!isProjectEntry(entry)) {
      entry.approvalStatus = 'not_required';
      connectableServers[entry.name] = entry.normalizedConfig;
    } else if (!workspaceKey) {
      entry.approvalStatus = 'store_unavailable';
    } else if (store.status === 'corrupt') {
      entry.approvalStatus = 'store_corrupt';
    } else if (store.status === 'unavailable') {
      entry.approvalStatus = 'store_unavailable';
    } else {
      const pathDigest = sourcePathDigest(entry.source.path);
      const id = projectApprovalRecordId({
        workspaceKey,
        serverName: entry.name,
        sourceKind: entry.source.kind,
        sourcePathDigest: pathDigest,
      });
      const record = store.records[id];
      if (!record || record.configDigest !== entry.configDigest) {
        entry.approvalStatus = 'pending_approval';
      } else {
        entry.approvalStatus = record.decision;
        if (record.decision === 'approved') {
          connectableServers[entry.name] = conservativeProjectConfig(entry.normalizedConfig);
        }
      }
    }
    if (isProjectEntry(entry)) {
      projectApprovals.push({
        name: entry.name,
        sourceKind: entry.source.kind,
        sourcePath: entry.source.path,
        transport: entry.normalizedConfig?.type ?? 'stdio',
        configDigest: entry.configDigest,
        status: entry.approvalStatus === 'not_required' ? 'pending_approval' : entry.approvalStatus,
        review: approvalReview(entry.rawConfig),
        diagnostics: entry.diagnostics.map((diagnostic) => diagnostic.message),
      });
    }
  }

  return {
    entries,
    effective: winners,
    connectableServers,
    projectApprovals,
    diagnostics,
    workspace,
  };
}

export function loadMcpConfig(configPath?: string, workspace?: string): McpConfig {
  const catalog = loadMcpConfigCatalog({ configPath, workspace });
  return { servers: { ...catalog.connectableServers }, catalog };
}
