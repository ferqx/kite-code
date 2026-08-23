import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { McpServerConfig } from '@kite/builtin-runtime/mcp';
import { type ParseError, parse } from 'jsonc-parser';
import {
  canonicalWorkspaceKey,
  computeProjectMcpConfigDigest,
  type McpProjectSourceKind,
  projectApprovalRecordId,
  readProjectMcpApprovalStore,
  sourcePathDigest,
} from './mcp-project-approvals';
import { mcpServerSchema, normalizeMcpServerConfig } from './mcp-server-config';
import { projectMcpConfigPath, userMcpConfigPath } from './paths';

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
  sourceRevisions: Readonly<Record<McpWritableScope, string>>;
}

interface SourceSpec {
  kind: McpConfigSourceKind;
  path: string;
  priority: number;
}

const CONFIG_REVISION_DOMAIN = 'kite-mcp-config-revision-v1\0';

function revision(value: unknown): string {
  return createHash('sha256')
    .update(CONFIG_REVISION_DOMAIN)
    .update(stableJson(value))
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceTextRevision(path: string): string {
  try {
    return revision(readFileSync(path, 'utf8'));
  } catch {
    return revision('missing');
  }
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
  const fileRevision = revision(text);
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
      spec.kind === 'project'
        ? computeProjectMcpConfigDigest({
            serverName: name,
            sourceKind: spec.kind,
            rawConfig,
          })
        : undefined;
    const providerConfigDigest = revision({
      source: spec.kind,
      sourcePath: resolve(spec.path),
      name,
      rawConfig,
    });
    if (normalizedConfig) normalizedConfig.providerVersion = providerConfigDigest;
    entries.push({
      name,
      source: { kind: spec.kind, path: spec.path, workspace },
      rawConfig,
      normalizedConfig,
      configDigest,
      revision: revision({ fileRevision, source: spec.kind, name, rawConfig }),
      providerConfigDigest,
      enabled: normalizedConfig?.enabled !== false,
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
  return entry.source.kind === 'project' && typeof entry.configDigest === 'string';
}

function conservativeProjectConfig(config: McpServerConfig): McpServerConfig {
  const tools = Object.fromEntries(
    Object.entries(config.tools ?? {}).flatMap(([name, policy]) => {
      const restrictivePolicy = {
        ...(policy.enabled === false ? { enabled: false } : {}),
        ...(policy.minimumApproval === 'user' ? { minimumApproval: 'user' as const } : {}),
        ...(policy.retry === 'never' ? { retry: 'never' as const } : {}),
      };
      return Object.keys(restrictivePolicy).length > 0 ? [[name, restrictivePolicy]] : [];
    }),
  );
  return {
    ...config,
    trust: 'untrusted',
    modelDescriptionTrust: 'trusted_remote',
    modelDescriptionProvenance: 'approved_project',
    ...(config.enabledTools ? { enabledTools: [...config.enabledTools] } : {}),
    ...(config.disabledTools ? { disabledTools: [...config.disabledTools] } : {}),
    tools: Object.keys(tools).length > 0 ? tools : undefined,
  };
}

function admittedUserDescriptionConfig(config: McpServerConfig): McpServerConfig {
  return {
    ...config,
    modelDescriptionTrust: 'trusted_remote',
    modelDescriptionProvenance: 'user_config',
  };
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
 * Load a provenance-preserving MCP catalog. Precedence is:
 * Current sources: project .kite-code/mcp.json > user ~/.kite-code/mcp.json.
 */
export function loadMcpConfigCatalog(
  options: { workspace?: string; configPath?: string } = {},
): McpConfigCatalog {
  const workspace = resolve(options.workspace ?? process.cwd());
  let workspaceKey: string | undefined;
  try {
    workspaceKey = canonicalWorkspaceKey(workspace);
  } catch {
    // Reported below; project sources remain visible but fail closed.
  }
  const specs: SourceSpec[] = options.configPath
    ? [{ kind: 'explicit', path: resolve(options.configPath), priority: 100 }]
    : [
        { kind: 'user', path: userMcpConfigPath(), priority: 10 },
        { kind: 'project', path: projectMcpConfigPath(workspace), priority: 20 },
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
  if (!workspaceKey) {
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
      if (entry.enabled) {
        connectableServers[entry.name] = admittedUserDescriptionConfig(entry.normalizedConfig);
      }
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
      const record =
        store.records[id]?.configDigest === entry.configDigest ? store.records[id] : undefined;
      if (!record) {
        entry.approvalStatus = 'pending_approval';
      } else {
        entry.approvalStatus = record.decision;
        if (record.decision === 'approved' && entry.enabled) {
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
    sourceRevisions: Object.freeze({
      project: sourceTextRevision(projectMcpConfigPath(workspace)),
      user: sourceTextRevision(userMcpConfigPath()),
    }),
  };
}
