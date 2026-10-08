import { useState } from 'react';
import { ScrollArea } from './components/ui/scroll-area';
import type { WorkspaceSummary } from './types';
import { Button } from './ui';

export interface ScheduledTaskSummary {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly workspaceLabel: string;
  readonly scheduleLabel: string;
  readonly environment: 'worktree' | 'local';
  readonly status: 'active' | 'paused';
  readonly nextRunAt?: string;
}

export interface ScheduledTasksProps {
  readonly tasks: readonly ScheduledTaskSummary[];
  readonly workspaces: readonly WorkspaceSummary[];
  readonly onCreate?: (draft: {
    readonly name: string;
    readonly prompt: string;
    readonly workspaceId: string;
    readonly schedule: string;
    readonly environment: 'worktree' | 'local';
  }) => void;
  readonly onToggle?: (id: string, active: boolean) => void;
  readonly onDelete?: (id: string) => void;
}

export function ScheduledTaskEditor({
  props,
  onClose,
}: {
  props: ScheduledTasksProps;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workspaceId, setWorkspaceId] = useState(props.workspaces[0]?.id ?? '');
  const [schedule, setSchedule] = useState('weekdays-0900');
  const [environment, setEnvironment] = useState<'worktree' | 'local'>('worktree');
  const valid = !!name.trim() && !!prompt.trim() && !!workspaceId;
  return (
    <form
      className="scheduled-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !props.onCreate) return;
        props.onCreate({
          name: name.trim(),
          prompt: prompt.trim(),
          workspaceId,
          schedule,
          environment,
        });
        onClose();
      }}
    >
      <div className="scheduled-editor-body">
        <input
          className="scheduled-title-input"
          aria-label="名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="安排任务标题"
        />
        <textarea
          className="scheduled-prompt-input"
          aria-label="任务说明"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述 kite 应该做什么"
        />
        <section className="scheduled-editor-section" aria-labelledby="scheduled-details-title">
          <h3 id="scheduled-details-title">详情</h3>
          <div className="scheduled-editor-group">
            <label className="scheduled-editor-row">
              <span>项目</span>
              <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
                {!props.workspaces.length && <option value="">暂无项目</option>}
                {props.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="scheduled-editor-row">
              <span>运行环境</span>
              <select
                value={environment}
                onChange={(event) => setEnvironment(event.target.value as 'worktree' | 'local')}
              >
                <option value="worktree">独立工作树</option>
                <option value="local">本地项目</option>
              </select>
            </label>
          </div>
        </section>
        <section className="scheduled-editor-section" aria-labelledby="scheduled-frequency-title">
          <h3 id="scheduled-frequency-title">频率</h3>
          <div className="scheduled-editor-group">
            <label className="scheduled-editor-row">
              <span>重复</span>
              <select value={schedule} onChange={(event) => setSchedule(event.target.value)}>
                <option value="daily-0900">每天 09:00</option>
                <option value="weekdays-0900">工作日 09:00</option>
                <option value="weekly-monday-0900">每周一 09:00</option>
              </select>
            </label>
          </div>
        </section>
        {!props.onCreate && (
          <p className="scheduled-unavailable" role="note">
            当前桌面服务尚未接入任务保存与后台运行。
          </p>
        )}
      </div>
      <footer className="scheduled-editor-footer">
        <Button onClick={onClose}>取消</Button>
        <Button type="submit" className="primary" disabled={!valid || !props.onCreate}>
          保存任务
        </Button>
      </footer>
    </form>
  );
}

export function ScheduledTasks({
  onNewTask,
  ...props
}: ScheduledTasksProps & { onNewTask: (trigger: HTMLButtonElement) => void }) {
  return (
    <ScrollArea className="scheduled-scroll">
      <main className="scheduled-page" aria-label="安排任务">
        <header className="scheduled-page-heading">
          <div>
            <h1>安排任务</h1>
            <p>让 kite 按计划在后台处理重复工作，并在这里查看最近运行。</p>
          </div>
          <Button className="primary" onClick={(event) => onNewTask(event.currentTarget)}>
            新建任务
          </Button>
        </header>
        {props.tasks.length ? (
          <section className="scheduled-list" aria-label="任务列表">
            {props.tasks.map((task) => (
              <article className="scheduled-card" key={task.id}>
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
                  {props.onToggle && (
                    <Button onClick={() => props.onToggle?.(task.id, task.status !== 'active')}>
                      {task.status === 'active' ? '暂停' : '启用'}
                    </Button>
                  )}
                  {props.onDelete && (
                    <Button variant="ghost" onClick={() => props.onDelete?.(task.id)}>
                      删除
                    </Button>
                  )}
                </div>
              </article>
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
