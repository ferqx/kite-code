import { KiteSessionStoreOpenError } from '@kite-ai/runtime-storage-sqlite';

type AdmissionScope = 'Installed Store' | 'Paired Desktop Store' | 'Store';

/** Only an observed live legacy writer is known to be a temporary admission failure. */
export function storeAdmissionFailure(scope: AdmissionScope, reason: string): Error {
  if (reason === 'legacy_process_busy')
    return new KiteSessionStoreOpenError(
      'store_busy',
      'A Kite client is still using the session Store. Retry after it exits.',
    );
  return new Error(`${scope} writer admission is unavailable: ${reason}.`);
}
