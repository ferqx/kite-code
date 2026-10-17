import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskRunStatus,
  ScheduledTaskRunUpdate,
  ScheduledTaskSchedule,
} from '../src/scheduled-task-types';

export type NativeScheduledTaskData = {
  scheduledTasks(): ScheduledTask[];
  saveScheduledTask(input: ScheduledTaskInput, now?: number): ScheduledTask;
  deleteScheduledTask(id: string): void;
  scheduledTaskRuns(taskId?: string): ScheduledTaskRun[];
  claimScheduledTask(
    id: string,
    now: number,
    options?: { manual?: boolean; storeId?: string },
  ): ScheduledTaskRun | null;
  updateScheduledTaskRun(
    id: string,
    update: ScheduledTaskRunUpdate,
    now?: number,
  ): ScheduledTaskRun;
};
const fail = (): never => {
  throw Error('scheduled_task_invalid');
};
const idValid = (s: unknown): s is string =>
  typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const timeValid = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < 8640000000000000;
const terminal = (s: ScheduledTaskRunStatus) => ['completed', 'failed', 'cancelled'].includes(s);
const runByteLimit = 33554432;
const runBytes = (run: ScheduledTaskRun) => Buffer.byteLength(JSON.stringify(run));
const maximumRunUpdate = {
  status: 'cancelled' as const,
  serviceRunId: 'x'.repeat(128),
  error: '\u0000'.repeat(4096),
  updatedAt: 8639999999999999,
  finishedAt: 8639999999999999,
  settlementVersion: 1 as const,
};
// The old writer could cross the limit once; its next read refused any further writes.
// Allow that bounded growth for recovery reads, without accepting unbounded history.
const recoveryRunByteLimit = runByteLimit + Buffer.byteLength(JSON.stringify(maximumRunUpdate));
// Reserve live records only; legacy terminal verification may fail closed at capacity. JSON escaping
// can consume six bytes per permitted error code unit; timestamps and IDs are bounded too.
const reservedRunBytes = (run: ScheduledTaskRun) =>
  terminal(run.status) ? runBytes(run) : runBytes({ ...run, ...maximumRunUpdate });
const statuses = [
  'queued',
  'creating',
  'starting',
  'running',
  'waiting',
  'completed',
  'failed',
  'unknown',
  'cancelled',
];
export function parseScheduledTaskInput(value: unknown): ScheduledTaskInput {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          'id',
          'name',
          'prompt',
          'workspaceId',
          'modelId',
          'storeId',
          'schedule',
          'enabled',
        ].includes(k),
    )
  )
    fail();
  const schedule = (value as ScheduledTaskInput).schedule;
  if (
    !schedule ||
    typeof schedule !== 'object' ||
    Array.isArray(schedule) ||
    Object.keys(schedule).some((k) => !['frequency', 'time', 'weekday', 'timeZone'].includes(k))
  )
    fail();
  return validateScheduledTaskInput(value as ScheduledTaskInput);
}
export function validateScheduledTaskInput(input: ScheduledTaskInput): ScheduledTaskInput {
  if (
    !input ||
    typeof input !== 'object' ||
    (input.id !== undefined && !idValid(input.id)) ||
    !idValid(input.workspaceId) ||
    !idValid(input.storeId) ||
    typeof input.modelId !== 'string' ||
    !/^[A-Za-z0-9_.:/-]{1,128}$/.test(input.modelId) ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    Buffer.byteLength(input.name) > 512 ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    Buffer.byteLength(input.prompt) > 262144 ||
    typeof input.enabled !== 'boolean'
  )
    fail();
  const s = input.schedule;
  if (
    !s ||
    !['daily', 'weekdays', 'weekly'].includes(s.frequency) ||
    typeof s.time !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time) ||
    (s.weekday !== undefined && (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6)) ||
    (s.frequency === 'weekly' && s.weekday === undefined) ||
    typeof s.timeZone !== 'string' ||
    s.timeZone.length > 128 ||
    /^[+-]/.test(s.timeZone)
  )
    fail();
  try {
    new Intl.DateTimeFormat('en', { timeZone: s.timeZone }).format(0);
  } catch {
    fail();
  }
  return {
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    modelId: input.modelId,
    storeId: input.storeId,
    enabled: input.enabled,
    schedule: {
      frequency: s.frequency,
      time: s.time,
      timeZone: s.timeZone,
      ...(s.weekday !== undefined ? { weekday: s.weekday } : {}),
    },
  };
}
function formatter(zone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}
function wall(format: Intl.DateTimeFormat, at: number): number {
  const p = Object.fromEntries(format.formatToParts(at).map((v) => [v.type, v.value]));
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}
/** Missing local times are skipped. Repeated times use the first instant only. */
function occurrence(
  schedule: ScheduledTaskSchedule,
  day: number,
  format: Intl.DateTimeFormat,
): number | null {
  const weekday = new Date(day).getUTCDay();
  if (
    (schedule.frequency === 'weekdays' && (weekday === 0 || weekday === 6)) ||
    (schedule.frequency === 'weekly' && weekday !== schedule.weekday)
  )
    return null;
  const [h, m] = schedule.time.split(':').map(Number);
  const target = day + h! * 3600000 + m! * 60000;
  const offsets = new Set<number>();
  for (let i = -36; i <= 36; i += 6) {
    const sample = target + i * 3600000;
    offsets.add(wall(format, sample) - sample);
  }
  const matches = [...offsets]
    .map((offset) => target - offset)
    .filter((at) => wall(format, at) === target);
  return matches.length ? Math.min(...matches) : null;
}
function findOccurrence(schedule: ScheduledTaskSchedule, at: number, direction: 1 | -1): number {
  if (!timeValid(at)) fail();
  const format = formatter(schedule.timeZone),
    local = new Date(wall(format, at));
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  for (let n = 0; n < 370; n++) {
    const result = occurrence(schedule, day + n * 86400000 * direction, format);
    if (result !== null && (direction === 1 ? result > at : result <= at)) return result;
  }
  return fail();
}
export const nextScheduledOccurrence = (schedule: ScheduledTaskSchedule, after: number): number =>
  findOccurrence(schedule, after, 1);
