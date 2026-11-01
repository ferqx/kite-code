import type { StartCommandRequest } from '@kite-ai/client';
export type ScheduledTaskSchedule = {
  frequency: 'daily' | 'weekdays' | 'weekly';
  time: string;
  weekday?: number;
  timeZone: string;
};
export type ScheduledTaskInput = {
  id?: string;
  name: string;
  prompt: string;
  workspaceId: string;
  modelId: string;
  reasoningEffort?: StartCommandRequest['reasoningEffort'];
  storeId: string;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
};
/** Renderer supplies wall-clock fields; the scheduling host owns the time zone. */
export type ScheduledTaskSaveInput = Omit<ScheduledTaskInput, 'schedule'> & {
  schedule: Omit<ScheduledTaskSchedule, 'timeZone'>;
};
export type ScheduledTask = Omit<ScheduledTaskInput, 'id'> & {
  id: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
};
export type ScheduledTaskRunStatus =
  | 'queued'
  | 'creating'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'cancelled';
export type ScheduledTaskRun = {
  id: string;
  taskId: string;
  task: ScheduledTask;
  occurrenceAt: number;
  sessionId: string;
  createCommandId: string;
  startCommandId: string;
  serviceRunId?: string;
  status: ScheduledTaskRunStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Original execution group (or an effect-free rejection) was verified settled. */
  settlementVersion?: 1;
};
export type ScheduledTaskRunUpdate = {
  status: ScheduledTaskRunStatus;
  serviceRunId?: string;
  /** null clears a recovered read error; persisted rows still only contain strings. */
  error?: string | null;
  settlementVersion?: 1;
};
