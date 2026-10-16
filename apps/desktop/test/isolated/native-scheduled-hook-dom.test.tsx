import { expect, test } from 'bun:test';
import type { ScheduledTaskDraft, ScheduledTasksProps } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import { useNativeScheduledTasks } from '../../src/native-scheduled-tasks';
import type { NativeScheduledResult } from '../../src/scheduled-bridge';

test('scheduled page reads do not navigate; create retry reuses identity and results open exact session', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const calls: NativeRequest[] = [],
    opened: string[] = [];
  const facts: NativeScheduledResult = { kind: 'scheduled.tasks', tasks: [], runs: [] };
  let failed = false,
    props: ScheduledTasksProps;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      calls.push(request);
      if (request.method === 'conversation.models.read')
        return {
          kind: 'settings.models',
          observationId: 1,
          storeId: 'store',
          scope: 'user',
          canWrite: false,
          errors: [],
          defaultModelId: 'fixed',
          models: [{ id: 'fixed', enabled: true, configured: true, diagnostics: [] }],
        };
      if (request.method === 'scheduled.save') {
        if (!failed) {
          failed = true;
          throw Error('reply_lost');
        }
        facts.tasks = [
          { ...request.input, id: request.input.id!, createdAt: 1, updatedAt: 1, nextRunAt: 1000 },
        ];
        facts.runs = [
          {
            id: 'run',
            taskId: request.input.id!,
            occurrenceAt: 1,
            sessionId: 'independent',
            createCommandId: 'create',
            startCommandId: 'start',
            status: 'waiting',
            createdAt: 1,
            updatedAt: 1,
          },
        ];
      }
      return { ...facts };
    },
  };
  function Harness() {
    props = useNativeScheduledTasks({
      bridge,
      generation: 1,
      storeId: 'store',
      active: true,
      workspaces: [],
      onOpen: async (id) => {
        opened.push(id);
      },
    });
    return <div>{props.tasks.length}</div>;
  }
  try {
    await act(async () => root.render(<Harness />));
    expect(opened).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual([
      'scheduled.list',
      'conversation.models.read',
    ]);
    const draft: ScheduledTaskDraft = {
      name: 'Review',
      prompt: 'Review project',
      workspaceId: 'w',
      modelId: 'fixed',
      environment: 'local',
      schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
    };
    await act(async () => {
      await expect(Promise.resolve(props!.onCreate!(draft))).rejects.toThrow('reply_lost');
    });
    await act(async () => {
      await props!.onCreate!(draft);
    });
    const saves = calls.filter(
      (call): call is Extract<NativeRequest, { method: 'scheduled.save' }> =>
        call.method === 'scheduled.save',
    );
    expect(saves[0]!.input.id).toBe(saves[1]!.input.id);
    expect(props!.tasks[0]!.runs![0]!.status).toBe('waiting');
    await act(async () => {
      await props!.onOpenRun!(saves[0]!.input.id!, 'run');
    });
    expect(opened).toEqual(['independent']);
    expect(calls.some((call) => call.method === 'select')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test('scheduled hook creates through the real closed IPC and caller; retries keep identity and deleted edits stay deleted', async () => {
  const { NativeCaller } = await import('../../electron/native-caller');
  const { ScheduledTaskRunner } = await import('../../electron/scheduled-task-runner');
  const { decodeNativeRequest } = await import('../../electron/native-ipc');
  const { memoryPrivateData } = await import('../private-data.fixture');
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  let modelId = 'fixed',
    releaseModels: (() => void) | undefined;
  const data = memoryPrivateData();
  const client = {
    serverInfo: {
      storeId: 'store',
      subjectId: 'owner',
      capabilities: ['configuration_management'],
    },
    connect: async () => ({}),
    observe: async ({ signal }: { signal: AbortSignal }) =>
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
    disposeNetwork() {},
    listWorkspaces: async () => [{ id: 'w' }],
    getModelSettings: async () => {
      if (modelId === 'changed')
        await new Promise<void>((resolve) => {
          releaseModels = resolve;
        });
      return {
        storeId: 'store',
        scope: 'user',
        errors: [],
        models: [{ id: modelId, enabled: true, configured: true, diagnostics: [] }],
      };
    },
  } as unknown as import('@kite-ai/client').AgentClient;
  const caller = new NativeCaller(client, () => {}, data);
  caller.setScheduledTasks(new ScheduledTaskRunner(client, data));
  const state = (await caller.invoke({
    method: 'attach',
  })) as import('../../src/native-bridge').NativeState;
  const calls: NativeRequest[] = [];
  let lost = false,
    props!: ScheduledTasksProps;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      calls.push(request);
      const result = await caller.invoke(decodeNativeRequest(request));
      if (request.method === 'scheduled.save' && !lost) {
        lost = true;
        throw Error('reply_lost');
      }
      return result;
    },
  };
  function Harness({ revision = 0 }: { revision?: number }) {
    props = useNativeScheduledTasks({
      bridge,
      generation: state.generation,
      storeId: 'store',
      active: true,
      revision,
      workspaces: [],
      onOpen: async () => {},
    });
    return <div>{props.tasks.length}</div>;
  }
  const draft: ScheduledTaskDraft = {
    name: 'Real create',
    prompt: 'Review',
    workspaceId: 'w',
    modelId: 'fixed',
    environment: 'local',
    schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
  };
  try {
    await act(async () => root.render(<Harness />));
    expect(props.models?.map((model) => model.id)).toEqual(['fixed']);
    await act(async () => {
      await expect(Promise.resolve(props.onCreate!(draft))).rejects.toThrow('reply_lost');
    });
    expect(data.scheduledTasks()).toHaveLength(1);
    const original = data.scheduledTasks()[0]!;
    await act(async () => {
      await props.onCreate!(draft);
    });
    expect(data.scheduledTasks()).toEqual([original]);
    expect(props.tasks[0]?.id).toBe(original.id);
    const saves = calls.filter(
      (call): call is Extract<NativeRequest, { method: 'scheduled.save' }> =>
        call.method === 'scheduled.save',
    );
    expect(saves.map((save) => save.operation)).toEqual(['create', 'create']);
    expect(saves[0]!.input.id).toBe(saves[1]!.input.id);
    await expect(
      caller.invoke({ ...saves[0]!, input: { ...saves[0]!.input, prompt: 'conflicting create' } }),
    ).rejects.toThrow('scheduled_task_identity_conflict');
    await act(async () => {
      await props.onDelete!(original.id);
    });
    await act(async () => {
      await expect(Promise.resolve(props.onUpdate!(original.id, draft))).rejects.toThrow(
        'scheduled_task_not_found',
      );
    });
    await expect(caller.invoke(saves[0]!)).rejects.toThrow('scheduled_task_not_found');
    expect(data.scheduledTasks()).toHaveLength(0);
    modelId = 'changed';
    await act(async () => root.render(<Harness revision={1} />));
    expect(props.models).toEqual([]);
    expect(releaseModels).toBeDefined();
    await act(async () => {
      releaseModels!();
    });
    expect(props.models?.map((model) => model.id)).toEqual(['changed']);
    expect(calls.some((call) => call.method === 'select')).toBe(false);
  } finally {
    releaseModels?.();
    await act(async () => root.unmount());
    await caller.close();
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test('creation retry identity survives settings refresh and same-Store reconnect but never crosses Stores', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const calls: Extract<NativeRequest, { method: 'scheduled.save' }>[] = [];
  let props!: ScheduledTasksProps;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      if (request.method !== 'scheduled.save') throw Error('unexpected_read');
      calls.push(request);
      throw Error('reply_lost');
    },
  };
  function Harness({
    generation,
    storeId,
    revision,
  }: {
    generation: number;
    storeId: string;
    revision: number;
  }) {
    props = useNativeScheduledTasks({
      bridge,
      generation,
      storeId,
      revision,
      active: false,
      workspaces: [],
      onOpen: async () => {},
    });
    return null;
  }
  const draft: ScheduledTaskDraft = {
    name: 'Scoped',
    prompt: 'Review',
    workspaceId: 'w',
    modelId: 'm',
    environment: 'local',
    schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
  };
  try {
    for (const scope of [
      { generation: 1, storeId: 'store-a', revision: 0 },
      { generation: 1, storeId: 'store-a', revision: 1 },
      { generation: 2, storeId: 'store-a', revision: 1 },
      { generation: 2, storeId: 'store-b', revision: 1 },
    ]) {
      await act(async () => root.render(<Harness {...scope} />));
      await act(async () => {
        await expect(Promise.resolve(props.onCreate!(draft))).rejects.toThrow('reply_lost');
      });
    }
    expect(calls[0]!.input.id).toBe(calls[1]!.input.id);
    expect(calls[2]!.input.id).toBe(calls[1]!.input.id);
    expect(calls[3]!.input.id).not.toBe(calls[2]!.input.id);
    expect(calls.map((call) => [call.generation, call.input.storeId])).toEqual([
      [1, 'store-a'],
      [1, 'store-a'],
      [2, 'store-a'],
      [2, 'store-b'],
    ]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
