/** Pure-function MCP inventory projection from Capability + Provider Directory snapshots. */
import type { McpConfigSourceKind } from '@/core/config/mcp-config';
import type { CapabilitySnapshot } from '@/protocol/capabilities';
import type { McpDiagnosticCode } from './diagnostics';
import type { McpProviderDirectorySnapshot, McpProviderDirectoryStatus } from './runtime-provider';

export type McpInventoryNextAction =
  | 'approve_project_provider'
  | 'review_project_approval'
  | 'enable_provider'
  | 'authenticate'
  | 'wait_or_retry'
  | 'retry_connection'
  | 'retry_if_needed'
  | 'fix_configuration_or_schema';

export interface McpInventoryQuery {
  provider?: string;
  limit?: number;
  cursor?: string;
}

export interface McpInventoryProviderSummary {
  name: string;
  status: McpProviderDirectoryStatus;
  required: boolean;
  source: McpConfigSourceKind | 'explicit';
  available_tool_count: number;
  last_known_tool_count: number;
  next_action?: McpInventoryNextAction;
  diagnostic_code?: McpDiagnosticCode;
}

export interface McpInventoryToolSummary {
  provider: string;
  name: string;
}

export interface McpInventorySuccess {
  ok: true;
  configured_provider_count: number;
  callable_provider_count: number;
  available_tool_count: number;
  providers: McpInventoryProviderSummary[];
  tools: McpInventoryToolSummary[];
  truncated: boolean;
  next_cursor?: string;
}

export interface McpInventoryFailure {
  ok: false;
  code: 'invalid_cursor' | 'stale_cursor' | 'unknown_provider' | 'invalid_limit';
  message: string;
}

export type McpInventoryResult = McpInventorySuccess | McpInventoryFailure;

// ── cursor ──

interface McpInventoryCursor {
  catalogRevision: string;
  providerDirectoryRevision: string;
  offset: number;
  provider?: string;
}

function encodeCursor(data: McpInventoryCursor): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeCursor(raw: string): McpInventoryCursor | null {
  try {
    if (raw.length > 2048) return null;
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed.catalogRevision !== 'string' ||
      typeof parsed.providerDirectoryRevision !== 'string' ||
      typeof parsed.offset !== 'number' ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      (parsed.provider !== undefined && typeof parsed.provider !== 'string')
    ) {
      return null;
    }
    const allowed = new Set(['catalogRevision', 'providerDirectoryRevision', 'offset', 'provider']);
    if (Object.keys(parsed).some((key) => !allowed.has(key))) return null;
    return parsed as McpInventoryCursor;
  } catch {
    return null;
  }
}

// ── status → next_action mapping ──

export function nextActionForProvider(
  status: McpProviderDirectoryStatus,
): McpInventoryNextAction | undefined {
  switch (status) {
    case 'pending_approval':
      return 'approve_project_provider';
    case 'rejected':
      return 'review_project_approval';
    case 'disabled':
      return 'enable_provider';
    case 'login_required':
      return 'authenticate';
    case 'connecting':
      return 'wait_or_retry';
    case 'failed':
      return 'retry_connection';
    case 'degraded':
      return 'retry_if_needed';
    case 'quarantined':
      return 'fix_configuration_or_schema';
    default:
      return undefined;
  }
}

// ── callable check ──

function isCallable(status: McpProviderDirectoryStatus): boolean {
  return status === 'ready' || status === 'degraded';
}

// ── main builder ──

