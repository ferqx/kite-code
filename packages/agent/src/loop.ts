import type { ModelMessage, ModelRequest, ModelTool } from '@kite-ai/ai';
import type { ModelResponse, ToolExecutionResult } from './execution';
import type { ToolResult } from './extensions';
import { canonicalJson } from './json';
import { AgentError, type ToolCall } from './storage/types';

/** A Run-local streak, retained across completion checks and reconstructed on resume. */
export interface ToolFailureStreak {
  signature: string | null;
  count: number;
}
export function recordToolOutcome(
  streak: ToolFailureStreak,
  call: ToolCall,
  result: ToolResult,
  dispatched?: boolean,
): void {
  const details = result.details;
  if (
    result.outcome === 'failed' &&
    dispatched === false &&
    details &&
    typeof details === 'object' &&
    !Array.isArray(details) &&
    [
      'context_refresh_required',
      'capability_refresh_required',
      'input_pending',
      'work_not_selected',
      'work_paused',
    ].includes(String(details.code))
  )
    // A retired decision neither consumes nor resets genuine failure attempts.
    return;
  if (result.outcome !== 'failed') {
    streak.signature = null;
    streak.count = 0;
    return;
  }
  let parameters: string;
  try {
    parameters = canonicalJson(JSON.parse(call.arguments));
  } catch {
    parameters = call.arguments;
  }
  const signature = JSON.stringify([call.name, parameters]);
  streak.count = streak.signature === signature ? streak.count + 1 : 1;
  streak.signature = signature;
}

export interface LoopContext {
  readonly modelId: string;
  readonly signal: AbortSignal;
  toolFailureStreak?: ToolFailureStreak;
  getMessages(): Promise<ModelMessage[]>;
  getTools(): readonly ModelTool[];
  executeModel(request: ModelRequest, stepId: string): Promise<ModelResponse>;
  prepareToolCalls?(calls: readonly ToolCall[]): Promise<void>;
  beginToolBatch?(
    calls: readonly ToolCall[],
    signal: AbortSignal,
    cancel: (reason: unknown) => void,
  ):
    | { settled(callId: string, result: ToolResult, dispatched?: boolean): void; finish(): void }
    | undefined;
  executeTool(
    call: ToolCall,
    stepId: string,
    sourceExecutionId: string,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;
  restoreToolCall?(call: ToolCall): void | Promise<void>;
  /** A verified durable boundary, consumed once before the ordinary loop proceeds. */
  checkpoint?:
    | { kind: 'model'; stepId: string; request: ModelRequest }
    | {
        kind: 'response';
        stepId: string;
        response: ModelResponse;
        settledCalls: readonly (ToolExecutionResult & { callId: string })[];
      };
}

/** A transient loop-owned instruction, tied only to an actual length result. */
export function outputLengthContinuation(executionId: string): ModelMessage {
  return {
    role: 'user',
    content:
      'The preceding Model response reached its output length. Continue the original task from the saved response; do not repeat completed work. This continuation grants no additional permission.',
    sourceIds: [executionId],
  };
}

/** The single model/tool loop for root and child Sessions. */
export async function defaultLoop(context: LoopContext): Promise<void> {
  context.toolFailureStreak ??= { signature: null, count: 0 };
  const streak = context.toolFailureStreak;
  if (streak.count >= 5) throw new AgentError('repeated_tool_failure');
  let checkpoint = context.checkpoint;
  let continuation: string | undefined;
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
                  messages: [
                    ...(await context.getMessages()),
                    ...(continuation ? [outputLengthContinuation(continuation)] : []),
                  ],
                  tools: context.getTools(),
                },
            stepId,
          );
    if (!response.toolCalls.length) {
      if (response.finishReason === 'length') {
        continuation = response.executionId;
        continue;
      }
      return;
    }
    continuation = undefined;
    await context.prepareToolCalls?.(response.toolCalls);
    const batch = new AbortController();
    const abort = () => batch.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const admission = context.beginToolBatch?.(response.toolCalls, batch.signal, (reason) =>
      batch.abort(reason),
    );
    let failed = false,
      failure: unknown;
    let outcomes: PromiseSettledResult<void>[] = [];
    const results = new Map<string, ToolExecutionResult>();
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
            const outcome =
              settled ??
              (await context.executeTool(call, stepId, response.executionId, batch.signal));
            const { result } = outcome;
            results.set(call.id, outcome);
            if (settled) await context.restoreToolCall?.(call);
            if (result.content === 'approval_denied' && result.outcome === 'failed')
              throw new AgentError('approval_denied');
            if (result.outcome === 'outcome_unknown')
              throw new Error('Execution outcome requires reconciliation.');
            if (settled) admission?.settled(call.id, result, settled.dispatched);
            if (admission) batch.signal.throwIfAborted();
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
      admission?.finish();
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
    // Physical completion order can differ from the Model's call order. All started
    // calls have settled before enforcing the limit or releasing the Run binding.
    for (const call of response.toolCalls) {
      const outcome = results.get(call.id)!;
      recordToolOutcome(streak, call, outcome.result, outcome.dispatched);
      if (streak.count >= 5) throw new AgentError('repeated_tool_failure');
    }
  }
}
