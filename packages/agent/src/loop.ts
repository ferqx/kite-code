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
  executeTool(call: ToolCall, stepId: string, sourceExecutionId: string): Promise<ToolResult>;
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
    for (const call of response.toolCalls) {
      context.signal.throwIfAborted();
      const settled =
        initial?.kind === 'response'
          ? initial.settledCalls.find((candidate) => candidate.callId === call.id)
          : undefined;
      const result =
        settled?.result ?? (await context.executeTool(call, stepId, response.executionId));
      if (settled) await context.restoreToolCall?.(call);
      if (result.content === 'approval_denied' && result.outcome === 'failed')
        throw new AgentError('approval_denied');
      if (result.outcome === 'outcome_unknown')
        throw new Error('Execution outcome requires reconciliation.');
    }
  }
}
