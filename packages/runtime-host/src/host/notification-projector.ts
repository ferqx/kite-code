import {
  RUNTIME_NOTIFICATION_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeNotification,
  type RuntimeSessionIndexNotification,
  type RuntimeSessionProjection,
  type RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import type { SessionProjectionChange, SessionRegistry } from './session-registry';

export const RUNTIME_HOST_DURABLE_HISTORY_LIMIT = 256;
export const RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT = 256;

interface Subscriber {
  readonly scope: 'session' | 'sessions';
  readonly sessionId?: string;
  readonly includeEphemeral: boolean;
  readonly signal?: AbortSignal;
  readonly queue: RuntimeAccessNotification[];
  readonly wake: Set<() => void>;
  readonly generation?: number;
  indexSeed?: IndexSeed;
  lastRevision?: number;
  closed: boolean;
  onAbort?: () => void;
}

interface IndexSeed {
  readonly serverInstanceId: string;
  readonly generation: number;
  readonly indexRevision: number;
  readonly projections: readonly RuntimeSessionProjection[];
  position: number;
  phase: 'begin' | 'sessions' | 'end';
}

interface StreamCursor {
  readonly attemptId: string;
  readonly compositionRevision: string;
  readonly streamId: string;
  readonly sequence: number;
}

interface ClosedEphemeralRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly turnId?: string;
}

/** Owns Host-local projection/index ordering, never Runtime execution authority. */
export class NotificationProjector {
  readonly #registry: SessionRegistry;
  readonly #serverInstanceId: string;
  readonly #history = new Map<
    string,
    Array<Extract<RuntimeNotification, { readonly durability: 'durable' }>>
  >();
  readonly #subscribers = new Set<Subscriber>();
  readonly #streamCursors = new Map<string, StreamCursor>();
  readonly #closedEphemeralRuns = new Map<string, ClosedEphemeralRun>();
  readonly #stopRegistryListener: () => void;
  #indexRevision = 0;
  #nextGeneration = 0;
  #closed = false;

