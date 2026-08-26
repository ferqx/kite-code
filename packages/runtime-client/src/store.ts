import type {
  RuntimeClientEvent,
  RuntimeNotification,
  RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';

export interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export type RuntimeClientConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'active'
  | 'reconnecting'
  | 'draining'
  | 'closed';

export interface RuntimeClientSessionState {
  readonly projection: RuntimeSessionProjection;
  readonly subscriptionGeneration: number;
  readonly ready: boolean;
  readonly historyResyncRequired: boolean;
}

export interface RuntimeClientEphemeralStream {
  readonly sessionId: string;
  readonly workId: string;
  readonly turnId: string;
  readonly actorId: string;
  readonly attemptId: string;
  readonly compositionRevision: string;
  readonly streamId: string;
  readonly sequence: number;
  /** Closed client-safe ephemeral event reconstructed from Protocol. */
  readonly event: RuntimeClientEvent;
}

export interface RuntimeClientSnapshot {
  readonly connectionGeneration: number;
  readonly status: RuntimeClientConnectionStatus;
  readonly serverInstanceId?: string;
  readonly index: {
    readonly subscriptionGeneration: number;
    readonly indexRevision: number;
    readonly ready: boolean;
  };
  readonly sessions: Readonly<Record<string, RuntimeClientSessionState>>;
  readonly streams: Readonly<Record<string, RuntimeClientEphemeralStream>>;
}

interface PendingIndexReset {
  readonly connectionGeneration: number;
  readonly subscriptionGeneration: number;
  readonly serverInstanceId: string;
  readonly indexRevision: number;
  readonly sessions: Map<string, RuntimeClientSessionState>;
}

export type RuntimeSnapshotApplyResult = 'applied' | 'ignored' | 'resync_required';

export class RuntimeSnapshotStore implements ObservableSnapshot<RuntimeClientSnapshot> {
  readonly #listeners = new Set<() => void>();
  #snapshot: RuntimeClientSnapshot = freezeSnapshot({
    connectionGeneration: 0,
    status: 'disconnected',
    index: { subscriptionGeneration: 0, indexRevision: 0, ready: false },
    sessions: {},
    streams: {},
  });
  #pendingIndex: PendingIndexReset | undefined;
  #notificationScheduled = false;
  #closed = false;

  getSnapshot(): RuntimeClientSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setConnection(input: {
    readonly generation: number;
    readonly status: RuntimeClientConnectionStatus;
    readonly serverInstanceId?: string;
  }): void {
    if (input.generation < this.#snapshot.connectionGeneration || this.#closed) return;
    const generationChanged = input.generation !== this.#snapshot.connectionGeneration;
    this.#pendingIndex = generationChanged ? undefined : this.#pendingIndex;
    this.#replace({
      ...this.#snapshot,
      connectionGeneration: input.generation,
      status: input.status,
      ...(input.serverInstanceId === undefined
        ? { serverInstanceId: this.#snapshot.serverInstanceId }
        : { serverInstanceId: input.serverInstanceId }),
      ...(generationChanged
        ? {
            index: {
              subscriptionGeneration: 0,
              indexRevision: 0,
              ready: false,
            },
            // Session revisions are scoped to the server connection. A replacement
            // may legitimately seed an older projection, so keep no prior
            // generation projection available while subscriptions re-establish.
            sessions: {},
            streams: {},
          }
        : {}),
    });
  }

  beginIndexReset(input: {
    readonly connectionGeneration: number;
    readonly subscriptionGeneration: number;
    readonly serverInstanceId: string;
    readonly indexRevision: number;
  }): RuntimeSnapshotApplyResult {
    if (!this.#acceptConnection(input.connectionGeneration)) return 'ignored';
    this.#pendingIndex = { ...input, sessions: new Map() };
    return 'applied';
  }

  applyIndexSession(input: {
    readonly connectionGeneration: number;
    readonly subscriptionGeneration: number;
    readonly indexRevision: number;
    readonly session: RuntimeSessionProjection;
  }): RuntimeSnapshotApplyResult {
    if (!this.#acceptConnection(input.connectionGeneration)) return 'ignored';
    const pending = this.#pendingIndex;
    if (pending && pending.subscriptionGeneration === input.subscriptionGeneration) {
      const current = pending.sessions.get(input.session.sessionId);
      const compared = compareProjection(current?.projection, input.session);
      if (compared === 'diverged') return 'resync_required';
      if (compared === 'newer') {
        pending.sessions.set(input.session.sessionId, {
          projection: input.session,
          subscriptionGeneration: input.subscriptionGeneration,
          ready: false,
          historyResyncRequired: false,
        });
      }
      return 'applied';
    }
    if (
      !this.#snapshot.index.ready ||
      input.subscriptionGeneration !== this.#snapshot.index.subscriptionGeneration ||
      input.indexRevision <= this.#snapshot.index.indexRevision
    ) {
      return 'ignored';
    }
    const existing = this.#snapshot.sessions[input.session.sessionId];
    const compared = compareProjection(existing?.projection, input.session);
    if (compared === 'diverged') return this.#markResync(input.session.sessionId);
    if (compared !== 'newer') return 'ignored';
    this.#replace({
      ...this.#snapshot,
      index: { ...this.#snapshot.index, indexRevision: input.indexRevision },
      sessions: {
        ...this.#snapshot.sessions,
        [input.session.sessionId]: {
          projection: input.session,
          subscriptionGeneration: input.subscriptionGeneration,
          ready: true,
          historyResyncRequired: existing?.historyResyncRequired ?? false,
        },
      },
    });
    return 'applied';
  }

  removeIndexSession(input: {
    readonly connectionGeneration: number;
    readonly subscriptionGeneration: number;
    readonly indexRevision: number;
    readonly sessionId: string;
  }): RuntimeSnapshotApplyResult {
    if (
      !this.#acceptConnection(input.connectionGeneration) ||
      !this.#snapshot.index.ready ||
      input.subscriptionGeneration !== this.#snapshot.index.subscriptionGeneration ||
      input.indexRevision <= this.#snapshot.index.indexRevision
    ) {
      return 'ignored';
    }
    const sessions = { ...this.#snapshot.sessions };
    delete sessions[input.sessionId];
    this.#replace({
      ...this.#snapshot,
      index: { ...this.#snapshot.index, indexRevision: input.indexRevision },
      sessions,
    });
    return 'applied';
  }

  endIndexReset(input: {
    readonly connectionGeneration: number;
    readonly subscriptionGeneration: number;
    readonly indexRevision: number;
  }): RuntimeSnapshotApplyResult {
    const pending = this.#pendingIndex;
    if (
      !pending ||
      !this.#acceptConnection(input.connectionGeneration) ||
      pending.connectionGeneration !== input.connectionGeneration ||
      pending.subscriptionGeneration !== input.subscriptionGeneration ||
      pending.indexRevision !== input.indexRevision
    ) {
      return 'ignored';
    }
    this.#pendingIndex = undefined;
    this.#replace({
      ...this.#snapshot,
      serverInstanceId: pending.serverInstanceId,
      index: {
        subscriptionGeneration: input.subscriptionGeneration,
        indexRevision: input.indexRevision,
        ready: true,
      },
      sessions: Object.fromEntries(pending.sessions),
    });
    return 'applied';
  }

  applySessionNotification(input: {
    readonly connectionGeneration: number;
    readonly subscriptionGeneration: number;
    readonly notification: RuntimeNotification;
    readonly reset?: boolean;
    readonly ready?: boolean;
  }): RuntimeSnapshotApplyResult {
    if (!this.#acceptConnection(input.connectionGeneration)) return 'ignored';
    const notification = input.notification;
    if (notification.durability === 'ephemeral') return this.#applyEphemeral(notification);
    const sessionId = notification.sessionId;
    const current = this.#snapshot.sessions[sessionId];
    if (current && input.subscriptionGeneration < current.subscriptionGeneration && !input.reset) {
      return 'ignored';
    }
    const compared = input.reset
      ? 'newer'
      : compareProjection(current?.projection, notification.projection.session);
    if (compared === 'diverged') return this.#markResync(sessionId);
    if (compared !== 'newer' && !input.ready) return 'ignored';
    const hasGap =
      !input.reset &&
      current !== undefined &&
      notification.revision > current.projection.revision + 1;
    this.#replace({
      ...this.#snapshot,
      sessions: {
        ...this.#snapshot.sessions,
        [sessionId]: {
          projection: compared === 'newer' ? notification.projection.session : current!.projection,
          subscriptionGeneration: input.subscriptionGeneration,
          ready: input.ready ?? current?.ready ?? false,
          historyResyncRequired: input.reset || hasGap || current?.historyResyncRequired === true,
        },
      },
      ...(input.reset ? { streams: removeSessionStreams(this.#snapshot.streams, sessionId) } : {}),
    });
    return hasGap ? 'resync_required' : 'applied';
  }

  markSessionReady(input: {
    readonly connectionGeneration: number;
    readonly subscriptionGeneration: number;
    readonly sessionId: string;
  }): RuntimeSnapshotApplyResult {
    if (!this.#acceptConnection(input.connectionGeneration)) return 'ignored';
    const current = this.#snapshot.sessions[input.sessionId];
    if (!current || input.subscriptionGeneration < current.subscriptionGeneration) return 'ignored';
    this.#replace({
      ...this.#snapshot,
      sessions: {
        ...this.#snapshot.sessions,
        [input.sessionId]: {
          ...current,
          subscriptionGeneration: input.subscriptionGeneration,
          ready: true,
        },
      },
    });
    return 'applied';
  }

  dispose(): void {
    this.#closed = true;
    this.#pendingIndex = undefined;
    this.#listeners.clear();
    this.#snapshot = freezeSnapshot({ ...this.#snapshot, status: 'closed', streams: {} });
  }

  #applyEphemeral(
    notification: Extract<RuntimeNotification, { durability: 'ephemeral' }>,
  ): RuntimeSnapshotApplyResult {
    const key = streamKey(notification);
    const current = this.#snapshot.streams[key];
    if (
      current &&
      current.attemptId === notification.attemptId &&
      current.streamId === notification.streamId &&
      notification.sequence <= current.sequence
    ) {
      return 'ignored';
    }
    if (
      current &&
      (current.attemptId !== notification.attemptId ||
        current.streamId !== notification.streamId) &&
      notification.sequence !== 1
    ) {
      return 'ignored';
    }
    this.#replace({
      ...this.#snapshot,
      streams: {
        ...this.#snapshot.streams,
        [key]: {
          sessionId: notification.sessionId,
          workId: notification.workId,
          turnId: notification.turnId,
          actorId: notification.actorId,
          attemptId: notification.attemptId,
          compositionRevision: notification.compositionRevision,
          streamId: notification.streamId,
          sequence: notification.sequence,
          event: notification.event,
        },
      },
    });
    return 'applied';
  }

  #markResync(sessionId: string): RuntimeSnapshotApplyResult {
    const current = this.#snapshot.sessions[sessionId];
    if (current) {
      this.#replace({
        ...this.#snapshot,
        sessions: {
          ...this.#snapshot.sessions,
          [sessionId]: { ...current, ready: false, historyResyncRequired: true },
        },
      });
    }
    return 'resync_required';
  }

  #acceptConnection(generation: number): boolean {
    return !this.#closed && generation === this.#snapshot.connectionGeneration;
  }

  #replace(snapshot: RuntimeClientSnapshot): void {
    this.#snapshot = freezeSnapshot(snapshot);
    if (this.#notificationScheduled) return;
    this.#notificationScheduled = true;
    queueMicrotask(() => {
      this.#notificationScheduled = false;
      for (const listener of this.#listeners) {
        try {
          listener();
        } catch {
          // An observer is presentation-only and cannot corrupt client state or other observers.
        }
      }
    });
  }
}

