import {
  RUNTIME_NOTIFICATION_SCHEMA_V1,
  type RuntimeNotification,
  type RuntimeSubscription,
} from '@kite/runtime-contract';
import type { SessionRegistry } from './session-registry';

export const RUNTIME_HOST_DURABLE_HISTORY_LIMIT = 256;
export const RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT = 256;

interface Subscriber {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly queue: RuntimeNotification[];
  readonly wake: Set<() => void>;
  lastRevision?: number;
  closed: boolean;
  onAbort?: () => void;
}

interface StreamCursor {
  readonly attemptId: string;
  readonly streamId: string;
  readonly sequence: number;
}

export class NotificationProjector {
  readonly #registry: SessionRegistry;
  readonly #history = new Map<string, RuntimeNotification[]>();
  readonly #subscribers = new Set<Subscriber>();
  readonly #streamCursors = new Map<string, StreamCursor>();
  #closed = false;

  constructor(registry: SessionRegistry) {
    this.#registry = registry;
  }

  publish(notification: RuntimeNotification): void {
    if (this.#closed) return;
    if (notification.durability === 'durable') {
      if (
        notification.schema !== RUNTIME_NOTIFICATION_SCHEMA_V1 ||
        notification.sessionId !== notification.projection.session.sessionId ||
        notification.revision !== notification.projection.session.revision
      ) {
        throw new Error('Durable Runtime notification identity is inconsistent');
      }
      const committed = this.#registry.projection(notification.sessionId);
      if (committed && notification.revision <= committed.revision) return;
      this.#registry.commitProjection(notification.projection.session);
      const history = this.#history.get(notification.sessionId) ?? [];
      history.push(notification);
      if (history.length > RUNTIME_HOST_DURABLE_HISTORY_LIMIT) {
        history.splice(0, history.length - RUNTIME_HOST_DURABLE_HISTORY_LIMIT);
      }
      this.#history.set(notification.sessionId, history);
    } else if (!this.#acceptEphemeral(notification)) {
      return;
    }

    for (const subscriber of this.#subscribers) {
      if (subscriber.closed || subscriber.sessionId !== notification.sessionId) continue;
      if (notification.durability === 'durable') {
        this.#publishDurableToSubscriber(subscriber, notification);
      } else {
        this.#enqueue(subscriber, notification);
      }
    }
  }

  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeNotification> {
    const subscriber: Subscriber = {
      sessionId: subscription.sessionId,
      signal: subscription.signal,
      queue: [],
      wake: new Set(),
      lastRevision: subscription.afterRevision,
      closed: false,
    };
    this.#seed(subscriber, subscription.afterRevision);

    const close = (): void => {
      this.#closeSubscriber(subscriber);
    };
    subscriber.onAbort = close;
    if (this.#closed || subscription.signal?.aborted) {
      this.#closeSubscriber(subscriber);
    } else {
      this.#subscribers.add(subscriber);
      subscription.signal?.addEventListener('abort', close, { once: true });
    }

    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<RuntimeNotification>> => {
          while (!subscriber.closed && subscriber.queue.length === 0) {
            await new Promise<void>((resolve) => {
              subscriber.wake.add(resolve);
            });
          }
          const value = subscriber.queue.shift();
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        return: async (): Promise<IteratorResult<RuntimeNotification>> => {
          close();
          return { done: true, value: undefined };
        },
      }),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) this.#closeSubscriber(subscriber);
    this.#history.clear();
    this.#streamCursors.clear();
  }

  #seed(subscriber: Subscriber, afterRevision: number | undefined): void {
    const projection = this.#registry.projection(subscriber.sessionId);
    if (afterRevision === undefined) {
      if (projection) this.#enqueue(subscriber, snapshotNotification(projection));
      subscriber.lastRevision = projection?.revision;
      return;
    }
    if (!projection || projection.revision <= afterRevision) return;

    const durable = (this.#history.get(subscriber.sessionId) ?? []).filter(
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
    const activeWork = projection?.activeWork;
    if (activeWork && activeWork.workId !== notification.workId) return false;
    if (activeWork?.activeTurn && activeWork.activeTurn.turnId !== notification.turnId)
      return false;

    const key = [
      notification.sessionId,
      notification.workId,
      notification.turnId,
      notification.actorId,
    ].join('\u0000');
    const cursor = this.#streamCursors.get(key);
    if (
      cursor?.attemptId === notification.attemptId &&
      cursor.streamId === notification.streamId &&
      notification.sequence <= cursor.sequence
    ) {
      return false;
    }
    if (
      cursor &&
      (cursor.attemptId !== notification.attemptId || cursor.streamId !== notification.streamId) &&
      notification.sequence !== 1
    ) {
      return false;
    }
    this.#streamCursors.set(key, {
      attemptId: notification.attemptId,
      streamId: notification.streamId,
      sequence: notification.sequence,
    });
    return true;
  }

  #enqueue(subscriber: Subscriber, notification: RuntimeNotification): void {
    if (subscriber.closed) return;
    while (subscriber.queue.length >= RUNTIME_HOST_SUBSCRIBER_QUEUE_LIMIT) {
      const ephemeralIndex = subscriber.queue.findIndex(
        (queued) => queued.durability === 'ephemeral',
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
    this.#subscribers.delete(subscriber);
    subscriber.queue.length = 0;
    if (subscriber.signal && subscriber.onAbort) {
      subscriber.signal.removeEventListener('abort', subscriber.onAbort);
    }
    for (const wake of subscriber.wake) wake();
    subscriber.wake.clear();
  }
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
    schema: RUNTIME_NOTIFICATION_SCHEMA_V1,
    durability: 'durable',
    sessionId: projection.sessionId,
    revision: projection.revision,
    projection: { kind: 'snapshot', session: projection },
  };
}