export function buildMcpInventory(input: {
  capabilities: CapabilitySnapshot;
  providers: McpProviderDirectorySnapshot;
  query: McpInventoryQuery;
}): McpInventoryResult {
  const { capabilities, providers, query } = input;
  const DEFAULT_LIMIT = 50;
  const limit = Math.max(1, Math.min(100, query.limit ?? DEFAULT_LIMIT));

  // validate limit
  if (query.limit != null && (query.limit < 1 || query.limit > 100)) {
    return { ok: false, code: 'invalid_limit', message: 'limit must be between 1 and 100.' };
  }

  // resolve cursor
  let offset = 0;
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) {
      return { ok: false, code: 'invalid_cursor', message: 'Invalid cursor.' };
    }
    if (
      cursor.catalogRevision !== capabilities.revision ||
      cursor.providerDirectoryRevision !== providers.revision ||
      (cursor.provider ?? undefined) !== (query.provider ?? undefined)
    ) {
      return {
        ok: false,
        code: 'stale_cursor',
        message: 'The MCP inventory changed. Restart listing without a cursor.',
      };
    }
    offset = cursor.offset;
  }

  // collect provider ids
  const providerSet = new Set(providers.entries.map((e) => e.providerId));
  const capabilityProviderIds = new Set(
    capabilities.descriptors
      .filter((d) => d.kind === 'mcp_tool' && d.availability === 'available')
      .map((d) => d.provider.id),
  );
  const allProviderIds = new Set([...providerSet, ...capabilityProviderIds]);

  // validate provider filter
  if (query.provider && !allProviderIds.has(query.provider)) {
    return {
      ok: false,
      code: 'unknown_provider',
      message: `Unknown provider: ${query.provider}`,
    };
  }

  // build provider summaries — Provider Directory is the primary source
  const providerMap = new Map<string, McpInventoryProviderSummary>();

  for (const entry of providers.entries) {
    if (query.provider && entry.providerId !== query.provider) continue;
    const toolCount = capabilities.descriptors.filter(
      (d) =>
        d.kind === 'mcp_tool' &&
        d.availability === 'available' &&
        d.provider.id === entry.providerId,
    ).length;
    providerMap.set(entry.providerId, {
      name: entry.providerId,
      status: entry.status,
      required: entry.required,
      source: entry.source,
      available_tool_count: toolCount,
      last_known_tool_count: entry.lastKnownCapabilityNames.length,
      next_action: nextActionForProvider(entry.status),
      ...(entry.diagnosticCode ? { diagnostic_code: entry.diagnosticCode } : {}),
    });
  }

  // defensive backfill from Capability Snapshot
  for (const capId of capabilityProviderIds) {
    if (!providerMap.has(capId)) {
      if (query.provider && capId !== query.provider) continue;
      const toolCount = capabilities.descriptors.filter(
        (d) => d.kind === 'mcp_tool' && d.availability === 'available' && d.provider.id === capId,
      ).length;
      // CapabilitySnapshot has no source field, mark as 'explicit'
      providerMap.set(capId, {
        name: capId,
        status: 'ready',
        required: false,
        source: 'explicit' as McpConfigSourceKind,
        available_tool_count: toolCount,
        last_known_tool_count: toolCount,
      });
    }
  }

  // build tool summaries — de-duplicate, stable sort
  const seen = new Set<string>();
  const allTools: McpInventoryToolSummary[] = [];
  for (const d of capabilities.descriptors) {
    if (d.kind !== 'mcp_tool' || d.availability !== 'available') continue;
    if (query.provider && d.provider.id !== query.provider) continue;
    const key = `${d.provider.id}::${d.displayName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allTools.push({ provider: d.provider.id, name: d.displayName });
  }
  allTools.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

  // stable-sort providers
  const providerList = [...providerMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  // paginate tools
  const sliced = allTools.slice(offset, offset + limit);
  const truncated = offset + limit < allTools.length;
  const nextCursor = truncated
    ? encodeCursor({
        catalogRevision: capabilities.revision,
        providerDirectoryRevision: providers.revision,
        offset: offset + limit,
        provider: query.provider,
      })
    : undefined;

  const callable = providerList.filter((p) => isCallable(p.status));

  return {
    ok: true,
    configured_provider_count: providerList.length,
    callable_provider_count: callable.length,
    available_tool_count: allTools.length,
    providers: providerList,
    tools: sliced,
    truncated,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}
