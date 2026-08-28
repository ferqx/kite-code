import type { RuntimeInteractionResponse } from '@kite-ai/runtime-contract';

export const RUNTIME_INTERACTION_IDENTITY_SCHEMA_ = 'kite.runtime-interaction-identity.v1' as const;

export interface RuntimeInteractionIdentity {
  readonly schema: typeof RUNTIME_INTERACTION_IDENTITY_SCHEMA_;
  readonly sessionId: string;
  readonly interactionId: string;
  readonly generation: number;
  readonly revision: number;
}

export type RuntimeInteractionResolveResult =
  | 'resolved'
  | 'stale'
  | 'duplicate'
  | 'not_found'
  | 'closed';

export interface RuntimeInteractionWaiter<T = RuntimeInteractionResponse> {
  readonly identity: RuntimeInteractionIdentity;
  wait(): Promise<T>;
  resolve(value: T): RuntimeInteractionResolveResult;
  reject(reason: unknown): RuntimeInteractionResolveResult;
  attach(clientId: string): void;
}

export interface RuntimeInteractionBroker<T = RuntimeInteractionResponse> {
  publish(identity: RuntimeInteractionIdentity): RuntimeInteractionWaiter<T>;
  wait(identity: RuntimeInteractionIdentity, clientId?: string): Promise<T>;
  resolve(identity: RuntimeInteractionIdentity, value: T): RuntimeInteractionResolveResult;
  reject(identity: RuntimeInteractionIdentity, reason: unknown): RuntimeInteractionResolveResult;
  /** Client disconnect only releases its binding; it never rejects a pending waiter. */
  disconnect(clientId: string): void;
  /** Rebinds a durable interaction after restart while preserving pending waiters. */
  rebind(identity: RuntimeInteractionIdentity): RuntimeInteractionWaiter<T>;
  /** Explicit Service shutdown, distinct from client disconnect. */
  close(reason?: string): void;
}

export class RuntimeInteractionBrokerError extends Error {
  readonly code:
    | 'interaction_broker_closed'
    | 'interaction_identity_invalid'
    | 'interaction_identity_stale';

  constructor(code: RuntimeInteractionBrokerError['code'], message: string) {
    super(message);
    this.name = 'RuntimeInteractionBrokerError';
    this.code = code;
  }
}

interface Pending<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

interface Entry<T> {
  identity: RuntimeInteractionIdentity;
  readonly pending: Set<Pending<T>>;
  readonly clients: Set<string>;
  settled: boolean;
  value?: T;
  error?: unknown;
}

function assertIdentity(identity: RuntimeInteractionIdentity): RuntimeInteractionIdentity {
  if (
    !identity ||
    typeof identity !== 'object' ||
    identity.schema !== RUNTIME_INTERACTION_IDENTITY_SCHEMA_ ||
    typeof identity.sessionId !== 'string' ||
    identity.sessionId.length === 0 ||
    identity.sessionId.length > 512 ||
    typeof identity.interactionId !== 'string' ||
    identity.interactionId.length === 0 ||
    identity.interactionId.length > 512 ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 0 ||
    !Number.isSafeInteger(identity.revision) ||
    identity.revision < 0
  ) {
    throw new RuntimeInteractionBrokerError(
      'interaction_identity_invalid',
      'Runtime interaction identity is invalid.',
    );
  }
  return Object.freeze({ ...identity });
}

function logicalKey(identity: RuntimeInteractionIdentity): string {
  return `${identity.sessionId}\u0000${identity.interactionId}`;
}

function exactIdentity(
  left: RuntimeInteractionIdentity,
  right: RuntimeInteractionIdentity,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.interactionId === right.interactionId &&
    left.generation === right.generation &&
    left.revision === right.revision
  );
}

function identityIsOlder(
  candidate: RuntimeInteractionIdentity,
  current: RuntimeInteractionIdentity,
): boolean {
  return (
    candidate.generation < current.generation ||
    (candidate.generation === current.generation && candidate.revision < current.revision)
  );
}

class BrokerWaiter<T> implements RuntimeInteractionWaiter<T> {
  readonly identity: RuntimeInteractionIdentity;
  readonly #entry: Entry<T>;
  readonly #broker: RuntimeInteractionBrokerImpl<T>;

  constructor(broker: RuntimeInteractionBrokerImpl<T>, entry: Entry<T>) {
    this.#broker = broker;
    this.#entry = entry;
    this.identity = entry.identity;
  }

  wait(): Promise<T> {
    return this.#broker.waitEntry(this.#entry);
  }

