import type {
  ClassifiedInvocationV1,
  PreparedToolInvocationV1,
  ResolvedInvocationV1,
  ToolCallSnapshotV1,
  ToolClassificationResultV1,
  ToolPipelineClassifiedIdentityVerificationResultV1,
  ToolPipelineResolutionContextV1,
  ToolResolutionResultV1,
  ToolValidationResultV1,
  ValidatedInvocationV1,
} from '@kite/runtime-spi';
import {
  type BuiltinDynamicMcpToolPipelineCallbacksV1,
  createBuiltinDynamicMcpToolPipelineCallbacksV1,
} from './mcp/tool-pipeline-callbacks';
import type { BuiltinToolCatalogProjectionV1 } from './tool-catalog';
import {
  type BuiltinToolPipelineCallbacksV1,
  createBuiltinToolPipelineCallbacksV1,
} from './tool-pipeline-callbacks';

/**
 * The one Builtin callback bundle used by the Host pipeline coordinator.
 *
 * Ordinary Builtin operations and the internal dynamic-MCP wrapper retain
 * separate owners.  This bundle is only a discriminated router over those
 * owners; it creates no registry, snapshot, port, parser, or fallback path.
 */
export type BuiltinRuntimeToolPipelineCallbacksV1 = BuiltinToolPipelineCallbacksV1;

type PipelineBranchV1 = 'ordinary' | 'dynamic' | 'invalid';

/**
 * Compose ordinary and dynamic callbacks from the exact same frozen
 * projection.  Routing is deliberately based on the SPI discriminants only:
 * binding identity for resolve, target identity for validate/classify, and
 * prepared identity for verification.
 */
export function createBuiltinRuntimeToolPipelineCallbacksV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
): BuiltinRuntimeToolPipelineCallbacksV1 {
  const ordinary: BuiltinToolPipelineCallbacksV1 = createBuiltinToolPipelineCallbacksV1(projection);
  const dynamic: BuiltinDynamicMcpToolPipelineCallbacksV1 =
    createBuiltinDynamicMcpToolPipelineCallbacksV1(projection);

  const resolve = (
    call: Readonly<ToolCallSnapshotV1>,
    context: Readonly<ToolPipelineResolutionContextV1>,
  ): ToolResolutionResultV1 => {
    const branch = resolveBranchV1(call);
    if (branch === 'ordinary') return ordinary.resolve(call, context);
    if (branch === 'dynamic') return dynamic.resolve(call, context);
    return resolveRoutingFailureV1(call);
  };

  const validate = (resolved: Readonly<ResolvedInvocationV1>): ToolValidationResultV1 => {
    const branch = targetBranchV1(resolved?.target);
    if (branch === 'ordinary') return ordinary.validate(resolved);
    if (branch === 'dynamic') return dynamic.validate(resolved);
    return validationRoutingFailureV1(resolved);
  };

  const classify = (validated: Readonly<ValidatedInvocationV1>): ToolClassificationResultV1 => {
    const branch = targetBranchV1(validated?.resolved?.target);
    if (branch === 'ordinary') return ordinary.classify(validated);
    if (branch === 'dynamic') return dynamic.classify(validated);
    return classificationRoutingFailureV1(validated);
  };

  const verifyPreparedIdentity = (prepared: Readonly<PreparedToolInvocationV1>) => {
    const branch = preparedIdentityBranchV1(prepared);
    if (branch === 'ordinary') return ordinary.verifyPreparedIdentity(prepared);
    if (branch === 'dynamic') return dynamic.verifyPreparedIdentity(prepared);
    return Object.freeze({ valid: false, code: 'identity_mismatch' as const });
  };

  const verifyClassifiedIdentity = (
    classified: Readonly<ClassifiedInvocationV1>,
  ): ToolPipelineClassifiedIdentityVerificationResultV1 | boolean => {
    const branch = classifiedIdentityBranchV1(classified);
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

function resolveBranchV1(call: Readonly<ToolCallSnapshotV1> | null | undefined): PipelineBranchV1 {
  if (!call || typeof call !== 'object') return 'invalid';
  const bindingIdentity = [call.bindingId, call.capabilityId, call.capabilityRevision] as const;
  if (bindingIdentity.every((value) => value === null)) return 'ordinary';
  if (bindingIdentity.every((value) => typeof value === 'string')) return 'dynamic';
  return 'invalid';
}

function targetBranchV1(target: unknown): PipelineBranchV1 {
  if (!target || typeof target !== 'object') return 'invalid';
  const discriminant = (target as { readonly isDynamicMcp?: unknown }).isDynamicMcp;
  if (discriminant === false) return 'ordinary';
  if (discriminant === true) return 'dynamic';
  return 'invalid';
}

function preparedIdentityBranchV1(
  prepared: Readonly<PreparedToolInvocationV1> | null | undefined,
): PipelineBranchV1 {
  if (!prepared || typeof prepared !== 'object' || !prepared.identity) return 'invalid';
  const discriminant = (prepared.identity as { readonly isDynamicMcp?: unknown }).isDynamicMcp;
  if (discriminant === false) return 'ordinary';
  if (discriminant === true) return 'dynamic';
  return 'invalid';
}

function classifiedIdentityBranchV1(
  classified: Readonly<ClassifiedInvocationV1> | null | undefined,
): PipelineBranchV1 {
  if (!classified || typeof classified !== 'object' || !classified.governance) return 'invalid';
  const discriminant = classified.governance.invocation?.isDynamicMcp;
  if (discriminant === false) return 'ordinary';
  if (discriminant === true) return 'dynamic';
  return 'invalid';
}

function resolveRoutingFailureV1(
  call: Readonly<ToolCallSnapshotV1> | null | undefined,
): ToolResolutionResultV1 {
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

function validationRoutingFailureV1(
  resolved: Readonly<ResolvedInvocationV1> | null | undefined,
): ToolValidationResultV1 {
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

function classificationRoutingFailureV1(
  validated: Readonly<ValidatedInvocationV1> | null | undefined,
): ToolClassificationResultV1 {
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
