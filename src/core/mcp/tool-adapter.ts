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
