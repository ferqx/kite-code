import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { ScheduledTaskRunner } from '../electron/scheduled-task-runner';
import { createScheduledTaskData } from '../electron/scheduled-tasks';

const path = process.argv[2]!;
let db = new DatabaseSync(path);
db.exec('PRAGMA user_version=7');
let data = createScheduledTaskData(() => db);
const task = data.saveScheduledTask(
  {
    id: 'task',
    name: 'Scheduled',
    prompt: 'Review',
    workspaceId: 'workspace',
    storeId: 'store',
    modelId: 'model',
    schedule: { frequency: 'daily', time: '10:00', timeZone: 'UTC' },
    enabled: true,
  },
  0,
);
const run = data.claimScheduledTask(task.id, Date.parse('2026-10-15T12:00Z'), {
  storeId: 'store',
})!;
assert.equal(run.status, 'queued');
db.close();
db = new DatabaseSync(path);
data = createScheduledTaskData(() => db);
assert.equal(data.scheduledTaskRuns()[0]?.createCommandId, run.createCommandId);
assert.equal(data.claimScheduledTask(task.id, Date.parse('2026-10-16T12:00Z')), null);
assert.equal(data.scheduledTasks()[0]?.nextRunAt, Date.parse('2026-10-17T10:00Z'));
db.close();
console.log('scheduled-node-ok');

// These cases deliberately use the actual node:sqlite engine and its raw UTF-8 bytes.
const budget = 32 * 1024 * 1024;
const maxTime = 8639999999999999;
const maximumUpdate = {
  status: 'completed' as const,
  settlementVersion: 1 as const,
  serviceRunId: 'r'.repeat(128),
  error: '\u0000'.repeat(4096),
};
const bytes = (database: DatabaseSync) =>
  Number(
    database
      .prepare(
        'SELECT COALESCE(SUM(length(CAST(state AS BLOB))),0) AS bytes FROM scheduled_task_runs',
      )
      .get()!.bytes,
  );
