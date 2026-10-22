import { expect, test } from 'bun:test';
import { NativeSessionRecovery } from '../src/native-session-recovery';

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('read reconciliation survives prolonged outages with capped backoff and no concurrent lookup', async () => {
  const recovery = new NativeSessionRecovery([1, 2, 3]);
  let calls = 0,
    active = 0,
    peak = 0,
    recovered = false;
  const action = async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await wait(2);
    active--;
    if (calls <= 4) throw Error('offline');
    recovered = true;
    recovery.close();
  };
  recovery.reconcile(new Map([['store:session:original-command', action]]));
  try {
    const until = Date.now() + 1000;
    while (!recovered && Date.now() < until) await wait(5);
    expect(recovered).toBe(true);
    expect(calls).toBe(5);
    expect(peak).toBe(1);
    await wait(15);
    expect(calls).toBe(5);
  } finally {
    recovery.close();
  }
});

test('navigation cancels pending work and late completion cannot restart a removed scope', async () => {
  const recovery = new NativeSessionRecovery([1]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let old = 0,
    next = 0;
  recovery.reconcile(
    new Map([
      [
        'old',
        async () => {
          old++;
          await gate;
        },
      ],
    ]),
  );
  await wait(10);
  recovery.reconcile(
    new Map([
      [
        'new',
        () => {
          next++;
          recovery.close();
        },
      ],
    ]),
  );
  release();
  await wait(15);
  expect(old).toBe(1);
  expect(next).toBe(1);
  expect(recovery.has('old')).toBe(false);
  recovery.close();
});

test('hiding and reopening the same key waits for its held lookup to finish', async () => {
  const recovery = new NativeSessionRecovery([1]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0,
    active = 0,
    peak = 0;
  const action = async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
  };
  const tasks = new Map([['original-command', action]]);
  try {
    recovery.reconcile(tasks);
    await wait(10);
    recovery.close();
    recovery.reconcile(tasks);
    await wait(10);
    expect(calls).toBe(1);
    expect(peak).toBe(1);
    release();
    await wait(10);
    recovery.close();
    expect(calls).toBeGreaterThan(1);
    expect(peak).toBe(1);
  } finally {
    release();
    recovery.close();
  }
});

test('revoked scope reads retain their tombstones without consuming the current scope recovery budget', async () => {
  const recovery = new NativeSessionRecovery([1]);
  let releaseOld!: () => void, releaseCurrent!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const currentGate = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  let oldCalls = 0,
    currentCalls = 0,
    currentActive = 0,
    currentPeak = 0;
  const old = async () => {
    oldCalls++;
    await oldGate;
  };
  const current = async () => {
    currentCalls++;
    currentActive++;
    currentPeak = Math.max(currentPeak, currentActive);
    await currentGate;
    currentActive--;
  };
  try {
    recovery.reconcile(
      new Map([
        ['old:a', old],
        ['old:b', old],
      ]),
    );
    await wait(15);
    expect(oldCalls).toBe(2);
    recovery.reconcile(
      new Map([
        ['current:a', current],
        ['current:b', current],
        ['current:c', current],
      ]),
    );
    await wait(20);
    expect(currentCalls).toBe(2);
    expect(currentPeak).toBe(2);
    expect(recovery.has('old:a')).toBe(false);
    releaseOld();
    await wait(15);
    expect(oldCalls).toBe(2);
    expect(currentCalls).toBe(2);
    recovery.close();
    releaseCurrent();
    await wait(15);
    expect(currentCalls).toBe(2);
  } finally {
    recovery.close();
    releaseOld();
    releaseCurrent();
  }
});
