import { useRef, useState } from 'react';
import { ScrollArea } from './components/ui/scroll-area';
import type { WorkspaceSummary } from './types';
import { Button } from './ui';

export interface ScheduledTaskDraft {
  readonly name: string;
  readonly prompt: string;
  readonly workspaceId: string;
  readonly modelId: string;
  readonly schedule: {
    readonly frequency: 'daily' | 'weekdays' | 'weekly';
    readonly time: string;
    readonly timeZone: string;
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
type Mutation = void | Promise<void>;
export interface ScheduledTasksProps {
  readonly tasks: readonly ScheduledTaskSummary[];
  readonly workspaces: readonly WorkspaceSummary[];
  readonly loading?: boolean;
  readonly error?: string;
  readonly models?: readonly { readonly id: string; readonly label: string }[];
  readonly onCreate?: (draft: ScheduledTaskDraft) => Mutation;
  readonly onUpdate?: (id: string, draft: ScheduledTaskDraft) => Mutation;
  readonly onToggle?: (id: string, active: boolean) => Mutation;
  readonly onDelete?: (id: string) => Mutation;
  readonly onRunNow?: (id: string) => Mutation;
  readonly onOpenRun?: (taskId: string, runId: string) => Mutation;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export function validScheduledTaskDraft(draft: ScheduledTaskDraft): boolean {
  if (!draft.name.trim() || !draft.prompt.trim() || !draft.workspaceId || !draft.modelId)
    return false;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.schedule.time)) return false;
  if (
    draft.schedule.frequency === 'weekly' &&
    (!Number.isInteger(draft.schedule.weekday) ||
      draft.schedule.weekday! < 0 ||
      draft.schedule.weekday! > 6)
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: draft.schedule.timeZone }).format();
    return !!draft.schedule.timeZone.trim();
  } catch {
    return false;
  }
}
export function ScheduledTaskEditor({
  props,
  task,
  onClose,
}: {
  props: ScheduledTasksProps;
  task?: ScheduledTaskSummary;
  onClose: () => void;
}) {
  const initial = task?.draft;
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [workspaceId, setWorkspaceId] = useState(
    initial?.workspaceId ?? props.workspaces[0]?.id ?? '',
  );
  const [modelId, setModelId] = useState(initial?.modelId ?? props.models?.[0]?.id ?? '');
  const [frequency, setFrequency] = useState<ScheduledTaskDraft['schedule']['frequency']>(
    initial?.schedule.frequency ?? 'weekdays',
  );
  const [time, setTime] = useState(initial?.schedule.time ?? '09:00');
  const [timezone, setTimezone] = useState(
    initial?.schedule.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );
  const [weekday, setWeekday] = useState(initial?.schedule.weekday ?? 1);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const draft: ScheduledTaskDraft = {
    name: name.trim(),
    prompt: prompt.trim(),
    workspaceId,
    modelId,
    schedule: {
      frequency,
      time,
      timeZone: timezone.trim(),
      ...(frequency === 'weekly' ? { weekday } : {}),
    },
    environment: 'local',
  };
  const valid =
    validScheduledTaskDraft(draft) &&
    props.workspaces.some((item) => item.id === workspaceId) &&
    !!props.models?.some((item) => item.id === modelId);
  const save = task
    ? props.onUpdate
      ? () => props.onUpdate!(task.id, draft)
      : undefined
    : props.onCreate
      ? () => props.onCreate!(draft)
      : undefined;
  return (
    <form
      className="scheduled-editor"
      aria-busy={pending}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid || !save || pendingRef.current) return;
        pendingRef.current = true;
        setPending(true);
        setError(undefined);
        try {
          await save();
          onClose();
        } catch (failure) {
          setError(errorMessage(failure));
        } finally {
          pendingRef.current = false;
          setPending(false);
        }
      }}
    >
      <div className="scheduled-editor-body">
        <input
          className="scheduled-title-input"
          aria-label="名称"
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
          placeholder="安排任务标题"
        />
        <textarea
          className="scheduled-prompt-input"
          aria-label="任务说明"
          value={prompt}
          disabled={pending}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述 Kite 应该做什么"
        />
        <section className="scheduled-editor-section" aria-labelledby="scheduled-details-title">
          <h3 id="scheduled-details-title">详情</h3>
          <p role="note">
            仅在应用运行时执行；退出后暂停，重新打开最多补最近一次。每次独立会话，审批仍需处理。
          </p>
          <div className="scheduled-editor-group">
            <label className="scheduled-editor-row">
              <span>项目</span>
              <select
                value={workspaceId}
                disabled={pending}
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                {!props.workspaces.some((item) => item.id === workspaceId) && (
                  <option value={workspaceId}>项目不可用，请重新选择</option>
                )}
                {props.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="scheduled-editor-row">
              <span>模型</span>
              <select
                value={modelId}
                disabled={pending}
                onChange={(event) => setModelId(event.target.value)}
              >
                {!props.models?.some((item) => item.id === modelId) && (
                  <option value={modelId}>模型不可用，请重新选择</option>
                )}
                {props.models?.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="scheduled-editor-row">
              <span>运行环境</span>
              <select value="local" disabled>
                <option value="local">本地项目</option>
                <option value="worktree" disabled>
                  独立工作树（暂不支持）
                </option>
              </select>
            </label>
          </div>
        </section>
        <section className="scheduled-editor-section" aria-labelledby="scheduled-frequency-title">
          <h3 id="scheduled-frequency-title">频率</h3>
          <div className="scheduled-editor-group">
            <label className="scheduled-editor-row">
              <span>重复</span>
              <select
                value={frequency}
                disabled={pending}
                onChange={(event) => setFrequency(event.target.value as typeof frequency)}
              >
                <option value="daily">每天</option>
                <option value="weekdays">工作日</option>
                <option value="weekly">每周</option>
              </select>
            </label>
            {frequency === 'weekly' && (
              <label className="scheduled-editor-row">
                <span>星期</span>
                <select
                  value={weekday}
                  disabled={pending}
                  onChange={(event) => setWeekday(Number(event.target.value))}
                >
                  {['日', '一', '二', '三', '四', '五', '六'].map((day, index) => (
                    <option key={day} value={index}>
                      星期{day}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="scheduled-editor-row">
              <span>时间</span>
              <input
                type="time"
                value={time}
                disabled={pending}
                onChange={(event) => setTime(event.target.value)}
                required
              />
            </label>
            <label className="scheduled-editor-row">
              <span>时区</span>
              <input
                value={timezone}
                disabled={pending}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Asia/Shanghai"
                required
              />
            </label>
          </div>
        </section>
        {!save && (
          <p className="scheduled-unavailable" role="note">
            当前桌面服务尚未接入任务保存与后台运行。
          </p>
        )}
        {error && (
          <p className="scheduled-error" role="alert">
            保存失败：{error}
          </p>
        )}
      </div>
      <footer className="scheduled-editor-footer">
        <Button onClick={onClose} disabled={pending}>
          取消
        </Button>
        <Button type="submit" className="primary" disabled={!valid || !save || pending}>
          {pending ? '正在保存…' : '保存任务'}
        </Button>
      </footer>
    </form>
  );
}
function ScheduledTaskCard({
  task,
  props,
  onEditTask,
}: {
  task: ScheduledTaskSummary;
  props: ScheduledTasksProps;
  onEditTask?: (task: ScheduledTaskSummary, trigger: HTMLButtonElement) => void;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function perform(action: () => Mutation) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
      setConfirmDelete(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <article className="scheduled-card" aria-busy={pending}>
      <div className="scheduled-card-copy">
        <div>
          <strong>{task.name}</strong>
          <span className={`scheduled-status ${task.status}`}>
            {task.status === 'active' ? '启用' : '已暂停'}
          </span>
        </div>
        <p>{task.prompt}</p>
        <small>
          {task.workspaceLabel} · {task.scheduleLabel} ·{' '}
          {task.environment === 'worktree' ? '独立工作树' : '本地项目'}
          {task.nextRunAt ? ` · 下次 ${task.nextRunAt}` : ''}
        </small>
      </div>
      <div className="scheduled-card-actions">
        {props.onUpdate && task.draft && onEditTask && (
          <Button disabled={pending} onClick={(event) => onEditTask(task, event.currentTarget)}>
            编辑
          </Button>
        )}
        {props.onRunNow && (
          <Button disabled={pending} onClick={() => void perform(() => props.onRunNow!(task.id))}>
            立即运行
          </Button>
        )}
        {props.onToggle && (
          <Button
            disabled={pending}
            onClick={() => void perform(() => props.onToggle!(task.id, task.status !== 'active'))}
          >
            {task.status === 'active' ? '暂停' : '启用'}
          </Button>
        )}
        {props.onDelete && (
          <Button variant="ghost" disabled={pending} onClick={() => setConfirmDelete(true)}>
            删除
          </Button>
        )}
      </div>
      {confirmDelete && (
        <fieldset className="scheduled-delete-confirm" aria-label="确认删除任务">
          <span>删除此安排任务？已有运行会话仍保留。</span>
          <Button disabled={pending} onClick={() => void perform(() => props.onDelete!(task.id))}>
            确认删除
          </Button>
          <Button disabled={pending} onClick={() => setConfirmDelete(false)}>
            取消
          </Button>
        </fieldset>
      )}
      {error && (
        <p className="scheduled-error" role="alert">
          操作失败：{error}
        </p>
      )}
      <details className="scheduled-history">
        <summary>运行记录（{task.runs?.length ?? 0}）</summary>
        {!task.runs?.length && <p>暂无运行记录</p>}
        {task.runs?.map((run) => (
          <div className="scheduled-history-row" key={run.id}>
            <span>
              {run.startedAt ?? '等待运行'} · {run.status}
              {run.finishedAt ? ` · 结束 ${run.finishedAt}` : ''}
            </span>
            {run.error && <span>{run.error}</span>}
            {run.sessionId && props.onOpenRun && (
              <Button
                disabled={pending}
                onClick={() => void perform(() => props.onOpenRun!(task.id, run.id))}
              >
                打开会话
              </Button>
            )}
          </div>
        ))}
      </details>
    </article>
  );
}
export function ScheduledTasks({
  onNewTask,
  onEditTask,
  ...props
}: ScheduledTasksProps & {
  onNewTask: (trigger: HTMLButtonElement) => void;
  onEditTask?: (task: ScheduledTaskSummary, trigger: HTMLButtonElement) => void;
}) {
  return (
    <ScrollArea className="scheduled-scroll">
      <main className="scheduled-page" aria-label="安排任务">
        <header className="scheduled-page-heading">
          <div>
            <h1>安排任务</h1>
            <p>仅在应用运行时按计划执行，每次创建独立会话。关闭窗口继续运行，退出应用停止调度。</p>
          </div>
          <Button className="primary" onClick={(event) => onNewTask(event.currentTarget)}>
            新建任务
          </Button>
        </header>
        {!props.onCreate && (
          <p className="scheduled-unavailable" role="note">
            当前桌面服务尚未接入任务保存与后台运行。
          </p>
        )}
        {props.loading && <p role="status">正在读取安排任务…</p>}
        {props.error && (
          <p className="scheduled-error" role="alert">
            {props.error}
          </p>
        )}
        {props.tasks.length ? (
          <section className="scheduled-list" aria-label="任务列表">
            {props.tasks.map((task) => (
              <ScheduledTaskCard key={task.id} task={task} props={props} onEditTask={onEditTask} />
            ))}
          </section>
        ) : (
          <section className="scheduled-empty">
            <div className="scheduled-empty-icon" aria-hidden="true">
              ◷
            </div>
            <h2>还没有安排任务</h2>
            <p>把已经稳定的重复工作安排在固定时间运行，例如检查 CI、汇总提交或生成周报。</p>
            <Button onClick={(event) => onNewTask(event.currentTarget)}>创建第一个任务</Button>
          </section>
        )}
      </main>
    </ScrollArea>
  );
}
