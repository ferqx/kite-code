/** Trusted Store facts only. This neutral brand performs no SQLite or Worker I/O. */
const unconfirmedTransactions = new WeakSet<object>();
const settledRequests = new WeakSet<object>();

/** The original Worker request has returned with no transaction left open.
 * This proves request lifetime only; callers must still inspect its exact durable receipt. */
export function markStorageRequestSettled<T extends object>(error: T): T {
  settledRequests.add(error);
  return error;
}
export function isStorageRequestSettled(error: unknown): boolean {
  return error !== null && typeof error === 'object' && settledRequests.has(error);
}

export function markStorageTransactionUnconfirmed<T extends Error>(error: T): T {
  unconfirmedTransactions.add(error);
  return error;
}

export function isStorageTransactionUnconfirmed(error: unknown): boolean {
  return error !== null && typeof error === 'object' && unconfirmedTransactions.has(error);
}
