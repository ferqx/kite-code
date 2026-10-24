import { AgentError } from '@kite-ai/agent';
import type { JsonObject } from '@kite-ai/agent/config';

/** User defaults only. An explicit MCP selection retains its original allowlist semantics. */
export function disabledUserMcpSources(user: JsonObject): readonly string[] {
  if (Object.hasOwn(user, 'mcp')) return [];
  const value = user.disabledUserMcpSources;
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 8192 ||
    value.some((id) => typeof id !== 'string' || !/^mcp-[a-f0-9]{64}$/.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new AgentError('mcp_configuration_unavailable');
  return value as string[];
}