  constructor(registry: SessionRegistry, input: { readonly serverInstanceId?: string } = {}) {
    this.#registry = registry;
    this.#serverInstanceId = input.serverInstanceId ?? `runtime-host-${crypto.randomUUID()}`;
    this.#stopRegistryListener = registry.onProjectionChange((change) =>
      this.#publishIndexChange(change),
    );
  }

  publish(notification: RuntimeNotification): void {
    if (this.#closed) return;
    if (notification.durability === 'durable') {
      if (
        notification.schema !== RUNTIME_NOTIFICATION_SCHEMA_ ||
        notification.sessionId !== notification.projection.session.sessionId ||
        notification.revision !== notification.projection.session.revision
      ) {
        throw new Error('Durable Runtime notification identity is inconsistent');
      }
      if (this.#registry.commitProjection(notification.projection.session) === 'unchanged') {
        this.#observeDurableTerminal(notification);
        // A historical Session can be registered by the query used to prepare
        // an initial subscription boundary. In that race the following query
        // snapshot is equal to the registry entry, but the newly registered
        // subscriber still has no baseline. Seed only those uninitialized
        // subscribers; established revision cursors must not see duplicates.
        for (const subscriber of this.#subscribers) {
          if (
            subscriber.closed ||
            subscriber.scope !== 'session' ||
            subscriber.sessionId !== notification.sessionId ||
            subscriber.lastRevision !== undefined
          ) {
            continue;
          }
          this.#enqueue(subscriber, notification);
          subscriber.lastRevision = notification.revision;
        }
        return;
      }
      this.#observeDurableTerminal(notification);
      const history = this.#history.get(notification.sessionId) ?? [];
      if (history.at(-1)?.revision === notification.revision) {
        history[history.length - 1] = notification;
      } else {
        history.push(notification);
      }
      if (history.length > RUNTIME_HOST_DURABLE_HISTORY_LIMIT) {
        history.splice(0, history.length - RUNTIME_HOST_DURABLE_HISTORY_LIMIT);
      }
      this.#history.set(notification.sessionId, history);
    } else if (!this.#acceptEphemeral(notification)) {
      return;
    }

    for (const subscriber of this.#subscribers) {
      if (
        subscriber.closed ||
        subscriber.scope !== 'session' ||
        subscriber.sessionId !== notification.sessionId
      ) {
        continue;
      }
      if (notification.durability === 'durable') {
        this.#publishDurableToSubscriber(subscriber, notification);
      } else if (subscriber.includeEphemeral) {
        this.#enqueue(subscriber, notification);
      }
    }
  }

  /** Explicit tombstone seam for a future Session lifecycle owner. */
  removeSession(sessionId: string): boolean {
    if (this.#closed) return false;
    this.#history.delete(sessionId);
    this.#deleteClosedEphemeralRuns(sessionId);
    for (const key of this.#streamCursors.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.#streamCursors.delete(key);
    }
    return this.#registry.removeProjection(sessionId);
  }

  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    const { spec } = subscription;
    const afterRevision = spec.scope === 'session' ? spec.afterRevision : undefined;
    const subscriber: Subscriber =
      spec.scope === 'session'
        ? {
            scope: 'session',
            sessionId: spec.sessionId,
            includeEphemeral: spec.includeEphemeral ?? false,
            signal: subscription.signal,
            queue: [],
            wake: new Set(),
            lastRevision: spec.afterRevision,
            closed: false,
          }
        : {
            scope: 'sessions',
            includeEphemeral: false,
            signal: subscription.signal,
            queue: [],
            wake: new Set(),
            generation: ++this.#nextGeneration,
            closed: false,
          };

    const close = (): void => this.#closeSubscriber(subscriber);
    subscriber.onAbort = close;
    if (this.#closed || subscription.signal?.aborted) {
      this.#closeSubscriber(subscriber);
    } else {
      // Register before the synchronous seed. A subsequent publish therefore
      // queues after the matching reset boundary and cannot be lost.
      this.#subscribers.add(subscriber);
      if (subscriber.scope === 'session') {
        this.#seedSession(subscriber, afterRevision);
      } else {
        this.#seedIndex(subscriber);
      }
      subscription.signal?.addEventListener('abort', close, { once: true });
    }

    return iteratorFor(subscriber, close);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopRegistryListener();
    for (const subscriber of [...this.#subscribers]) this.#closeSubscriber(subscriber);
    this.#history.clear();
    this.#streamCursors.clear();
    this.#closedEphemeralRuns.clear();
  }

  #seedSession(subscriber: Subscriber, afterRevision: number | undefined): void {
    const sessionId = subscriber.sessionId;
    if (!sessionId) return;
    const projection = this.#registry.projection(sessionId);
    if (afterRevision === undefined) {
      if (projection) this.#enqueue(subscriber, snapshotNotification(projection));
      subscriber.lastRevision = projection?.revision;
      return;
    }
    if (!projection || projection.revision <= afterRevision) return;

    const durable = (this.#history.get(sessionId) ?? []).filter(
      (notification): notification is Extract<RuntimeNotification, { durability: 'durable' }> =>
        notification.durability === 'durable' && notification.revision > afterRevision,
    );
    if (!isContinuous(afterRevision, durable) || durable.at(-1)?.revision !== projection.revision) {
      this.#enqueue(subscriber, snapshotNotification(projection));
      subscriber.lastRevision = projection.revision;
      return;
    }
    for (const notification of durable) {
      this.#enqueue(subscriber, notification);
      subscriber.lastRevision = notification.revision;
    }
  }

  #seedIndex(subscriber: Subscriber): void {
    const generation = subscriber.generation;
    if (generation === undefined) return;
    const indexRevision = this.#indexRevision;
    // Do not materialize an arbitrarily large reset in the subscriber queue.
    // The registry snapshot is captured at one index watermark and emitted
    // lazily; live changes queue behind its matching reset_end boundary.
    subscriber.indexSeed = {
      serverInstanceId: this.#serverInstanceId,
      generation,
      indexRevision,
      projections: this.#registry.projections(),
      position: 0,
      phase: 'begin',
    };
  }

  #publishIndexChange(change: SessionProjectionChange): void {
    if (this.#closed) return;
    const indexRevision = ++this.#indexRevision;
    for (const subscriber of this.#subscribers) {
      if (subscriber.closed || subscriber.scope !== 'sessions') continue;
      if (change.type === 'upsert') {
        this.#enqueueIndex(subscriber, {
          type: 'session_upsert',
          indexRevision,
          session: indexProjection(change.projection),
        });
      } else {
        this.#enqueueIndex(subscriber, {
          type: 'session_remove',
          indexRevision,
          sessionId: change.sessionId,
        });
      }
    }
  }

  #enqueueIndex(
    subscriber: Subscriber,
    notification:
      | Omit<
          Extract<RuntimeSessionIndexNotification, { type: 'index_reset_begin' }>,
          'serverInstanceId' | 'generation'
        >
      | Omit<
          Extract<RuntimeSessionIndexNotification, { type: 'index_reset_end' }>,
          'serverInstanceId' | 'generation'
        >
      | Omit<
          Extract<RuntimeSessionIndexNotification, { type: 'session_upsert' }>,
          'serverInstanceId' | 'generation'
        >
      | Omit<
          Extract<RuntimeSessionIndexNotification, { type: 'session_remove' }>,
          'serverInstanceId' | 'generation'
        >,
  ): void {
    if (subscriber.generation === undefined) return;
    this.#enqueue(subscriber, {
      ...notification,
      serverInstanceId: this.#serverInstanceId,
      generation: subscriber.generation,
    } as RuntimeSessionIndexNotification);
  }

  #publishDurableToSubscriber(
    subscriber: Subscriber,
    notification: Extract<RuntimeNotification, { durability: 'durable' }>,
  ): void {
    if (subscriber.lastRevision !== undefined) {
      if (notification.revision <= subscriber.lastRevision) return;
      if (notification.revision !== subscriber.lastRevision + 1) {
        const projection = this.#registry.projection(notification.sessionId);
        if (projection) this.#enqueue(subscriber, snapshotNotification(projection));
        subscriber.lastRevision = projection?.revision ?? notification.revision;
        return;
      }
    }
    this.#enqueue(subscriber, notification);
    subscriber.lastRevision = notification.revision;
  }

  #acceptEphemeral(
    notification: Extract<RuntimeNotification, { durability: 'ephemeral' }>,
  ): boolean {
    const projection = this.#registry.projection(notification.sessionId);
    const currentRun = projection?.currentRun;
    if (this.#isClosedEphemeral(notification, currentRun)) return false;
    if (
      currentRun?.taskId &&
      currentRun.taskId !== notification.workId &&
      currentRun.runId !== notification.workId
    )
      return false;
    if (currentRun?.activeTurnId && currentRun.activeTurnId !== notification.turnId) return false;

    const key = [
      notification.sessionId,
      notification.workId,
      notification.turnId,
      notification.actorId,
    ].join('\u0000');
    const cursor = this.#streamCursors.get(key);
    if (
      cursor?.attemptId === notification.attemptId &&
      cursor.compositionRevision === notification.compositionRevision &&
      cursor.streamId === notification.streamId &&
      notification.sequence <= cursor.sequence
    ) {
      return false;
    }
    if (
      cursor &&
      (cursor.attemptId !== notification.attemptId ||
        cursor.compositionRevision !== notification.compositionRevision ||
        cursor.streamId !== notification.streamId) &&
      notification.sequence !== 1
    ) {
      return false;
    }
    this.#streamCursors.set(key, {
      attemptId: notification.attemptId,
      compositionRevision: notification.compositionRevision,
      streamId: notification.streamId,
      sequence: notification.sequence,
    });
    return true;
  }

  #observeDurableTerminal(
    notification: Extract<RuntimeNotification, { readonly durability: 'durable' }>,
  ): void {
    const projection = notification.projection.session;
    const run = projection.currentRun;
    const event = notification.projection.event;
    const eventRunId = event?.type === 'run.terminal' ? event.runId : undefined;
    if (run && isTerminalRunStatus(run.status)) {
      this.#closedEphemeralRuns.set(closedEphemeralRunKey(notification.sessionId, run.runId), {
        sessionId: notification.sessionId,
        runId: run.runId,
        ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
        ...(run.activeTurnId === undefined ? {} : { turnId: run.activeTurnId }),
      });
    } else if (eventRunId) {
      this.#closedEphemeralRuns.set(closedEphemeralRunKey(notification.sessionId, eventRunId), {
        sessionId: notification.sessionId,
        runId: eventRunId,
        ...(run?.taskId === undefined ? {} : { taskId: run.taskId }),
        ...(run?.activeTurnId === undefined ? {} : { turnId: run.activeTurnId }),
      });
    }
  }

  #isClosedEphemeral(
    notification: Extract<RuntimeNotification, { readonly durability: 'ephemeral' }>,
    currentRun: RuntimeSessionProjection['currentRun'],
  ): boolean {
    if (currentRun && isTerminalRunStatus(currentRun.status)) {
      if (notification.runId !== undefined && notification.runId !== currentRun.runId) return false;
      if (
        notification.taskId !== undefined &&
        currentRun.taskId !== undefined &&
        notification.taskId !== currentRun.taskId
      ) {
        return false;
      }
      return notification.turnId === currentRun.activeTurnId;
    }
    for (const fence of this.#closedEphemeralRuns.values()) {
      if (fence.sessionId !== notification.sessionId) continue;
      if (notification.runId !== undefined) return notification.runId === fence.runId;
      const taskMatches =
        fence.taskId === undefined || (notification.taskId ?? notification.workId) === fence.taskId;
      const turnMatches = fence.turnId === undefined || notification.turnId === fence.turnId;
      if (taskMatches && turnMatches) return true;
    }
    return false;
  }

  #deleteClosedEphemeralRuns(sessionId: string): void {
    for (const [key, fence] of this.#closedEphemeralRuns) {
      if (fence.sessionId === sessionId) this.#closedEphemeralRuns.delete(key);
    }
  }

  #enqueue(subscriber: Subscriber, notification: RuntimeAccessNotification): void {
    if (subscriber.closed) return;
    while (subscriber.queue.length >= RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT) {
      const ephemeralIndex = subscriber.queue.findIndex(
        (queued) => 'durability' in queued && queued.durability === 'ephemeral',
      );
      if (ephemeralIndex < 0) {
        this.#closeSubscriber(subscriber);
        return;
      }
      subscriber.queue.splice(ephemeralIndex, 1);
    }
    subscriber.queue.push(notification);
    for (const wake of subscriber.wake) wake();
    subscriber.wake.clear();
  }

  #closeSubscriber(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.indexSeed = undefined;
    this.#subscribers.delete(subscriber);
    subscriber.queue.length = 0;
    if (subscriber.signal && subscriber.onAbort) {
      subscriber.signal.removeEventListener('abort', subscriber.onAbort);
    }
    for (const wake of subscriber.wake) wake();
    subscriber.wake.clear();
  }
}

