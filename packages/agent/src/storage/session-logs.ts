import type { Store } from './port';
/** Abort only this observation. The bounded Store transaction cannot cancel business work. */
export async function readSessionLogs(
  store: Pick<Store, 'getSessionLogs'>,
  input: Parameters<Store['getSessionLogs']>[0],
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const page = await store.getSessionLogs(input);
  options.signal?.throwIfAborted();
  return page;
}