function fresh() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA user_version=9');
  const port = createScheduledTaskData(() => database);
  const { nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...input } = task;
  port.saveScheduledTask({ ...input, enabled: false }, 0);
  const history = port.claimScheduledTask(task.id, 0, { manual: true, storeId: 'store' })!;
  port.updateScheduledTaskRun(history.id, { status: 'completed', settlementVersion: 1 }, 0);
  return { database, port, history, input: { ...input, enabled: false } };
}
function padHistory(database: DatabaseSync, id: string, target: number) {
  const row = database.prepare('SELECT state FROM scheduled_task_runs WHERE id=?').get(id)!;
  const padding = target - bytes(database);
  assert.ok(padding >= 0);
  database
    .prepare('UPDATE scheduled_task_runs SET state=? WHERE id=?')
    .run(String(row.state) + ' '.repeat(padding), id);
  assert.equal(bytes(database), target);
}
function raw(database: DatabaseSync, id: string) {
  return database.prepare('SELECT hex(state) AS raw FROM scheduled_task_runs WHERE id=?').get(id)!
    .raw;
}
{
  const { database, port, history } = fresh();
  const live = port.claimScheduledTask(task.id, 1, { manual: true, storeId: 'store' })!;
  // A valid old-format row had no future growth reservation. Reject growth atomically.
  padHistory(database, history.id, budget - 5);
  const before = raw(database, live.id);
  assert.throws(
    () =>
      port.updateScheduledTaskRun(
        live.id,
        { status: 'running', serviceRunId: 'service_run_id' },
        1,
      ),
    /scheduled_task_capacity_exceeded/,
  );
  assert.equal(raw(database, live.id), before);
  assert.equal(bytes(database), budget - 5);
  assert.equal(port.scheduledTaskRuns().length, 2);
  // A no-growth update must still work against unreserved legacy history.
  assert.equal(port.updateScheduledTaskRun(live.id, { status: 'queued' }, 1).status, 'queued');
  assert.equal(bytes(database), budget - 5);
  assert.throws(() => port.deleteScheduledTask(task.id), /scheduled_task_active/);
  assert.throws(
    () =>
      port.updateScheduledTaskRun(
        live.id,
        { status: 'queued', task: { ...task, prompt: 'changed' } } as never,
        1,
      ),
    /scheduled_task_invalid/,
  );
  database.close();
}
{
  const { database, port, history, input } = fresh();
  const other = port.saveScheduledTask({ ...input, id: 'other' }, 0);
  const live = port.claimScheduledTask(other.id, 1, { manual: true, storeId: 'store' })!;
  const preserved = raw(database, live.id);
  // Historical files already poisoned by the old writer can be explicitly cleaned up.
  padHistory(database, history.id, budget + 20);
  assert.equal(port.scheduledTaskRuns().length, 2);
  const runner = new ScheduledTaskRunner({} as never, {
    ...port,
    begin() {
      throw Error('unexpected_begin');
    },
    finish() {
      throw Error('unexpected_finish');
    },
  });
  assert.equal(runner.list().runs.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(runner.list())) <= 3 * 1024 * 1024);
  assert.throws(() => port.deleteScheduledTask(other.id), /scheduled_task_active/);
  port.deleteScheduledTask(task.id);
  assert.equal(port.scheduledTaskRuns().length, 1);
  assert.equal(raw(database, live.id), preserved);
  assert.equal(port.scheduledTasks()[0]!.id, other.id);
  database.close();
}
{
  const { database, port, history, input } = fresh();
  const first = port.claimScheduledTask(task.id, 1, { manual: true, storeId: 'store' })!;
  const worst = { ...first, ...maximumUpdate, updatedAt: maxTime, finishedAt: maxTime };
  const reserved = Buffer.byteLength(JSON.stringify(worst));
  // Keep the first run active, and prove a second task receives its own growth budget.
  port.saveScheduledTask({ ...input, id: 'other', prompt: '中文🙂' }, 0);
  const second = port.claimScheduledTask('other', 1, { manual: true, storeId: 'store' })!;
  const secondReserved = Buffer.byteLength(
    JSON.stringify({ ...second, ...maximumUpdate, updatedAt: maxTime, finishedAt: maxTime }),
  );
  database.prepare('DELETE FROM scheduled_task_runs WHERE id=?').run(second.id);
  padHistory(
    database,
    history.id,
    budget - (reserved - Buffer.byteLength(JSON.stringify(first))) - secondReserved,
  );
  assert.ok(port.claimScheduledTask('other', 1, { manual: true, storeId: 'store' }));
  port.updateScheduledTaskRun(first.id, maximumUpdate, maxTime);
  port.updateScheduledTaskRun(second.id, maximumUpdate, maxTime);
  assert.equal(bytes(database), budget);
  assert.equal(port.scheduledTaskRuns().length, 3);
  // Every terminal row keeps only its actual storage cost; no permanent per-row reservation.
  port.saveScheduledTask({ ...input, id: 'third' }, 0);
  assert.throws(
    () => port.claimScheduledTask('third', 1, { manual: true, storeId: 'store' }),
    /scheduled_task_capacity_exceeded/,
  );
  assert.equal(bytes(database), budget);
  database.close();
}
{
  const { database, port, history, input } = fresh();
  const measurement = port.claimScheduledTask(task.id, 1, { manual: true, storeId: 'store' })!;
  const reserved = Buffer.byteLength(
    JSON.stringify({ ...measurement, ...maximumUpdate, updatedAt: maxTime, finishedAt: maxTime }),
  );
  database.prepare('DELETE FROM scheduled_task_runs WHERE id=?').run(measurement.id);
  padHistory(database, history.id, budget - reserved + 1);
  const prior = raw(database, history.id);
  assert.throws(
    () => port.claimScheduledTask(task.id, 1, { manual: true, storeId: 'store' }),
    /scheduled_task_capacity_exceeded/,
  );
  assert.equal(raw(database, history.id), prior);
  assert.equal(port.scheduledTaskRuns().length, 1);
  assert.equal(port.scheduledTasks()[0]!.prompt, input.prompt);
  database.close();
}
{
  const { database, port, input } = fresh();
  const old = port.claimScheduledTask(task.id, 1, { manual: true, storeId: 'store' })!;
  port.updateScheduledTaskRun(old.id, { status: 'unknown' }, 1);
  const before = raw(database, old.id);
  port.saveScheduledTask({ ...input, storeId: 'restored' }, 1);
  const rebound = port.claimScheduledTask(task.id, 1, { manual: true, storeId: 'restored' })!;
  assert.ok(rebound);
  assert.notEqual(rebound.id, old.id);
  assert.equal(raw(database, old.id), before);
  assert.equal(port.claimScheduledTask(task.id, 2, { manual: true, storeId: 'restored' }), null);
  assert.throws(() => port.deleteScheduledTask(task.id), /scheduled_task_active/);
  port.updateScheduledTaskRun(rebound.id, { status: 'completed', settlementVersion: 1 }, 2);
  port.deleteScheduledTask(task.id);
  assert.equal(port.scheduledTasks().length, 0);
  database.close();
}
console.log('scheduled-node-capacity-and-restore-ok');
{
  const { database, port, history } = fresh();
  const recoveryAllowance = Buffer.byteLength(
    JSON.stringify({
      ...maximumUpdate,
      status: 'cancelled',
      updatedAt: maxTime,
      finishedAt: maxTime,
    }),
  );
  padHistory(database, history.id, budget + recoveryAllowance);
  assert.equal(port.scheduledTaskRuns().length, 1);
  assert.throws(
    () => port.claimScheduledTask(task.id, 1, { manual: true, storeId: 'store' }),
    /scheduled_task_capacity_exceeded/,
  );
  padHistory(database, history.id, budget + recoveryAllowance + 1);
  assert.throws(() => port.scheduledTaskRuns(), /scheduled_task_capacity_exceeded/);
  port.deleteScheduledTask(task.id);
  assert.equal(port.scheduledTaskRuns().length, 0);
  database.close();
}
{
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA user_version=9');
  const port = createScheduledTaskData(() => database);
  const { nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...input } = task;
  for (let index = 0; index < 4; index++)
    port.saveScheduledTask(
      { ...input, id: `task${index}`, prompt: 'x'.repeat(index < 3 ? 262000 : 1), enabled: true },
      0,
    );
  const used = Number(
    database.prepare('SELECT SUM(length(CAST(state AS BLOB))) AS bytes FROM scheduled_tasks').get()!
      .bytes,
  );
  port.saveScheduledTask(
    { ...input, id: 'task3', prompt: 'x'.repeat(1048576 - used + 1), enabled: true },
    0,
  );
  const before = database.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all();
  assert.throws(
    () => port.claimScheduledTask('task0', Date.parse('2026-10-16T12:00Z'), { storeId: 'store' }),
    /scheduled_task_capacity_exceeded/,
  );
  assert.deepEqual(database.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all(), before);
  assert.equal(port.scheduledTasks().length, 4);
  assert.equal(port.scheduledTaskRuns().length, 0);
  database.close();
}
{
  const { database, port, history, input } = fresh();
  port.saveScheduledTask({ ...input, id: 'legacy' }, 0);
  const legacy = port.claimScheduledTask('legacy', 1, { manual: true, storeId: 'store' })!;
  port.updateScheduledTaskRun(legacy.id, { status: 'failed' }, 1);
  padHistory(database, history.id, budget - 5);
  const before = raw(database, legacy.id);
  assert.equal(port.claimScheduledTask('legacy', 2, { manual: true, storeId: 'store' }), null);
  assert.throws(() => port.deleteScheduledTask('legacy'), /scheduled_task_active/);
  assert.throws(
    () => port.updateScheduledTaskRun(legacy.id, { status: 'failed', settlementVersion: 1 }, 1),
    /scheduled_task_capacity_exceeded/,
  );
  assert.equal(raw(database, legacy.id), before);
  assert.equal(port.scheduledTaskRuns().length, 2);
  // Explicit deletion of independently verified history can reclaim room; unverified
  // history itself is never erased merely to bypass a missing settlement proof.
  port.deleteScheduledTask(task.id);
  port.updateScheduledTaskRun(legacy.id, { status: 'failed', settlementVersion: 1 }, 1);
  port.deleteScheduledTask('legacy');
  assert.equal(port.scheduledTaskRuns().length, 0);
  database.close();
}
{
  const { database, port, history, input } = fresh();
  port.saveScheduledTask({ ...input, id: 'legacy' }, 0);
  const legacy = port.claimScheduledTask('legacy', 1, { manual: true, storeId: 'store' })!;
  port.updateScheduledTaskRun(legacy.id, { status: 'failed' }, 1);
  const live = port.claimScheduledTask(task.id, 1, { manual: true, storeId: 'store' })!;
  const reserved = Buffer.byteLength(
    JSON.stringify({ ...live, ...maximumUpdate, updatedAt: maxTime, finishedAt: maxTime }),
  );
  padHistory(database, history.id, budget - (reserved - Buffer.byteLength(JSON.stringify(live))));
  const before = raw(database, legacy.id);
  assert.throws(
    () => port.updateScheduledTaskRun(legacy.id, { status: 'failed', settlementVersion: 1 }, 1),
    /scheduled_task_capacity_exceeded/,
  );
  assert.equal(raw(database, legacy.id), before);
  // The already-admitted run still receives every byte of its promised capacity.
  port.updateScheduledTaskRun(live.id, maximumUpdate, maxTime);
  assert.equal(bytes(database), budget);
  database.close();
}
