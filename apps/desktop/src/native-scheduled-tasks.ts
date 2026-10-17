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
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const identity = `${generation}/${storeId}/${revision ?? 0}`;
  const current = useRef(identity);
  current.current = identity;
  const sequence = useRef(0);
  const creations = useRef(new Map<string, string>());
  const publish = useCallback((value: unknown, original: string) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('kind' in value) ||
      value.kind !== 'scheduled.tasks'
    )
      throw Error('scheduled_tasks_unavailable');
    if (current.current === original) setFacts(value as NativeScheduledResult);
  }, []);
  useEffect(() => {
    if (!active || !generation || !storeId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
    setLoading(true);
    setModels([]);
    void read();
    void bridge
      .request({ method: 'conversation.models.read', generation })
      .then((value) => {
        if (stopped || current.current !== original) return;
        if (
          value &&
          'kind' in value &&
          value.kind === 'settings.models' &&
          'models' in value &&
          value.storeId === storeId
        ) {
          setModels(
            value.models
              .filter((model) => model.enabled && model.configured)
              .map((model) => ({ id: model.id, label: model.model ?? model.id })),
          );
        }
      })
      .catch((cause) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : '模型读取失败');
      });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
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
  async function save(draft: ScheduledTaskDraft, id?: string) {
    if (!storeId) throw Error('store_identity_unavailable');
    const key = JSON.stringify([storeId, draft]);
    const taskId = id ?? creations.current.get(key) ?? crypto.randomUUID();
    if (!id) creations.current.set(key, taskId);
    await mutate({
      method: 'scheduled.save',
      generation,
      operation: id ? 'update' : 'create',
      input: {
        id: taskId,
        name: draft.name,
        prompt: draft.prompt,
        workspaceId: draft.workspaceId,
        modelId: draft.modelId,
        storeId,
        schedule: { ...draft.schedule },
        enabled: id ? (facts?.tasks.find((task) => task.id === id)?.enabled ?? false) : true,
      },
    });
    creations.current.delete(key);
  }
  return {
    workspaces,
    models,
    error,
    loading,
    tasks: (facts?.tasks ?? []).map((task) => ({
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      workspaceLabel:
        workspaces.find((workspace) => workspace.id === task.workspaceId)?.label ?? '项目不可用',
      scheduleLabel: `${task.schedule.frequency === 'daily' ? '每天' : task.schedule.frequency === 'weekdays' ? '工作日' : `每周${['日', '一', '二', '三', '四', '五', '六'][task.schedule.weekday ?? 0]}`} ${task.schedule.time} (${task.schedule.timeZone})`,
      environment: 'local',
      status: task.enabled && task.storeId === storeId ? 'active' : 'paused',
      nextRunAt:
        task.enabled && task.storeId === storeId && task.nextRunAt !== null
          ? new Date(task.nextRunAt).toLocaleString()
          : undefined,
      draft: {
        name: task.name,
        prompt: task.prompt,
        workspaceId: task.workspaceId,
        modelId: task.modelId,
        schedule: task.schedule,
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
          error: run.error,
        })),
    })),
    onCreate: (draft) => save(draft),
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
