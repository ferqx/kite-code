import type { Message } from '@kite-ai/client';
import type { NativeBridge, NativeSelection } from './native-bridge';

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
  private cached = new Map<string, Message[]>();
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
  preview(sessionId: string) {
    this.revision = undefined;
    const previous = this.scope;
    this.close();
    if (previous) {
      this.cached.set(`${previous.storeId}/${previous.sessionId}`, this.state.messages);
      while (this.cached.size > 8) this.cached.delete(this.cached.keys().next().value!);
      this.entries = new Map(
        (this.cached.get(`${previous.storeId}/${sessionId}`) ?? []).map((message) => [
          message.id,
          message,
        ]),
      );
      this.scope = { ...previous, sessionId, selection: -1 };
    } else this.entries.clear();
    this.publish('loading');
  }
  select(generation: number, selection: NativeSelection, epoch = 0) {
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
    this.revision = selection.viewGeneration;
    if (JSON.stringify(scope) !== JSON.stringify(this.scope)) {
      const previous = this.scope;
      this.close();
      if (previous && previous.generation === generation && previous.epoch === epoch) {
        this.cached.set(`${previous.storeId}/${previous.sessionId}`, this.state.messages);
        while (this.cached.size > 8) this.cached.delete(this.cached.keys().next().value!);
      } else this.cached.clear();
      const same = previous?.storeId === scope.storeId && previous.sessionId === scope.sessionId;
      this.entries = new Map(
        (same
          ? this.state.messages
          : (this.cached.get(`${scope.storeId}/${scope.sessionId}`) ?? [])
        ).map((message) => [message.id, message]),
      );
      this.scope = scope;
      this.publish('loading');
    }
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
        for (const message of page.messages) this.entries.set(message.id, message);
        if (page.nextAfterSeq === null) break;
        if (!page.messages.length || page.nextAfterSeq !== page.messages.at(-1)!.seq)
          throw Error('history_page_cursor_mismatch');
        afterSeq = page.nextAfterSeq;
      }
      this.publish(this.wanted ? 'loading' : 'complete', upperSeq);
    } catch (error) {
      if (!run.canceled && this.scope === scope)
        this.publish('unavailable', this.state.highWaterSeq, (error as Error).message);
    } finally {
      if (this.run === run) this.run = undefined;
      await this.bridge
        .request({ method: 'messages.close', generation: scope.generation, readId: run.readId })
        .catch(() => {});
      if (!run.canceled && this.scope === scope && this.wanted) void this.drain();
    }
  }
}
