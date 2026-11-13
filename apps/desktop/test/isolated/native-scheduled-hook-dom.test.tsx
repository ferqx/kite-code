import type { ScheduledTaskDraft, ScheduledTasksProps } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { expect, test } from '#kite-test';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import { useNativeScheduledTasks } from '../../src/native-scheduled-tasks';
import type { NativeScheduledResult } from '../../src/scheduled-bridge';

test('model read failures survive list and mutation success, retry independently, and ignore old-scope results', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    setTimeout: ((...args: Parameters<typeof setTimeout>) => {
      const handle = previous.setTimeout(...args);
      const [callback, delay, ...values] = args;
      if (delay === 5000) timers.set(handle, () => callback(...values));
      return handle;
    }) as typeof setTimeout,
    clearTimeout: ((handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle);
      previous.clearTimeout(handle);
    }) as typeof clearTimeout,
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const facts: NativeScheduledResult = { kind: 'scheduled.tasks', tasks: [], runs: [] };
  let props!: ScheduledTasksProps,
    releaseList!: (value: NativeScheduledResult) => void,
    releaseModels!: (value: Awaited<ReturnType<NativeBridge['request']>>) => void,
    listReads = 0,
    modelReads = 0,
    listFailure = false,
    modelFailure = true;
  const modelFacts = (id: string) => ({
    kind: 'settings.models' as const,
    storeId: 'store',
    scope: 'user' as const,
    observationId: 1,
    canWrite: false,
    errors: [],
    defaultModelId: id,
    models: [{ id, enabled: true, configured: true, diagnostics: [] }],
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      if (request.method === 'scheduled.list') {
        if (++listReads === 1)
          return new Promise<NativeScheduledResult>((resolve) => {
            releaseList = resolve;
          });
        if (listFailure) throw Error('list_network_failed');
        return facts;
      }
      if (request.method === 'conversation.models.read') {
        modelReads++;
        if (modelFailure) throw Error('models_network_failed');
        return new Promise((resolve) => {
          releaseModels = resolve;
        });
      }
      if (request.method === 'scheduled.toggle') return facts;
      throw Error('unexpected_request');
    },
  };
  function Harness({ revision = 0 }: { revision?: number }) {
    props = useNativeScheduledTasks({
      bridge,
      generation: 1,
      storeId: 'store',
      revision,
      active: true,
      workspaces: [],
      onOpen: async () => {},
    });
    return <div>{props.error}</div>;
  }
  async function poll() {
    const pending = [...timers];
    await act(async () => {
      for (const [handle, callback] of pending) {
        clearTimeout(handle);
        callback();
      }
    });
  }
  try {
    await act(async () => root.render(<Harness />));
    expect(props.error).toContain('models_network_failed');
    await act(async () => releaseList(facts));
    expect(props.error).toContain('models_network_failed');
    await act(async () => props.onToggle!('task', false));
    expect(props.error).toContain('models_network_failed');
    listFailure = true;
    modelFailure = false;
    await poll();
    expect(modelReads).toBe(2);
    expect(props.error).toContain('models_network_failed');
    expect(props.error).toContain('list_network_failed');
    expect(props.models).toEqual([]);
    await act(async () => releaseModels(modelFacts('recovered')));
    expect(props.models?.map((model) => model.id)).toEqual(['recovered']);
    expect(props.error).toBe('list_network_failed');
    listFailure = false;
    await poll();
    expect(props.error).toBe('');
    expect(modelReads).toBe(2);

    modelFailure = true;
    await act(async () => root.render(<Harness revision={1} />));
    expect(props.models).toEqual([]);
    modelFailure = false;
    await poll();
    const oldModels = releaseModels;
    await act(async () => root.render(<Harness revision={2} />));
    await act(async () => releaseModels(modelFacts('current')));
    await act(async () => oldModels(modelFacts('stale')));
    expect(props.models?.map((model) => model.id)).toEqual(['current']);
    expect(props.error).toBe('');
  } finally {
    releaseList(facts);
    await act(async () => root.unmount());
    const remaining = timers.size;
    for (const handle of timers.keys()) previous.clearTimeout(handle);
    Object.assign(globalThis, previous);
    dom.window.close();
    expect(remaining).toBe(0);
  }
});

