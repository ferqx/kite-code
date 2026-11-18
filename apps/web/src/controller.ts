import {
  type BrowserView,
  ClientError,
  estimateSnapshotBytes,
  type Message,
  parseCursorSequence,
} from '@kite-ai/client';
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

function sameHistoryScope(left: BrowserView, right: BrowserView) {
  return (
    left.storeId === right.storeId &&
    left.session.id === right.session.id &&
    left.session.contextSelectionId === right.session.contextSelectionId &&
    left.session.controlRevision === right.session.controlRevision
  );
}

const historyPageSize = 200;
// The Store covers up to 200 global change events per cursor batch, independently of page size.
const eventsPerChangeBatch = 200n;

function baselineCostsLess(saved: WebSnapshot, view: BrowserView) {
  const addedSlots = BigInt(view.session.nextSeq) - BigInt(saved.view.session.nextSeq);
  if (addedSlots < 0n) return false; // Let coverChanges reject a regressed View.
  const rows = BigInt(saved.messages.length) + addedSlots;
  const pageSize = BigInt(historyPageSize);
  const pages = rows === 0n ? 1n : (rows + pageSize - 1n) / pageSize;
  const events = BigInt(view.snapshotCursor) - BigInt(saved.view.snapshotCursor);
  // A fresh scan also needs a closing View. Both paths still verify their full target.
  return events > (pages + 1n) * eventsPerChangeBatch;
}

function historyPageReader(signal: AbortSignal) {
  let limit = historyPageSize;
  return async function readPage<T>(load: (limit: number) => Promise<T>) {
    for (;;) {
      signal.throwIfAborted();
      try {
        return { page: await load(limit), limit };
      } catch (error) {
        if (!(error instanceof ClientError && error.code === 'response_too_large') || limit === 1)
          throw error;
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }
  };
}

async function readBaseline(client: BrowserClient, view: BrowserView, signal: AbortSignal) {
  const sessionId = view.session.id;
  // The Store's nextSeq is the last allocated Session sequence (commands share this ledger).
  const upperSeq = parseCursorSequence(view.session.nextSeq).toString();
  const messages: Message[] = [];
  const ids = new Set<string>();
  const readPage = historyPageReader(signal);
  let afterSeq: string | undefined;
  while (BigInt(upperSeq) > 0n) {
    const { page, limit } = await readPage((limit) =>
      client.listMessages(sessionId, { afterSeq, upperSeq, limit, signal }),
    );
    let previous = afterSeq === undefined ? -1n : parseCursorSequence(afterSeq);
    for (const message of page) {
      const seq = parseCursorSequence(message.seq);
      if (
        message.sessionId !== sessionId ||
        ids.has(message.id) ||
        seq <= previous ||
        seq > BigInt(upperSeq)
      )
        throw new ClientError('history_page_conflict');
      previous = seq;
      ids.add(message.id);
      messages.push(message);
    }
    if (page.length < limit || previous === BigInt(upperSeq)) break;
    afterSeq = previous.toString();
  }
  return messages;
}

/** Reconcile to a fixed target even if more events arrive while these pages are in flight. */
async function coverChanges(
  client: BrowserClient,
  source: readonly Message[],
  from: BrowserView,
  to: BrowserView,
  signal: AbortSignal,
): Promise<readonly Message[]> {
  const upperCursor = to.snapshotCursor;
  const upperSeq = to.session.nextSeq;
  if (
    !sameHistoryScope(from, to) ||
    BigInt(from.snapshotCursor) > BigInt(upperCursor) ||
    BigInt(from.session.nextSeq) > BigInt(upperSeq)
  )
    throw new ClientError('history_snapshot_changed');
  if (from.snapshotCursor === upperCursor) {
    if (from.session.nextSeq !== upperSeq) throw new ClientError('history_snapshot_changed');
    return source;
  }
  if (!client.serverInfo?.capabilities?.includes('message_changes'))
    throw new ClientError('history_snapshot_changed');

  let rows: Map<string, Message> | undefined;
  const readPage = historyPageReader(signal);
  let afterCursor = from.snapshotCursor;
  while (afterCursor !== upperCursor) {
    const seen = new Set<string>();
    let afterSeq: string | undefined, nextCursor: string | undefined;
    do {
      const { page } = await readPage((limit) =>
        client.listMessageChanges(
          to.session.id,
          { afterCursor, upperCursor, upperSeq, afterSeq, limit },
          { signal },
        ),
      );
      if (nextCursor !== undefined && nextCursor !== page.nextCursor)
        throw new ClientError('history_page_cursor_mismatch');
      nextCursor = page.nextCursor;
      afterSeq = page.nextAfterSeq ?? undefined;
      if (!page.removedIds.length && !page.messages.length) continue;
      rows ??= new Map(source.map((message) => [message.id, message]));
      for (const id of page.removedIds) {
        if (seen.has(id)) throw new ClientError('history_page_conflict');
        seen.add(id);
        rows.delete(id);
      }
      for (const message of page.messages) {
        const previous = rows.get(message.id);
        if (seen.has(message.id) || (previous && previous.seq !== message.seq))
          throw new ClientError('history_page_conflict');
        seen.add(message.id);
        rows.set(message.id, message);
      }
    } while (afterSeq !== undefined);
    afterCursor = nextCursor;
  }
  if (!rows) return source;
  const sorted = [...rows.values()].sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)));
  if (sorted.some((message, index) => index > 0 && sorted[index - 1]!.seq === message.seq))
    throw new ClientError('history_page_conflict');
  return sorted;
}

