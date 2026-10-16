import type { Message } from '@kite-ai/client';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { NativeHistoryCache } from './native-history-cache';

export type HistoryState = {
  messages: Message[];
  phase: 'loading' | 'complete' | 'unavailable';
  highWaterSeq?: string;
  error?: string;
};
/** Reading never owns execution. Each scan seals one public high water before publishing its reading snapshot. */
export class NativeHistory {
  private scope?: {
    generation: number;
    storeId: string;
    sessionId: string;
    selection: number;
    epoch: number;
  };
  private run?: { readId: string; canceled: boolean };
  private wanted?: string;
  private revision?: number;
  private entries = new Map<string, Message>();
  private cached = new NativeHistoryCache();
  private disposed = false;
  state: HistoryState = { messages: [], phase: 'loading' };
  private bridge: NativeBridge;
  private changed: (value: HistoryState) => void;
  constructor(bridge: NativeBridge, changed: (value: HistoryState) => void) {
    this.bridge = bridge;
    this.changed = changed;
  }
  private publish(phase: HistoryState['phase'], highWaterSeq?: string, error?: string) {
    this.state = {
      messages: [...this.entries.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1)),
      phase,
      highWaterSeq,
      error,
    };
    this.changed(this.state);
  }
  close() {
    // Returning to an unchanged selection still requires a fresh reading after a pause.
    this.revision = undefined;
    if (this.run && this.scope) {
      this.run.canceled = true;
      void this.bridge
        .request({
          method: 'messages.close',
          generation: this.scope.generation,
          readId: this.run.readId,
        })
        .catch(() => {});
    }
    this.run = undefined;
    this.wanted = undefined;
  }
  /** Confirmed scope removal: release its cached data as well as its current read. */
  evictStore(storeId: string) {
    this.cached.evictStore(storeId);
    if (this.scope?.storeId === storeId) this.reset();
  }
  private reset() {
    this.close();
    this.scope = undefined;
    this.revision = undefined;
    this.entries.clear();
    this.publish('loading');
  }
  clear() {
    this.cached.clear();
    this.reset();
  }
  /** Permanent owner teardown must not publish into an unmounted renderer. */
  dispose() {
    this.disposed = true;
    this.changed = () => {};
    this.clear();
  }
  preview(sessionId: string) {
    if (this.disposed) return;
    this.revision = undefined;
    const previous = this.scope;
    this.close();
    if (previous) {
      this.cached.save(previous.storeId, previous.sessionId, this.state.messages);
      this.entries = new Map(
        (this.cached.take(previous.storeId, sessionId) ?? []).map((message) => [
          message.id,
          message,
        ]),
      );
      this.scope = { ...previous, sessionId, selection: -1 };
    } else this.entries.clear();
    this.publish('loading');
  }
  select(generation: number, selection: NativeSelection, epoch = 0) {
    if (this.disposed) return;
    const scope = {
      generation,
      storeId: selection.storeId,
      sessionId: selection.session.id,
      selection: selection.viewSelection ?? selection.viewGeneration,
      epoch,
    };
    const sameScope = JSON.stringify(scope) === JSON.stringify(this.scope);
    if (
      sameScope &&
      this.revision === selection.viewGeneration &&
      this.state.phase !== 'unavailable'
    )
      return;
    if (JSON.stringify(scope) !== JSON.stringify(this.scope)) {
      const previous = this.scope;
      this.close();
      const sameObservation = previous?.generation === generation && previous.epoch === epoch;
      const sameReading =
        previous?.generation === generation &&
        previous.storeId === scope.storeId &&
        previous.sessionId === scope.sessionId &&
        // A preview may have just taken an inactive snapshot from the old epoch.
        (sameObservation || previous.selection !== -1);
      // Reset invalidates cached observations, while the active reading remains read-only.
      // The new loading state still requires a full scan before actions resume.
      if (!sameObservation) this.cached.clear();
      else if (!sameReading)
        this.cached.save(previous.storeId, previous.sessionId, this.state.messages);
      this.entries = new Map(
        (sameReading
          ? this.state.messages
          : (this.cached.take(scope.storeId, scope.sessionId) ?? [])
        ).map((message) => [message.id, message]),
      );
      this.scope = scope;
      this.publish('loading');
    }
    this.revision = selection.viewGeneration;
    this.wanted = selection.session.nextSeq;
    void this.drain();
  }
  private async drain() {
    if (this.run || !this.scope || !this.wanted) return;
    const scope = this.scope,
      upperSeq = this.wanted,
      run = { readId: crypto.randomUUID(), canceled: false };
    this.wanted = undefined;
    this.run = run;
    this.publish('loading');
    const scanned = new Map<string, Message>();
    let afterSeq = '0';
    try {
      for (;;) {
        const page = await this.bridge.request({
          method: 'messages',
          generation: scope.generation,
          sessionId: scope.sessionId,
          expectedStoreId: scope.storeId,
          readId: run.readId,
          afterSeq,
          upperSeq,
          limit: 200,
        });
        if (run.canceled || this.scope !== scope) return;
        if (!page || !('messages' in page) || page.highWaterSeq !== upperSeq)
          throw Error('history_page_identity_mismatch');
        let last = BigInt(afterSeq);
        for (const message of page.messages) {
          if (
            message.sessionId !== scope.sessionId ||
            BigInt(message.seq) <= last ||
            BigInt(message.seq) > BigInt(upperSeq)
          )
            throw Error('history_page_sequence_mismatch');
          last = BigInt(message.seq);
        }
        for (const message of page.messages) scanned.set(message.id, message);
        if (page.nextAfterSeq === null) break;
        if (!page.messages.length || page.nextAfterSeq !== page.messages.at(-1)!.seq)
          throw Error('history_page_cursor_mismatch');
        afterSeq = page.nextAfterSeq;
      }
      // EOF proves the complete reading, including removal or replacement of older records.
      this.entries = scanned;
      this.publish(this.wanted ? 'loading' : 'complete', upperSeq);
    } catch (error) {
      if (!run.canceled && this.scope === scope) {
        // A failed scan proves only its legal prefix; retain the last reading beyond it.
        for (const [id, message] of scanned) this.entries.set(id, message);
        this.publish('unavailable', this.state.highWaterSeq, (error as Error).message);
      }
    } finally {
      if (this.run === run) this.run = undefined;
      await this.bridge
        .request({ method: 'messages.close', generation: scope.generation, readId: run.readId })
        .catch(() => {});
      if (!run.canceled && this.scope === scope && this.wanted) void this.drain();
    }
  }
}
