import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acquireConfigFileMutationLocks,
  replaceConfigFileAtomically,
} from '@kite-ai/kite-local-runtime/config';
import { type ParseError, parse } from 'jsonc-parser';
import { mcpProjectApprovalPath } from './paths';

export type McpProjectSourceKind = 'project';
export type McpProjectDecision = 'approved' | 'rejected';

export interface McpProjectApprovalRecord {
  workspaceKey: string;
  serverName: string;
  sourceKind: McpProjectSourceKind;
  sourcePathDigest: string;
  configDigest: string;
  decision: McpProjectDecision;
  decidedAt: string;
}

interface McpProjectApprovalFile {
  version: 1;
  records: Record<string, McpProjectApprovalRecord>;
}

export type McpProjectApprovalStoreRead =
  | { status: 'ready'; records: Readonly<Record<string, McpProjectApprovalRecord>> }
  | { status: 'corrupt'; message: string }
  | { status: 'unavailable'; message: string };

export type McpProjectDecisionResult =
  | { status: 'recorded'; record: McpProjectApprovalRecord }
  | { status: 'config_changed' | 'store_corrupt' | 'store_unavailable'; message: string };

const APPROVAL_DIGEST_DOMAIN = 'kite-mcp-project-approval-v1\0';
const WORKSPACE_DIGEST_DOMAIN = 'kite-mcp-workspace-v1\0';
const PATH_DIGEST_DOMAIN = 'kite-mcp-source-path-v1\0';
const RECORD_DIGEST_DOMAIN = 'kite-mcp-approval-record-v1\0';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MCP config contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  throw new Error('MCP config contains a non-JSON value.');
}

function normalizePathIdentity(path: string): string {
  let normalized = path.replaceAll('\\', '/');
  if (/^[A-Z]:\//.test(normalized)) normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

export function canonicalWorkspaceKey(workspace: string): string {
  const absolute = resolve(workspace);
  const canonical = realpathSync.native(absolute);
  return sha256(WORKSPACE_DIGEST_DOMAIN + normalizePathIdentity(canonical));
}

export function sourcePathDigest(sourcePath: string): string {
  const absolute = resolve(sourcePath);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // A missing source must still have a deterministic identity for diagnostics.
  }
  return sha256(PATH_DIGEST_DOMAIN + normalizePathIdentity(canonical));
}

export function computeProjectMcpConfigDigest(input: {
  serverName: string;
  sourceKind: McpProjectSourceKind;
  rawConfig: Readonly<Record<string, unknown>>;
}): string {
  return sha256(
    APPROVAL_DIGEST_DOMAIN +
      canonicalize({
        serverName: input.serverName,
        sourceKind: input.sourceKind,
        config: input.rawConfig,
      }),
  );
}

export function projectApprovalRecordId(input: {
  workspaceKey: string;
  serverName: string;
  sourceKind: McpProjectSourceKind;
  sourcePathDigest: string;
}): string {
  return sha256(
    RECORD_DIGEST_DOMAIN +
      canonicalize({
        workspaceKey: input.workspaceKey,
        serverName: input.serverName,
        sourceKind: input.sourceKind,
        sourcePathDigest: input.sourcePathDigest,
      }),
  );
}

function isRecord(value: unknown): value is McpProjectApprovalRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspaceKey === 'string' &&
    typeof record.serverName === 'string' &&
    record.sourceKind === 'project' &&
    typeof record.sourcePathDigest === 'string' &&
    typeof record.configDigest === 'string' &&
    (record.decision === 'approved' || record.decision === 'rejected') &&
    typeof record.decidedAt === 'string'
  );
}

export function readProjectMcpApprovalStore(
  path = mcpProjectApprovalPath(),
): McpProjectApprovalStoreRead {
  if (!existsSync(path)) return { status: 'ready', records: {} };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { status: 'unavailable', message: 'Project MCP approval store is unreadable.' };
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors) as unknown;
  if (
    errors.length > 0 ||
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).version !== 1 ||
    !(parsed as Record<string, unknown>).records ||
    typeof (parsed as Record<string, unknown>).records !== 'object'
  ) {
    return { status: 'corrupt', message: 'Project MCP approval store is malformed.' };
  }
  const records = (parsed as { records: Record<string, unknown> }).records;
  if (
    Object.entries(records).some(
      ([id, record]) => !isRecord(record) || projectApprovalRecordId(record) !== id,
    )
  ) {
    return { status: 'corrupt', message: 'Project MCP approval store contains an invalid record.' };
  }
  return { status: 'ready', records: records as Record<string, McpProjectApprovalRecord> };
}

function writeStore(path: string, file: McpProjectApprovalFile): void {
  replaceConfigFileAtomically(path, `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

function readRawServer(sourcePath: string, serverName: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(sourcePath, 'utf8');
  } catch {
    return null;
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors) as unknown;
  if (errors.length > 0 || !parsed || typeof parsed !== 'object') return null;
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  const raw = (servers as Record<string, unknown>)[serverName];
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

export function decideProjectMcpServer(input: {
  workspace: string;
  serverName: string;
  sourceKind: McpProjectSourceKind;
  sourcePath: string;
  expectedConfigDigest: string;
  decision: McpProjectDecision;
  approvalPath?: string;
}): McpProjectDecisionResult {
  const path = input.approvalPath ?? mcpProjectApprovalPath();
  let workspaceKey: string;
  try {
    workspaceKey = canonicalWorkspaceKey(input.workspace);
  } catch {
    return { status: 'store_unavailable', message: 'Workspace identity is unavailable.' };
  }
  let lock: ReturnType<typeof acquireConfigFileMutationLocks> | undefined;
  try {
    lock = acquireConfigFileMutationLocks([input.sourcePath, path]);
    const currentRaw = readRawServer(input.sourcePath, input.serverName);
    if (!currentRaw) {
      return { status: 'config_changed', message: 'Project MCP configuration changed.' };
    }
    const currentDigest = computeProjectMcpConfigDigest({
      serverName: input.serverName,
      sourceKind: input.sourceKind,
      rawConfig: currentRaw,
    });
    if (currentDigest !== input.expectedConfigDigest) {
      return { status: 'config_changed', message: 'Project MCP configuration changed.' };
    }
    const store = readProjectMcpApprovalStore(path);
    if (store.status === 'corrupt') return { status: 'store_corrupt', message: store.message };
    if (store.status === 'unavailable') {
      return { status: 'store_unavailable', message: store.message };
    }
    const record: McpProjectApprovalRecord = {
      workspaceKey,
      serverName: input.serverName,
      sourceKind: input.sourceKind,
      sourcePathDigest: sourcePathDigest(input.sourcePath),
      configDigest: currentDigest,
      decision: input.decision,
      decidedAt: new Date().toISOString(),
    };
    const id = projectApprovalRecordId(record);
    writeStore(path, { version: 1, records: { ...store.records, [id]: record } });
    return { status: 'recorded', record };
  } catch {
    return {
      status: 'store_unavailable',
      message: 'Project MCP approval store could not be written.',
    };
  } finally {
    lock?.release();
  }
}
