import { type AgentClient, ClientError } from '@kite-ai/client';
import type { TuiController } from '@kite-ai/ui/tui';
/** A new read baseline is not an applied-event ACK. Freeze it before rereading selected facts. */
export async function prepareTuiObservationStart(
  client: AgentClient,
  storeId: string,
  readSelectedFacts: () => Promise<void>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const page = await client.listSessionDirectory({ storeId, limit: 1 }, { signal });
  if (
    page.storeId !== storeId ||
    !/^(0|[1-9]\d{0,18})$/.test(page.snapshotCursor) ||
    BigInt(page.snapshotCursor) > 9223372036854775807n
  )
    throw new ClientError('store_identity_mismatch');
  await readSelectedFacts();
  signal.throwIfAborted();
  return { storeId, sequence: page.snapshotCursor };
}

/** Reconnection refreshes observations; only explicit selection owns reconciliation. */
export async function refreshTuiObservation(
  controller: Pick<TuiController, 'observationReady' | 'refreshPermissions' | 'state' | 'select'>,
  storeId: string,
) {
  controller.observationReady(storeId);
  await controller.refreshPermissions();
  const target = controller.state.sessionId;
  if (target)
    await controller.select(target, { preserveReconnectionReview: true, reconcile: false });
}