function compareProjection(
  current: RuntimeSessionProjection | undefined,
  next: RuntimeSessionProjection,
): 'newer' | 'older_or_equal' | 'diverged' {
  if (!current || next.revision > current.revision) return 'newer';
  if (next.revision < current.revision) return 'older_or_equal';
  return canonical(next) === canonical(current) ? 'older_or_equal' : 'diverged';
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function streamKey(
  notification: Extract<RuntimeNotification, { durability: 'ephemeral' }>,
): string {
  return [
    notification.sessionId,
    notification.workId,
    notification.turnId,
    notification.actorId,
  ].join('\u0000');
}

function removeSessionStreams(
  streams: Readonly<Record<string, RuntimeClientEphemeralStream>>,
  sessionId: string,
): Readonly<Record<string, RuntimeClientEphemeralStream>> {
  return Object.fromEntries(
    Object.entries(streams).filter(([, value]) => value.sessionId !== sessionId),
  );
}

function freezeSnapshot(snapshot: RuntimeClientSnapshot): RuntimeClientSnapshot {
  return Object.freeze({
    ...snapshot,
    index: Object.freeze({ ...snapshot.index }),
    sessions: Object.freeze({ ...snapshot.sessions }),
    streams: Object.freeze({ ...snapshot.streams }),
  });
}
