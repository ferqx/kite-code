import type { Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import { UNKNOWN_EXTERNAL_EFFECTS } from '@/core/capabilities/catalog';
import type {
  CapabilityApproval,
  CapabilityDescriptor,
  EffectProfile,
} from '@/protocol/capabilities';
import type { McpServerConfig, McpToolRetryPolicy } from './types';

export interface ResolvedMcpToolPolicy {
  enabled: boolean;
  declaredEffects: EffectProfile;
  effectiveEffects: EffectProfile;
  annotationProvenance: CapabilityDescriptor['provider']['provenance'];
  minimumApproval: CapabilityApproval;
  retry: McpToolRetryPolicy;
  idempotencyKeyArgument?: string;
}

/** Resolve allowlist -> denylist -> exact override precedence for one discovered Tool. */
export function isMcpToolEnabled(config: McpServerConfig, toolName: string): boolean {
  let enabled = config.enabledTools ? config.enabledTools.includes(toolName) : true;
  if (config.disabledTools?.includes(toolName)) enabled = false;
  const exactOverride = config.tools?.[toolName]?.enabled;
  if (exactOverride !== undefined) enabled = exactOverride;
  return enabled;
}

/** Names mentioned only by policy remain diagnosable even when discovery does not return them. */
export function configuredMcpToolNames(config: McpServerConfig): string[] {
  return [
    ...new Set([
      ...(config.enabledTools ?? []),
      ...(config.disabledTools ?? []),
      ...Object.keys(config.tools ?? {}),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

export function hasConfiguredMcpToolPolicy(config: McpServerConfig, toolName: string): boolean {
  return (
    config.enabledTools !== undefined ||
    config.disabledTools?.includes(toolName) === true ||
    config.tools?.[toolName] !== undefined
  );
}

export function resolveMcpToolPolicy(
  config: McpServerConfig,
  tool: Pick<SdkTool, 'name' | 'annotations'>,
): ResolvedMcpToolPolicy {
  const override = config.tools?.[tool.name];
  const declaredEffects = declaredEffectsFromAnnotations(tool.annotations);
  const effectiveEffects: EffectProfile = {
    ...trustedAnnotationEffects(config, tool.annotations),
    ...override?.effects,
  };
  const requestedRetry = override?.retry ?? 'never';
  const retry =
    requestedRetry === 'safe_read' && !isReadOnlyEffects(effectiveEffects)
      ? 'never'
      : requestedRetry === 'idempotency_key' && !override?.idempotencyKeyArgument
        ? 'never'
        : requestedRetry;
  return {
    enabled: isMcpToolEnabled(config, tool.name),
    declaredEffects,
    effectiveEffects,
    annotationProvenance: trustedProvenance(config),
    minimumApproval: override?.minimumApproval ?? 'user',
    retry,
    ...(retry === 'idempotency_key' && override?.idempotencyKeyArgument
      ? { idempotencyKeyArgument: override.idempotencyKeyArgument }
      : {}),
  };
}

function declaredEffectsFromAnnotations(annotations: SdkTool['annotations']): EffectProfile {
  if (!annotations) return UNKNOWN_EXTERNAL_EFFECTS;
  if (annotations.destructiveHint) {
    return {
      filesystem: 'unknown',
      network: 'unknown',
      externalState: 'destructive',
    };
  }
  if (annotations.readOnlyHint) {
    return { filesystem: 'read', network: 'read', externalState: 'read' };
  }
  if (annotations.readOnlyHint === false) {
    return { filesystem: 'unknown', network: 'unknown', externalState: 'write' };
  }
  return UNKNOWN_EXTERNAL_EFFECTS;
}

function trustedAnnotationEffects(
  config: McpServerConfig,
  annotations: SdkTool['annotations'],
): EffectProfile {
  if (!allowsReadOnlyAnnotations(config) || !annotations?.readOnlyHint) {
    return UNKNOWN_EXTERNAL_EFFECTS;
  }
  return { filesystem: 'read', network: 'read', externalState: 'read' };
}

function allowsReadOnlyAnnotations(config: McpServerConfig): boolean {
  return (
    config.trust === 'trusted' ||
    (typeof config.trust === 'object' && config.trust.allowAnnotations === 'read_only')
  );
}

function trustedProvenance(
  config: McpServerConfig,
): CapabilityDescriptor['provider']['provenance'] {
  return typeof config.trust === 'object' ? config.trust.provenance : 'remote';
}

function isReadOnlyEffects(effects: EffectProfile): boolean {
  return [effects.filesystem, effects.network, effects.externalState].every(
    (effect) => effect === 'none' || effect === 'read',
  );
}
