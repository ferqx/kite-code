import { createHash } from 'node:crypto';
import type { ContextSource } from '../context';
import type { Json } from '../storage';

export const mcpResourceModelToolIds = ['mcp.resources.list', 'mcp.resources.read'] as const;

/** Trusted current Run capture supplies only finite identity facts, never remote permissions. */
export function createMcpResourceModelSource(input: {
  readonly storeId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly facts: Json;
}): ContextSource | null {
  const connections: Json[] = [];
  for (const value of Array.isArray(input.facts) ? input.facts : []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (
      value.originalStoreId !== input.storeId ||
      value.sessionId !== input.sessionId ||
      value.runId !== input.runId ||
      typeof value.serverId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.serverId) ||
      typeof value.connectionKey !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.connectionKey) ||
      typeof value.connectionExecutionId !== 'string' ||
      !value.connectionExecutionId ||
      typeof value.configDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.configDigest) ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1
    )
      continue;
    connections.push({
      originalStoreId: input.storeId,
      sessionId: input.sessionId,
      runId: input.runId,
      serverId: value.serverId,
      ...(typeof value.serverName === 'string' && value.serverName.length <= 256
        ? { serverName: value.serverName }
        : {}),
      connectionKey: value.connectionKey,
      connectionExecutionId: value.connectionExecutionId,
      configDigest: value.configDigest,
      generation: value.generation,
    });
  }
  if (!connections.length) return null;
  const content = JSON.stringify({
    source: 'mcp_selected_connection_refs',
    trustedAsAuthority: false,
    connections,
    tools: {
      list: {
        definitionId: 'mcp.resources.list',
        definitionVersion: '1',
        bindingInput: ['serverId', 'connectionKey', 'configDigest', 'generation'],
      },
      read: {
        definitionId: 'mcp.resources.read',
        definitionVersion: '1',
        bindingInput: ['serverId', 'connectionKey', 'configDigest', 'generation'],
        targetInput: ['uri', 'catalogueExecutionId', 'descriptorDigest'],
        catalogueExecutionIdSource: 'list result binding.executionId',
        descriptorDigestSource: 'list result descriptors[].descriptorDigest',
      },
    },
  });
  return {
    id: `mcp.resource-connections/${input.runId}`,
    kind: 'mcp-selected-resource-connections',
    scope: `${input.storeId}/${input.sessionId}/${input.runId}`,
    digest: createHash('sha256').update(content).digest('hex'),
    content,
    role: 'user',
  };
}