test('superseded scheduled reads and mutations cannot publish stale failures or replace a newer list', async () => {
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
  let props!: ScheduledTasksProps;
  const lists: {
    resolve: (value: NativeScheduledResult) => void;
    reject: (cause: Error) => void;
  }[] = [];
  const mutations: ((value: NativeScheduledResult) => void)[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      if (request.method === 'scheduled.list')
        return new Promise<NativeScheduledResult>((resolve, reject) =>
          lists.push({ resolve, reject }),
        );
      if (request.method === 'scheduled.toggle')
        return new Promise<NativeScheduledResult>((resolve) => mutations.push(resolve));
      if (request.method === 'conversation.models.read')
        return {
          kind: 'settings.models',
          storeId: 'store',
          scope: 'user',
          observationId: 1,
          canWrite: false,
          errors: [],
          defaultModelId: null,
          models: [],
        };
      throw Error('unexpected_request');
    },
  };
  function Harness() {
    props = useNativeScheduledTasks({
      bridge,
      generation: 1,
      storeId: 'store',
      active: true,
      workspaces: [],
      onOpen: async () => {},
    });
    return <div>{props.error}</div>;
  }
  const facts = (count = 0): NativeScheduledResult => ({
    kind: 'scheduled.tasks',
    runs: [],
    tasks: Array.from({ length: count }, (_, index) => ({
      id: `task-${index}`,
      name: 'Current task',
      prompt: 'Prompt',
      storeId: 'store',
      workspaceId: 'workspace',
      modelId: 'model',
      enabled: false,
      schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 1,
    })),
  });
  try {
    await act(async () => root.render(<Harness />));
    let first!: Promise<void>;
    await act(async () => {
      first = Promise.resolve(props.onToggle!('task', false));
    });
    await act(async () => {
      mutations[0]!(facts(1));
      await first;
    });
    expect(props.tasks).toHaveLength(1);
    await act(async () => lists[0]!.reject(Error('obsolete_read_failed')));
    expect(props.error).toBe('');

    let old!: Promise<void>, current!: Promise<void>;
    await act(async () => {
      old = Promise.resolve(props.onToggle!('task', true));
    });
    await act(async () => {
      current = Promise.resolve(props.onToggle!('task', false));
    });
    await act(async () => {
      mutations[2]!(facts(1));
      await current;
    });
    await act(async () => {
      mutations[1]!(facts());
    });
    expect(props.tasks).toHaveLength(1);
    expect(lists).toHaveLength(2);
    await act(async () => {
      lists[1]!.resolve(facts(1));
      await old;
    });
    expect(props.tasks).toHaveLength(1);
    expect(props.error).toBe('');
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

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
          models: [
            {
              id: 'fixed',
              provider: 'codex',
              model: 'gpt-6-luna',
              reasoningEffort: 'low',
              reasoningEffortChoices: ['low', 'high'],
              enabled: true,
              configured: true,
              diagnostics: [],
            },
          ],
        };
      if (request.method === 'scheduled.save') {
        if (!failed) {
          failed = true;
          throw Error('reply_lost');
        }
        facts.tasks = [
          {
            ...request.input,
            schedule: { ...request.input.schedule, timeZone: 'UTC' },
            id: request.input.id!,
            createdAt: 1,
            updatedAt: 1,
            nextRunAt: 1000,
          },
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
      reasoningEffort: 'high',
      environment: 'local',
      schedule: { frequency: 'daily', time: '09:00' },
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
    expect(saves[1]!.input.reasoningEffort).toBe('high');
    expect(saves[1]!.input.schedule).not.toHaveProperty('timeZone');
    expect(props!.tasks[0]!.draft!.schedule).not.toHaveProperty('timeZone');
    expect(props!.tasks[0]!.draft!.reasoningEffort).toBe('high');
    expect(props!.models![0]).toMatchObject({
      id: 'fixed',
      name: 'gpt-6-luna',
      provider: 'codex',
      reasoningEffort: 'low',
      reasoningEffortChoices: ['low', 'high'],
    });
    expect(props!.tasks[0]!.runs![0]!.status).toBe('waiting');
    await act(async () => {
      await props!.onOpenRun!(saves[0]!.input.id!, 'run');
    });
    expect(opened).toEqual(['independent']);
    expect(calls.some((call) => call.method === 'select')).toBe(false);
    facts.runs[0]!.status = 'completed';
    facts.runs[0]!.error = 'network_outcome_unknown';
    await act(async () => {
      await props!.onToggle!(saves[0]!.input.id!, false);
    });
    expect(props!.tasks[0]!.runs![0]!.error).toBeUndefined();
    expect(facts.runs[0]!.error).toBe('network_outcome_unknown');
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
    listAllWorkspaces: async () => [{ id: 'w' }],
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
    failNextLookup = false,
    props!: ScheduledTasksProps;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      calls.push(request);
      if (request.method === 'scheduled.list' && failNextLookup) {
        failNextLookup = false;
        throw Error('lookup_failed');
      }
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
    schedule: { frequency: 'daily', time: '09:00' },
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
    expect(saves.map((save) => save.operation)).toEqual(['create', 'update']);
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

    lost = false;
    await act(async () => {
      await expect(Promise.resolve(props.onCreate!(draft, 'edited-retry'))).rejects.toThrow(
        'reply_lost',
      );
    });
    const pending = data.scheduledTasks()[0]!;
    const edited = { ...draft, prompt: 'Changed after the lost save response' };
    failNextLookup = true;
    const writes = calls.filter((call) => call.method === 'scheduled.save').length;
    await act(async () => {
      await expect(Promise.resolve(props.onCreate!(edited, 'edited-retry'))).rejects.toThrow(
        'lookup_failed',
      );
    });
    expect(calls.filter((call) => call.method === 'scheduled.save')).toHaveLength(writes);
    expect(data.scheduledTasks()).toEqual([pending]);
    await act(async () => {
      await props.onCreate!(edited, 'edited-retry');
    });
    expect(data.scheduledTasks()).toHaveLength(1);
    expect(data.scheduledTasks()[0]).toMatchObject({
      id: pending.id,
      prompt: edited.prompt,
      enabled: true,
    });
    await act(async () => {
      await props.onCreate!(draft, 'separate-editor');
    });
    expect(data.scheduledTasks()).toHaveLength(2);
    const existing = new Set(data.scheduledTasks().map((task) => task.id));
    lost = false;
    await act(async () => {
      await expect(Promise.resolve(props.onCreate!(draft, 'deleted-retry'))).rejects.toThrow(
        'reply_lost',
      );
    });
    const deleted = data.scheduledTasks().find((task) => !existing.has(task.id))!;
    await act(async () => {
      await props.onToggle!(deleted.id, false);
      await props.onDelete!(deleted.id);
    });
    const beforeDeletedRetry = calls.filter((call) => call.method === 'scheduled.save').length;
    await act(async () => {
      await expect(Promise.resolve(props.onCreate!(edited, 'deleted-retry'))).rejects.toThrow(
        'scheduled_task_not_found',
      );
    });
    expect(calls.filter((call) => call.method === 'scheduled.save')).toHaveLength(
      beforeDeletedRetry,
    );
    expect(data.scheduledTasks()).toHaveLength(2);
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
      if (request.method === 'scheduled.list')
        return { kind: 'scheduled.tasks', tasks: [], runs: [] };
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
    schedule: { frequency: 'daily', time: '09:00' },
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
