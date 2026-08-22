import type {
  CheckpointPort,
  RuntimeRecoveryIdentityPortV1,
  RuntimeStorage,
  RuntimeTransactionInputV1,
  SessionStore,
} from './storage';

export type RuntimeTransactionAcknowledgement =
  | 'decision'
  | 'attempt_start'
  | 'receipt_evidence'
  | 'terminal_recovery';

export interface RuntimeLeaseRequirementV1 {
  readonly sessionId: string;
  readonly effectId: string;
  readonly ownerId: string;
}

export interface RuntimeHostTransactionPort<Event = unknown, State = unknown> {
  commit(
    acknowledgement: RuntimeTransactionAcknowledgement,
    input: RuntimeTransactionInputV1<Event, State>,
    requiredLease?: RuntimeLeaseRequirementV1,
  ): void;
}

export interface RuntimeHostLeasePort {
  tryAcquire(sessionId: string, effectId: string, ownerId: string, expiresAtMs: number): boolean;
  renew(sessionId: string, effectId: string, ownerId: string, expiresAtMs: number): boolean;
  release(sessionId: string, effectId: string, ownerId: string): void;
  hasClaim(sessionId: string, effectId: string): boolean;
}

export interface RuntimeHostExecutionServices<Event = unknown, State = unknown> {
  readonly sessions: SessionStore<Event, State>;
  readonly transactions: RuntimeHostTransactionPort<Event, State>;
  readonly leases: RuntimeHostLeasePort;
  readonly checkpoints: CheckpointPort<State>;
  readonly recoveryIdentities: RuntimeRecoveryIdentityPortV1;
}

interface ActiveLease {
  readonly ownerId: string;
  expiresAtMs: number;
}

/** Store 4 transaction acknowledgements and single-Store lease fencing. */
export class EffectSupervisor<Event = unknown, State = unknown> {
  readonly services: RuntimeHostExecutionServices<Event, State>;
  readonly #storage: RuntimeStorage<Event, State>;
  readonly #leases = new Map<string, ActiveLease>();
  readonly #now: () => number;
  readonly #onLeaseLost: (sessionId: string, effectId: string) => void;

  constructor(
    storage: RuntimeStorage<Event, State>,
    now: () => number = Date.now,
    onLeaseLost: (sessionId: string, effectId: string) => void = () => undefined,
  ) {
    this.#storage = storage;
    this.#now = now;
    this.#onLeaseLost = onLeaseLost;
    this.services = Object.freeze({
      sessions: storage.sessions,
      checkpoints: storage.checkpoints,
      recoveryIdentities: storage.recoveryIdentities,
      transactions: Object.freeze({
        commit: (
          acknowledgement: RuntimeTransactionAcknowledgement,
          input: RuntimeTransactionInputV1<Event, State>,
          requiredLease?: RuntimeLeaseRequirementV1,
        ) => this.commit(acknowledgement, input, requiredLease),
      }),
      leases: Object.freeze({
        tryAcquire: (sessionId: string, effectId: string, ownerId: string, expiresAtMs: number) =>
          this.tryAcquire(sessionId, effectId, ownerId, expiresAtMs),
        renew: (sessionId: string, effectId: string, ownerId: string, expiresAtMs: number) =>
          this.renew(sessionId, effectId, ownerId, expiresAtMs),
        release: (sessionId: string, effectId: string, ownerId: string) =>
          this.release(sessionId, effectId, ownerId),
        hasClaim: (sessionId: string, effectId: string) => this.hasClaim(sessionId, effectId),
      }),
    });
  }

  commit(
    acknowledgement: RuntimeTransactionAcknowledgement,
    input: RuntimeTransactionInputV1<Event, State>,
    requiredLease?: RuntimeLeaseRequirementV1,
  ): void {
    if (requiredLease && requiredLease.sessionId !== input.sessionId) {
      throw new Error('Runtime effect lease session does not match the transaction session');
    }
    const guardedInput = requiredLease
      ? { ...input, requiredEffectLease: this.#currentLeaseExpectation(requiredLease) }
      : input;
    switch (acknowledgement) {
      case 'decision':
        this.#storage.transactions.commitDecision(guardedInput);
        return;
      case 'attempt_start':
        this.#storage.transactions.commitAttemptStart(guardedInput);
        return;
      case 'receipt_evidence':
        this.#storage.transactions.commitReceiptEvidence(guardedInput);
        return;
      case 'terminal_recovery':
        this.#storage.transactions.commitTerminalRecovery(guardedInput);
        return;
    }
  }

  tryAcquire(sessionId: string, effectId: string, ownerId: string, expiresAtMs: number): boolean {
    const key = leaseKey(sessionId, effectId);
    if (!this.#storage.effects.tryAcquireEffectLease(sessionId, effectId, ownerId, expiresAtMs)) {
      return false;
    }
    this.#leases.set(key, { ownerId, expiresAtMs });
    return true;
  }

  renew(sessionId: string, effectId: string, ownerId: string, expiresAtMs: number): boolean {
    const key = leaseKey(sessionId, effectId);
    const active = this.#leases.get(key);
    if (!active || active.ownerId !== ownerId || active.expiresAtMs <= this.#now()) {
      this.#onLeaseLost(sessionId, effectId);
      return false;
    }
    if (!this.#storage.effects.renewEffectLease(sessionId, effectId, ownerId, expiresAtMs)) {
      active.expiresAtMs = 0;
      this.#onLeaseLost(sessionId, effectId);
      return false;
    }
    active.expiresAtMs = expiresAtMs;
    return true;
  }

  release(sessionId: string, effectId: string, ownerId: string): void {
    const key = leaseKey(sessionId, effectId);
    const active = this.#leases.get(key);
    if (!active || active.ownerId !== ownerId) return;
    this.#storage.effects.releaseEffectLease(sessionId, effectId, ownerId);
    this.#leases.delete(key);
  }

  hasClaim(sessionId: string, effectId: string): boolean {
    return this.#leases.has(leaseKey(sessionId, effectId));
  }

  #currentLeaseExpectation(requirement: RuntimeLeaseRequirementV1) {
    const key = leaseKey(requirement.sessionId, requirement.effectId);
    const active = this.#leases.get(key);
    if (!active || active.ownerId !== requirement.ownerId || active.expiresAtMs <= this.#now()) {
      this.#onLeaseLost(requirement.sessionId, requirement.effectId);
      throw new Error('Runtime effect lease is stale; commit refused');
    }
    return {
      effectId: requirement.effectId,
      ownerId: requirement.ownerId,
      observedAtMs: this.#now(),
    };
  }
}

function leaseKey(sessionId: string, effectId: string): string {
  return `${sessionId}\u0000${effectId}`;
}
