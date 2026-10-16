import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRun } from './scheduled-task-types';

export type NativeScheduledRequest =
  | { method: 'scheduled.list'; generation: number }
  | {
      method: 'scheduled.save';
      generation: number;
      operation: 'create' | 'update';
      input: ScheduledTaskInput;
    }
  | { method: 'scheduled.toggle'; generation: number; id: string; enabled: boolean }
  | { method: 'scheduled.delete' | 'scheduled.runNow'; generation: number; id: string };
export type NativeScheduledResult = {
  kind: 'scheduled.tasks';
  tasks: ScheduledTask[];
  runs: Omit<ScheduledTaskRun, 'task'>[];
};
