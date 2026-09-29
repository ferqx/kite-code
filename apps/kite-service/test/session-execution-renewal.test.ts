import { expect, test } from 'bun:test';
import { KiteHomeWriteError } from '@kite-ai/runtime-storage-sqlite';
import { createKiteSessionAppServerStorage } from '../src/bootstrap/kite-session-app-server-storage';

const sessionId = 'renewal-test-session';
const hostInstanceId = 'renewal-test-host';

function fixture() {
  let nowMs = 1_000;
  let renewCalls = 0;
  let failWrites = true;
  let losses = 0;
  let authority = {
    sessionId,
    status: 'active' as const,
    controllerGeneration: 1,
    hostInstanceId,
    clientId: `parent-${hostInstanceId}`,
    connectionGeneration: 1,
    interactionGeneration: 0,
    leaseUntilMs: 1_100,
    cleanupConfirmed: false,
    updatedAt: nowMs,
    revision: 1,
  };
  const target = {
    authority: {
      read: () => authority,
      renew: (request: { leaseUntilMs: number }) => {
        renewCalls++;
        if (failWrites)
          throw new KiteHomeWriteError('write_failed', 'Simulated transient Store write failure.', {
            cause: Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }),
          });
        authority = {
          ...authority,
          leaseUntilMs: request.leaseUntilMs,
          updatedAt: nowMs,
          revision: authority.revision + 1,
        };
        return { status: 'acquired' as const, authority };
      },
    },
    bindExecution: () => Object.freeze({ sessionId }),
    refreshExecution: () => undefined,
    runWithExecution: (_handle: unknown, operation: () => unknown) => operation(),
    storage: { sessions: {}, transactions: {}, recoveryIdentities: {} },
    close: () => undefined,
  } as unknown as Parameters<typeof createKiteSessionAppServerStorage>[0]['target'];
  const owner = createKiteSessionAppServerStorage({
    target,
    hostInstanceId,
    childApprovalProxyId: () => 'approval-proxy',
    executionLeaseMs: 100,
    renewIntervalMs: 10,
    now: () => nowMs,
  });
  owner.setExecutionLossHandler(async () => {
    losses++;
  });
  owner.runWithSessionExecution(sessionId, () => undefined);
  return {
    owner,
    get authority() {
      return authority;
    },
    get renewCalls() {
      return renewCalls;
    },
    get losses() {
      return losses;
    },
    set failWrites(value: boolean) {
      failWrites = value;
    },
    set nowMs(value: number) {
      nowMs = value;
    },
    set controllerGeneration(value: number) {
      authority = { ...authority, controllerGeneration: value };
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test('a transient Store renewal write failure keeps the valid owner and retries', async () => {
  const f = fixture();
  try {
    await until(() => f.renewCalls >= 1);
    expect(f.owner.ownsSessionExecution(sessionId)).toBe(true);
    expect(f.losses).toBe(0);
    f.failWrites = false;
    f.nowMs = 1_010;
    await until(() => f.authority.revision >= 2);
    expect(f.authority.controllerGeneration).toBe(1);
    expect(f.authority.leaseUntilMs).toBeGreaterThan(1_100);
    expect(f.owner.ownsSessionExecution(sessionId)).toBe(true);
    expect(f.losses).toBe(0);
  } finally {
    f.owner.close();
  }
});

test('repeated renewal write failures lose ownership when the held lease expires', async () => {
  const f = fixture();
  try {
    await until(() => f.renewCalls >= 1);
    expect(f.owner.ownsSessionExecution(sessionId)).toBe(true);
    f.nowMs = 1_100;
    await until(() => !f.owner.ownsSessionExecution(sessionId));
    expect(f.losses).toBe(1);
    expect(f.authority.revision).toBe(1);
  } finally {
    f.owner.close();
  }
});

test('a changed authority generation is lost immediately even with lease time remaining', async () => {
  const f = fixture();
  try {
    f.controllerGeneration = 2;
    await until(() => !f.owner.ownsSessionExecution(sessionId));
    expect(f.losses).toBe(1);
    expect(f.renewCalls).toBe(0);
    expect(f.authority.leaseUntilMs).toBe(1_100);
  } finally {
    f.owner.close();
  }
});
