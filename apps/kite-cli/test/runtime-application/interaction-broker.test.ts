import { describe, expect, test } from 'bun:test';
import {
  createRuntimeInteractionBroker,
  RUNTIME_INTERACTION_IDENTITY_SCHEMA_,
  type RuntimeInteractionIdentity,
} from '../../src/runtime-application/interaction-broker';

function identity(generation: number, revision: number): RuntimeInteractionIdentity {
  return {
    schema: RUNTIME_INTERACTION_IDENTITY_SCHEMA_,
    sessionId: 'session-1',
    interactionId: 'interaction-1',
    generation,
    revision,
  };
}

describe('RuntimeInteractionBroker', () => {
  test('disconnect removes only the client binding and does not cancel the waiter', async () => {
    const broker = createRuntimeInteractionBroker<string>();
    const current = identity(1, 4);
    const waiter = broker.publish(current);
    waiter.attach('client-1');
    const pending = waiter.wait();
    broker.disconnect('client-1');

    expect(broker.resolve(current, 'accepted')).toBe('resolved');
    await expect(pending).resolves.toBe('accepted');
    expect(broker.resolve(current, 'duplicate')).toBe('duplicate');
  });

  test('rejects stale generation/revision responses and rebinds pending durable identity', async () => {
    const broker = createRuntimeInteractionBroker<string>();
    const first = identity(1, 4);
    const restarted = identity(2, 1);
    const pending = broker.publish(first).wait();
    broker.rebind(restarted);

    expect(broker.resolve(first, 'stale-response')).toBe('stale');
    expect(broker.resolve(restarted, 'restarted-response')).toBe('resolved');
    await expect(pending).resolves.toBe('restarted-response');
  });

  test('rejects malformed identity and explicitly closes pending waiters only on broker close', async () => {
    const broker = createRuntimeInteractionBroker<string>();
    expect(() => broker.publish({ ...identity(1, 1), generation: -1 })).toThrow();
    const pending = broker.publish(identity(1, 1)).wait();
    broker.close('service shutdown');
    await expect(pending).rejects.toMatchObject({ code: 'interaction_broker_closed' });
    expect(broker.resolve(identity(1, 1), 'late')).toBe('closed');
  });

  test('does not reopen a settled interaction under an older or newer identity', async () => {
    const broker = createRuntimeInteractionBroker<string>();
    const current = identity(2, 3);
    broker.publish(current);
    expect(broker.resolve(current, 'settled')).toBe('resolved');
    await expect(broker.wait(current)).resolves.toBe('settled');
    expect(() => broker.publish(identity(1, 9))).toThrow('settled interaction cannot be rebound');
    expect(() => broker.publish(identity(3, 1))).toThrow('settled interaction cannot be rebound');
    expect(broker.resolve(identity(1, 9), 'stale')).toBe('stale');
    expect(broker.resolve(identity(3, 1), 'stale')).toBe('stale');
  });
});
