import type { Message } from '@kite-ai/client';
import type { NativeBridge, NativeHistoryChange, NativeSelection } from './native-bridge';
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
type HistoryScope = {
  generation: number;
  storeId: string;
  sessionId: string;
  selection: number;
  epoch: number;
  previews?: boolean;
};

function isHistoryChange(scope: HistoryScope | undefined, notice: NativeHistoryChange) {
  return (
    scope?.generation === notice.generation &&
    scope.storeId === notice.storeId &&
    scope.sessionId === notice.sessionId &&
    scope.selection === notice.viewSelection &&
    scope.epoch === notice.historyEpoch
  );
}
/** Full baselines seal placement; subsequent reads cover durable changes, including same-seq edits. */
export class NativeHistory {
  private scope?: HistoryScope;
  private run?: { readId: string; canceled: boolean; target: HistoryTarget };
  private wanted?: HistoryTarget;
  private baseline?: HistoryTarget;
  private notice?: NativeHistoryChange;
  private pendingNotice?: NativeHistoryChange;
  private cursor?: string;
  private revision?: number;
  private baselineReady = false;
  private messages: Message[] = [];
  private positions = new Map<string, number>();
  private readonly inlineReasoningVersions = new WeakMap<Message, string>();
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
      messages: this.messages,
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
    this.baseline = undefined;
    this.notice = undefined;
    this.pendingNotice = undefined;
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
    this.install([]);
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
    const pending = this.pendingNotice?.sessionId === sessionId ? this.pendingNotice : undefined;
    this.close();
    this.pendingNotice = pending;
    if (previous) {
      this.cached.save(previous.storeId, previous.sessionId, this.state.messages);
      this.install(this.cached.take(previous.storeId, sessionId) ?? []);
      this.scope = { ...previous, sessionId, selection: -1 };
    } else this.install([]);
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
    const notice =
      this.pendingNotice && isHistoryChange(scope, this.pendingNotice)
        ? this.pendingNotice
        : this.notice && isHistoryChange(scope, this.notice)
          ? this.notice
          : undefined;
    const baseline = {
      upperSeq: selection.session.nextSeq,
      cursor: selection.historyTargetCursor ?? selection.historyCursor,
      baselineCursor: selection.historyCursor,
    };
    const target =
      notice && baseline.cursor !== undefined && BigInt(notice.cursor) > BigInt(baseline.cursor)
        ? { ...baseline, cursor: notice.cursor }
        : baseline;
    // A View read started before the last notification can carry an older cursor.
    if (sameScope) this.baseline = baseline;
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
      if (!sameReading) this.install(this.cached.take(scope.storeId, scope.sessionId) ?? []);
      this.scope = scope;
      this.publish('loading');
    }
    this.notice = notice;
    this.revision = selection.viewGeneration;
    this.baseline = baseline;
    this.wanted = target;
    void this.drain();
  }
  advance(notice: NativeHistoryChange) {
    if (this.disposed) return;
    const baseline = this.baseline;
    if (
      baseline &&
      this.scope &&
      (this.scope.generation !== notice.generation ||
        this.scope.storeId !== notice.storeId ||
        this.scope.sessionId !== notice.sessionId ||
        this.scope.selection > notice.viewSelection ||
        (this.scope.selection === notice.viewSelection && this.scope.epoch > notice.historyEpoch))
    )
      return;
    // A notice may arrive while the selecting IPC is still resolving. That read
    // establishes the original Store, selection and baseline before we advance it.
    if (!isHistoryChange(this.scope, notice) || !baseline) {
      this.pendingNotice = notice;
      return;
    }
    if (
      !baseline.cursor ||
      BigInt(notice.cursor) <= BigInt(this.notice?.cursor ?? baseline.cursor) ||
      BigInt(notice.cursor) <= BigInt(baseline.cursor)
    )
      return;
    this.notice = notice;
    this.wanted = { ...baseline, cursor: notice.cursor };
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
      this.install([...scanned.values()].map((message) => this.retain(message, run.readId)));
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
        this.applyChanges(
          [...scanned.values()].filter((message) => !this.positions.has(message.id)),
          new Set(),
        );
        const code = (error as { code?: string })?.code ?? (error as Error)?.message;
        this.publish('unavailable', this.state.highWaterSeq, code);
      }
    } finally {
      if (this.run === run) this.run = undefined;
      this.closeRead(scope.generation, run.readId);
      if (!run.canceled && this.scope === scope && this.wanted) void this.drain();
    }
  }
  inlineReasoningRevision(message: Message) {
    return message.inlineReasoningBytes === undefined
      ? this.inlineReasoningVersions.get(message)
      : `bytes:${message.inlineReasoningBytes}`;
  }
  private install(messages: Message[]) {
    this.messages = messages;
    this.positions = new Map(messages.map((message, index) => [message.id, index]));
  }
  private retain(message: Message, revision: string, previous?: Message): Message {
    previous ??= this.messages[this.positions.get(message.id) ?? -1];
    if (previous === message) return message;
    const retained =
      previous && JSON.stringify(previous) === JSON.stringify(message) ? previous : message;
    // Older Services omit the byte count. A returned row may then have new reasoning
    // even when all its public fields stayed the same.
    if (
      retained.status === 'incomplete' &&
      retained.firstOutput === 'reasoning' &&
      !retained.outputBody &&
      retained.inlineReasoningBytes === undefined
    )
      this.inlineReasoningVersions.set(retained, revision);
    return retained;
  }
  private applyChanges(updates: Iterable<Message>, removed: Set<string>, revision?: string) {
    let next = this.messages;
    const inserted: Message[] = [];
    for (const update of updates) {
      const position = this.positions.get(update.id) ?? -1;
      const previous = this.messages[position];
      const message = revision ? this.retain(update, revision, previous) : update;
      if (!previous) inserted.push(message);
      else if (previous.seq !== message.seq) {
        removed.add(message.id);
        inserted.push(message);
      } else if (message !== previous) {
        if (next === this.messages) next = next.slice();
        next[position] = message;
      }
    }
    const tail = next.at(-1);
    if (removed.size || (tail && inserted.length && BigInt(inserted[0]!.seq) <= BigInt(tail.seq))) {
      this.install(
        next
          .filter((message) => !removed.has(message.id))
          .concat(inserted)
          .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1)),
      );
      return;
    }
    // The delta pages already prove the order of new tail rows. A same-sequence
    // revision leaves the index intact and an empty delta can reuse the array.
    for (const [offset, message] of inserted.entries())
      this.positions.set(message.id, next.length + offset);
    this.messages = inserted.length ? next.concat(inserted) : next;
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
      this.applyChanges(updates.values(), removed, nextCursor!);
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
