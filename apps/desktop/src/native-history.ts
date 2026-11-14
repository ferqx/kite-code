import type { Message } from '@kite-ai/client';
import type { NativeBridge, NativeSelection } from './native-bridge';
import { NativeHistoryCache } from './native-history-cache';
import { nativeReadDeadline } from './native-read-deadline';

export type HistoryState = {
  messages: Message[];
  phase: 'loading' | 'complete' | 'unavailable';
  /** The fixed snapshot is readable while newer durable changes are still arriving. */
  baselineReady: boolean;
  highWaterSeq?: string;
  cursor?: string;
  error?: string;
};
type HistoryTarget = { upperSeq: string; cursor?: string; baselineCursor?: string };
/** Full baselines seal placement; subsequent reads cover durable changes, including same-seq edits. */
export class NativeHistory {
  private scope?: {
    generation: number;
    storeId: string;
    sessionId: string;
    selection: number;
    epoch: number;
    previews?: boolean;
  };
  private run?: { readId: string; canceled: boolean; target: HistoryTarget };
  private wanted?: HistoryTarget;
  private cursor?: string;
  private revision?: number;
  private baselineReady = false;
  private entries = new Map<string, Message>();
  private cached = new NativeHistoryCache();
  private disposed = false;
  state: HistoryState = { messages: [], phase: 'loading', baselineReady: false };
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
      baselineReady: this.baselineReady,
      highWaterSeq,
      cursor: this.cursor,
      error,
    };
    this.changed(this.state);
  }
  close() {
    // Returning to an unchanged selection still requires a fresh reading after a pause.
    this.revision = undefined;
    this.cursor = undefined;
    this.baselineReady = false;
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
      ...(selection.canReadHistoryPreviews === true ? { previews: true } : {}),
    };
    const sameScope = JSON.stringify(scope) === JSON.stringify(this.scope);
    const target = {
      upperSeq: selection.session.nextSeq,
      cursor: selection.historyTargetCursor ?? selection.historyCursor,
      baselineCursor: selection.historyCursor,
    };
    if (
      sameScope &&
      this.revision === selection.viewGeneration &&
      (target.cursor === undefined ||
        target.cursor === this.cursor ||
        target.cursor === this.wanted?.cursor ||
        target.cursor === this.run?.target.cursor) &&
      this.state.phase !== 'unavailable'
    )
      return;
    if (!sameScope) {
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
    this.wanted = target;
    void this.drain();
  }
  private closeRead(generation: number, readId: string) {
    void this.bridge.request({ method: 'messages.close', generation, readId }).catch(() => {});
  }
  private async drain() {
    if (this.run || !this.scope || !this.wanted) return;
    const scope = this.scope,
      target = this.wanted,
      upperSeq = target.upperSeq,
      run = { readId: crypto.randomUUID(), canceled: false, target };
    this.wanted = undefined;
    const incremental =
      this.cursor !== undefined &&
      target.cursor !== undefined &&
      BigInt(this.cursor) <= BigInt(target.cursor);
    const lastReadMessage = this.state.messages.at(-1);
    if (!incremental && lastReadMessage && BigInt(upperSeq) < BigInt(lastReadMessage.seq)) {
      // A retained View can lag the message stream after reconnect. Its earlier
      // boundary cannot replace messages already read from the same session.
      this.revision = undefined;
      this.publish('loading', this.state.highWaterSeq, 'history_high_water_unavailable');
      return;
    }
    this.run = run;
    if (!incremental) this.publish('loading', this.state.highWaterSeq);
    const scanned = new Map<string, Message>();
    let afterSeq = '0';
    try {
      if (incremental) {
        await this.readChanges(scope, run, target as { upperSeq: string; cursor: string });
        return;
      }
      for (;;) {
        const page = await nativeReadDeadline(
          this.bridge.request({
            method: 'messages',
            generation: scope.generation,
            sessionId: scope.sessionId,
            expectedStoreId: scope.storeId,
            readId: run.readId,
            afterSeq,
            upperSeq,
            limit: 200,
            ...(scope.previews ? { previews: true } : {}),
          }),
        );
        if (run.canceled || this.scope !== scope) return;
        if (!page || !('messages' in page) || page.highWaterSeq !== upperSeq)
          throw Error('history_page_identity_mismatch');
        let last = BigInt(afterSeq);
        const upper = BigInt(upperSeq);
        const pageIds = new Set<string>();
        for (const message of page.messages) {
          const sequence = BigInt(message.seq);
          if (
            message.sessionId !== scope.sessionId ||
            scanned.has(message.id) ||
            pageIds.has(message.id) ||
            sequence <= last ||
            sequence > upper
          )
            throw Error('history_page_sequence_mismatch');
          pageIds.add(message.id);
          last = sequence;
        }
        if (
          page.nextAfterSeq !== null &&
          (!page.messages.length || page.nextAfterSeq !== page.messages.at(-1)!.seq)
        )
          throw Error('history_page_cursor_mismatch');
        for (const message of page.messages) scanned.set(message.id, message);
        if (page.nextAfterSeq === null) break;
        afterSeq = page.nextAfterSeq;
      }
      // EOF proves the complete reading, including removal or replacement of older records.
      this.replace(scanned);
      this.baselineReady = true;
      this.cursor = target.baselineCursor;
      if (target.cursor !== target.baselineCursor) this.wanted ??= target;
      this.publish(this.wanted ? 'loading' : 'complete', upperSeq);
    } catch (error) {
      if (!run.canceled && this.scope === scope) {
        this.cursor = undefined;
        if (
          incremental &&
          ((error as { code?: string }).code === 'cursor_expired' ||
            (error as Error).message === 'cursor_expired')
        ) {
          // The retained reading stays visible; only a full baseline may resume coverage.
          this.baselineReady = false;
          this.wanted ??= target;
          this.publish('loading', this.state.highWaterSeq);
          return;
        }
        // A failed scan proves only its legal prefix; retain the last reading beyond it.
        // Failed recalibration must not replace a newer, already visible version.
        for (const [id, message] of scanned)
          if (!this.entries.has(id)) this.entries.set(id, message);
        const code = (error as { code?: string })?.code ?? (error as Error)?.message;
        this.publish('unavailable', this.state.highWaterSeq, code);
      }
    } finally {
      if (this.run === run) this.run = undefined;
      this.closeRead(scope.generation, run.readId);
      if (!run.canceled && this.scope === scope && this.wanted) void this.drain();
    }
  }
  private replace(messages: Map<string, Message>) {
    for (const [id, message] of messages) {
      const previous = this.entries.get(id);
      if (previous && previous !== message && JSON.stringify(previous) === JSON.stringify(message))
        messages.set(id, previous);
    }
    this.entries = messages;
  }
  private async readChanges(
    scope: NonNullable<NativeHistory['scope']>,
    run: NonNullable<NativeHistory['run']>,
    target: { upperSeq: string; cursor: string },
  ) {
    if (this.cursor === target.cursor) {
      if (this.state.phase !== 'complete') this.publish('complete', this.state.highWaterSeq);
      return;
    }
    while (this.cursor !== target.cursor) {
      const afterCursor = this.cursor!;
      const updates = new Map<string, Message>(),
        removed = new Set<string>();
      let afterSeq = '0',
        nextCursor: string | undefined,
        upperSeq: string | undefined;
      for (;;) {
        const page = await nativeReadDeadline(
          this.bridge.request({
            method: 'messages',
            generation: scope.generation,
            sessionId: scope.sessionId,
            expectedStoreId: scope.storeId,
            readId: run.readId,
            upperSeq,
            afterSeq,
            limit: 200,
            changes: { afterCursor, upperCursor: target.cursor },
          }),
        );
        if (run.canceled || this.scope !== scope) return;
        if (
          !page ||
          !('messages' in page) ||
          (upperSeq !== undefined && page.highWaterSeq !== upperSeq) ||
          !page.changes ||
          page.changes.afterCursor !== afterCursor ||
          page.changes.upperCursor !== target.cursor ||
          BigInt(page.changes.nextCursor) <= BigInt(afterCursor) ||
          BigInt(page.changes.nextCursor) > BigInt(target.cursor) ||
          (nextCursor !== undefined && nextCursor !== page.changes.nextCursor)
        )
          throw Error('history_page_identity_mismatch');
        nextCursor = page.changes.nextCursor;
        upperSeq = page.highWaterSeq;
        let last = BigInt(afterSeq);
        for (const message of page.messages) {
          if (
            message.sessionId !== scope.sessionId ||
            updates.has(message.id) ||
            removed.has(message.id) ||
            BigInt(message.seq) <= last ||
            BigInt(message.seq) > BigInt(upperSeq)
          )
            throw Error('history_page_sequence_mismatch');
          last = BigInt(message.seq);
          updates.set(message.id, message);
        }
        for (const id of page.changes.removedIds) {
          if (updates.has(id) || removed.has(id)) throw Error('history_page_identity_mismatch');
          removed.add(id);
        }
        if (page.nextAfterSeq === null) break;
        if (
          BigInt(page.nextAfterSeq) <= BigInt(afterSeq) ||
          BigInt(page.nextAfterSeq) < last ||
          BigInt(page.nextAfterSeq) > BigInt(upperSeq)
        )
          throw Error('history_page_cursor_mismatch');
        afterSeq = page.nextAfterSeq;
      }
      // Commit one covered cursor batch atomically. Failed/late pages never delete old rows.
      const merged = new Map(this.entries);
      for (const id of removed) merged.delete(id);
      for (const [id, message] of updates) merged.set(id, message);
      this.replace(merged);
      this.cursor = nextCursor;
      this.publish(
        this.state.phase !== 'complete' && (this.cursor !== target.cursor || this.wanted)
          ? 'loading'
          : 'complete',
        upperSeq,
      );
    }
  }
}