/** Selected visible activity only: one read at a time, no SSE or execution ownership. */
export class WebController {
  private readonly options: WebOptions;
  private readonly interval: number;
  private generation = 0;
  private failures = 0;
  private selected: string | undefined;
  private visible: boolean;
  private disposed = false;
  private current: WebSnapshot | undefined;
  // Only verified History/View data. No Model body reader or observer survives a switch.
  private readonly retained = new Map<string, WebSnapshot>();
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
    const previous = this.current;
    if (
      previous &&
      !this.failures &&
      this.options.admittedClient.serverInfo?.capabilities?.includes('message_changes')
    ) {
      const perSessionBytes = 4 * 1024 * 1024;
      this.retained.delete(previous.sessionId);
      if (estimateSnapshotBytes(previous, perSessionBytes) <= perSessionBytes) {
        this.retained.set(previous.sessionId, previous);
        if (this.retained.size > 3) this.retained.delete(this.retained.keys().next().value!);
      }
    }
    this.stopRead();
    this.generation++;
    this.failures = 0;
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
    this.failures = 0;
    this.selected = undefined;
    this.current = undefined;
    this.retained.clear();
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
      let latest = view;
      let messages: readonly Message[] | undefined;
      const saved = this.current ?? this.retained.get(sessionId);
      if (
        saved &&
        sameHistoryScope(saved.view, view) &&
        client.serverInfo?.capabilities?.includes('message_changes') &&
        !baselineCostsLess(saved, view)
      ) {
        try {
          messages = await coverChanges(client, saved.messages, saved.view, view, signal);
        } catch (error) {
          if (!(error instanceof ClientError && error.code === 'cursor_expired')) throw error;
        }
      }
      if (messages === undefined) {
        const baseline = await readBaseline(client, view, signal);
        latest = await client.getView(sessionId, { signal });
        signal.throwIfAborted();
        this.activity = { sessionId, generation, active: latest.runs.some((run) => run.isActive) };
        messages = await coverChanges(client, baseline, view, latest, signal);
      }
      if (
        this.disposed ||
        generation !== this.generation ||
        sessionId !== this.selected ||
        signal.aborted
      )
        return undefined;
      this.current = { sessionId, generation, view: latest, messages };
      this.retained.delete(sessionId);
      this.failures = 0;
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
      this.failures++;
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
      !this.selected ||
      (!this.failures &&
        (!this.activity?.active ||
          this.activity.sessionId !== this.selected ||
          this.activity.generation !== this.generation))
    )
      return;
    this.timer = setTimeout(
      () => {
        void this.refresh().catch(() => {});
      },
      this.failures
        ? Math.min(30000, this.interval * 2 ** Math.min(this.failures - 1, 4))
        : this.interval,
    );
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
    this.retained.clear();
  }
}
