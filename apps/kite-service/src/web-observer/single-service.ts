import type { WebSessionStatus } from '@kite-ai/kite-app-contract';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeClientEvent,
} from '@kite-ai/runtime-contract';
import {
  createWebObserverCore,
  type WebObserverCore,
  type WebObserverHistoryPort,
  type WebObserverLiveInput,
  type WebObserverLivePort,
} from './core';
import {
  createSingleStoreWebObserverDirectoryPort,
  type SingleStoreDirectoryQueryPort,
} from './single-store-directory';

const INTERNAL_NOOP_EVENT: RuntimeClientEvent = {
  type: 'interaction_mode.changed',
  mode: 'auto',
};

export interface SingleServiceWebObserverFactoryOptions {
  readonly runtime: RuntimeAccess;
  readonly directory: SingleStoreDirectoryQueryPort;
  readonly history: WebObserverHistoryPort;
  readonly serviceInstanceId: string;
  readonly contractRevision: string;
}

export type SingleServiceWebObserverFactory = (binding: {
  readonly tabHandle: string;
  readonly connectionGeneration: number;
}) => WebObserverCore;

/** Compose Browser observers directly over in-process Runtime and the one Store query owner. */
export function createSingleServiceWebObserverFactory(
  options: SingleServiceWebObserverFactoryOptions,
): SingleServiceWebObserverFactory {
  const directory = createSingleStoreWebObserverDirectoryPort({
    query: options.directory,
    status: (_workspaceId, sessionId) => statusForSession(options.runtime, sessionId),
  });
  const live = createSingleServiceWebObserverLivePort(options.runtime);
  return (binding) =>
    createWebObserverCore({
      directory,
      history: options.history,
      live,
      gatewayInstanceId: options.serviceInstanceId,
      contractRevision: options.contractRevision,
      createTabBinding: () => binding,
    });
}

/** Durable-only in-process live projection; ephemeral stream sequence never becomes History order. */
export function createSingleServiceWebObserverLivePort(
  runtime: RuntimeAccess,
): WebObserverLivePort {
  return Object.freeze({
    subscribe(input: Parameters<WebObserverLivePort['subscribe']>[0]) {
      const source = runtime.subscribe({
        spec: {
          scope: 'session',
          sessionId: input.sessionId,
          ...(input.afterSequence === undefined ? {} : { afterRevision: input.afterSequence }),
          includeEphemeral: false,
        },
        signal: input.signal,
      });
      return {
        [Symbol.asyncIterator]: () => durableIterator(source, input.sessionId, input.afterSequence),
      };
    },
  });
}

function durableIterator(
  source: AsyncIterable<RuntimeAccessNotification>,
  sessionId: string,
  afterSequence: number | undefined,
): AsyncIterator<WebObserverLiveInput> {
  const iterator = source[Symbol.asyncIterator]();
  let expected = afterSequence;
  let finished = false;
  return {
    async next() {
      if (finished) return { done: true, value: undefined };
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          return { done: true, value: undefined };
        }
        if (!isDurable(next.value)) continue;
        const projected = durableInput(next.value, sessionId, expected);
        if (!projected) {
          finished = true;
          await iterator.return?.();
          throw new Error('Single-Service durable Web notification is invalid.');
        }
        if (projected.sequence <= (expected ?? -1)) continue;
        expected = projected.sequence;
        return { done: false, value: projected };
      }
    },
    async return() {
      finished = true;
      await iterator.return?.();
      return { done: true, value: undefined };
    },
  };
}

function durableInput(
  notification: Extract<RuntimeAccessNotification, { durability: 'durable' }>,
  sessionId: string,
  expected: number | undefined,
): WebObserverLiveInput | undefined {
  if (
    notification.sessionId !== sessionId ||
    !Number.isSafeInteger(notification.revision) ||
    notification.revision < 0 ||
    notification.projection.session.sessionId !== sessionId ||
    notification.projection.session.revision !== notification.revision
  ) {
    return undefined;
  }
  if (notification.revision <= (expected ?? -1)) {
    return { sessionId, sequence: notification.revision, event: INTERNAL_NOOP_EVENT };
  }
  return {
    sessionId,
    sequence: notification.revision,
    event: notification.projection.event ?? INTERNAL_NOOP_EVENT,
  };
}

function isDurable(
  value: RuntimeAccessNotification,
): value is Extract<RuntimeAccessNotification, { durability: 'durable' }> {
  return 'durability' in value && value.durability === 'durable';
}

async function statusForSession(
  runtime: RuntimeAccess,
  sessionId: string,
): Promise<WebSessionStatus> {
  const result = await runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  if (result.status !== 'ok' || result.session?.sessionId !== sessionId) return 'unavailable';
  const projection = result.session;
  if (projection.lifecycle === 'closed') return 'completed';
  const activeWork = projection.activeWork;
  if (!activeWork) return 'idle';
  if (activeWork.status === 'waiting') return 'waiting';
  if (activeWork.status === 'failed') return 'failed';
  if (activeWork.status === 'cancelled') return 'cancelled';
  if (activeWork.status === 'completed') return 'completed';
  return 'running';
}
