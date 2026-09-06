import { RuntimeClientError } from '@kite-ai/runtime-client';

export type InteractionSubmissionFailure = 'connection' | 'expired' | 'state_changed' | 'unknown';

export function classifyInteractionSubmissionFailure(error: unknown): InteractionSubmissionFailure {
  if (
    error instanceof RuntimeClientError &&
    (error.code === 'connection_closed' || error.code === 'connection_failed')
  ) {
    return 'connection';
  }
  const message = error instanceof Error ? error.message : '';
  if (
    message.includes('no longer pending') ||
    message.includes('identity could not be refreshed')
  ) {
    return 'expired';
  }
  if (
    message.includes('projection') ||
    message.includes('revision_conflict') ||
    message.includes('interaction_mismatch')
  ) {
    return 'state_changed';
  }
  return 'unknown';
}
