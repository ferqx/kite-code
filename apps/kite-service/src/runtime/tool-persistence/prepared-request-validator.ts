import type {
  CapabilityEffects,
  RuntimeJsonValue,
  ToolPipelineReceiptRequirement,
  ToolPipelineRetryEligibility,
} from '@kite-ai/runtime-spi';
import type { AppToolPipelinePreparedRequest } from '#kite-service/bootstrap/runtime/tool-pipeline-prepared';

export function isPreparedRequest(
  value: RuntimeJsonValue | undefined,
): value is AppToolPipelinePreparedRequest & RuntimeJsonValue {
  if (!isJsonRecord(value)) return false;
  const expectedKeys = [
    'schema',
    'authorizationKind',
    'grantUsed',
    'interactionMode',
    'sandboxScope',
    'policyEffects',
    'effectiveEffects',
    'receiptRequirement',
    'retryEligibility',
    'taskId',
    'planId',
    'planStepId',
    'capabilityRequestFacts',
  ];
  return (
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key)) &&
    value.schema === 'kite.tool-pipeline-prepared-request.v1' &&
    (value.authorizationKind === 'policy_allow' || value.authorizationKind === 'approved_call') &&
    (value.grantUsed === 'none' ||
      value.grantUsed === 'approve_once' ||
      value.grantUsed === 'same_command') &&
    (value.interactionMode === 'auto' ||
      value.interactionMode === 'accept_edits' ||
      value.interactionMode === 'full') &&
    isSandboxScope(value.sandboxScope) &&
    isPolicyEffects(value.policyEffects) &&
    isCapabilityEffects(value.effectiveEffects) &&
    isReceiptRequirement(value.receiptRequirement) &&
    isRetryEligibility(value.retryEligibility) &&
    nullableString(value.taskId) &&
    nullableString(value.planId) &&
    nullableString(value.planStepId) &&
    (value.capabilityRequestFacts === null || isRuntimeJson(value.capabilityRequestFacts))
  );
}

function isSandboxScope(value: RuntimeJsonValue | undefined): boolean {
  if (value === null) return true;
  if (!isJsonRecord(value) || Object.keys(value).length !== 4) return false;
  return (
    (value.kind === 'baseline' || value.kind === 'expanded' || value.kind === 'unrestricted') &&
    (value.filesystem === 'read_only' ||
      value.filesystem === 'workspace_write' ||
      value.filesystem === 'full_access') &&
    (value.network === 'disabled' || value.network === 'allow_all') &&
    typeof value.digest === 'string' &&
    value.digest.length > 0
  );
}

function isPolicyEffects(value: RuntimeJsonValue | undefined): boolean {
  if (!isJsonRecord(value)) return false;
  const allowed = new Set([
    'network',
    'externalRead',
    'externalWrite',
    'uncertainEffects',
    'sensitiveExternalAccess',
  ]);
  return Object.entries(value).every(([key, item]) => allowed.has(key) && item === true);
}

function isCapabilityEffects(
  value: RuntimeJsonValue | undefined,
): value is CapabilityEffects & RuntimeJsonValue {
  if (!isJsonRecord(value)) return false;
  return (
    effectLevel(value.filesystem) && effectLevel(value.network) && effectLevel(value.externalState)
  );
}

function effectLevel(value: RuntimeJsonValue | undefined): boolean {
  return (
    value === 'none' ||
    value === 'read' ||
    value === 'write' ||
    value === 'destructive' ||
    value === 'unknown'
  );
}

function isReceiptRequirement(
  value: RuntimeJsonValue | undefined,
): value is ToolPipelineReceiptRequirement {
  return (
    value === 'observation_receipt' ||
    value === 'effect_receipt' ||
    value === 'control_receipt' ||
    value === 'not_applicable'
  );
}

function isRetryEligibility(
  value: RuntimeJsonValue | undefined,
): value is ToolPipelineRetryEligibility {
  return (
    value === 'none' || value === 'safe_read_candidate' || value === 'idempotency_key_candidate'
  );
}

function nullableString(value: RuntimeJsonValue | undefined): value is string | null {
  return value === null || typeof value === 'string';
}

function isJsonRecord(
  value: RuntimeJsonValue | undefined,
): value is { readonly [key: string]: RuntimeJsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeJson(value: unknown): value is RuntimeJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isRuntimeJson(entry));
  if (typeof value !== 'object') return false;
  return Object.values(value).every((entry) => isRuntimeJson(entry));
}
