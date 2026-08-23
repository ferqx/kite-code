import type { StateRuntimeEvent } from '@kite/runtime-host';
import type {
  CapabilityToolTerminalResult,
  PreparedToolInvocation,
  RuntimeJsonValue,
  ToolPipelineAttemptAcknowledgement,
} from '@kite/runtime-spi';
import {
  AppStateToolPipelinePersistenceError,
  type CreateAppStateToolPipelinePersistenceInput,
  type StateBuiltinOperationStructuredContent,
} from './contracts';

const TASK_RESOURCE_ADMISSION_REASONS_ = Object.freeze([
  'budget_unconfigured',
  'persistence_unavailable',
  'budget_exhausted',
  'reconciliation_required',
  'tool_concurrency_saturated',
  'shell_concurrency_saturated',
] as const);

export function exactTaskResourceAdmissionFailure(
  value: Readonly<StateBuiltinOperationStructuredContent>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
):
  | Readonly<{
      reason: (typeof TASK_RESOURCE_ADMISSION_REASONS_)[number];
      message: string;
    }>
  | undefined {
  if (identity.operationId !== 'builtin:task' || !isJsonRecord(value.subagentResult)) {
    return undefined;
  }
  const candidate = value.subagentResult.resourceAdmissionFailure;
  if (candidate === undefined) return undefined;
  if (
    value.ok !== false ||
    !isJsonRecord(candidate) ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify([
        'childInvocationId',
        'message',
        'parentInvocationId',
        'parentToolCallId',
        'reason',
      ]) ||
    !TASK_RESOURCE_ADMISSION_REASONS_.includes(
      candidate.reason as (typeof TASK_RESOURCE_ADMISSION_REASONS_)[number],
    ) ||
    typeof candidate.message !== 'string' ||
    candidate.message.length === 0 ||
    candidate.parentInvocationId !== identity.invocationId ||
    candidate.parentToolCallId !== identity.toolCallId ||
    typeof candidate.childInvocationId !== 'string' ||
    candidate.childInvocationId.length === 0
  ) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Task resource admission failure did not match its exact parent attempt identity.',
    );
  }
  return Object.freeze({
    reason: candidate.reason as (typeof TASK_RESOURCE_ADMISSION_REASONS_)[number],
    message: candidate.message,
  });
}

export function fileChangeEvent(
  prepared: Readonly<PreparedToolInvocation> | undefined,
  result: Readonly<CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>>,
  value: Readonly<StateBuiltinOperationStructuredContent>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): Extract<StateRuntimeEvent, { type: 'tool.file_change' }> | undefined {
  const mutationOperation =
    identity.operationId === 'builtin:write_file' || identity.operationId === 'builtin:edit_file';
  if (!mutationOperation || result.status !== 'success' || !value.ok) return undefined;
  const argumentsValue = prepared?.input.arguments;
  const path =
    isJsonRecord(argumentsValue) && typeof argumentsValue.path === 'string'
      ? argumentsValue.path
      : undefined;
  if (!prepared || !path || value.path !== path) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Successful filesystem mutation result did not match its exact prepared lexical path.',
    );
  }
  const preview = (value.stdout || value.stderr).slice(0, 500);
  return {
    type: 'tool.file_change',
    toolCallId: identity.toolCallId,
    path,
    kind: identity.operationId === 'builtin:edit_file' ? 'edit' : 'add',
    ...(preview ? { preview } : {}),
  };
}

export function providerActionRequiredEvent(
  composition: CreateAppStateToolPipelinePersistenceInput['providerAction'],
  prepared: Readonly<PreparedToolInvocation> | undefined,
  result: Readonly<CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>>,
  identity: Readonly<ToolPipelineAttemptAcknowledgement['attempt']>,
): Extract<StateRuntimeEvent, { type: 'provider.action_required' }> | undefined {
  const isDynamicMcp = identity.operationId === 'mcp:dynamic_tool';
  if (
    composition?.enabled !== true ||
    !prepared ||
    (identity.operationId !== 'builtin:read_mcp_resource' && !isDynamicMcp) ||
    result.status === 'success'
  ) {
    return undefined;
  }
  const code = result.failure?.code;
  const action =
    code === 'provider_auth_required'
      ? ('login' as const)
      : code === 'provider_approval_required'
        ? ('approve' as const)
        : code === 'provider_unavailable' && result.failure?.retryable === true
          ? ('retry' as const)
          : undefined;
  if (!action) return undefined;
  const argumentsValue = prepared.input.arguments;
  const providerId = isDynamicMcp
    ? identity.providerId
    : isJsonRecord(argumentsValue) && typeof argumentsValue.server === 'string'
      ? argumentsValue.server
      : '';
  if (!providerId || providerId.length > 512 || /\p{Cc}/u.test(providerId)) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Confirmed MCP provider action is missing its exact prepared provider identity.',
    );
  }
  const interactionId = composition.createInteractionId();
  if (!interactionId || interactionId.length > 512 || /\p{Cc}/u.test(interactionId)) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Provider action interaction identity is unavailable.',
    );
  }
  return {
    type: 'provider.action_required',
    interactionId,
    providerId,
    action,
    originatingToolCallId: identity.toolCallId,
  };
}

function isJsonRecord(
  value: RuntimeJsonValue | undefined,
): value is { readonly [key: string]: RuntimeJsonValue } {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
