import { expect, test } from 'bun:test';
import { ControlObservation } from '../../../src/execution/control-observation';
import type { Store } from '../../../src/storage/port';
import { AgentError, type ChangeEvent, type StoreMetadata } from '../../../src/storage/types';

function fixture() {
  const events: ChangeEvent[] = [];
  const reads: string[] = [];
  let failure: Error | undefined;
  let floor = 0;
  const metadata = (): StoreMetadata => ({
    storeId: 'store',
    formatMajor: 1,
    replayFloor: String(floor),
    lastChangeCursor: String(events.length),
    engine: { version: 'fixture', sourceId: 'fixture' },
  });
  const store: Pick<Store, 'getMetadata' | 'getChanges'> = {
    async getMetadata() {
      reads.push('metadata');
      return metadata();
    },
    async getChanges(input) {
      reads.push(input.after);
      if (failure) throw failure;
      if (BigInt(input.after) < BigInt(floor)) throw new AgentError('cursor_expired');
      return {
        metadata: metadata(),
        events: events.slice(Number(input.after), Number(input.after) + input.limit!),
      };
    },
  };
  return {
    observation: new ControlObservation(store),
    reads,
    append(type: string) {
      events.push({
        cursor: String(events.length + 1),
        type,
        objectId: 'object',
        sessionId: 's',
        revision: '1',
        payload: null,
      });
    },
    expire() {
      floor = events.length;
    },
    fail(error?: Error) {
      failure = error;
    },
  };
}

test('idle ticks and audited output events avoid repeated owned-handle scans', async () => {
  const f = fixture();
  let scans = 0;
  const scan = async () => {
    scans++;
  };
  await f.observation.poll(scan);
  for (let index = 0; index < 40; index++) await f.observation.poll(scan);
  expect(scans).toBe(1);
  for (const type of [
    'message.updated',
    'execution.output',
    'authorization.check.partial',
    'session.title.partial',
  ]) {
    f.append(type);
    await f.observation.poll(scan);
  }
  expect(scans).toBe(1);
  expect(f.reads.filter((read) => read === 'metadata')).toHaveLength(1);
  expect(f.reads).toHaveLength(45);
});

test('control, aggregate deletion and unknown events recheck facts instead of inferring targets', async () => {
  const f = fixture();
  let scans = 0;
  const scan = async () => {
    scans++;
  };
  await f.observation.poll(scan);
  for (const type of [
    'execution.cancel_requested',
    'command.cancel_requested',
    'run.cancel_requested',
    'session.delete_requested',
    'future.control',
  ]) {
    f.append(type);
    await f.observation.poll(scan);
  }
  expect(scans).toBe(6);
  await f.observation.poll(scan);
  expect(scans).toBe(6);
  expect(f.reads.at(-1)).toBe('5');
});

test('new handles are checked even without new events, including registration during a scan', async () => {
  const f = fixture();
  let scans = 0;
  const scan = async () => {
    scans++;
  };
  await f.observation.poll(scan);
  f.observation.markDirty();
  await f.observation.poll(async () => {
    scans++;
    f.observation.markDirty();
  });
  await f.observation.poll(scan);
  await f.observation.poll(scan);
  expect(scans).toBe(3);
  expect(f.reads).toEqual(['metadata', 'metadata', 'metadata', '0']);
});

test('control writes during a scan remain beyond its previously captured high water', async () => {
  const f = fixture();
  let scans = 0;
  await f.observation.poll(async () => {
    scans++;
    f.append('execution.cancel_requested');
  });
  await f.observation.poll(async () => {
    scans++;
  });
  expect(scans).toBe(2);
  expect(f.reads).toEqual(['metadata', '0']);
});

test('a full output page cannot hide a cancellation behind the bounded page', async () => {
  const f = fixture();
  let scans = 0;
  let durableCancellation = false;
  let cancelled = false;
  const scan = async () => {
    scans++;
    cancelled = durableCancellation;
  };
  await f.observation.poll(scan);
  for (let index = 0; index < 200; index++) f.append('message.updated');
  durableCancellation = true;
  f.append('execution.cancel_requested');
  await f.observation.poll(scan);
  expect(scans).toBe(2);
  expect(cancelled).toBe(true);
  await f.observation.poll(scan);
  expect(scans).toBe(2);
  expect(f.reads.at(-1)).toBe('201');
});

test('expired cursors scan from a precheck high water and retain concurrent controls', async () => {
  const f = fixture();
  let scans = 0;
  await f.observation.poll(async () => {
    scans++;
  });
  f.append('message.updated');
  f.expire();
  await f.observation.poll(async () => {
    scans++;
    f.append('session.delete_requested');
  });
  await f.observation.poll(async () => {
    scans++;
  });
  expect(scans).toBe(3);
  expect(f.reads).toEqual(['metadata', '0', 'metadata', '1']);
});

test('failed reads and scans preserve the old position for a later successful check', async () => {
  const f = fixture();
  await f.observation.poll(async () => {});
  f.append('execution.cancel_requested');
  const failure = new AgentError('storage_error');
  f.fail(failure);
  await expect(f.observation.poll(async () => {})).rejects.toBe(failure);
  f.fail();
  await expect(
    f.observation.poll(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  let scanned = false;
  await f.observation.poll(async () => {
    scanned = true;
  });
  expect(scanned).toBe(true);
  expect(f.reads).toEqual(['metadata', '0', '0', '0']);
});
