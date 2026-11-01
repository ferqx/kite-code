import { Add01Icon, CalendarClockIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';
import { ScrollArea } from './components/ui/scroll-area';
import { ScheduledTaskCard } from './ScheduledTaskCard';
import type { ScheduledTaskSummary, ScheduledTasksProps } from './scheduled-task-types';
import { Button } from './ui';

// Keep the public host contract and editor entry point stable.
export { ScheduledTaskEditor } from './ScheduledTaskEditor';
export type {
  ScheduledTaskDraft,
  ScheduledTaskRunSummary,
  ScheduledTaskSummary,
  ScheduledTasksProps,
} from './scheduled-task-types';
export { validScheduledTaskDraft } from './scheduled-task-types';

export function ScheduledTasks({
  onNewTask,
  onEditTask,
  ...props
}: ScheduledTasksProps & {
  onNewTask: (trigger: HTMLButtonElement) => void;
  onEditTask?: (task: ScheduledTaskSummary, trigger: HTMLButtonElement) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const visible = props.tasks.filter(
    (task) =>
      (filter === 'all' || task.status === filter) &&
      (!query ||
        `${task.name}\n${task.prompt}\n${task.workspaceLabel}`.toLocaleLowerCase().includes(query)),
  );
  return (
    <ScrollArea className="scheduled-scroll">
      <main className="scheduled-page" aria-label="安排任务" aria-busy={props.loading || undefined}>
        <header className="scheduled-page-heading">
          <div>
            <h1 className="sr-only">安排任务</h1>
            <p>仅在应用运行时执行</p>
          </div>
          <Button className="primary" onClick={(event) => onNewTask(event.currentTarget)}>
            <HugeiconsIcon icon={Add01Icon} aria-hidden="true" />
            新建
          </Button>
        </header>
        {!!props.tasks.length && (
          <div className="scheduled-toolbar">
            <fieldset className="scheduled-filters" aria-label="筛选任务">
              {(
                [
                  ['all', '全部'],
                  ['active', '已启用'],
                  ['paused', '已暂停'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  aria-label={`${label}任务`}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                  <span className="scheduled-count" aria-hidden="true">
                    {props.tasks.filter((task) => value === 'all' || task.status === value).length}
                  </span>
                </Button>
              ))}
            </fieldset>
            <label className="scheduled-search">
              <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索任务"
                placeholder="搜索任务或项目"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
        )}
        {!props.onCreate && (
          <p className="scheduled-unavailable" role="note">
            当前无法新建任务。
          </p>
        )}
        {props.error && (
          <p className="scheduled-error" role="alert">
            {props.error}
          </p>
        )}
        {visible.length ? (
          <section className="scheduled-list" aria-label="任务列表">
            {visible.map((task) => (
              <ScheduledTaskCard key={task.id} task={task} props={props} onEditTask={onEditTask} />
            ))}
          </section>
        ) : props.tasks.length ? (
          <section className="scheduled-empty scheduled-filter-empty">
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
            <h2>无匹配任务</h2>
            <Button
              variant="ghost"
              onClick={() => {
                setFilter('all');
                setSearch('');
              }}
            >
              清除筛选
            </Button>
          </section>
        ) : !props.loading && !props.error ? (
          <section className="scheduled-empty">
            <div className="scheduled-empty-icon">
              <HugeiconsIcon icon={CalendarClockIcon} aria-hidden="true" />
            </div>
            <h2>暂无任务</h2>
          </section>
        ) : null}
      </main>
    </ScrollArea>
  );
}
