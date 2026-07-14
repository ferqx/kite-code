// src/core/mcp/tool-adapter.ts

/**
 * Parse MCP tool name into server name and tool name.
 * Format: mcp__<serverName>__<toolName>
 * Splits on the first two "__" after the "mcp" prefix, so tool names containing "__" are preserved.
 */
export function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5); // remove "mcp__"
  const sepIndex = rest.indexOf('__');
  if (sepIndex < 0) return null;
  return {
    serverName: rest.slice(0, sepIndex),
    toolName: rest.slice(sepIndex + 2),
  };
}
