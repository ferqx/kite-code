import { isBuiltinOperationExecutionValue } from '@kite-ai/builtin-runtime';
import type { CapabilityFailure, CapabilityResult } from '@kite-ai/runtime-contract';
import {
  runtimeHostStateAdmitCurrentRuntimeEvent,
  type StateRuntimeEvent,
} from '@kite-ai/runtime-host';
import type {
  CapabilityToolTerminalResult,
  RuntimeJsonValue,
  ToolPipelineSuspendedExecutionResult,
} from '@kite-ai/runtime-spi';
import {
  AppStateToolPipelinePersistenceError,
  type StateBuiltinOperationStructuredContent,
} from './contracts';

export function readStructuredContent(
  result: Readonly<
    | CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>
    | ToolPipelineSuspendedExecutionResult<StateBuiltinOperationStructuredContent>
  >,
): Readonly<{
  value: Readonly<StateBuiltinOperationStructuredContent>;
  runtimeEvents: readonly StateRuntimeEvent[];
}> {
  const value = result.structuredContent;
  if (!isBuiltinOperationExecutionValue(value)) {
    throw new AppStateToolPipelinePersistenceError('invalid_terminal_result');
  }
  return Object.freeze({ value, runtimeEvents: admitRuntimeEvents(value.runtimeEvents) });
}

export function capabilityResultFromTerminal(
  result: Readonly<
    | CapabilityToolTerminalResult<StateBuiltinOperationStructuredContent>
    | ToolPipelineSuspendedExecutionResult<StateBuiltinOperationStructuredContent>
  >,
  value: Readonly<StateBuiltinOperationStructuredContent>,
): CapabilityResult {
  const content = result.content.map((entry) => {
    if (!isJsonRecord(entry)) {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_terminal_result',
        'Capability terminal content must contain JSON objects for Artifact storage.',
      );
    }
    return { ...entry };
  });
  const failure = 'failure' in result ? result.failure : undefined;
  const capabilityFailure: CapabilityFailure | undefined = failure
    ? {
        kind: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        modelFixable: failure.modelFixable,
        needsUserIntervention: failure.needsUserIntervention,
        terminatesTurn: failure.terminatesTurn,
        journal: failure.journal,
        ...(failure.parseFailureCode ? { parseFailureCode: failure.parseFailureCode } : {}),
      }
    : undefined;
  const providerMeta = result.providerMeta;
  if (providerMeta !== undefined && !isJsonRecord(providerMeta)) {
    throw new AppStateToolPipelinePersistenceError(
      'invalid_terminal_result',
      'Capability provider metadata must be a JSON object for Artifact storage.',
    );
  }
  return {
    status: result.status,
    content,
    structuredContent: value,
    ...(capabilityFailure ? { error: capabilityFailure } : {}),
    ...(providerMeta === undefined ? {} : { providerMeta: { ...providerMeta } }),
  };
}

function admitRuntimeEvents(events: readonly RuntimeJsonValue[] | undefined): StateRuntimeEvent[] {
  if (!events) return [];
  return events.map((event) => {
    try {
      return runtimeHostStateAdmitCurrentRuntimeEvent(event);
    } catch {
      throw new AppStateToolPipelinePersistenceError(
        'invalid_terminal_result',
        'Builtin runtime event failed State admission.',
      );
    }
  });
}

function isJsonRecord(
  value: RuntimeJsonValue | undefined,
): value is { readonly [key: string]: RuntimeJsonValue } {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
