import type { SessionLogPage, Store } from '@kite-ai/agent/storage';

/** A trusted host binds this finite observer to its selected Store. */
export type SessionLogsSource = (
  input: Parameters<Store['getSessionLogs']>[0],
  options: { signal?: AbortSignal },
) => Promise<SessionLogPage>;
