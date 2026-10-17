/** Trusted Store facts only. This neutral brand performs no SQLite or Worker I/O. */
const unconfirmedTransactions = new WeakSet<object>();

export function markStorageTransactionUnconfirmed<T extends Error>(error: T): T {
  unconfirmedTransactions.add(error);
  return error;
}

export function isStorageTransactionUnconfirmed(error: unknown): boolean {
  return error !== null && typeof error === 'object' && unconfirmedTransactions.has(error);
}
