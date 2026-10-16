import type { Database } from 'bun:sqlite';
import { MaintenanceError } from './types';

/** Frozen DB10 caller metadata. Restore retains original Store binding; never dispatches work. */
export function verifyDesktopScheduleRows(db: Database) {
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  const time = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 8640000000000000;
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error();
    return v as Record<string, unknown>;
  };
  const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => {
    if (
      required.some((k) => !(k in v)) ||
      Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
    )
      throw Error();
  };
  const task = (v: unknown) => {
    const t = object(v);
    keys(t, [
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
    ]);
    if (
      ![t.id, t.workspaceId, t.storeId].every(id) ||
      typeof t.modelId !== 'string' ||
      !/^[A-Za-z0-9_.:/-]{1,128}$/.test(t.modelId) ||
      typeof t.name !== 'string' ||
      !t.name.trim() ||
      Buffer.byteLength(t.name) > 512 ||
      typeof t.prompt !== 'string' ||
      !t.prompt.trim() ||
      Buffer.byteLength(t.prompt) > 262144 ||
      typeof t.enabled !== 'boolean' ||
      !time(t.createdAt) ||
      !time(t.updatedAt) ||
      (t.nextRunAt !== null && !time(t.nextRunAt)) ||
      t.enabled !== (t.nextRunAt !== null)
    )
      throw Error();
    const s = object(t.schedule);
    keys(s, ['frequency', 'time', 'timeZone'], ['weekday']);
    if (
      typeof s.frequency !== 'string' ||
      !['daily', 'weekdays', 'weekly'].includes(s.frequency) ||
      typeof s.time !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time) ||
      typeof s.timeZone !== 'string' ||
      s.timeZone.length > 128 ||
      /^[+-]/.test(s.timeZone) ||
      (s.weekday !== undefined &&
        (typeof s.weekday !== 'number' ||
          !Number.isInteger(s.weekday) ||
          s.weekday < 0 ||
          s.weekday > 6)) ||
      (s.frequency === 'weekly' && s.weekday === undefined)
    )
      throw Error();
    new Intl.DateTimeFormat('en', { timeZone: s.timeZone }).format(0);
    return t;
  };
  try {
    const tasks = new Set<string>(),
      active = new Set<string>();
    for (const table of ['scheduled_tasks', 'scheduled_task_runs']) {
      let count = 0,
        bytes = 0;
      for (const row of db
        .query<Record<string, unknown>, []>(
          `SELECT *,hex(CAST(state AS BLOB)) AS raw FROM ${table}`,
        )
        .iterate()) {
        if (typeof row.state !== 'string' || typeof row.raw !== 'string') throw Error();
        const raw = Buffer.from(row.raw, 'hex'),
          text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        bytes += raw.length;
        if (
          text !== row.state ||
          bytes > (table === 'scheduled_tasks' ? 1048576 : 33554432) ||
          ++count > (table === 'scheduled_tasks' ? 128 : 10000)
        )
          throw Error();
        const v = object(JSON.parse(text));
        if (v.id !== row.id) throw Error();
        if (table === 'scheduled_tasks') {
          task(v);
          tasks.add(String(v.id));
          continue;
        }
        keys(
          v,
          [
            'id',
            'taskId',
            'task',
            'occurrenceAt',
            'sessionId',
            'createCommandId',
            'startCommandId',
            'status',
            'createdAt',
            'updatedAt',
          ],
          ['serviceRunId', 'error', 'finishedAt', 'settlementVersion'],
        );
        if (
          ![v.id, v.taskId, v.sessionId, v.createCommandId, v.startCommandId].every(id) ||
          ![v.occurrenceAt, v.createdAt, v.updatedAt].every(time) ||
          typeof v.status !== 'string' ||
          ![
            'queued',
            'creating',
            'starting',
            'running',
            'waiting',
            'completed',
            'failed',
            'unknown',
            'cancelled',
          ].includes(v.status) ||
          (v.serviceRunId !== undefined && !id(v.serviceRunId)) ||
          (v.error !== undefined && (typeof v.error !== 'string' || v.error.length > 4096)) ||
          (v.finishedAt !== undefined && !time(v.finishedAt)) ||
          (v.settlementVersion !== undefined &&
            (v.settlementVersion !== 1 ||
              !['completed', 'failed', 'cancelled'].includes(v.status))) ||
          task(v.task).id !== v.taskId ||
          row.task_id !== v.taskId ||
          row.occurrence_at !== v.occurrenceAt ||
          !tasks.has(String(v.taskId))
        )
          throw Error();
        if (!['completed', 'failed', 'cancelled'].includes(v.status)) {
          const binding = JSON.stringify([v.taskId, object(v.task).storeId]);
          if (active.has(binding)) throw Error();
          active.add(binding);
        }
      }
    }
  } catch {
    throw new MaintenanceError('backup_ui_invalid');
  }
}