  resolve(value: T): RuntimeInteractionResolveResult {
    return this.#broker.resolve(this.identity, value);
  }

  reject(reason: unknown): RuntimeInteractionResolveResult {
    return this.#broker.reject(this.identity, reason);
  }

  attach(clientId: string): void {
    if (clientId.length === 0) throw new TypeError('Client identity must not be empty.');
    this.#entry.clients.add(clientId);
  }
}

class RuntimeInteractionBrokerImpl<T> implements RuntimeInteractionBroker<T> {
  readonly #entries = new Map<string, Entry<T>>();
  #closed = false;

  publish(identityInput: RuntimeInteractionIdentity): RuntimeInteractionWaiter<T> {
    if (this.#closed)
      throw new RuntimeInteractionBrokerError(
        'interaction_broker_closed',
        'Interaction broker is closed.',
      );
    const identity = assertIdentity(identityInput);
    const key = logicalKey(identity);
    const current = this.#entries.get(key);
    if (current && exactIdentity(current.identity, identity))
      return new BrokerWaiter(this, current);
    if (current?.settled) {
      throw new RuntimeInteractionBrokerError(
        'interaction_identity_stale',
        'A settled interaction cannot be rebound with a different identity.',
      );
    }
    if (current && !current.settled && identityIsOlder(identity, current.identity))
      return new BrokerWaiter(this, current);
    if (current && !current.settled) current.identity = identity;
    const entry: Entry<T> =
      current && !current.settled
        ? current
        : { identity, pending: new Set(), clients: new Set(), settled: false };
    if (current?.settled) this.#entries.set(key, entry);
    else if (!current) this.#entries.set(key, entry);
    else current.identity = identity;
    return new BrokerWaiter(this, entry);
  }

  rebind(identity: RuntimeInteractionIdentity): RuntimeInteractionWaiter<T> {
    return this.publish(identity);
  }

  wait(identityInput: RuntimeInteractionIdentity, clientId?: string): Promise<T> {
    const waiter = this.publish(identityInput);
    if (clientId !== undefined) waiter.attach(clientId);
    return waiter.wait();
  }

  waitEntry(entry: Entry<T>): Promise<T> {
    if (entry.settled) {
      return entry.error === undefined
        ? Promise.resolve(entry.value as T)
        : Promise.reject(entry.error);
    }
    if (this.#closed) {
      return Promise.reject(
        new RuntimeInteractionBrokerError(
          'interaction_broker_closed',
          'Interaction broker is closed.',
        ),
      );
    }
    return new Promise<T>((resolve, reject) => entry.pending.add({ resolve, reject }));
  }

  resolve(identityInput: RuntimeInteractionIdentity, value: T): RuntimeInteractionResolveResult {
    if (this.#closed) return 'closed';
    const identity = assertIdentity(identityInput);
    const entry = this.#entries.get(logicalKey(identity));
    if (!entry) return 'not_found';
    if (!exactIdentity(entry.identity, identity)) return 'stale';
    if (entry.settled) return 'duplicate';
    entry.settled = true;
    entry.value = value;
    const pending = [...entry.pending];
    entry.pending.clear();
    for (const waiter of pending) waiter.resolve(value);
    return 'resolved';
  }

  reject(
    identityInput: RuntimeInteractionIdentity,
    reason: unknown,
  ): RuntimeInteractionResolveResult {
    if (this.#closed) return 'closed';
    const identity = assertIdentity(identityInput);
    const entry = this.#entries.get(logicalKey(identity));
    if (!entry) return 'not_found';
    if (!exactIdentity(entry.identity, identity)) return 'stale';
    if (entry.settled) return 'duplicate';
    entry.settled = true;
    entry.error = reason;
    const pending = [...entry.pending];
    entry.pending.clear();
    for (const waiter of pending) waiter.reject(reason);
    return 'resolved';
  }

  disconnect(clientId: string): void {
    for (const entry of this.#entries.values()) entry.clients.delete(clientId);
  }

  close(reason = 'Runtime interaction broker closed.'): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new RuntimeInteractionBrokerError('interaction_broker_closed', reason);
    for (const entry of this.#entries.values()) {
      for (const waiter of entry.pending) waiter.reject(error);
      entry.pending.clear();
      entry.clients.clear();
    }
    this.#entries.clear();
  }
}

export function createRuntimeInteractionBroker<
  T = RuntimeInteractionResponse,
>(): RuntimeInteractionBroker<T> {
  return new RuntimeInteractionBrokerImpl<T>();
}
