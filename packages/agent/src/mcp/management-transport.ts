import type { McpTransportConfiguration } from './index';
import type { McpLifecycleTransportPort } from './lifecycle';

export type McpSessionTransportBinding = Parameters<McpLifecycleTransportPort['open']>[0];
/** A local user's original durable settings operation, never an Agent Execution. */
export interface McpUserTransportBinding {
  readonly owner: 'user';
  readonly originalStoreId: string;
  readonly subjectId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly serverId: string;
  readonly scopeId: string;
  readonly configDigest: string;
  readonly configuration: McpTransportConfiguration;
}
export type McpHostTransportBinding = McpSessionTransportBinding | McpUserTransportBinding;
export interface McpHostTransportPort<
  B extends McpHostTransportBinding = McpSessionTransportBinding,
> {
  open(binding: B, options: { signal: AbortSignal }): ReturnType<McpLifecycleTransportPort['open']>;
}
export function isUserMcpTransportBinding(
  value: McpHostTransportBinding,
): value is McpUserTransportBinding {
  return 'owner' in value && value.owner === 'user';
}
/** Disjoint closed owners: adding user fields can never upgrade a Session Job. */
export function validMcpTransportOwner(binding: McpHostTransportBinding): boolean {
  if (isUserMcpTransportBinding(binding))
    return (
      Object.keys(binding).sort().join(',') ===
        'commandId,configDigest,configuration,originalStoreId,owner,requestDigest,scopeId,serverId,subjectId' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(binding.commandId) &&
      !!binding.subjectId &&
      binding.subjectId.length <= 256 &&
      !!binding.originalStoreId &&
      /^[a-f0-9]{64}$/.test(binding.requestDigest) &&
      binding.scopeId ===
        JSON.stringify(['user', binding.originalStoreId, binding.subjectId, binding.serverId])
    );
  return (
    Object.keys(binding).sort().join(',') ===
      'configDigest,configuration,executionId,originalStoreId,scopeId,serverId,sessionId' &&
    !!binding.originalStoreId &&
    !!binding.sessionId &&
    !!binding.executionId &&
    binding.scopeId ===
      JSON.stringify([binding.originalStoreId, binding.sessionId, binding.serverId])
  );
}
export function mcpTransportEvidenceBinding(binding: McpHostTransportBinding) {
  const common = {
    originalStoreId: binding.originalStoreId,
    serverId: binding.serverId,
    scopeId: binding.scopeId,
    configDigest: binding.configDigest,
  };
  return isUserMcpTransportBinding(binding)
    ? {
        ...common,
        owner: 'user' as const,
        subjectId: binding.subjectId,
        commandId: binding.commandId,
        requestDigest: binding.requestDigest,
      }
    : { ...common, sessionId: binding.sessionId, executionId: binding.executionId };
}
/** Global settings can initialize and inspect catalogue metadata, never execute a Tool/Task. */
export function userMcpMessageAllowed(binding: McpHostTransportBinding, value: unknown): boolean {
  if (!isUserMcpTransportBinding(binding)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.method !== 'string' ||
    [
      'initialize',
      'notifications/initialized',
      'tools/list',
      'ping',
      'notifications/cancelled',
    ].includes(message.method)
  );
}
export type McpTransportEvidenceBinding = ReturnType<typeof mcpTransportEvidenceBinding>;
export function sameMcpTransportEvidenceBinding(
  value: unknown,
  binding: McpTransportEvidenceBinding,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const fields =
    'owner' in binding && binding.owner === 'user'
      ? 'commandId,configDigest,originalStoreId,owner,requestDigest,scopeId,serverId,subjectId'
      : 'configDigest,executionId,originalStoreId,scopeId,serverId,sessionId';
  // The expected host object may be the full open binding (including configuration).
  // The evidence itself remains closed; only its original identity fields are compared.
  if (Object.keys(row).sort().join(',') !== fields) return false;
  return Object.entries(row).every(
    ([key, entry]) =>
      typeof entry === 'string' &&
      !!entry &&
      entry.length <= 8192 &&
      entry === binding[key as keyof typeof binding],
  );
}
