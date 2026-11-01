import type { ModelOption, ThinkingEffort } from './ModelEffortSelector';
import type { WorkspaceSummary } from './types';

export type ScheduledTaskReasoningEffort = ThinkingEffort | 'none' | 'minimal';

export interface ScheduledTaskDraft {
  readonly name: string;
  readonly prompt: string;
  readonly workspaceId: string;
  readonly modelId: string;
  readonly reasoningEffort?: ScheduledTaskReasoningEffort;
  readonly schedule: {
    readonly frequency: 'daily' | 'weekdays' | 'weekly';
    readonly time: string;
    readonly weekday?: number;
  };
  readonly environment: 'local';
}
export interface ScheduledTaskRunSummary {
  readonly id: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly sessionId?: string;
  readonly error?: string;
}
export interface ScheduledTaskSummary {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly workspaceLabel: string;
  readonly scheduleLabel: string;
  readonly environment: 'worktree' | 'local';
  readonly status: 'active' | 'paused';
  readonly nextRunAt?: string;
  readonly draft?: ScheduledTaskDraft;
  readonly runs?: readonly ScheduledTaskRunSummary[];
}
export type ScheduledTaskMutation = void | Promise<void>;
export interface ScheduledTasksProps {
  readonly tasks: readonly ScheduledTaskSummary[];
  readonly workspaces: readonly WorkspaceSummary[];
  readonly loading?: boolean;
  readonly error?: string;
  readonly models?: readonly (ModelOption & { readonly id: string })[];
  readonly onCreate?: (draft: ScheduledTaskDraft, creationKey?: string) => ScheduledTaskMutation;
  readonly onUpdate?: (id: string, draft: ScheduledTaskDraft) => ScheduledTaskMutation;
  readonly onToggle?: (id: string, active: boolean) => ScheduledTaskMutation;
  readonly onDelete?: (id: string) => ScheduledTaskMutation;
  readonly onRunNow?: (id: string) => ScheduledTaskMutation;
  readonly onOpenRun?: (taskId: string, runId: string) => ScheduledTaskMutation;
}
export function scheduledTaskError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const labels: Record<string, string> = {
    scheduled_task_not_started: '本次未新建运行，请查看运行记录。',
    scheduled_tasks_scope_changed: '连接或配置已变化，请重试保存。',
    scheduled_reasoning_effort_unavailable: '思考程度不可用，请重新选择。',
    cancel_requested: '已按请求停止。',
    model_failed: '模型回复失败，请查看会话。',
    workspace_untrusted: '项目未授权，请在会话中处理。',
  };
  return labels[message] ?? message;
}
export function validScheduledTaskDraft(draft: ScheduledTaskDraft): boolean {
  if (!draft.name.trim() || !draft.prompt.trim() || !draft.workspaceId || !draft.modelId)
    return false;
  if (
    draft.reasoningEffort !== undefined &&
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultar'].includes(
      draft.reasoningEffort,
    )
  )
    return false;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.schedule.time)) return false;
  if (
    draft.schedule.frequency === 'weekly' &&
    (!Number.isInteger(draft.schedule.weekday) ||
      draft.schedule.weekday! < 0 ||
      draft.schedule.weekday! > 6)
  )
    return false;
  return true;
}
