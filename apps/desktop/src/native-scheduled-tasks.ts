import type {
  ScheduledTaskDraft,
  ScheduledTasksProps,
  WorkspaceSummary,
} from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import type { NativeScheduledRequest, NativeScheduledResult } from './scheduled-bridge';

/** Page reads never select a Session; only the explicit result action changes navigation. */
export function useNativeScheduledTasks(options: {
  bridge: NativeBridge;
  generation: number;
  storeId?: string;
  active: boolean;
  revision?: number;
  workspaces: readonly WorkspaceSummary[];
  onOpen: (sessionId: string) => Promise<void>;
}): ScheduledTasksProps {
  const { bridge, generation, storeId, active, revision, workspaces } = options;
  const [facts, setFacts] = useState<NativeScheduledResult>();
  const [models, setModels] = useState<NonNullable<ScheduledTasksProps['models']>>([]);
  const [error, setError] = useState('');
  const [modelError, setModelError] = useState('');
  const [loading, setLoading] = useState(false);
  const identity = `${generation}/${storeId}/${revision ?? 0}`;
  const current = useRef(identity);
  current.current = identity;
  const sequence = useRef(0);
  const creations = useRef(new Map<string, { id: string; storeId: string; confirmed: boolean }>());
  const publish = useCallback((value: unknown, original: string) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('kind' in value) ||
      value.kind !== 'scheduled.tasks'
    )
      throw Error('scheduled_tasks_unavailable');
    const result = value as NativeScheduledResult;
    if (current.current === original) {
      for (const creation of creations.current.values())
        if (
          result.tasks.some((task) => task.id === creation.id && task.storeId === creation.storeId)
        )
          creation.confirmed = true;
      setFacts(result);
    }
    return result;
  }, []);
  useEffect(() => {
    if (!active || !generation || !storeId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let modelTimer: ReturnType<typeof setTimeout> | undefined;
    const original = identity;
    const read = async () => {
      const request = ++sequence.current;
      try {
        const value = await bridge.request({ method: 'scheduled.list', generation });
        if (!stopped && current.current === original && request === sequence.current) {
          publish(value, original);
          setError('');
        }
      } catch (cause) {
        if (!stopped && current.current === original)
          setError(cause instanceof Error ? cause.message : '读取失败');
      } finally {
        if (!stopped) {
          setLoading(false);
          timer = setTimeout(read, 5000);
        }
      }
    };
    const readModels = async () => {
      if (stopped || current.current !== original) return;
      try {
        const value = await bridge.request({ method: 'conversation.models.read', generation });
        if (stopped || current.current !== original) return;
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'settings.models' ||
          !('models' in value) ||
          value.storeId !== storeId
        )
          throw Error('scheduled_models_unavailable');
        setModels(
          value.models
            .filter((model) => model.enabled && model.configured)
            .map((model) => ({
              id: model.id,
              provider: model.provider ?? '其他',
              name: model.model ?? model.id,
              reasoningEffort: model.reasoningEffort ?? undefined,
              reasoningEffortChoices: model.reasoningEffortChoices ?? [],
            })),
        );
        setModelError('');
      } catch (cause) {
        if (!stopped && current.current === original) {
          setModelError(cause instanceof Error ? cause.message : '模型读取失败');
          modelTimer = setTimeout(readModels, 5000);
        }
      }
    };
    setLoading(true);
    setModels([]);
    setModelError('');
    void read();
    void readModels();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (modelTimer) clearTimeout(modelTimer);
      sequence.current++;
    };
  }, [active, identity, bridge, generation, storeId, publish]);
  async function mutate(request: NativeScheduledRequest) {
    const original = identity;
    sequence.current++;
    const value = await bridge.request(request);
    publish(value, original);
    if (current.current === original) setError('');
  }
  async function save(draft: ScheduledTaskDraft, id?: string, creationKey?: string) {
    if (!storeId) throw Error('store_identity_unavailable');
    const key = JSON.stringify([storeId, creationKey ?? 'default']);
    const pending = id ? undefined : creations.current.get(key);
    const taskId = id ?? pending?.id ?? crypto.randomUUID();
    let operation: 'create' | 'update' = id ? 'update' : 'create';
    let enabled = id ? (facts?.tasks.find((task) => task.id === id)?.enabled ?? false) : true;
    if (!id && !pending) creations.current.set(key, { id: taskId, storeId, confirmed: false });
    if (pending) {
      const original = identity;
      sequence.current++;
      const result = publish(
        await bridge.request({ method: 'scheduled.list', generation }),
        original,
      );
      if (current.current !== original) throw Error('scheduled_tasks_scope_changed');
      const saved = result.tasks.find((task) => task.id === taskId);
      if (saved) {
        if (saved.storeId !== storeId) throw Error('scheduled_task_identity_conflict');
        operation = 'update';
        enabled = saved.enabled;
      } else if (pending.confirmed) throw Error('scheduled_task_not_found');
    }
    await mutate({
      method: 'scheduled.save',
      generation,
      operation,
      input: {
        id: taskId,
        name: draft.name,
        prompt: draft.prompt,
        workspaceId: draft.workspaceId,
        modelId: draft.modelId,
        ...(draft.reasoningEffort === undefined ? {} : { reasoningEffort: draft.reasoningEffort }),
        storeId,
        schedule: { ...draft.schedule },
        enabled,
      },
    });
    if (!id && creations.current.get(key)?.id === taskId) creations.current.delete(key);
  }
  return {
    workspaces,
    models,
    error: [error, modelError].filter(Boolean).join('；'),
    loading,
    tasks: (facts?.tasks ?? []).map((task) => ({
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      workspaceLabel:
        workspaces.find((workspace) => workspace.id === task.workspaceId)?.label ?? '项目不可用',
      scheduleLabel: `${task.schedule.frequency === 'daily' ? '每天' : task.schedule.frequency === 'weekdays' ? '工作日' : `每周${['日', '一', '二', '三', '四', '五', '六'][task.schedule.weekday ?? 0]}`} ${task.schedule.time}`,
      environment: 'local',
      status: task.enabled && task.storeId === storeId ? 'active' : 'paused',
      nextRunAt:
        task.enabled && task.storeId === storeId && task.nextRunAt !== null
          ? new Date(task.nextRunAt).toLocaleString(undefined, { timeZone: task.schedule.timeZone })
          : undefined,
      draft: {
        name: task.name,
        prompt: task.prompt,
        workspaceId: task.workspaceId,
        modelId: task.modelId,
        ...(task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort }),
        schedule: {
          frequency: task.schedule.frequency,
          time: task.schedule.time,
          ...(task.schedule.weekday === undefined ? {} : { weekday: task.schedule.weekday }),
        },
        environment: 'local',
      },
      runs: (facts?.runs ?? [])
        .filter((run) => run.taskId === task.id)
        .map((run) => ({
          id: run.id,
          status: run.status,
          startedAt: new Date(run.createdAt).toLocaleString(),
          finishedAt:
            run.finishedAt === undefined ? undefined : new Date(run.finishedAt).toLocaleString(),
          sessionId: run.sessionId,
          error: run.status === 'completed' ? undefined : run.error,
        })),
    })),
    onCreate: (draft, creationKey) => save(draft, undefined, creationKey),
    onUpdate: (id, draft) => save(draft, id),
    onToggle: (id, enabled) => mutate({ method: 'scheduled.toggle', generation, id, enabled }),
    onDelete: (id) => mutate({ method: 'scheduled.delete', generation, id }),
    onRunNow: (id) => mutate({ method: 'scheduled.runNow', generation, id }),
    onOpenRun: async (taskId, runId) => {
      const run = facts?.runs.find((run) => run.taskId === taskId && run.id === runId);
      if (!run) throw Error('scheduled_run_unavailable');
      await options.onOpen(run.sessionId);
    },
  };
}
