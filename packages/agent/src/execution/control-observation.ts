import type { Store } from '../storage/port';
import { AgentError } from '../storage/types';

// These producers append output without changing any cancellation flag. Everything
// else, including future event types, conservatively rechecks the owned handles.
const outputEvents = new Set([
  'message.updated',
  'execution.output',
  'authorization.check.partial',
  'session.title.partial',
]);
const pageLimit = 200;

/** Change hints only suppress redundant reads; durable flags still decide cancellation. */
export class ControlObservation {
  private cursor: string | undefined;
  private revision = 0;
  private observedRevision = -1;
  private readonly store: Pick<Store, 'getMetadata' | 'getChanges'>;
  constructor(store: Pick<Store, 'getMetadata' | 'getChanges'>) {
    this.store = store;
  }

  /** A newly tracked handle must be checked even if cancellation predates registration. */
  markDirty(): void {
    this.revision++;
  }

  /** The Runtime's existing control task serializes calls and owns its original timer. */
  async poll(scan: () => Promise<void>): Promise<void> {
    const revision = this.revision;
    let cursor: string;
    let required = this.observedRevision !== revision;
    if (this.cursor === undefined || required) {
      // Capture before checking flags: a concurrent control write remains observable.
      cursor = (await this.store.getMetadata()).lastChangeCursor;
      required = true;
    } else {
      try {
        const page = await this.store.getChanges({ after: this.cursor, limit: pageLimit });
        cursor = page.metadata.lastChangeCursor;
        // A bounded page may hide a later control event. Scan instead of allowing
        // output backlog to delay cancellation, then resume at this snapshot's head.
        required =
          page.events.length >= pageLimit ||
          page.events.some((event) => !outputEvents.has(event.type));
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'cursor_expired') throw error;
        cursor = (await this.store.getMetadata()).lastChangeCursor;
        required = true;
      }
    }
    if (required) await scan();
    // Failed reads/scans never advance observation. markDirty during scan must
    // remain pending for the next tick rather than losing a newly tracked handle.
    this.cursor = cursor;
    this.observedRevision = revision;
  }
}
