import { AgentError } from '../../storage/types';

// Only the Host's checked, pre-admission failure can establish nonacceptance.
const failures = new WeakSet<AgentError>();
export function childPreparationFailure(error: unknown): AgentError {
  const failure = new AgentError(
    error instanceof AgentError ? error.code : 'child_preparation_failed',
  );
  failures.add(failure);
  return failure;
}
export function isChildPreparationFailure(error: unknown): error is AgentError {
  return error instanceof AgentError && failures.has(error);
}
