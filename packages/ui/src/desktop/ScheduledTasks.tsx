import { Add01Icon, AlarmClockIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useId, useState } from 'react';
import { Input } from './components/ui/input';
import { ScrollArea } from './components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
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
  const searchId = useId();
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const visible = props.tasks.filter(
    (task) =>
      (filter === 'all' || task.status === filter) &&
      (!query ||
        `${task.name}\n${task.prompt}\n${task.workspaceLabel}`.toLocaleLowerCase().includes(query)),
  );
  const content = (
    <>
      {!props.onCreate && (
        <p className="scheduled-unavailable" role="note">
          当前无法新建定时任务。
        </p>
      )}
      {props.error && (
        <p className="scheduled-error" role="alert">
          {props.error}
        </p>
      )}
      {visible.length ? (
        <section className="scheduled-list" aria-label="定时任务列表">
          {visible.map((task) => (
            <ScheduledTaskCard key={task.id} task={task} props={props} onEditTask={onEditTask} />
          ))}
        </section>
      ) : props.tasks.length ? (
        <section className="scheduled-empty scheduled-filter-empty">
          <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
          <h2>无匹配定时任务</h2>
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
            <HugeiconsIcon icon={AlarmClockIcon} aria-hidden="true" />
          </div>
          <h2>暂无定时任务</h2>
        </section>
      ) : null}
    </>
  );
  return (
    <ScrollArea className="scheduled-scroll">
      <Tabs
        value={filter}
        onValueChange={(value) => {
          if (value === 'all' || value === 'active' || value === 'paused') setFilter(value);
        }}
        asChild
      >
        <main
          className="scheduled-page"
          aria-label="定时任务"
          aria-busy={props.loading || undefined}
        >
          <h1 className="sr-only">定时任务</h1>
          <div className="scheduled-toolbar">
            {!!props.tasks.length && (
              <TabsList aria-label="筛选定时任务" className="rounded-full">
                {(
                  [
                    ['all', '全部'],
                    ['active', '已启用'],
                    ['paused', '已暂停'],
                  ] as const
                ).map(([value, label]) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="gap-1.5 rounded-full"
                    aria-label={`${label}定时任务`}
                  >
                    {label}
                    <span className="scheduled-count" aria-hidden="true">
                      {
                        props.tasks.filter((task) => value === 'all' || task.status === value)
                          .length
                      }
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            )}
            <div className="scheduled-toolbar-actions">
              {!!props.tasks.length && (
                <label className="scheduled-search" htmlFor={searchId}>
                  <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
                  <Input
                    id={searchId}
                    type="search"
                    className="pl-8"
                    aria-label="搜索定时任务"
                    placeholder="搜索定时任务或项目"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              )}
              <Button className="primary" onClick={(event) => onNewTask(event.currentTarget)}>
                <HugeiconsIcon icon={Add01Icon} aria-hidden="true" />
                新建
              </Button>
            </div>
          </div>
          {props.tasks.length ? (
            <TabsContent value={filter} className="m-0">
              {content}
            </TabsContent>
          ) : (
            content
          )}
        </main>
      </Tabs>
    </ScrollArea>
  );
}