function iteratorFor(
  subscriber: Subscriber,
  close: () => void,
): AsyncIterable<RuntimeAccessNotification> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<RuntimeAccessNotification>> => {
        while (!subscriber.closed) {
          const seeded = takeIndexSeed(subscriber);
          if (seeded) return { done: false, value: seeded };
          const queued = subscriber.queue.shift();
          if (queued) return { done: false, value: queued };
          await new Promise<void>((resolve) => subscriber.wake.add(resolve));
        }
        return { done: true, value: undefined };
      },
      return: async (): Promise<IteratorResult<RuntimeAccessNotification>> => {
        close();
        return { done: true, value: undefined };
      },
    }),
  };
}

function takeIndexSeed(subscriber: Subscriber): RuntimeSessionIndexNotification | undefined {
  const seed = subscriber.indexSeed;
  if (!seed) return undefined;
  if (seed.phase === 'begin') {
    seed.phase = seed.projections.length === 0 ? 'end' : 'sessions';
    return {
      type: 'index_reset_begin',
      serverInstanceId: seed.serverInstanceId,
      generation: seed.generation,
      indexRevision: seed.indexRevision,
    };
  }
  if (seed.phase === 'sessions') {
    const projection = seed.projections[seed.position++];
    if (!projection) {
      seed.phase = 'end';
      return takeIndexSeed(subscriber);
    }
    if (seed.position >= seed.projections.length) seed.phase = 'end';
    return {
      type: 'session_upsert',
      serverInstanceId: seed.serverInstanceId,
      generation: seed.generation,
      indexRevision: seed.indexRevision,
      session: indexProjection(projection),
    };
  }
  subscriber.indexSeed = undefined;
  return {
    type: 'index_reset_end',
    serverInstanceId: seed.serverInstanceId,
    generation: seed.generation,
    indexRevision: seed.indexRevision,
  };
}

function isContinuous(
  afterRevision: number,
  notifications: readonly Extract<RuntimeNotification, { durability: 'durable' }>[],
): boolean {
  let expected = afterRevision + 1;
  for (const notification of notifications) {
    if (notification.revision !== expected) return false;
    expected += 1;
  }
  return notifications.length > 0;
}

function snapshotNotification(
  projection: NonNullable<ReturnType<SessionRegistry['projection']>>,
): Extract<RuntimeNotification, { durability: 'durable' }> {
  return {
    schema: RUNTIME_NOTIFICATION_SCHEMA_,
    durability: 'durable',
    sessionId: projection.sessionId,
    revision: projection.revision,
    projection: { kind: 'snapshot', session: projection },
  };
}

/** Session-index DTOs remain path-free even for the in-process Host publisher. */
function indexProjection(projection: RuntimeSessionProjection): RuntimeSessionProjection {
  const { workspace: _workspace, ...safe } = projection;
  return safe;
}

function closedEphemeralRunKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId}`;
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
