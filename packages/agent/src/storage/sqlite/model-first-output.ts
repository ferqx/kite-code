import { AgentError, type Json } from '../types';

/** Preserve the producer's original channel across partials and terminal publication. */
export function modelFirstOutput(previous: Json, next: unknown) {
  const recorded =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? previous.firstOutput
      : undefined;
  const valid = (value: unknown) =>
    value === undefined || value === 'content' || value === 'reasoning' || value === 'tool_calls';
  if (
    !valid(recorded) ||
    !valid(next) ||
    (recorded !== undefined && next !== undefined && recorded !== next)
  )
    throw new AgentError('model_output_conflict');
  return recorded ?? next;
}
