import {
  ArrowDown01Icon,
  CalendarClockIcon,
  Delete02Icon,
  Folder01Icon,
  MoreHorizontalIcon,
  PlayIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import {
  type ScheduledTaskMutation,
  type ScheduledTaskRunSummary,
  type ScheduledTaskSummary,
  type ScheduledTasksProps,
  scheduledTaskError,
} from './scheduled-task-types';
import { Button } from './ui';

const runStatuses: Readonly<Record<string, { label: string; tone: string }>> = {
  queued: { label: '排队中', tone: 'neutral' },
  creating: { label: '创建会话中', tone: 'neutral' },
  starting: { label: '启动中', tone: 'neutral' },
  running: { label: '运行中', tone: 'active' },
  waiting: { label: '等待中', tone: 'attention' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '运行失败', tone: 'error' },
  unknown: { label: '结果未知', tone: 'attention' },
  cancelled: { label: '已停止', tone: 'neutral' },
};
function RunStatus({ status }: { status: string }) {
  const presentation = runStatuses[status] ?? { label: '状态未知', tone: 'attention' };
  return (
    <span className="scheduled-run-status" data-tone={presentation.tone}>
      <i aria-hidden="true" />
      {presentation.label}
    </span>
  );
}
function TaskRunHistory({
  runs = [],
  pending,
  onOpen,
}: {
  runs?: readonly ScheduledTaskRunSummary[];
  pending: boolean;
  onOpen?: (runId: string) => void;
}) {
  if (!runs.length) return null;
  return (
    <details className="scheduled-history">
      <summary>
        <span className="scheduled-history-title">
          <HugeiconsIcon icon={ArrowDown01Icon} aria-hidden="true" />
          运行记录<span className="scheduled-count">{runs.length}</span>
        </span>
        {runs[0] && <RunStatus status={runs[0].status} />}
      </summary>
      <div className="scheduled-history-list">
        {runs.map((run) => (
          <div className="scheduled-history-row" key={run.id}>
            <div className="scheduled-run-copy">
              <RunStatus status={run.status} />
              {(run.startedAt || run.finishedAt) && (
                <div className="scheduled-run-times">
                  {run.startedAt && <span>{run.startedAt}</span>}
                  {run.finishedAt && <span>结束 {run.finishedAt}</span>}
                </div>
              )}
              {run.error && !(run.status === 'cancelled' && run.error === 'cancel_requested') && (
                <p className="scheduled-run-reason">{scheduledTaskError(run.error)}</p>
              )}
            </div>
            {run.sessionId && onOpen && (
              <Button
                variant="ghost"
                className="scheduled-open-run"
                disabled={pending}
                onClick={() => onOpen(run.id)}
              >
                打开会话
              </Button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
export function ScheduledTaskCard({
  task,
  props,
  onEditTask,
}: {
  task: ScheduledTaskSummary;
  props: ScheduledTasksProps;
  onEditTask?: (task: ScheduledTaskSummary, trigger: HTMLButtonElement) => void;
}) {
  const [pending, setPending] = useState(false),
    pendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function perform(action: () => ScheduledTaskMutation) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
      setConfirmDelete(false);
    } catch (failure) {
      setError(scheduledTaskError(failure));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <article
      className="scheduled-card"
      aria-label={task.name}
      aria-busy={pending}
      data-paused={task.status === 'paused' || undefined}
    >
      <div className="scheduled-card-header">
        <div className="scheduled-card-identity">
          <span className="scheduled-task-icon">
            <HugeiconsIcon icon={CalendarClockIcon} aria-hidden="true" />
          </span>
          <h2 title={task.name}>{task.name}</h2>
        </div>
        <div className="scheduled-card-tools">
          <span className={`scheduled-status ${task.status}`}>
            <i aria-hidden="true" />
            {task.status === 'active' ? '已启用' : '已暂停'}
          </span>
          {props.onUpdate && task.draft && onEditTask && (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={(event) => onEditTask(task, event.currentTarget)}
            >
              编辑
            </Button>
          )}
          {props.onRunNow && (
            <Button
              className="scheduled-run-button"
              disabled={pending}
              onClick={() => void perform(() => props.onRunNow!(task.id))}
            >
              <HugeiconsIcon icon={PlayIcon} aria-hidden="true" />
              立即运行
            </Button>
          )}
          {(props.onToggle || props.onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${task.name}的更多操作`}
                  disabled={pending}
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="scheduled-task-menu" align="end">
                {props.onToggle && (
                  <DropdownMenuItem
                    onSelect={() =>
                      void perform(() => props.onToggle!(task.id, task.status !== 'active'))
                    }
                  >
                    {task.status === 'active' ? '暂停' : '启用'}
                  </DropdownMenuItem>
                )}
                {props.onToggle && props.onDelete && <DropdownMenuSeparator />}
                {props.onDelete && (
                  <DropdownMenuItem onSelect={() => setConfirmDelete(true)}>
                    <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
                    删除
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      <p className="scheduled-card-prompt" title={task.prompt}>
        {task.prompt}
      </p>
      <div className="scheduled-card-meta">
        <span>
          <HugeiconsIcon icon={Folder01Icon} aria-hidden="true" />
          {task.workspaceLabel}
        </span>
        <span>
          <HugeiconsIcon icon={CalendarClockIcon} aria-hidden="true" />
          {task.scheduleLabel}
        </span>
        {task.environment === 'worktree' && <span>独立工作树</span>}
        {task.status === 'active' && task.nextRunAt && (
          <span className="scheduled-next-run">
            <span>下次</span> {task.nextRunAt}
          </span>
        )}
      </div>
      {confirmDelete && (
        <fieldset className="scheduled-delete-confirm" aria-label="确认删除任务">
          <div>
            <strong>删除任务？</strong>
            <p>已有会话将保留。</p>
          </div>
          <div className="scheduled-confirm-actions">
            <Button variant="ghost" disabled={pending} onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void perform(() => props.onDelete!(task.id))}
            >
              删除
            </Button>
          </div>
        </fieldset>
      )}
      {error && (
        <p className="scheduled-error" role="alert">
          操作失败：{error}
        </p>
      )}
      <TaskRunHistory
        runs={task.runs}
        pending={pending}
        onOpen={
          props.onOpenRun
            ? (runId) => void perform(() => props.onOpenRun!(task.id, runId))
            : undefined
        }
      />
    </article>
  );
}
