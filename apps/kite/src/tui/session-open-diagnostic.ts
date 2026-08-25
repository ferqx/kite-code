export type HistoricalSessionOpenStage =
  | 'persisted_load'
  | 'runtime_registration'
  | 'runtime_recovery'
  | 'persisted_reload'
  | 'runtime_switch'
  | 'presentation_replay'
  | 'context_projection';

export type HistoricalSessionOpenFailureCode =
  | 'project_identity_missing'
  | 'project_identity_invalid'
  | 'runtime_composition_unavailable'
  | 'storage_format_incompatible'
  | 'storage_corrupted'
  | 'session_missing'
  | `${HistoricalSessionOpenStage}_failed`;

/**
 * Convert a private exception into a content-free local diagnostic. Never
 * forward raw messages: Store and composition errors may contain paths or
 * provider details even though the stage itself is safe to expose locally.
 */
export function classifyHistoricalSessionOpenFailure(
  stage: HistoricalSessionOpenStage,
  error: unknown,
): HistoricalSessionOpenFailureCode {
  const message = error instanceof Error ? error.message : '';
  const name = error instanceof Error ? error.name : '';
  if (message === 'Persisted State Session is missing its Project identity.') {
    return 'project_identity_missing';
  }
  if (message === 'Runtime session Project identity is invalid.') {
    return 'project_identity_invalid';
  }
  if (message.includes('Runtime Host') && message.includes('unavailable')) {
    return 'runtime_composition_unavailable';
  }
  if (name === 'SqliteRuntimeFormatMismatchError' || message.includes('incompatible')) {
    return 'storage_format_incompatible';
  }
  if (
    name === 'SqliteRuntimeStorageOpenError' ||
    message.includes('corrupted') ||
    message.includes('checksum')
  ) {
    return 'storage_corrupted';
  }
  if (message.includes('has no saved checkpoints')) return 'session_missing';
  return `${stage}_failed`;
}
