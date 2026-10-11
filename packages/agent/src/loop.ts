import type { ModelMessage, ModelRequest, ModelTool } from '@kite-ai/ai';
import type { ModelResponse } from './execution';
import type { ToolResult } from './extensions';
import { AgentError, type ToolCall } from './storage/types';

export interface LoopContext {
  readonly modelId: string;
  readonly signal: AbortSignal;
  getMessages(): Promise<ModelMessage[]>;
  getTools(): readonly ModelTool[];
  executeModel(request: ModelRequest, stepId: string): Promise<ModelResponse>;
  prepareToolCalls?(calls: readonly ToolCall[]): Promise<void>;
  executeTool(
    call: ToolCall,
    stepId: string,
    sourceExecutionId: string,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  restoreToolCall?(call: ToolCall): void | Promise<void>;
  /** A verified durable boundary, consumed once before the ordinary loop proceeds. */
  checkpoint?:
    | { kind: 'model'; stepId: string; request: ModelRequest }
    | {
        kind: 'response';
        stepId: string;
        response: ModelResponse;
        settledCalls: readonly { callId: string; result: ToolResult }[];
      };
}

/** The single model/tool loop for root and child Sessions. */
export async function defaultLoop(context: LoopContext): Promise<void> {
  let checkpoint = context.checkpoint;
  context.checkpoint = undefined;
  while (true) {
    context.signal.throwIfAborted();
    const initial = checkpoint;
    checkpoint = undefined;
    const stepId = initial?.stepId ?? crypto.randomUUID();
    const response =
      initial?.kind === 'response'
        ? initial.response
        : await context.executeModel(
            initial?.kind === 'model'
              ? initial.request
              : {
                  modelId: context.modelId,
                  requestId: crypto.randomUUID(),
                  messages: await context.getMessages(),
                  tools: context.getTools(),
                },
            stepId,
          );
    if (!response.toolCalls.length) return;
    await context.prepareToolCalls?.(response.toolCalls);
    const batch = new AbortController();
    const abort = () => batch.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    let failed = false,
      failure: unknown;
    let outcomes: PromiseSettledResult<void>[] = [];
    try {
      // Every started call reaches its durable boundary before the next Model, Run terminal or
      // binding release. A batch error stops siblings without rewriting the Run as user-cancelled.
      outcomes = await Promise.allSettled(
        response.toolCalls.map(async (call) => {
          try {
            batch.signal.throwIfAborted();
            const settled =
              initial?.kind === 'response'
                ? initial.settledCalls.find((candidate) => candidate.callId === call.id)
                : undefined;
            const result =
              settled?.result ??
              (await context.executeTool(call, stepId, response.executionId, batch.signal));
            if (settled) await context.restoreToolCall?.(call);
            if (result.content === 'approval_denied' && result.outcome === 'failed')
              throw new AgentError('approval_denied');
            if (result.outcome === 'outcome_unknown')
              throw new Error('Execution outcome requires reconciliation.');
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
              batch.abort(error);
            }
            throw error;
          }
        }),
      );
    } finally {
      context.signal.removeEventListener('abort', abort);
    }
    if (failed) {
      const failures = [
        ...new Set(
          outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : [])),
        ),
      ];
      if (failures.length > 1)
        throw new AggregateError(failures, 'tool_batch_failed', { cause: failure });
      throw failure;
    }
  }
}
