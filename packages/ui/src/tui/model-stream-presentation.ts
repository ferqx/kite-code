import type { Execution } from '@kite-ai/client';

/** A displayed retry joins its real failed predecessor; text alone never creates an attempt. */
export function observedModelRetry(
  execution: Execution | undefined,
  executions: readonly Execution[],
): Execution['modelRetry'] {
  const retry = execution?.modelRetry;
  if (execution?.kind !== 'model' || !retry) return undefined;
  const predecessors = executions.filter((item) => item.id === retry.previousExecutionId);
  const previous = predecessors.length === 1 ? predecessors[0] : undefined;
  if (
    previous?.kind !== 'model' ||
    previous.status !== 'failed' ||
    previous.id === execution.id ||
    !execution.originStoreId ||
    !execution.rootWorkCommandId ||
    execution.rootWorkSeq === undefined ||
    previous.originStoreId !== execution.originStoreId ||
    previous.sessionId !== execution.sessionId ||
    previous.runId !== execution.runId ||
    previous.rootWorkCommandId !== execution.rootWorkCommandId ||
    previous.rootWorkSeq !== execution.rootWorkSeq ||
    !previous.result ||
    typeof previous.result !== 'object' ||
    Array.isArray(previous.result) ||
    previous.result.code !== `MODEL_ATTEMPT_RETRYABLE_FAILURE:${retry.reason}` ||
    (previous.modelRetry?.attempt ?? 1) !== retry.attempt - 1
  )
    return undefined;
  return retry;
}

/** Hot presentation state for one exact Model execution. It never authorizes work. */
export interface InkModelStreamState {
  readonly identity: string;
  readonly mode: 'pending' | 'thought' | 'answer';
  readonly content: string;
  readonly reasoning: string;
  readonly complete: boolean;
  readonly toolBearing: boolean;
  /** One verified final reasoning suffix remains in the mutable view until its frame flushes. */
  readonly finalReasoningPreview: boolean;
}
export interface InkModelStreamInput {
  /** Canonical Store / Session / Run / Execution tuple, supplied by the qualified reader. */
  readonly identity: string;
  readonly content: string;
  readonly reasoning: string;
  readonly complete: boolean;
  /** Undefined means classification is still unavailable, rather than zero tools. */
  readonly toolCallCount?: number;
  readonly explorationOwner?: boolean;
  /** First nonempty channel recorded by the original Model producer. */
  readonly firstOutput?: 'content' | 'reasoning' | 'tool_calls';
}
/** Once an answer owns visible components, later reasoning cannot reopen its Thought. */
export function advanceInkModelStream(
  previous: InkModelStreamState | undefined,
  input: InkModelStreamInput,
): InkModelStreamState {
  const prior = previous?.identity === input.identity ? previous : undefined;
  if (prior?.complete) return prior;
  // A stale/divergent prefix cannot rewrite material already shown by this source.
  const content = prior && !input.content.startsWith(prior.content) ? prior.content : input.content;
  const reasoning =
    prior && !input.reasoning.startsWith(prior.reasoning) ? prior.reasoning : input.reasoning;
  const toolBearing = (input.toolCallCount ?? 0) > 0;
  let mode = prior?.mode ?? 'pending';
  if (mode === 'pending') {
    if (input.explorationOwner) mode = 'thought';
    else if (input.firstOutput === 'content') mode = 'answer';
    else if (input.firstOutput === 'reasoning' || input.firstOutput === 'tool_calls')
      mode = 'thought';
    else if (reasoning.trim()) mode = 'thought';
    else if (content.trim()) mode = 'answer';
  }
  return {
    identity: input.identity,
    mode,
    content,
    reasoning,
    complete: input.complete && input.toolCallCount !== undefined,
    toolBearing,
    finalReasoningPreview:
      prior?.mode === 'thought' &&
      !prior.complete &&
      input.complete &&
      input.toolCallCount === 0 &&
      !input.explorationOwner &&
      reasoning !== prior.reasoning,
  };
}
export function settleInkModelStream(state: InkModelStreamState): InkModelStreamState {
  return state.finalReasoningPreview ? { ...state, finalReasoningPreview: false } : state;
}
export function inkModelStreamVisibility(state: InkModelStreamState): {
  readonly content: string;
  readonly reasoning: string;
  readonly buffered: boolean;
} {
  const buffered = state.mode === 'thought' && (!state.complete || state.finalReasoningPreview);
  return {
    content: (state.toolBearing && state.mode !== 'answer') || buffered ? '' : state.content,
    reasoning: buffered ? state.reasoning : '',
    buffered,
  };
}
