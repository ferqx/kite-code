import { describe, expect, test } from 'bun:test';
import { EffectSupervisor } from '../src/lifecycle/effect-supervisor';
import type { RuntimeStorage, RuntimeTransactionInput } from '../src/storage';

describe('Host EffectSupervisor', () => {
  test('exposes the exact storage-owned recovery identity port without a second owner', () => {
    const storage = storageFixture([]);
    const supervisor = new EffectSupervisor(storage);
    expect(supervisor.services.recoveryIdentities).toBe(storage.recoveryIdentities);
  });

  test('maps every acknowledgement class to one Store 4 transaction method', () => {
    const calls: string[] = [];
    const supervisor = new EffectSupervisor(storageFixture(calls));
    const input = transactionInput();
    supervisor.commit('decision', input);
    supervisor.commit('attempt_start', input);
    supervisor.commit('receipt_evidence', input);
    supervisor.commit('terminal_recovery', input);
    expect(calls).toEqual(['decision', 'attempt_start', 'receipt_evidence', 'terminal_recovery']);
  });

  test('never reaches an external dispatch when attempt acknowledgement fails', () => {
    let providerCalls = 0;
    const storage = storageFixture([]);
    storage.transactions.commitAttemptStart = () => {
      throw new Error('attempt ack failed');
    };
    const supervisor = new EffectSupervisor(storage);
    expect(() => {
      supervisor.commit('attempt_start', transactionInput());
      providerCalls += 1;
    }).toThrow('attempt ack failed');
    expect(providerCalls).toBe(0);
  });

  test('refuses a fenced commit after lease expiry or renewal loss', () => {
    const calls: string[] = [];
    let now = 100;
    let renews = true;
    const storage = storageFixture(calls, { renew: () => renews });
    const supervisor = new EffectSupervisor(storage, () => now);
    expect(supervisor.tryAcquire('session-1', 'effect-1', 'owner-a', 200)).toBe(true);
    supervisor.commit('receipt_evidence', transactionInput(), {
      sessionId: 'session-1',
      effectId: 'effect-1',
      ownerId: 'owner-a',
    });
    renews = false;
    expect(supervisor.renew('session-1', 'effect-1', 'owner-a', 300)).toBe(false);
    expect(() =>
      supervisor.commit('receipt_evidence', transactionInput(), {
        sessionId: 'session-1',
        effectId: 'effect-1',
        ownerId: 'owner-a',
      }),
    ).toThrow('lease is stale');

    renews = true;
    expect(supervisor.tryAcquire('session-1', 'effect-2', 'owner-b', 250)).toBe(true);
    now = 251;
    expect(() =>
      supervisor.commit('receipt_evidence', transactionInput(), {
        sessionId: 'session-1',
        effectId: 'effect-2',
        ownerId: 'owner-b',
      }),
    ).toThrow('lease is stale');
  });

  test('does not let a stale executor borrow a replacement owner claim', () => {
    const calls: string[] = [];
    const supervisor = new EffectSupervisor(storageFixture(calls), () => 100);
    expect(supervisor.tryAcquire('session-1', 'effect-1', 'owner-old', 200)).toBe(true);
    supervisor.release('session-1', 'effect-1', 'owner-old');
    expect(supervisor.tryAcquire('session-1', 'effect-1', 'owner-new', 300)).toBe(true);

    expect(() =>
      supervisor.commit('receipt_evidence', transactionInput(), {
        sessionId: 'session-1',
        effectId: 'effect-1',
        ownerId: 'owner-old',
      }),
    ).toThrow('lease is stale');
    expect(calls).not.toContain('receipt_evidence');

    supervisor.commit('receipt_evidence', transactionInput(), {
      sessionId: 'session-1',
      effectId: 'effect-1',
      ownerId: 'owner-new',
    });
    expect(calls).toContain('receipt_evidence');
  });

  test('signals the Host lifecycle when lease renewal is lost', () => {
    const lost: string[] = [];
    const supervisor = new EffectSupervisor(
      storageFixture([], { renew: () => false }),
      () => 100,
      (sessionId, effectId) => lost.push(`${sessionId}/${effectId}`),
    );
    expect(supervisor.tryAcquire('session-1', 'effect-1', 'owner-a', 200)).toBe(true);
    expect(supervisor.renew('session-1', 'effect-1', 'owner-a', 300)).toBe(false);
    expect(lost).toEqual(['session-1/effect-1']);
  });
});

function transactionInput(): RuntimeTransactionInput {
  return { sessionId: 'session-1', events: [], snapshot: {} };
}

function storageFixture(calls: string[], lease: { renew?: () => boolean } = {}): RuntimeStorage {
  return {
    adapterId: 'test',
    stateSchemaVersion: 25,
    storeSchemaVersion: 4,
    formatEpoch: 'kite-runtime-2026-08-18',
    sessions: {} as RuntimeStorage['sessions'],
    checkpoints: {} as RuntimeStorage['checkpoints'],
    artifacts: {} as RuntimeStorage['artifacts'],
    recoveryIdentities: {
      read: () => null,
      getOrCreate: (_sessionId, allocate) => allocate(),
      remove: () => undefined,
    },
    transactions: {
      commitDecision: () => calls.push('decision'),
      commitAttemptStart: () => calls.push('attempt_start'),
      commitReceiptEvidence: () => calls.push('receipt_evidence'),
      commitTerminalRecovery: () => calls.push('terminal_recovery'),
    },
    effects: {
      tryAcquireEffectLease: () => true,
      renewEffectLease: () => lease.renew?.() ?? true,
      releaseEffectLease: () => undefined,
    },
    close: () => undefined,
  };
}
