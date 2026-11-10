import type { Database } from 'bun:sqlite';
import { readFileSync, writeSync } from 'node:fs';
import type { TrajectoryPage } from '@kite-ai/trajectory';
import { TraceConsumerStore } from '../../src/trace-extensions/consumer-store';
import type { TraceEngineAssets } from '../../src/trace-extensions/engine';
import { TraceHost } from '../../src/trace-extensions/host';

// 仅由隔离测试启动；同步 SQLite function 把实际事务停在 commit 之前，不向产品加入开关。
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  path: string;
  installationId: string;
  partitionId: string;
  mode: 'enqueue_before' | 'enqueue_after' | 'ack_before' | 'ack_after';
  page?: TrajectoryPage;
  assets?: TraceEngineAssets;
};
const store = new TraceConsumerStore(input.path);
const db = Reflect.get(store, 'db') as Database;
const synchronous = db.query('PRAGMA synchronous').get();
const journal = db.query('PRAGMA journal_mode').get();
let sentEventIds: string[] = [];
const milestone = () => {
  writeSync(
    1,
    `${JSON.stringify({
      mode: input.mode,
      pid: process.pid,
      sentEventIds,
      synchronous,
      journal,
    })}\n`,
  );
};
const gate = () => {
  milestone();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw Error('fixture_gate_must_be_killed');
};
db.function('fixture_crash_gate', gate);
if (input.mode === 'enqueue_before')
  db.exec(
    'CREATE TEMP TRIGGER fixture_gate AFTER UPDATE OF scan_cursor ON subscription BEGIN SELECT fixture_crash_gate(); END',
  );
if (input.mode === 'ack_before')
  db.exec(
    "CREATE TEMP TRIGGER fixture_gate AFTER UPDATE OF state ON pending WHEN NEW.state='acknowledged' BEGIN SELECT fixture_crash_gate(); END",
  );
if (input.mode.startsWith('enqueue')) {
  if (!input.page || !store.enqueuePage(input.partitionId, input.page).accepted)
    throw Error('fixture_enqueue_rejected');
} else {
  if (!input.assets) throw Error('fixture_assets_missing');
  const host = new TraceHost({
    store,
    assets: input.assets,
    subjectId: 'fixture',
    source: {
      async open() {
        throw Error('fixture_source_not_needed');
      },
      async readEvents() {
        throw Error('fixture_source_not_needed');
      },
    },
    trustedConsumerFactory: async ({ generation }) => ({
      generation,
      async initialize() {},
      async onEvents(batch) {
        sentEventIds = batch.events.map((event) => event.eventId);
        return {
          batchId: batch.batchId,
          leaseToken: batch.leaseToken,
          processGeneration: batch.processGeneration,
          subscriptionEpoch: batch.partition.subscriptionEpoch,
          acknowledgedEventIds: sentEventIds,
          rejected: [],
        };
      },
      async retire() {
        return { confirmed: true };
      },
    }),
  });
  await host.pump(input.installationId);
}
milestone();
setInterval(() => {}, 60000);
