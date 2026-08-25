import type {
  ClassifiedInvocation,
  PreparedToolInvocation,
  ResolvedInvocation,
  ToolCallSnapshot,
  ToolClassificationResult,
  ToolPipelineClassifiedIdentityVerificationResult,
  ToolPipelineResolutionContext,
  ToolResolutionResult,
  ToolValidationResult,
  ValidatedInvocation,
} from '@kite/runtime-spi';
import {
  type BuiltinDynamicMcpToolPipelineCallbacks,
  createBuiltinDynamicMcpToolPipelineCallbacks,
} from './mcp/tool-pipeline-callbacks';
import type { BuiltinToolCatalogProjection } from './tool-catalog';
import {
  type BuiltinToolPipelineCallbacks,
  createBuiltinToolPipelineCallbacks,
} from './tool-pipeline-callbacks';

/**
 * The one Builtin callback bundle used by the Host pipeline coordinator.
 *
 * Ordinary Builtin operations and the internal dynamic-MCP wrapper retain
 * separate owners.  This bundle is only a discriminated router over those
 * owners; it creates no registry, snapshot, port, parser, or fallback path.
 */
export type BuiltinRuntimeToolPipelineCallbacks = BuiltinToolPipelineCallbacks;

type PipelineBranch = 'ordinary' | 'dynamic' | 'invalid';

/**
 * Compose ordinary and dynamic callbacks from the exact same frozen
 * projection.  Routing is deliberately based on the SPI discriminants only:
 * binding identity for resolve, target identity for validate/classify, and
 * prepared identity for verification.
 */
export function createBuiltinRuntimeToolPipelineCallbacks(
  projection: Readonly<BuiltinToolCatalogProjection>,
): BuiltinRuntimeToolPipelineCallbacks {
  const ordinary: BuiltinToolPipelineCallbacks = createBuiltinToolPipelineCallbacks(projection);
  const dynamic: BuiltinDynamicMcpToolPipelineCallbacks =
    createBuiltinDynamicMcpToolPipelineCallbacks(projection);

  const resolve = (
    call: Readonly<ToolCallSnapshot>,
    context: Readonly<ToolPipelineResolutionContext>,
  ): ToolResolutionResult => {
    const branch = resolveBranch(call);
    if (branch === 'ordinary') return ordinary.resolve(call, context);
    if (branch === 'dynamic') return dynamic.resolve(call, context);
    return resolveRoutingFailure(call);
  };

  const validate = (resolved: Readonly<ResolvedInvocation>): ToolValidationResult => {
    const branch = targetBranch(resolved?.target);
    if (branch === 'ordinary') return ordinary.validate(resolved);
    if (branch === 'dynamic') return dynamic.validate(resolved);
    return validationRoutingFailure(resolved);
  };

  const classify = (validated: Readonly<ValidatedInvocation>): ToolClassificationResult => {
    const branch = targetBranch(validated?.resolved?.target);
    if (branch === 'ordinary') return ordinary.classify(validated);
    if (branch === 'dynamic') return dynamic.classify(validated);
    return classificationRoutingFailure(validated);
  };

  const verifyPreparedIdentity = (prepared: Readonly<PreparedToolInvocation>) => {
    const branch = preparedIdentityBranch(prepared);
    if (branch === 'ordinary') return ordinary.verifyPreparedIdentity(prepared);
    if (branch === 'dynamic') return dynamic.verifyPreparedIdentity(prepared);
    return Object.freeze({ valid: false, code: 'identity_mismatch' as const });
  };

  const verifyClassifiedIdentity = (
    classified: Readonly<ClassifiedInvocation>,
  ): ToolPipelineClassifiedIdentityVerificationResult | boolean => {
    const branch = classifiedIdentityBranch(classified);
    if (branch === 'ordinary') return ordinary.verifyClassifiedIdentity(classified);
    if (branch === 'dynamic') return dynamic.verifyClassifiedIdentity(classified);
    return Object.freeze({ valid: false, code: 'governance_missing' as const });
  };

  return Object.freeze({
    resolve,
    validate,
    classify,
    verifyPreparedIdentity,
    verifyClassifiedIdentity,
  });
}

function resolveBranch(call: Readonly<ToolCallSnapshot> | null | undefined): PipelineBranch {
  if (!call || typeof call !== 'object') return 'invalid';
  const bindingIdentity = [call.bindingId, call.capabilityId, call.capabilityRevision] as const;
  if (bindingIdentity.every((value) => value === null)) return 'ordinary';
  if (bindingIdentity.every((value) => typeof value === 'string')) return 'dynamic';
  return 'invalid';
}

function targetBranch(target: unknown): PipelineBranch {
  if (!target || typeof target !== 'object') return 'invalid';
  const discriminant = (target as { readonly isDynamicMcp?: unknown }).isDynamicMcp;
  if (discriminant === false) return 'ordinary';
  if (discriminant === true) return 'dynamic';
  return 'invalid';
}

function preparedIdentityBranch(
  prepared: Readonly<PreparedToolInvocation> | null | undefined,
): PipelineBranch {
  if (!prepared || typeof prepared !== 'object' || !prepared.identity) return 'invalid';
  const discriminant = (prepared.identity as { readonly isDynamicMcp?: unknown }).isDynamicMcp;
  if (discriminant === false) return 'ordinary';
  if (discriminant === true) return 'dynamic';
  return 'invalid';
}

function classifiedIdentityBranch(
  classified: Readonly<ClassifiedInvocation> | null | undefined,
): PipelineBranch {
  if (!classified || typeof classified !== 'object' || !classified.governance) return 'invalid';
  const discriminant = classified.governance.invocation?.isDynamicMcp;
  if (discriminant === false) return 'ordinary';
  if (discriminant === true) return 'dynamic';
  return 'invalid';
}

function resolveRoutingFailure(
  call: Readonly<ToolCallSnapshot> | null | undefined,
): ToolResolutionResult {
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      stage: 'resolve' as const,
      code: 'binding_identity_mismatch' as const,
      toolCallId: typeof call?.toolCallId === 'string' ? call.toolCallId : null,
      toolName: typeof call?.name === 'string' ? call.name : null,
    }),
  });
}

function validationRoutingFailure(
  resolved: Readonly<ResolvedInvocation> | null | undefined,
): ToolValidationResult {
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      stage: 'validate' as const,
      code: 'stage_identity_drift' as const,
      toolCallId: typeof resolved?.call?.toolCallId === 'string' ? resolved.call.toolCallId : null,
      toolName: typeof resolved?.call?.name === 'string' ? resolved.call.name : null,
    }),
  });
}

function classificationRoutingFailure(
  validated: Readonly<ValidatedInvocation> | null | undefined,
): ToolClassificationResult {
  return Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      stage: 'classify' as const,
      code: 'stage_identity_drift' as const,
      toolCallId:
        typeof validated?.resolved?.call?.toolCallId === 'string'
          ? validated.resolved.call.toolCallId
          : null,
      toolName: typeof validated?.request?.name === 'string' ? validated.request.name : null,
    }),
  });
}
