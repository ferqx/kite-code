import type { Json, ToolDefinition } from '../extensions';

export const mcpToolsSearchId = 'mcp.tools.search';
export const mcpToolsSearchExtensionId = 'builtin.mcp.discovery';
export interface McpSearchSource {
  readonly names?: ReadonlyMap<string, string>;
  readonly serverId: string;
  readonly label: string;
  readonly tools: readonly ToolDefinition[];
  /** Checks the exact captured local publication; never connects or issues a remote RPC. */
  assertFresh(): Promise<void>;
}
/** One Model step's real selected, published catalogue; names and IDs are never reconstructed. */
export function createMcpToolsSearchTool(
  storeId: string,
  sessionId: string,
  sources: readonly McpSearchSource[],
  runId?: string,
): ToolDefinition {
  return {
    id: mcpToolsSearchId,
    version: '1',
    description:
      'Search this step’s actual selected MCP tool catalogue. Returns exact registered IDs, versions and schemas without connecting or invoking tools.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    async execute(input, context) {
      const request = input as { query: string; limit?: number };
      const own = await context.getExecution(context.executionId);
      if (
        own?.kind !== 'tool' ||
        own.originStoreId !== storeId ||
        own.sessionId !== sessionId ||
        (runId !== undefined && (context.runId !== runId || own.runId !== runId)) ||
        context.sessionId !== sessionId ||
        own.definitionVersion !== '1' ||
        typeof own.definitionId !== 'string' ||
        ![mcpToolsSearchId, `${mcpToolsSearchExtensionId}/${mcpToolsSearchId}`].includes(
          own.definitionId,
        )
      )
        return { outcome: 'failed', content: 'mcp_search_scope_unverifiable' };
      const words = request.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean);
      const items: Json[] = [];
      for (const source of sources) {
        context.signal.throwIfAborted();
        try {
          await source.assertFresh();
        } catch {
          continue;
        }
        for (const tool of source.tools) {
          if (
            !words.every((word) =>
              `${source.label} ${tool.description}`.toLocaleLowerCase('en-US').includes(word),
            )
          )
            continue;
          const row = {
            serverId: source.serverId,
            serverName: source.label,
            definitionId: tool.id,
            definitionVersion: tool.version,
            ...(source.names?.has(tool.id) ? { remoteName: source.names.get(tool.id)! } : {}),
            description: tool.description,
            inputSchema: structuredClone(tool.inputSchema),
          };
          if (Buffer.byteLength(JSON.stringify([...items, row])) > 256 * 1024) continue;
          items.push(row as Json);
          if (items.length >= (request.limit ?? 10)) break;
        }
        if (items.length >= (request.limit ?? 10)) break;
      }
      const details = { source: 'frozen_selected_mcp_catalogue', items };
      return { outcome: 'succeeded', content: JSON.stringify(details), details };
    },
  };
}
