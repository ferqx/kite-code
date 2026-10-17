import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { DatabaseSync } from 'node:sqlite';
import { verifyDesktopScheduleRows } from '../../../../packages/agent/src/maintenance/desktop-schedules';
import {
  createScheduledTaskData,
  latestScheduledOccurrence,
  nextScheduledOccurrence,
  parseScheduledTaskInput,
} from '../../electron/scheduled-tasks';
import type { ScheduledTaskInput } from '../../src/scheduled-task-types';

const schedule = { frequency: 'daily' as const, time: '02:30', timeZone: 'America/New_York' };
const at = (s: string) => Date.parse(s);
const input: ScheduledTaskInput = {
  id: 'task',
  name: 'Review',
  prompt: 'Review work',
  workspaceId: 'workspace',
  storeId: 'store',
  modelId: 'model',
  enabled: true,
  schedule: { frequency: 'daily', time: '10:00', timeZone: 'UTC' },
};
function fixture() {
  const db = new Database(':memory:');
  db.exec('PRAGMA user_version=7');
  return { db, data: createScheduledTaskData(() => db as unknown as DatabaseSync) };
}
test('recurrence skips DST gaps and uses first overlap only', () => {
  expect(new Date(nextScheduledOccurrence(schedule, at('2026-03-07T08:00Z'))).toISOString()).toBe(
    '2026-03-09T06:30:00.000Z',
  );
  const overlap = { ...schedule, time: '01:30' };
  expect(nextScheduledOccurrence(overlap, at('2026-11-01T04:00Z'))).toBe(at('2026-11-01T05:30Z'));
  expect(nextScheduledOccurrence(overlap, at('2026-11-01T05:30Z'))).toBe(at('2026-11-02T06:30Z'));
  expect(latestScheduledOccurrence(overlap, at('2026-11-01T06:45Z'))).toBe(at('2026-11-01T05:30Z'));
});
test('weekday weekly half-hour zone and strict input', () => {
  expect(
    nextScheduledOccurrence(
      { frequency: 'weekdays', time: '09:00', timeZone: 'Asia/Kolkata' },
      at('2026-10-16T04:00Z'),
    ),
  ).toBe(at('2026-10-19T03:30Z'));
  expect(
    nextScheduledOccurrence(
      { frequency: 'weekly', weekday: 0, time: '00:00', timeZone: 'UTC' },
      at('2026-10-18T00:00Z'),
    ),
  ).toBe(at('2026-10-25T00:00Z'));
  for (const bad of [
    { ...input, extra: true },
    { ...input, schedule: { ...input.schedule, time: '25:00' } },
    { ...input, schedule: { ...input.schedule, timeZone: 'Not/AZone' } },
  ])
    expect(() => parseScheduledTaskInput(bad)).toThrow();
});
test('lazy DB10 atomic latest-only claim, active skip, durable identity, manual pause and store guard', () => {
  const { db, data } = fixture();
  expect(data.scheduledTasks()).toEqual([]);
  expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
  const saved = data.saveScheduledTask(input, at('2026-10-01T00:00Z'));
  expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 10 });
  expect(data.saveScheduledTask(input, at('2026-10-10T00:00Z'))).toEqual(saved);
  const run = data.claimScheduledTask('task', at('2026-10-15T12:00Z'), { storeId: 'store' })!;
  expect(run.occurrenceAt).toBe(at('2026-10-15T10:00Z'));
  expect(data.scheduledTasks()[0]!.nextRunAt).toBe(at('2026-10-16T10:00Z'));
  data.updateScheduledTaskRun(run.id, { status: 'unknown' }, at('2026-10-15T12:01Z'));
  expect(data.claimScheduledTask('task', at('2026-10-16T12:00Z'))).toBeNull();
  expect(data.scheduledTasks()[0]!.nextRunAt).toBe(at('2026-10-17T10:00Z'));
  const reopened = createScheduledTaskData(() => db as unknown as DatabaseSync);
  expect(reopened.scheduledTaskRuns()[0]!.sessionId).toBe(run.sessionId);
  expect(() => data.deleteScheduledTask('task')).toThrow('scheduled_task_active');
  data.updateScheduledTaskRun(run.id, { status: 'completed', settlementVersion: 1 });
  data.saveScheduledTask({ ...input, enabled: false }, at('2026-10-16T13:00Z'));
  expect(data.claimScheduledTask('task', at('2026-10-17T12:00Z'))).toBeNull();
  expect(() =>
    data.claimScheduledTask('task', at('2026-10-17T12:00Z'), { manual: true, storeId: 'restored' }),
  ).toThrow('scheduled_task_store_changed');
  expect(
    data.claimScheduledTask('task', at('2026-10-17T12:00Z'), { manual: true, storeId: 'store' }),
  ).not.toBeNull();
  verifyDesktopScheduleRows(db);
  db.close();
});
test('closed backup metadata rejects extra fields', () => {
  const { db, data } = fixture();
  data.saveScheduledTask(input, 0);
  verifyDesktopScheduleRows(db);
  db.exec("UPDATE scheduled_tasks SET state=json_set(state,'$.injected',1)");
  expect(() => verifyDesktopScheduleRows(db)).toThrow('backup_ui_invalid');
  db.close();
});
test('actual Node sqlite preserves claims and enforces raw-byte capacity through updates, deletion and restored bindings', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'scheduled-node-'));
  try {
    const outfile = join(root, 'fixture.mjs');
    const built = await Bun.build({
      entrypoints: [resolve('apps/desktop/test/scheduled-tasks-node.fixture.ts')],
      target: 'node',
      outdir: root,
      naming: 'fixture.mjs',
    });
    expect(built.success).toBe(true);
    const child = Bun.spawn(['node', outfile, join(root, 'data.sqlite')], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw Error(`scheduled_node_failed:${err}`);
    expect(out).toContain('scheduled-node-ok');
    expect(out).toContain('scheduled-node-capacity-and-restore-ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
test('aggregate task IPC budget is 1MiB and replacements subtract old bytes', () => {
  const { db, data } = fixture();
  for (let i = 0; i < 4; i++)
    data.saveScheduledTask({ ...input, id: `task${i}`, prompt: 'a'.repeat(250000) }, 0);
  expect(() =>
    data.saveScheduledTask({ ...input, id: 'too-much', prompt: 'a'.repeat(100000) }, 0),
  ).toThrow('scheduled_task_capacity_exceeded');
  expect(
    data.saveScheduledTask({ ...input, id: 'task0', prompt: 'b'.repeat(250000) }, 1).prompt[0],
  ).toBe('b');
  verifyDesktopScheduleRows(db);
  db.prepare('INSERT INTO scheduled_tasks VALUES(?,?)').run(
    'overflow',
    JSON.stringify({ ...data.scheduledTasks()[0], id: 'overflow' }),
  );
  expect(() => data.scheduledTasks()).toThrow('scheduled_task_invalid');
  expect(() => verifyDesktopScheduleRows(db)).toThrow('backup_ui_invalid');
  db.close();
});

test('restored Store bindings keep old unknown history and maintenance accepts one active run per binding', () => {
  const { db, data } = fixture();
  data.saveScheduledTask(input, 0);
  const old = data.claimScheduledTask('task', 1, { manual: true, storeId: 'store' })!;
  data.updateScheduledTaskRun(old.id, { status: 'unknown' }, 1);
  const before = db
    .prepare('SELECT hex(state) AS bytes FROM scheduled_task_runs WHERE id=?')
    .get(old.id);
  data.saveScheduledTask({ ...input, storeId: 'restored' }, 1);
  const current = data.claimScheduledTask('task', 1, { manual: true, storeId: 'restored' })!;
  expect(current).not.toBeNull();
  expect(current.id).not.toBe(old.id);
  expect(
    db.prepare('SELECT hex(state) AS bytes FROM scheduled_task_runs WHERE id=?').get(old.id),
  ).toEqual(before);
  verifyDesktopScheduleRows(db);
  expect(data.claimScheduledTask('task', 2, { manual: true, storeId: 'restored' })).toBeNull();
  data.updateScheduledTaskRun(current.id, { status: 'completed', settlementVersion: 1 }, 2);
  const due = data.claimScheduledTask('task', at('2026-10-16T10:00Z'), { storeId: 'restored' })!;
  expect(due.task.storeId).toBe('restored');
  verifyDesktopScheduleRows(db);
  const duplicate = { ...due, id: 'duplicate' };
  db.prepare('INSERT INTO scheduled_task_runs VALUES(?,?,?,?)').run(
    duplicate.id,
    duplicate.taskId,
    duplicate.occurrenceAt,
    JSON.stringify(duplicate),
  );
  expect(() => verifyDesktopScheduleRows(db)).toThrow('backup_ui_invalid');
  db.close();
});

test('legacy occurrence identities still prevent same-Store replay after the Store-bound hash upgrade', async () => {
  const { createHash } = await import('node:crypto');
  const { db, data } = fixture();
  data.saveScheduledTask(input, 0);
  const run = data.claimScheduledTask('task', 1, { manual: true, storeId: 'store' })!;
  const id = createHash('sha256').update('task:manual:1').digest('hex');
  const legacy = {
    ...run,
    id,
    sessionId: `st_s_${id}`,
    createCommandId: `st_c_${id}`,
    startCommandId: `st_r_${id}`,
    status: 'completed',
    settlementVersion: 1,
  };
  db.prepare('DELETE FROM scheduled_task_runs WHERE id=?').run(run.id);
  db.prepare('INSERT INTO scheduled_task_runs VALUES(?,?,?,?)').run(
    id,
    legacy.taskId,
    legacy.occurrenceAt,
    JSON.stringify(legacy),
  );
  expect(data.claimScheduledTask('task', 1, { manual: true, storeId: 'store' })).toBeNull();
  data.saveScheduledTask({ ...input, storeId: 'restored' }, 0);
  expect(data.claimScheduledTask('task', 1, { manual: true, storeId: 'restored' })).not.toBeNull();
  verifyDesktopScheduleRows(db);
  db.close();
});

test('legacy terminal rows block claim and deletion until explicit verified settlement, and both codecs close the marker', () => {
  const { db, data } = fixture();
  try {
    data.saveScheduledTask(input, 0);
    const run = data.claimScheduledTask('task', 1, { manual: true, storeId: 'store' })!;
    data.updateScheduledTaskRun(run.id, { status: 'failed' }, 1);
    const due = data.scheduledTasks()[0]!.nextRunAt;
    expect(
      data.claimScheduledTask('task', at('2026-10-15T12:00Z'), { storeId: 'store' }),
    ).toBeNull();
    expect(data.scheduledTasks()[0]!.nextRunAt).toBe(due);
    expect(() => data.deleteScheduledTask('task')).toThrow('scheduled_task_active');
    expect(data.updateScheduledTaskRun(run.id, { status: 'unknown' }, 2).status).toBe('failed');
    verifyDesktopScheduleRows(db);
    const original = data.scheduledTaskRuns()[0]!;
    for (const invalid of [
      { ...original, settlementVersion: 2 },
      { ...original, settlementVersion: 1, status: 'unknown' },
    ]) {
      const isolated = fixture();
      try {
        isolated.data.saveScheduledTask(input, 0);
        isolated.db
          .prepare('INSERT INTO scheduled_task_runs VALUES(?,?,?,?)')
          .run(invalid.id, invalid.taskId, invalid.occurrenceAt, JSON.stringify(invalid));
        expect(() => isolated.data.scheduledTaskRuns()).toThrow('scheduled_task_invalid');
        expect(() => verifyDesktopScheduleRows(isolated.db)).toThrow('backup_ui_invalid');
      } finally {
        isolated.db.close();
      }
    }
    expect(
      data.updateScheduledTaskRun(run.id, { status: 'completed', settlementVersion: 1 }, 2)
        .settlementVersion,
    ).toBe(1);
    verifyDesktopScheduleRows(db);
    expect(data.updateScheduledTaskRun(run.id, { status: 'unknown' }, 3).status).toBe('completed');
    data.deleteScheduledTask('task');
    expect(data.scheduledTasks()).toEqual([]);
  } finally {
    db.close();
  }
});
