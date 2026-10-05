import { type BrowserView, ClientError, type Message, parseCursorSequence } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';

export interface WebSnapshot {
  readonly sessionId: string;
  readonly generation: number;
  readonly view: BrowserView;
  readonly messages: readonly Message[];
}
export interface WebUpdate {
  readonly sessionId: string;
  readonly generation: number;
  readonly phase: 'loading' | 'ready' | 'stale' | 'error';
  readonly snapshot?: WebSnapshot;
  readonly error?: string;
}
export interface WebOptions {
  readonly admittedClient: BrowserClient;
  readonly onUpdate: (update: WebUpdate) => void;
  readonly initiallyVisible?: boolean;
  readonly pollIntervalMs?: number;
}

/** Selected visible activity only: one read at a time, no SSE or execution ownership. */
export class WebController {
  private readonly options: WebOptions;
  private readonly interval: number;
  private generation = 0;
  private selected: string | undefined;
  private visible: boolean;
  private disposed = false;
  private current: WebSnapshot | undefined;
  private activity: { sessionId: string; generation: number; active: boolean } | undefined;
  private pending:
    | { controller: AbortController; promise: Promise<WebSnapshot | undefined> }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WebOptions) {
    if (!options.admittedClient.serverInfo) throw new ClientError('connection_not_admitted');
    this.options = options;
    this.visible = options.initiallyVisible ?? true;
    this.interval = options.pollIntervalMs ?? 2000;
    if (!Number.isSafeInteger(this.interval) || this.interval < 1)
      throw new ClientError('invalid_poll_interval');
  }
  get snapshot(): WebSnapshot | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }
  async selectSession(sessionId: string): Promise<WebSnapshot | undefined> {
    if (this.disposed) throw new ClientError('controller_disposed');
    this.stopRead();
    this.generation++;
    this.selected = sessionId;
    this.current = undefined;
    this.activity = undefined;
    this.publish('loading');
    return this.refresh();
  }
  clearSelection(): void {
    if (this.disposed) return;
    this.stopRead();
    this.generation++;
    this.selected = undefined;
    this.current = undefined;
    this.activity = undefined;
  }
  refresh(): Promise<WebSnapshot | undefined> {
    if (this.disposed) return Promise.reject(new ClientError('controller_disposed'));
    if (!this.selected) return Promise.resolve(undefined);
    if (this.pending) return this.pending.promise;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const sessionId = this.selected,
      generation = this.generation;
    const controller = new AbortController();
    const promise = this.read(sessionId, generation, controller.signal).finally(() => {
      if (this.pending?.controller === controller) {
        this.pending = undefined;
        this.schedule();
      }
    });
    this.pending = { controller, promise };
    return promise;
  }
  private async read(
    sessionId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<WebSnapshot | undefined> {
    try {
      const client = this.options.admittedClient;
      const view = await client.getView(sessionId, { signal });
      if (
        this.disposed ||
        generation !== this.generation ||
        sessionId !== this.selected ||
        signal.aborted
      )
        return undefined;
      this.activity = { sessionId, generation, active: view.runs.some((run) => run.isActive) };
      // The Store's nextSeq is the last allocated Session sequence (commands share this ledger).
      const upperSeq = parseCursorSequence(view.session.nextSeq).toString();
      const messages: Message[] = [];
      let afterSeq: string | undefined;
      while (BigInt(upperSeq) > 0n) {
        signal.throwIfAborted();
        const page = await client.listMessages(sessionId, {
          afterSeq,
          upperSeq,
          limit: 200,
          signal,
        });
        let previous = afterSeq === undefined ? -1n : parseCursorSequence(afterSeq);
        for (const message of page) {
          const seq = parseCursorSequence(message.seq);
          if (message.sessionId !== sessionId || seq <= previous || seq > BigInt(upperSeq))
            throw new ClientError('history_page_conflict');
          previous = seq;
          messages.push(message);
        }
        if (page.length < 200 || previous === BigInt(upperSeq)) break;
        afterSeq = previous.toString();
      }
      const latest = await client.getView(sessionId, { signal });
      if (
        !this.disposed &&
        generation === this.generation &&
        sessionId === this.selected &&
        !signal.aborted
      )
        this.activity = { sessionId, generation, active: latest.runs.some((run) => run.isActive) };
      if (
        latest.storeId !== view.storeId ||
        latest.session.contextSelectionId !== view.session.contextSelectionId ||
        latest.session.controlRevision !== view.session.controlRevision ||
        latest.snapshotCursor !== view.snapshotCursor
      )
        throw new ClientError('history_snapshot_changed');
      if (
        this.disposed ||
        generation !== this.generation ||
        sessionId !== this.selected ||
        signal.aborted
      )
        return undefined;
      this.current = { sessionId, generation, view: latest, messages };
      this.publish('ready');
      return this.snapshot;
    } catch (error) {
      if (
        this.disposed ||
        generation !== this.generation ||
        sessionId !== this.selected ||
        signal.aborted
      )
        return undefined;
      this.publish(
        this.current ? 'stale' : 'error',
        error instanceof ClientError ? error.code : 'browser_read_unavailable',
      );
      throw error;
    }
  }
  private publish(phase: WebUpdate['phase'], error?: string) {
    if (!this.selected || this.disposed) return;
    this.options.onUpdate({
      sessionId: this.selected,
      generation: this.generation,
      phase,
      ...(this.current ? { snapshot: this.snapshot } : {}),
      ...(error ? { error } : {}),
    });
  }
  private schedule(): void {
    if (
      !this.visible ||
      this.disposed ||
      !this.activity?.active ||
      this.activity.sessionId !== this.selected ||
      this.activity.generation !== this.generation
    )
      return;
    this.timer = setTimeout(() => {
      void this.refresh().catch(() => {});
    }, this.interval);
  }
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      this.stopRead();
      return;
    }
    void this.refresh().catch(() => {});
  }
  private stopRead(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending?.controller.abort();
    this.pending = undefined;
  }
  /** Route/document observers release only their own reads; browser-session close is explicit. */
  disposeObserver(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRead();
    this.current = undefined;
  }
}
