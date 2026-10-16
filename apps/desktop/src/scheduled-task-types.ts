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
  storeId: string;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
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
  error?: string;
  settlementVersion?: 1;
};