export const latestScheduledOccurrence = (schedule: ScheduledTaskSchedule, at: number): number =>
  findOccurrence(schedule, at, -1);
export const scheduledTaskSchemas = [
  'CREATE TABLE scheduled_tasks(id TEXT PRIMARY KEY,state TEXT NOT NULL)',
  'CREATE TABLE scheduled_task_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,occurrence_at INTEGER NOT NULL,state TEXT NOT NULL)',
];
export function createScheduledTaskData(database: () => DatabaseSync): NativeScheduledTaskData {
  const version = () => Number(database().prepare('PRAGMA user_version').get()!.user_version);
  const migrate = () => {
    if (version() >= 10) return;
    if (version() < 8)
      database().exec(
        'CREATE TABLE workspace_removal_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)',
      );
    for (const schema of scheduledTaskSchemas) database().exec(schema);
    database().exec('PRAGMA user_version=10');
  };
  const transaction = <T>(action: () => T): T => {
    const db = database();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const parseTask = (value: unknown): ScheduledTask => {
    const t = value as ScheduledTask;
    if (
      !t ||
      typeof t !== 'object' ||
      Object.keys(t).some(
        (k) =>
          ![
            'id',
            'name',
            'prompt',
            'workspaceId',
            'modelId',
            'storeId',
            'schedule',
            'enabled',
            'nextRunAt',
            'createdAt',
            'updatedAt',
          ].includes(k),
      )
    )
      fail();
    const { nextRunAt: _next, createdAt: _created, updatedAt: _updated, ...input } = t;
    parseScheduledTaskInput(input);
    if (
      !idValid(t.id) ||
      !timeValid(t.createdAt) ||
      !timeValid(t.updatedAt) ||
      (t.nextRunAt !== null && !timeValid(t.nextRunAt)) ||
      t.enabled !== (t.nextRunAt !== null)
    )
      fail();
    return t;
  };
  const parseRun = (value: unknown): ScheduledTaskRun => {
    const r = value as ScheduledTaskRun;
    if (
      !r ||
      Object.keys(r).some(
        (k) =>
          ![
            'id',
            'taskId',
            'task',
            'occurrenceAt',
            'sessionId',
            'createCommandId',
            'startCommandId',
            'serviceRunId',
            'status',
            'error',
            'createdAt',
            'updatedAt',
            'finishedAt',
            'settlementVersion',
          ].includes(k),
      ) ||
      ![r.id, r.taskId, r.sessionId, r.createCommandId, r.startCommandId].every(idValid) ||
      !statuses.includes(r.status) ||
      !timeValid(r.occurrenceAt) ||
      !timeValid(r.createdAt) ||
      !timeValid(r.updatedAt) ||
      (r.serviceRunId !== undefined && !idValid(r.serviceRunId)) ||
      (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 4096)) ||
      (r.finishedAt !== undefined && !timeValid(r.finishedAt)) ||
      (r.settlementVersion !== undefined && (r.settlementVersion !== 1 || !terminal(r.status)))
    )
      fail();
    if (parseTask(r.task).id !== r.taskId) fail();
    return r;
  };
  const rows = <T>(
    table: string,
    parse: (v: unknown) => T,
    target?: { column: 'id' | 'task_id'; id: string },
  ): T[] => {
    if (version() < 10) return [];
    const result: T[] = [];
    let bytes = 0;
    for (const row of database()
      .prepare(
        `SELECT *,hex(CAST(state AS BLOB)) AS raw FROM ${table}${target ? ` WHERE ${target.column}=?` : ''} ORDER BY id`,
      )
      .iterate(...(target ? [target.id] : []))) {
      if (typeof row.state !== 'string' || typeof row.raw !== 'string') fail();
      const raw = Buffer.from(String(row.raw), 'hex'),
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      bytes += raw.length;
      if (!target && table === 'scheduled_task_runs' && bytes > recoveryRunByteLimit)
        throw Error('scheduled_task_capacity_exceeded');
      if (
        text !== row.state ||
        (!target && table === 'scheduled_tasks' && bytes > 1048576) ||
        result.length >= 10000
      )
        fail();
      const value = parse(JSON.parse(text));
      if ((value as { id: string }).id !== row.id) fail();
      if (table === 'scheduled_task_runs') {
        const run = value as ScheduledTaskRun;
        if (row.task_id !== run.taskId || row.occurrence_at !== run.occurrenceAt) fail();
      }
      result.push(value);
    }
    return result;
  };
  const tasks = () => {
    const values = rows('scheduled_tasks', parseTask);
    if (
      values.length > 128 ||
      values.reduce((n, t) => n + Buffer.byteLength(JSON.stringify(t)), 0) > 1048576
    )
      fail();
    return values;
  };
  const runs = () => rows('scheduled_task_runs', parseRun);
  const writeTask = (t: ScheduledTask) => {
    const bytes = Number(
      database()
        .prepare(
          'SELECT COALESCE(SUM(length(CAST(state AS BLOB))),0) AS bytes FROM scheduled_tasks WHERE id<>?',
        )
        .get(t.id)!.bytes,
    );
    if (bytes + Buffer.byteLength(JSON.stringify(t)) > 1048576)
      throw Error('scheduled_task_capacity_exceeded');
    database()
      .prepare(
        'INSERT INTO scheduled_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state',
      )
      .run(t.id, JSON.stringify(t));
  };
  const port: NativeScheduledTaskData = {
    scheduledTasks: tasks,
    scheduledTaskRuns(taskId) {
      return runs()
        .filter((r) => taskId === undefined || r.taskId === taskId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    saveScheduledTask(input, now = Date.now()) {
      const clean = parseScheduledTaskInput(input);
      if (!timeValid(now)) fail();
      return transaction(() => {
        const all = tasks(),
          old = clean.id ? all.find((t) => t.id === clean.id) : undefined;
        if (!old && all.length >= 128) throw Error('scheduled_task_capacity_exceeded');
        if (old && JSON.stringify(validateScheduledTaskInput(old)) === JSON.stringify(clean))
          return old;
        const task: ScheduledTask = {
          ...clean,
          id: old?.id ?? clean.id ?? randomUUID(),
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
          nextRunAt: clean.enabled ? nextScheduledOccurrence(clean.schedule, now) : null,
        };
        if (
          all.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t)), 0) -
            (old ? Buffer.byteLength(JSON.stringify(old)) : 0) +
            Buffer.byteLength(JSON.stringify(task)) >
          1048576
        )
          throw Error('scheduled_task_capacity_exceeded');
        migrate();
        writeTask(task);
        return task;
      });
    },
    deleteScheduledTask(id) {
      transaction(() => {
        const task = tasks().find((t) => t.id === id);
        // Inspect only this target, without the aggregate history budget. Explicit deletion
        // can therefore recover old oversized metadata without silently dropping history.
        const history = rows('scheduled_task_runs', parseRun, { column: 'task_id', id });
        if (
          history.some(
            (r) =>
              r.task.storeId === task?.storeId &&
              (!terminal(r.status) || r.settlementVersion !== 1),
          )
        )
          throw Error('scheduled_task_active');
        if (version() >= 10) {
          database().prepare('DELETE FROM scheduled_tasks WHERE id=?').run(id);
          database().prepare('DELETE FROM scheduled_task_runs WHERE task_id=?').run(id);
        }
      });
    },
    claimScheduledTask(id, now, options = {}) {
      if (!timeValid(now)) fail();
      return transaction(() => {
        const task = tasks().find((t) => t.id === id);
        if (!task) throw Error('scheduled_task_not_found');
        if (options.storeId !== undefined && options.storeId !== task.storeId)
          throw Error('scheduled_task_store_changed');
        if (!options.manual && (!task.enabled || task.nextRunAt === null || task.nextRunAt > now))
          return null;
        const history = runs();
        // Old foreground terminal labels are not settlement proof. Preserve the due
        // occurrence while the runner verifies every original group, not just the latest.
        if (
          history.some(
            (r) =>
              r.taskId === id &&
              r.task.storeId === task.storeId &&
              terminal(r.status) &&
              r.settlementVersion !== 1,
          )
        )
          return null;
        // Consume elapsed occurrences even while another run blocks dispatch; never queue a backlog.
        const occurrenceAt = options.manual ? now : latestScheduledOccurrence(task.schedule, now);
        if (!options.manual)
          writeTask({
            ...task,
            nextRunAt: nextScheduledOccurrence(task.schedule, now),
            updatedAt: now,
          });
        if (
          history.some(
            (r) => r.taskId === id && r.task.storeId === task.storeId && !terminal(r.status),
          )
        )
          return null;
        const hash = createHash('sha256')
          .update(
            `${id}:${task.storeId}:${options.manual ? 'manual' : 'scheduled'}:${occurrenceAt}`,
          )
          .digest('hex');
        const legacyHash = createHash('sha256')
          .update(`${id}:${options.manual ? 'manual' : 'scheduled'}:${occurrenceAt}`)
          .digest('hex');
        if (
          history.some(
            (r) => r.id === hash || (r.id === legacyHash && r.task.storeId === task.storeId),
          )
        )
          return null;
        if (history.length >= 10000) throw Error('scheduled_task_capacity_exceeded');
        const run: ScheduledTaskRun = {
          id: hash,
          taskId: id,
          task,
          occurrenceAt,
          sessionId: `st_s_${hash}`,
          createCommandId: `st_c_${hash}`,
          startCommandId: `st_r_${hash}`,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        };
        const storedBytes = new Map<string, number>();
        for (const row of database()
          .prepare('SELECT id,length(CAST(state AS BLOB)) AS bytes FROM scheduled_task_runs')
          .iterate())
          storedBytes.set(String(row.id), Number(row.bytes));
        if (
          history.reduce(
            (n, r) =>
              n +
              (terminal(r.status)
                ? storedBytes.get(r.id)!
                : Math.max(storedBytes.get(r.id)!, reservedRunBytes(r))),
            0,
          ) +
            reservedRunBytes(run) >
          runByteLimit
        )
          throw Error('scheduled_task_capacity_exceeded');
        database()
          .prepare('INSERT INTO scheduled_task_runs VALUES(?,?,?,?)')
          .run(run.id, id, occurrenceAt, JSON.stringify(run));
        return run;
      });
    },
    updateScheduledTaskRun(id, update, now = Date.now()) {
      if (!timeValid(now)) fail();
      if (
        !update ||
        typeof update !== 'object' ||
        Array.isArray(update) ||
        Object.keys(update).some(
          (key) => !['status', 'serviceRunId', 'error', 'settlementVersion'].includes(key),
        )
      )
        fail();
      return transaction(() => {
        const old = rows('scheduled_task_runs', parseRun, { column: 'id', id })[0];
        if (!old) throw Error('scheduled_task_run_not_found');
        if (terminal(old.status) && (old.settlementVersion === 1 || update.settlementVersion !== 1))
          return old;
        if (old.serviceRunId && update.serviceRunId && old.serviceRunId !== update.serviceRunId)
          fail();
        const value = parseRun({
          ...old,
          status: update.status,
          ...(update.serviceRunId !== undefined ? { serviceRunId: update.serviceRunId } : {}),
          ...(update.error !== undefined ? { error: update.error } : {}),
          ...(update.settlementVersion !== undefined
            ? { settlementVersion: update.settlementVersion }
            : {}),
          updatedAt: now,
          ...(terminal(update.status) ? { finishedAt: now } : {}),
        });
        const bytes = Number(
          database()
            .prepare(
              'SELECT COALESCE(SUM(length(CAST(state AS BLOB))),0) AS bytes FROM scheduled_task_runs WHERE id<>?',
            )
            .get(id)!.bytes,
        );
        if (bytes + runBytes(value) > runByteLimit) throw Error('scheduled_task_capacity_exceeded');
        if (terminal(old.status)) {
          // A legacy settlement marker has no reserved growth of its own. It must
          // not spend capacity already promised to other in-flight occurrences.
          const stored = new Map<string, number>();
          for (const row of database()
            .prepare('SELECT id,length(CAST(state AS BLOB)) AS bytes FROM scheduled_task_runs')
            .iterate())
            stored.set(String(row.id), Number(row.bytes));
          if (runBytes(value) > stored.get(id)!) {
            const promised = runs().reduce(
              (n, record) =>
                n +
                (terminal(record.status)
                  ? 0
                  : Math.max(0, reservedRunBytes(record) - stored.get(record.id)!)),
              0,
            );
            if (bytes + runBytes(value) + promised > runByteLimit)
              throw Error('scheduled_task_capacity_exceeded');
          }
        }
        database()
          .prepare('UPDATE scheduled_task_runs SET state=? WHERE id=?')
          .run(JSON.stringify(value), id);
        return value;
      });
    },
  };
  return port;
}
