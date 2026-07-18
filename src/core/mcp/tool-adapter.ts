// src/core/mcp/tool-adapter.ts

import { createHash } from 'node:crypto';

const MODEL_TOOL_NAME_MAX_LENGTH = 64;

/**
 * Produce a provider-neutral model tool name accepted by strict model APIs.
 * Safe legacy names remain unchanged; transformed names carry a stable digest
 * so normalization cannot make two remote tools collide.
 */
export function exposedMcpToolName(serverName: string, toolName: string): string {
  const raw = `mcp__${serverName}__${toolName}`;
  if (/^[a-zA-Z0-9_-]+$/.test(raw) && raw.length <= MODEL_TOOL_NAME_MAX_LENGTH) return raw;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const body = `${serverName}_${toolName}`
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const fixedPrefix = 'mcp__';
  const available = MODEL_TOOL_NAME_MAX_LENGTH - fixedPrefix.length - digest.length - 1;
  return `${fixedPrefix}${body.slice(0, Math.max(1, available))}_${digest}`;
}

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
