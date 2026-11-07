import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type ReactNode, useId, useRef, useState } from 'react';
import {
  AnimatedCollapsibleContent,
  Collapsible,
  CollapsibleTrigger,
} from './components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Input } from './components/ui/input';
import { PillSelectTrigger } from './components/ui/pill-select-trigger';
import { TimePicker } from './components/ui/time-picker';
import {
  ModelEffortSelector,
  type ModelEffortSelectorProps,
  resolveThinkingEffort,
} from './ModelEffortSelector';
import { ProjectSelector } from './NewConversation';
import {
  type ScheduledTaskDraft,
  type ScheduledTaskReasoningEffort,
  type ScheduledTaskSummary,
  type ScheduledTasksProps,
  scheduledTaskError,
  validScheduledTaskDraft,
} from './scheduled-task-types';
import { Button, Textarea } from './ui';

function EditorSection({
  title,
  framed = false,
  children,
}: {
  title: string;
  framed?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`scheduled-editor-section${framed ? ' scheduled-setting-card' : ''}`}
      aria-label={title}
    >
      {children}
    </section>
  );
}
function EditorRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="scheduled-setting-row">
      {htmlFor ? (
        <label className="scheduled-setting-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="scheduled-setting-label">{label}</span>
      )}
      <div className="scheduled-setting-value">{children}</div>
    </div>
  );
}
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const frequencies = [
  ['daily', '每天'],
  ['weekdays', '工作日'],
  ['weekly', '每周'],
] as const;
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
  const creationKey = useId(),
    formId = useId(),
    nameId = useId(),
    promptId = useId();
  const daysName = useId(),
    timeId = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [workspaceId, setWorkspaceId] = useState(
    initial?.workspaceId ?? props.workspaces[0]?.id ?? '',
  );
  const [modelId, setModelId] = useState(initial?.modelId ?? props.models?.[0]?.id ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    initial?.reasoningEffort,
  );
  const selectedModel = props.models?.find((model) => model.id === modelId);
  const effort = selectedModel
    ? resolveThinkingEffort(
        reasoningEffort ?? selectedModel.reasoningEffort,
        selectedModel.reasoningEffortChoices,
      )
    : undefined;
  const [frequency, setFrequency] = useState<ScheduledTaskDraft['schedule']['frequency']>(
    initial?.schedule.frequency ?? 'weekdays',
  );
  const [time, setTime] = useState(initial?.schedule.time ?? '09:00');
  const [weekday, setWeekday] = useState(initial?.schedule.weekday ?? 1);
  const [pending, setPending] = useState(false),
    pendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const modelSelection: ModelEffortSelectorProps = {
    model: selectedModel,
    models: props.models ?? [],
    disabled: pending || !props.models?.length,
    reasoningEffort: effort,
    onModelChange: (_provider, _name, id) => {
      if (id !== undefined) {
        setModelId(id);
        setReasoningEffort(undefined);
      }
    },
    onReasoningEffortChange: setReasoningEffort,
  };
  const draft: ScheduledTaskDraft = {
    name: name.trim(),
    prompt: prompt.trim(),
    workspaceId,
    modelId,
    ...(effort === undefined ? {} : { reasoningEffort: effort as ScheduledTaskReasoningEffort }),
    schedule: {
      frequency,
      time,
      ...(frequency === 'weekly' ? { weekday } : {}),
    },
    environment: 'local',
  };
  const valid =
    validScheduledTaskDraft(draft) &&
    props.workspaces.some((item) => item.id === workspaceId) &&
    !!selectedModel &&
    (effort === undefined ||
      selectedModel.reasoningEffortChoices === undefined ||
      selectedModel.reasoningEffortChoices.includes(effort as ScheduledTaskReasoningEffort) ||
      effort === selectedModel.reasoningEffort);
  const save = task
    ? props.onUpdate
      ? () => props.onUpdate!(task.id, draft)
      : undefined
    : props.onCreate
      ? () => props.onCreate!(draft, creationKey)
      : undefined;
  return (
    <form
      id={formId}
      className="scheduled-editor right-sidebar-editor"
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
          setError(scheduledTaskError(failure));
        } finally {
          pendingRef.current = false;
          setPending(false);
        }
      }}
    >
      <div className="scheduled-editor-body right-sidebar-editor-body">
        <EditorSection title="定时任务内容">
          <div className="scheduled-field">
            <label className="sr-only" htmlFor={nameId}>
              名称
            </label>
            <Input
              id={nameId}
              className="h-9"
              aria-label="名称"
              placeholder="名称"
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="scheduled-field">
            <label className="sr-only" htmlFor={promptId}>
              说明
            </label>
            <Textarea
              id={promptId}
              className="scheduled-prompt-input"
              aria-label="定时任务说明"
              value={prompt}
              disabled={pending}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="说明…"
              required
            />
          </div>
        </EditorSection>
        <EditorSection title="执行时间" framed>
          <EditorRow label="重复">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PillSelectTrigger aria-label="重复频率" disabled={pending}>
                  {frequencies.find(([value]) => value === frequency)![1]}
                </PillSelectTrigger>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" collisionPadding={16}>
                <DropdownMenuRadioGroup value={frequency}>
                  {frequencies.map(([value, label]) => (
                    <DropdownMenuRadioItem
                      key={value}
                      value={value}
                      indicatorPosition="end"
                      onSelect={() => setFrequency(value)}
                    >
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </EditorRow>
          {frequency === 'weekly' && (
            <fieldset className="scheduled-weekdays" disabled={pending}>
              <legend className="sr-only">星期</legend>
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <label key={day}>
                  <input
                    className="sr-only"
                    type="radio"
                    name={daysName}
                    aria-label={`星期${weekdays[day]}`}
                    value={day}
                    checked={weekday === day}
                    onChange={() => setWeekday(day)}
                  />
                  <span>{weekdays[day]}</span>
                </label>
              ))}
            </fieldset>
          )}
          <EditorRow label="时间" htmlFor={timeId}>
            <TimePicker
              id={timeId}
              value={time}
              onValueChange={setTime}
              disabled={pending}
              form={formId}
            />
          </EditorRow>
        </EditorSection>
        <Collapsible className="scheduled-advanced" defaultOpen>
          <CollapsibleTrigger asChild>
            <Button className="scheduled-advanced-trigger" variant="ghost">
              高级
              <HugeiconsIcon icon={ArrowDown01Icon} aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <AnimatedCollapsibleContent>
            <EditorSection title="运行设置">
              <div className="scheduled-setting-card">
                <EditorRow label="项目">
                  <ProjectSelector
                    projects={props.workspaces}
                    value={workspaceId}
                    disabled={pending || !props.workspaces.length}
                    onChange={setWorkspaceId}
                  />
                </EditorRow>
                {!props.workspaces.some((workspace) => workspace.id === workspaceId) && (
                  <small className="scheduled-field-hint">请选择项目。</small>
                )}
              </div>
              <div className="scheduled-setting-card">
                <EditorRow label="模型">
                  <ModelEffortSelector {...modelSelection} mode="model" />
                </EditorRow>
                {!selectedModel && (
                  <small className="scheduled-field-hint">
                    {props.models?.length ? '请选择模型。' : '暂无可用模型。'}
                  </small>
                )}
              </div>
              <div className="scheduled-setting-card">
                <EditorRow label="思考程度">
                  <ModelEffortSelector {...modelSelection} mode="effort" />
                </EditorRow>
              </div>
            </EditorSection>
          </AnimatedCollapsibleContent>
        </Collapsible>
        {!save && (
          <p className="scheduled-unavailable" role="note">
            当前无法保存定时任务。
          </p>
        )}
        {error && (
          <p className="scheduled-error" role="alert">
            保存失败：{error}
          </p>
        )}
      </div>
      <footer className="scheduled-editor-footer right-sidebar-editor-footer">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          取消
        </Button>
        <Button type="submit" className="primary" disabled={!valid || !save || pending}>
          {pending ? '正在保存…' : task ? '保存' : '创建'}
        </Button>
      </footer>
    </form>
  );
}
