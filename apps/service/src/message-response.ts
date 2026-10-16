import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import type { ExecutionRecord, MessageRecord } from '@kite-ai/agent/storage';

/** The output head is private. Public history exposes only the original Execution and preview facts. */
export function messageResponse(
  message: MessageRecord,
  origin?: { storeId: string; message: MessageRecord },
  unsupported = false,
) {
  const projected =
    origin && origin.message.id !== message.id
      ? {
          ...message,
          originMessage: {
            storeId: origin.storeId,
            sessionId: origin.message.sessionId,
            messageId: origin.message.id,
            runId: origin.message.runId,
          },
        }
      : message;
  const output = message.modelOutput;
  if (!output)
    return unsupported ? { ...projected, contentFormat: 'unsupported' as const } : projected;
  if (
    output.head.scope.kind !== 'execution' ||
    message.sourceIds?.length !== 1 ||
    message.sourceIds[0] !== output.head.scope.id ||
    (!unsupported && output.head.sessionId !== (origin?.message.sessionId ?? message.sessionId)) ||
    message.role !== 'assistant'
  )
    throw new AgentError('model_output_invalid');
  return {
    ...projected,
    outputBody: {
      kind: 'model_output' as const,
      executionId: output.head.scope.id,
      complete: output.complete,
      contentBytes: output.contentBytes,
      reasoningBytes: output.reasoningBytes,
      toolCallCount: output.toolCallCount,
      ...(unsupported ? { readAvailability: 'unsupported' as const } : {}),
    },
  };
}

/** Only sealed SQL provenance can identify an original message across an explicit Fork. */
export async function messageResponses(
  runtime: AgentRuntime,
  messages: readonly MessageRecord[],
  storeId: string,
  subjectId: string,
) {
  return Promise.all(
    messages.map(async (message) => {
      if (message.runId !== null) return messageResponse(message);
      try {
        const origin = await runtime.getMessageOrigin({
          expectedStoreId: storeId,
          sessionId: message.sessionId,
          subjectId,
          messageId: message.id,
        });
        const originalStoreId = origin.originStoreId ?? origin.message.modelOutput?.head.storeId;
        return messageResponse(
          message,
          originalStoreId ? { storeId: originalStoreId, message: origin.message } : undefined,
        );
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'fork_content_unsupported')
          throw error;
        return messageResponse(message, undefined, true);
      }
    }),
  );
}

export function executionResponse(execution: ExecutionRecord) {
  const source = execution.decisionSource;
  const retry =
    execution.kind === 'model' &&
    source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    source.kind === 'model_request'
      ? source.retry
      : undefined;
  const publicExecution =
    retry &&
    typeof retry === 'object' &&
    !Array.isArray(retry) &&
    typeof retry.previousExecutionId === 'string' &&
    typeof retry.attempt === 'number' &&
    Number.isInteger(retry.attempt) &&
    retry.attempt >= 2 &&
    (retry.maxAttempts === null ||
      (typeof retry.maxAttempts === 'number' &&
        Number.isSafeInteger(retry.maxAttempts) &&
        retry.maxAttempts >= retry.attempt)) &&
    ['provider_unavailable', 'connection_failed', 'stream_incomplete'].includes(
      String(retry.reason),
    )
      ? {
          ...execution,
          modelRetry: {
            previousExecutionId: retry.previousExecutionId,
            attempt: retry.attempt,
            maxAttempts: retry.maxAttempts as number | null,
            reason: retry.reason,
          },
        }
      : execution;
  // A Tool's model-facing arguments are display facts. Never publish Model
  // request bodies, credential-bearing Job programs or recovery manifests here.
  if (execution.kind === 'tool')
    return { ...publicExecution, toolCallId: execution.callId, toolInput: execution.input };
  const result = execution.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || !result.modelOutput)
    return publicExecution;
  const output = result.modelOutput as unknown as NonNullable<MessageRecord['modelOutput']>;
  if (
    output.head?.scope.kind !== 'execution' ||
    output.head.scope.id !== execution.id ||
    output.head.sessionId !== execution.sessionId ||
    execution.kind !== 'model'
  )
    throw new AgentError('model_output_invalid');
  const { modelOutput: _privateOutput, ...publicResult } = result;
  return {
    ...publicExecution,
    result: {
      ...publicResult,
      outputBody: {
        kind: 'model_output',
        executionId: execution.id,
        complete: output.complete,
        contentBytes: output.contentBytes,
        reasoningBytes: output.reasoningBytes,
        toolCallCount: output.toolCallCount,
      },
    },
  };
}
