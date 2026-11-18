import { AgentError, type ExecutionRecord, type Json } from '../storage/types';
/** Owner-loss recovery must not silently resubmit a dispatched window request. */
export function imageWindowRecovery(execution: ExecutionRecord, source: Record<string, Json>) {
  const window = source.imageWindow as Record<string, Json> | undefined;
  if (window === undefined) return { observation: false, rebuild: false, rejected: false };
  if (
    !window ||
    window.version !== 1 ||
    !['business', 'observation'].includes(String(window.kind)) ||
    typeof window.route !== 'string' ||
    !Array.isArray(window.members)
  )
    throw new AgentError('image_window_scope_invalid');
  const observation = window.kind === 'observation';
  const result = execution.result as Record<string, Json> | null;
  const rejected = execution.status === 'failed' && result?.code === 'model_request_body_too_large';
  if (execution.status === 'planned') return { observation, rebuild: false, rejected: false };
  if (execution.status === 'succeeded') {
    if (
      observation &&
      (result?.finishReason !== 'stop' ||
        !Array.isArray(result.toolCalls) ||
        result.toolCalls.length ||
        !result.observation)
    )
      throw new AgentError('image_observation_incomplete');
    return { observation, rebuild: observation, rejected: false };
  }
  if (rejected || result?.dispatchCommitted === false)
    return { observation, rebuild: true, rejected };
  throw new AgentError('image_window_outcome_unknown');
}
