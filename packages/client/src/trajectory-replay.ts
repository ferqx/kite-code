import {
  canonicalSerialize,
  type Decimal64,
  parseDecimal64,
  type TrajectoryPage,
  type TrajectoryReadRequest,
  type TrajectorySnapshot,
  trajectorySnapshotSchema,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';

/** Already-validated local facts only. Transport and authorization belong to the explicit loader. */
export interface TrajectoryReplaySource {
  readonly snapshot: TrajectorySnapshot;
  readonly offline: boolean;
  readonly minimumCursor?: Decimal64;
  readEvents(request: TrajectoryReadRequest, signal?: AbortSignal): Promise<TrajectoryPage>;
}
export type TrajectoryReplayMode = 'live' | 'history' | 'replay';
export interface TrajectoryReplayState {
  mode: TrajectoryReplayMode;
  offline: boolean;
  cursor: Decimal64;
  upperCursor: Decimal64;
  playing: boolean;
  visible: boolean;
  newEventsAvailable: boolean;
  generation: number;
}
function scope(snapshot: TrajectorySnapshot): string {
  return canonicalSerialize({
    storeId: snapshot.storeId,
    sessionId: snapshot.sessionId,
    runId: snapshot.runId ?? null,
    executionId: snapshot.executionId ?? null,
    eventKinds: snapshot.eventKinds ?? [],
  });
}
function request(
  snapshot: TrajectorySnapshot,
  afterCursor: string,
  limit = 200,
): TrajectoryReadRequest {
  return {
    storeId: snapshot.storeId,
    sessionId: snapshot.sessionId,
    ...(snapshot.runId === undefined ? {} : { runId: snapshot.runId }),
    ...(snapshot.executionId === undefined ? {} : { executionId: snapshot.executionId }),
    ...(snapshot.eventKinds === undefined ? {} : { eventKinds: [...snapshot.eventKinds] }),
    afterCursor,
    upperCursor: snapshot.upperCursor,
    limit,
  };
}
/** Cursor/player state is pure viewing state. No Runtime, Provider, Tool or approval API is present. */
export class TrajectoryReplayController {
  private source: TrajectoryReplaySource;
  private descriptor: TrajectorySnapshot;
  private value: TrajectoryReplayState;
  private active: AbortController | null = null;
  private listeners = new Set<(state: TrajectoryReplayState) => void>();
  private closed = false;
  constructor(
    source: TrajectoryReplaySource,
    initial?: { mode?: TrajectoryReplayMode; cursor?: Decimal64 },
  ) {
    this.descriptor = trajectorySnapshotSchema.parse(structuredClone(source.snapshot));
    this.source = source;
    const cursor = initial?.cursor ?? this.descriptor.upperCursor;
    if (
      parseDecimal64(cursor) < parseDecimal64(this.source.minimumCursor ?? '0') ||
      parseDecimal64(cursor) > parseDecimal64(this.descriptor.upperCursor)
    )
      throw new Error('trajectory_cursor_ahead');
    this.value = {
      mode: source.offline ? 'replay' : (initial?.mode ?? 'live'),
      offline: source.offline,
      cursor,
      upperCursor: this.descriptor.upperCursor,
      playing: false,
      visible: true,
      newEventsAvailable: false,
      generation: 0,
    };
  }
  get state(): TrajectoryReplayState {
    return { ...this.value };
  }
  get snapshot(): TrajectorySnapshot {
    return structuredClone(this.descriptor);
  }
  subscribe(listener: (state: TrajectoryReplayState) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('trajectory_replay_closed');
  }
  private update(change: Partial<TrajectoryReplayState>): void {
    this.value = { ...this.value, ...change };
    for (const listener of this.listeners) listener(this.state);
  }
  private invalidate(): void {
    this.active?.abort();
    this.active = null;
    this.value.generation++;
  }
  seek(cursor: Decimal64): void {
    this.assertOpen();
    if (
      parseDecimal64(cursor) < parseDecimal64(this.source.minimumCursor ?? '0') ||
      parseDecimal64(cursor) > parseDecimal64(this.descriptor.upperCursor)
    )
      throw new Error('trajectory_cursor_ahead');
    this.invalidate();
    this.update({ cursor, mode: 'replay', playing: false });
  }
  setMode(mode: TrajectoryReplayMode): void {
    this.assertOpen();
    if (
      mode === 'live' &&
      (this.source.offline || this.value.cursor !== this.descriptor.upperCursor)
    )
      throw new Error('trajectory_latest_reload_required');
    this.invalidate();
    this.update({ mode, playing: false });
  }
  play(): void {
    this.assertOpen();
    if (
      this.value.visible &&
      parseDecimal64(this.value.cursor) < parseDecimal64(this.descriptor.upperCursor)
    )
      this.update({ mode: 'replay', playing: true });
  }
  pause(): void {
    this.assertOpen();
    this.invalidate();
    this.update({ playing: false });
  }
  setVisible(visible: boolean): void {
    this.assertOpen();
    this.invalidate();
    this.update({ visible, ...(visible ? {} : { playing: false }) });
  }
  notifyNewEvents(upperCursor: Decimal64): void {
    this.assertOpen();
    if (parseDecimal64(upperCursor) > parseDecimal64(this.descriptor.upperCursor))
      this.update({ newEventsAvailable: true });
  }
  /** The UI clock drives ticks; no timer or background I/O starts inside the controller. */
  async tick(): Promise<void> {
    if (!this.value.playing || !this.value.visible) return;
    const playing = this.value.playing;
    const generation = this.value.generation;
    await this.step(1);
    if (this.value.generation !== generation + 1) return;
    if (playing && this.value.visible && this.value.cursor !== this.value.upperCursor)
      this.update({ playing: true });
  }
  async step(direction: -1 | 1): Promise<void> {
    this.assertOpen();
    this.invalidate();
    const abort = new AbortController();
    this.active = abort;
    const generation = this.value.generation;
    const current = parseDecimal64(this.value.cursor);
    let cursor = direction === 1 ? this.value.cursor : (this.source.minimumCursor ?? '0');
    let previous = this.source.minimumCursor ?? '0';
    try {
      while (true) {
        abort.signal.throwIfAborted();
        const query = request(this.descriptor, cursor, direction === 1 ? 1 : 200);
        const page = verifyTrajectoryPage(await this.source.readEvents(query, abort.signal), query);
        abort.signal.throwIfAborted();
        if (generation !== this.value.generation) return;
        if (direction === 1 && page.events[0]) {
          previous = page.events[0].sequence;
          break;
        }
        if (direction === -1) {
          let reached = false;
          for (const event of page.events) {
            if (parseDecimal64(event.sequence) >= current) {
              reached = true;
              break;
            }
            previous = event.sequence;
          }
          if (reached || parseDecimal64(page.scannedThrough) >= current) break;
        }
        if (page.exhausted) {
          if (direction === 1) previous = this.descriptor.upperCursor;
          break;
        }
        cursor = page.scannedThrough;
      }
      this.update({ cursor: previous, mode: 'replay', playing: false });
    } finally {
      if (this.active === abort) this.active = null;
    }
  }
  /** Fixed snapshots never incorporate notifications implicitly. Reload is an explicit loader action. */
  async returnToLatest(
    loadLatest?: (signal: AbortSignal) => Promise<TrajectoryReplaySource>,
  ): Promise<void> {
    this.assertOpen();
    this.invalidate();
    if (this.source.offline) {
      this.update({
        cursor: this.descriptor.upperCursor,
        mode: 'replay',
        playing: false,
        newEventsAvailable: false,
      });
      return;
    }
    if (!loadLatest) throw new Error('trajectory_latest_loader_required');
    const abort = new AbortController();
    this.active = abort;
    const generation = this.value.generation;
    try {
      const source = await loadLatest(abort.signal);
      abort.signal.throwIfAborted();
      const descriptor = trajectorySnapshotSchema.parse(structuredClone(source.snapshot));
      if (
        source.offline ||
        scope(descriptor) !== scope(this.descriptor) ||
        parseDecimal64(descriptor.upperCursor) < parseDecimal64(this.descriptor.upperCursor)
      )
        throw new Error('trajectory_latest_identity_mismatch');
      if (generation !== this.value.generation) return;
      this.source = source;
      this.descriptor = descriptor;
      this.update({
        mode: 'live',
        cursor: descriptor.upperCursor,
        upperCursor: descriptor.upperCursor,
        playing: false,
        newEventsAvailable: false,
      });
    } finally {
      if (this.active === abort) this.active = null;
    }
  }
  /** A consumer can stream the exact prefix without retaining all source events. */
  async *readPrefix(signal?: AbortSignal): AsyncGenerator<{
    events: TrajectoryPage['events'];
    scannedThrough: Decimal64;
    atCursor: Decimal64;
    exhausted: boolean;
    completePrefix: boolean;
  }> {
    this.assertOpen();
    this.invalidate();
    const abort = new AbortController();
    const forwardAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    this.active = abort;
    const generation = this.value.generation;
    const at = parseDecimal64(this.value.cursor);
    let after = this.source.minimumCursor ?? '0';
    try {
      while (true) {
        abort.signal.throwIfAborted();
        const query = request(this.descriptor, after);
        const page = verifyTrajectoryPage(await this.source.readEvents(query, abort.signal), query);
        abort.signal.throwIfAborted();
        if (generation !== this.value.generation) throw new Error('trajectory_selection_changed');
        yield {
          events: page.events.filter((event) => parseDecimal64(event.sequence) <= at),
          scannedThrough:
            parseDecimal64(page.scannedThrough) > at ? this.value.cursor : page.scannedThrough,
          atCursor: this.value.cursor,
          exhausted: page.exhausted || parseDecimal64(page.scannedThrough) >= at,
          completePrefix: (this.source.minimumCursor ?? '0') === '0',
        };
        if (page.exhausted || parseDecimal64(page.scannedThrough) >= at) return;
        after = page.scannedThrough;
      }
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (this.active === abort) this.active = null;
      abort.abort();
    }
  }
  close(): void {
    if (this.closed) return;
    this.invalidate();
    this.closed = true;
    this.listeners.clear();
    this.value.playing = false;
  }
}
