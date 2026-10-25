import { expect, jest, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeModelSettingsSubmission,
  NativeRequest,
  NativeSelection,
} from '../../src/native-bridge';
import type { NativeModelSettingsProps } from '../../src/native-model-settings';
import { prepareDesktopDom } from '../native-page-dom.fixture';

// Radix chooses its layout effect when imported; use a browser for the real dropdown.
const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const priorBootstrap = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { Dialog, DialogContent, DialogTitle, DialogDescription } = await import(
  '@kite-ai/ui/desktop'
);
const {
  NativeModelSettings,
  NativeDefaultModelSettings,
  NativeModelSettingsRows,
  useNativeModelSettings,
} = await import('../../src/native-model-settings');
const { NativeConnectionModels } = await import('../../src/native-connection-models');
Object.assign(globalThis, priorBootstrap);
bootstrap.window.close();

const facts: NativeModelSettingsFacts = {
  kind: 'settings.models',
  observationId: 7,
  storeId: 'store',
  scope: 'user',
  canWrite: true,
  errors: [],
  defaultModelId: 'a',
  selectedModelId: 'b',
  models: [
    {
      id: 'a',
      provider: 'openai',
      model: 'remote-a',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'b',
      provider: 'deepseek',
      model: 'remote-b',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'c',
      provider: 'deepseek',
      model: 'disabled-c',
      enabled: false,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'broken',
      provider: 'openai',
      model: 'broken',
      enabled: true,
      configured: false,
      diagnostics: ['model_unconfigured'],
    },
  ],
};
const selected = (id: string) =>
  ({ storeId: 'store', session: { id }, viewSelection: id === 'old' ? 1 : 2 }) as NativeSelection;
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
function ModelParts(props: NativeModelSettingsProps & { modelIds: readonly string[] }) {
  const state = useNativeModelSettings(props);
  return (
    <section aria-label="组合模型设置">
      <NativeDefaultModelSettings state={state} />
      <NativeModelSettingsRows state={state} modelIds={props.modelIds} />
    </section>
  );
}
function ManagedModels(props: NativeModelSettingsProps & { modelIds: readonly string[] }) {
  const state = useNativeModelSettings(props);
  return (
    <>
      <NativeDefaultModelSettings state={state} />
      <NativeConnectionModels state={state} modelIds={props.modelIds} label="服务一" />
    </>
  );
}
function ManagedModelDialog(props: NativeModelSettingsProps & { modelIds: readonly string[] }) {
  const [open, setOpen] = useState(true);
  const state = useNativeModelSettings(props);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="desktop-settings" aria-label="设置测试">
        <DialogTitle>设置</DialogTitle>
        <DialogDescription>提供商模型管理</DialogDescription>
        <div className="fixture-provider-card">
          <NativeDefaultModelSettings state={state} />
          <NativeConnectionModels state={state} modelIds={props.modelIds} label="服务一" />
        </div>
        <button type="button" aria-label="外部设置按钮">
          其他设置
        </button>
      </DialogContent>
    </Dialog>
  );
}
function fixture(
  request: NativeBridge['request'],
  modelIds?: readonly string[],
  manager: boolean | 'dialog' = false,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restoreLayout = prepareDesktopDom(dom);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: () => {} });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const element = dom.window.document.body,
    root = createRoot(dom.window.document.getElementById('root')!);
  const calls: NativeRequest[] = [];
  let bridgeAvailable = true;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (!bridgeAvailable) throw Error('native_generation_changed');
      return request(input);
    },
  };
  let saved = 0;
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (entry) => entry.getAttribute('aria-label') === name || entry.textContent === name,
    )!;
  const toggle = (id: string) =>
    element.querySelector<HTMLInputElement>(`[role="switch"][aria-label="启用模型 ${id}"]`)!;
  const menuItem = (id: string) =>
    element.querySelector<HTMLElement>(`[role="menuitemradio"][aria-label="设为默认 ${id}"]`);
  return {
    dom,
    element,
    calls,
    button,
    toggle,
    menuItem,
    get saved() {
      return saved;
    },
    render: (
      selection?: NativeSelection,
      submissions: NativeModelSettingsSubmission[] = [],
      options: Partial<NativeModelSettingsProps> = {},
    ) =>
      act(async () => {
        const Component =
          manager === 'dialog'
            ? ManagedModelDialog
            : manager
              ? ManagedModels
              : modelIds
                ? ModelParts
                : NativeModelSettings;
        root.render(
          <Component
            bridge={bridge}
            generation={1}
            selection={selection}
            submissions={submissions}
            onSaved={() => {
              saved++;
            }}
            {...options}
            modelIds={modelIds ?? []}
          />,
        );
      }),
    openMenu: () =>
      act(async () => {
        button('默认模型').dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      }),
    choose: (id: string) =>
      act(async () => {
        const item = menuItem(id);
        expect(item).not.toBeNull();
        item!.click();
      }),
    hide: () => act(async () => root.render(null)),
    async close() {
      await act(async () => root.unmount());
      bridgeAvailable = false;
      await new Promise((resolve) => setTimeout(resolve, 0));
      restoreLayout();
      Object.assign(globalThis, prior);
      dom.window.close();
    },
  };
}

test('opening model settings loads the retained list once, groups all models and uses the configuration default', async () => {
  const read = deferred<NativeModelSettingsFacts>();
  const f = fixture(async (input) =>
    input.method === 'settings.models.read' ? read.promise : null,
  );
  try {
    await f.render();
    expect(f.calls).toEqual([{ method: 'settings.models.read', generation: 1, scope: 'user' }]);
    expect(f.element.textContent).not.toContain('正在读取');
    expect(f.element.querySelector('[aria-label="模型设置"]')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(f.button('默认模型').disabled).toBe(true);
    await act(async () => read.resolve(structuredClone(facts)));
    expect(f.element.querySelector('.settings-models .model-list')).not.toBeNull();
    expect(f.element.querySelectorAll('.settings-model-provider')).toHaveLength(2);
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(4);
    expect(f.button('默认模型').textContent).toContain('openai · remote-a');
    expect(f.element.querySelectorAll('.settings-model-default-badge')).toHaveLength(0);
    expect(f.toggle('a').disabled).toBe(false);
    expect(f.toggle('c').checked).toBe(false);
    expect(f.toggle('broken').checked).toBe(true);
    await f.render();
    expect(f.calls).toHaveLength(1);
    await f.openMenu();
    expect(
      [...f.element.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent),
    ).toEqual(['remote-a', 'remote-b']);
    expect(f.menuItem('a')!.getAttribute('aria-checked')).toBe('true');
    expect(f.menuItem('c')).toBeNull();
    expect(f.menuItem('broken')).toBeNull();
    await f.render(
      undefined,
      (['applied', 'failed', 'submitting'] as const).map((phase) => ({
        kind: 'settings.models.submission',
        commandId: `internal-${phase}-command`,
        storeId: 'internal-store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'enabled', modelId: 'internal-model', enabled: false },
        phase,
        error: 'internal_history_error',
      })),
    );
    expect(f.element.querySelector('[aria-label="模型设置提交"]')).toBeNull();
    expect(f.element.querySelector('[aria-label="待确认的模型更改"]')).toBeNull();
    for (const text of ['原模型设置提交', '原 Store', 'internal-', 'internal_history_error'])
      expect(f.element.textContent).not.toContain(text);
    expect(f.calls.some((input) => input.method !== 'settings.models.read')).toBe(false);
  } finally {
    await f.close();
  }
});

test('switches and the default dropdown save one exact intent, retain rows and refresh the saved configuration', async () => {
  let current = structuredClone(facts);
  const enable = deferred<NativeModelSettingsSubmission>();
  const savedRefresh = deferred<NativeModelSettingsFacts>();
  let refreshingDefault = false;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read')
      return refreshingDefault ? savedRefresh.promise : structuredClone(current);
    if (input.method === 'settings.models.enabled') return enable.promise;
    if (input.method === 'settings.models.default') {
      current = { ...current, defaultModelId: input.modelId };
      refreshingDefault = true;
      return {
        kind: 'settings.models.submission',
        commandId: 'default',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'default', modelId: input.modelId },
        phase: 'applied',
      };
    }
    return null;
  });
  try {
    await f.render();
    const row = f.toggle('c').closest('label');
    await act(async () => {
      f.toggle('c').click();
    });
    expect(f.toggle('c').checked).toBe(true);
    expect(f.toggle('c').disabled).toBe(false);
    expect(f.element.textContent).not.toContain('正在保存模型配置');
    expect(f.toggle('c').closest('label')).toBe(row);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 7,
        modelId: 'c',
        enabled: true,
      },
    ]);
    current.models.find((model) => model.id === 'c')!.enabled = true;
    await act(async () =>
      enable.resolve({
        kind: 'settings.models.submission',
        commandId: 'enabled',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'enabled', modelId: 'c', enabled: true },
        phase: 'applied',
      }),
    );
    expect(f.toggle('c').disabled).toBe(false);
    expect(f.toggle('c').closest('label')).toBe(row);
    await f.openMenu();
    await f.choose('c');
    expect(f.calls.filter((input) => input.method === 'settings.models.default')).toEqual([
      { method: 'settings.models.default', generation: 1, observationId: 7, modelId: 'c' },
    ]);
    expect(f.button('默认模型').textContent).toContain('deepseek · disabled-c');
    expect(f.button('默认模型').disabled).toBe(true);
    expect(f.button('刷新配置').disabled).toBe(true);
    expect(f.element.textContent).not.toContain('正在保存模型配置');
    expect(f.toggle('a').disabled).toBe(true);
    await act(async () => savedRefresh.resolve(structuredClone(current)));
    expect(f.button('默认模型').disabled).toBe(false);
    expect(f.button('刷新配置').disabled).toBe(false);
    expect(f.toggle('c').disabled).toBe(false);
    expect(f.toggle('a').disabled).toBe(false);
    expect(f.saved).toBe(2);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(3);
  } finally {
    await act(async () => savedRefresh.resolve(structuredClone(current)));
    await f.close();
  }
});

test('an externally disabled default stays explicit and can be enabled again without silently choosing another route', async () => {
  const f = fixture(async (input) =>
    input.method === 'settings.models.read' ? { ...facts, defaultModelId: 'c' } : null,
  );
  try {
    await f.render();
    expect(f.button('默认模型').textContent).toContain('c · 当前不可用');
    expect(f.toggle('c').checked).toBe(false);
    expect(f.toggle('c').disabled).toBe(false);
    await act(async () => f.toggle('c').click());
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 7,
        modelId: 'c',
        enabled: true,
      },
    ]);
    expect(f.calls.filter((input) => input.method === 'settings.models.default')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('same-provider duplicate names remain separate routes in the list and default menu', async () => {
  const duplicates = {
    ...facts,
    models: ['first', 'second'].map((id) => ({ ...facts.models[0]!, id, model: 'same-name' })),
    defaultModelId: 'first',
  };
  const f = fixture(async (input) => (input.method === 'settings.models.read' ? duplicates : null));
  try {
    await f.render();
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(f.element.textContent).toContain('same-name · first');
    expect(f.element.textContent).toContain('same-name · second');
    await f.openMenu();
    expect(
      [...f.element.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent),
    ).toEqual(['same-name · first', 'same-name · second']);
    await f.choose('second');
    expect(f.calls.find((input) => input.method === 'settings.models.default')).toEqual({
      method: 'settings.models.default',
      generation: 1,
      observationId: 7,
      modelId: 'second',
    });
  } finally {
    await f.close();
  }
});

test('failed enablement restores the same switch and requires a fresh observation before retry', async () => {
  const save = deferred<NativeModelSettingsSubmission>();
  const f = fixture(async (input) =>
    input.method === 'settings.models.read'
      ? structuredClone(facts)
      : input.method === 'settings.models.enabled'
        ? save.promise
        : null,
  );
  try {
    await f.render();
    const row = f.toggle('c').closest('label');
    await act(async () => f.toggle('c').click());
    expect(f.toggle('c').checked).toBe(true);
    await act(async () =>
      save.resolve({
        kind: 'settings.models.submission',
        commandId: 'failed',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'enabled', modelId: 'c', enabled: true },
        phase: 'failed',
        error: 'configuration_conflict',
      }),
    );
    expect(f.toggle('c').closest('label')).toBe(row);
    expect(f.toggle('c').checked).toBe(false);
    expect(f.toggle('c').disabled).toBe(true);
    expect(f.element.textContent).toContain('configuration_conflict');
    await act(async () => f.toggle('c').click());
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    await act(async () => f.button('刷新配置').click());
    expect(f.toggle('c').disabled).toBe(false);
  } finally {
    await f.close();
  }
});

test('unknown submissions retain explicit original lookup across automatic selection reloads and reject late facts', async () => {
  const save = deferred<NativeModelSettingsSubmission>(),
    lateRead = deferred<NativeModelSettingsFacts>();
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'original',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'default', modelId: 'b' },
    phase: 'unknown',
  };
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read')
      return ++reads === 2 ? lateRead.promise : structuredClone(facts);
    if (input.method === 'settings.models.default') return save.promise;
    if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
    return null;
  });
  try {
    await f.render(selected('old'));
    await f.openMenu();
    await f.choose('b');
    await f.render(selected('new'), [original]);
    await act(async () => save.resolve({ ...original, phase: 'applied' }));
    expect(reads).toBe(2);
    expect(f.saved).toBe(1);
    expect(f.element.textContent).toContain('默认模型更改结果待确认。');
    expect(f.element.textContent).not.toContain('原提交 original');
    expect(f.element.textContent).not.toContain('原 Store');
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toHaveLength(0);
    await f.render(selected('old'), [original]);
    await act(async () =>
      lateRead.resolve({
        ...facts,
        defaultModelId: 'stale-new-view',
        models: [{ ...facts.models[0]!, model: 'stale-new-view' }],
      }),
    );
    expect(f.element.textContent).not.toContain('stale-new-view');
    expect(f.toggle('b').disabled).toBe(true);
    expect(f.button('默认模型').disabled).toBe(true);
    expect(f.element.textContent).toContain('默认模型更改结果待确认。');
    await act(async () => f.button('查看结果').click());
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: 'original' },
    ]);
    expect(f.saved).toBe(2);
    expect(reads).toBe(4);
    expect(f.calls.filter((input) => input.method === 'settings.models.default')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('all Session selections use the same user configuration and reject late earlier reads', async () => {
  const lateRead = deferred<NativeModelSettingsFacts>();
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method !== 'settings.models.read') return null;
    return ++reads === 1
      ? lateRead.promise
      : { ...facts, models: [{ ...facts.models[0]!, model: 'user-model' }] };
  });
  try {
    await f.render(selected('old'));
    await f.render(selected('new'));
    expect(f.button('默认模型').textContent).toContain('user-model');
    await act(async () =>
      lateRead.resolve({ ...facts, models: [{ ...facts.models[0]!, model: 'late-model' }] }),
    );
    expect(f.element.textContent).not.toContain('late-model');
    await f.render();
    expect(f.element.querySelector('[aria-label="模型配置范围"]')).toBeNull();
    expect(
      f.calls
        .filter((input) => input.method === 'settings.models.read')
        .map((input) => input.scope),
    ).toEqual(['user', 'user', 'user']);
    expect(
      f.calls.filter(
        (input) =>
          input.method === 'settings.models.default' || input.method === 'settings.models.enabled',
      ),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('read failure, empty configuration and read-only facts stay explicit and refresh does not save', async () => {
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method !== 'settings.models.read') return null;
    if (++reads === 1) throw Error('configuration_unavailable');
    return reads === 2
      ? { ...facts, defaultModelId: null, models: [] }
      : { ...facts, canWrite: false, errors: ['configuration_invalid'] };
  });
  try {
    await f.render();
    expect(f.element.textContent).toContain('configuration_unavailable');
    expect(f.button('默认模型').disabled).toBe(true);
    await act(async () => f.button('刷新配置').click());
    expect(f.element.textContent).toContain('尚无模型配置，请连接提供商');
    expect(f.button('默认模型').disabled).toBe(true);
    await act(async () => f.button('刷新配置').click());
    expect(f.element.textContent).toContain('configuration_invalid');
    expect(f.toggle('b').disabled).toBe(true);
    expect(f.calls.every((input) => input.method === 'settings.models.read')).toBe(true);
  } finally {
    await f.close();
  }
});

test('a saved default with failed refresh can be read again without repeating the mutation', async () => {
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') {
      if (++reads === 2) throw Error('configuration_continuation_changed');
      return { ...facts, defaultModelId: reads > 2 ? 'b' : 'a' };
    }
    if (input.method === 'settings.models.default')
      return {
        kind: 'settings.models.submission',
        commandId: 'saved',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'default', modelId: 'b' },
        phase: 'applied',
      };
    return null;
  });
  try {
    await f.render();
    await f.openMenu();
    await f.choose('b');
    expect(f.element.textContent).toContain('已保存模型配置，正在后台恢复');
    expect(f.button('默认模型').disabled).toBe(true);
    await act(async () => f.button('刷新配置').click());
    expect(f.button('默认模型').textContent).toContain('remote-b');
    expect(f.button('默认模型').disabled).toBe(false);
    expect(f.saved).toBe(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.default')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('peer revision rereads once while retaining rows and never closes or saves the current observation', async () => {
  const second = deferred<NativeModelSettingsFacts>();
  let reads = 0;
  const f = fixture(async (input) =>
    input.method === 'settings.models.read'
      ? ++reads === 2
        ? second.promise
        : structuredClone(facts)
      : null,
  );
  try {
    await f.render(selected('old'), [], { revision: 0 });
    const row = f.toggle('c');
    await f.render(selected('old'), [], { revision: 1 });
    expect(reads).toBe(2);
    expect(f.toggle('c')).toBe(row);
    expect(row.disabled).toBe(true);
    expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(0);
    await f.render(selected('old'), [], { revision: 1 });
    expect(reads).toBe(2);
    await act(async () => second.resolve({ ...facts, observationId: 8 }));
    expect(f.toggle('c')).toBe(row);
    expect(row.disabled).toBe(false);
    expect(f.saved).toBe(0);
    expect(f.calls.every((input) => input.method === 'settings.models.read')).toBe(true);
  } finally {
    await f.close();
  }
});

test('local unknown locks without a watcher update and original lookup remains available when a peer blocks new writes', async () => {
  let reads = 0;
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'local-original',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'enabled', modelId: 'c', enabled: true },
    phase: 'unknown',
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') {
      reads++;
      return structuredClone(facts);
    }
    if (input.method === 'settings.models.enabled') return original;
    if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
    return null;
  });
  try {
    await f.render(selected('old'));
    await act(async () => f.toggle('c').click());
    expect(f.element.textContent).toContain('模型启用更改结果待确认');
    await act(async () => f.button('刷新配置').click());
    expect(f.toggle('c').disabled).toBe(true);
    await f.render(selected('old'), [], {
      blocked: true,
      acquireWrite: () => {
        throw Error('lookup must not acquire a new write');
      },
    });
    expect(f.button('查看结果').disabled).toBe(false);
    await act(async () => f.button('查看结果').click());
    expect(reads).toBe(2);
    expect(f.saved).toBe(1);
    expect(f.element.querySelector('[aria-label="待确认的模型更改"]')).toBeNull();
    expect(f.toggle('c').disabled).toBe(true);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: 'local-original' },
    ]);
    // A delayed watcher snapshot cannot revive an already confirmed local intent.
    await f.render(selected('old'), [original]);
    expect(f.element.querySelector('[aria-label="待确认的模型更改"]')).toBeNull();
    expect(f.toggle('c').disabled).toBe(false);
    expect(reads).toBe(2);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('new model writes synchronously acquire a shared lease and release it after one failed saved refresh', async () => {
  let admitted = false,
    acquired = 0,
    released = 0,
    reads = 0;
  const save = deferred<NativeModelSettingsSubmission>();
  const acquireWrite = () => {
    acquired++;
    return admitted
      ? () => {
          released++;
        }
      : undefined;
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') {
      if (++reads === 2) throw Error('configuration_continuation_changed');
      return structuredClone(facts);
    }
    if (input.method === 'settings.models.enabled') return save.promise;
    return null;
  });
  try {
    await f.render(selected('old'), [], { acquireWrite });
    await act(async () => f.toggle('c').click());
    expect(acquired).toBe(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(0);
    admitted = true;
    await act(async () => {
      f.toggle('c').click();
      f.toggle('c').click();
    });
    expect(acquired).toBe(2);
    expect(released).toBe(0);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    await act(async () =>
      save.resolve({
        kind: 'settings.models.submission',
        commandId: 'leased',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'enabled', modelId: 'c', enabled: true },
        phase: 'applied',
      }),
    );
    expect(released).toBe(1);
    expect(f.saved).toBe(1);
    expect(f.element.textContent).toContain('已保存模型配置，正在后台恢复');
    expect(f.toggle('c').disabled).toBe(true);
    await act(async () => f.button('刷新配置').click());
    expect(reads).toBe(3);
    expect(released).toBe(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('composed rows filter by exact route IDs without a second provider group or default list', async () => {
  const f = fixture(
    async (input) =>
      input.method === 'settings.models.read'
        ? {
            ...facts,
            models: facts.models.map((model) => ({
              ...model,
              provider: 'same display',
              model: 'same model',
            })),
          }
        : null,
    ['c', 'broken', 'missing', 'c'],
  );
  try {
    await f.render();
    expect(
      [...f.element.querySelectorAll('[role="switch"]')].map((node) =>
        node.getAttribute('aria-label'),
      ),
    ).toEqual(['启用模型 c', '启用模型 broken']);
    expect(f.element.querySelectorAll('.settings-model-provider')).toHaveLength(0);
    expect(f.element.querySelectorAll('[aria-label="默认模型"]')).toHaveLength(1);
    expect(f.element.textContent).toContain('model_unconfigured');
    expect(f.element.textContent).toContain('same model · c');
    await f.openMenu();
    expect(f.menuItem('a')).not.toBeNull();
    expect(f.menuItem('b')).not.toBeNull();
    expect(f.menuItem('c')).toBeNull();
    expect(f.menuItem('broken')).toBeNull();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const phase of ['applied', 'failed'] as const) {
  test(`a terminal ${phase} host submission supersedes local unknown without another save or lookup`, async () => {
    const original: NativeModelSettingsSubmission = {
      kind: 'settings.models.submission',
      commandId: `host-${phase}`,
      storeId: 'store',
      scope: 'user',
      observationId: 7,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
      phase: 'unknown',
    };
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') return structuredClone(facts);
      if (input.method === 'settings.models.enabled') return original;
      return null;
    });
    try {
      await f.render(selected('old'));
      await act(async () => f.toggle('c').click());
      expect(f.element.querySelector('[aria-label="待确认的模型更改"]')).not.toBeNull();
      await act(async () => f.button('刷新配置').click());
      expect(f.toggle('c').disabled).toBe(true);
      const row = f.toggle('c');
      await f.render(selected('old'), [{ ...original, phase }]);
      expect(f.element.querySelector('[aria-label="待确认的模型更改"]')).toBeNull();
      expect(f.toggle('c')).toBe(row);
      expect(row.disabled).toBe(true);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 280));
      });
      expect(row.disabled).toBe(false);
      expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
      expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toHaveLength(0);
      expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(2);
      expect(f.saved).toBe(phase === 'applied' ? 1 : 0);
    } finally {
      await f.close();
    }
  });
}

function setField(f: ReturnType<typeof fixture>, label: string, value: string) {
  const field = f.element.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
    field,
    value,
  );
  field.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
}

async function advanceRecovery(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

test('initial read recovery backs off with one active GET and retains the error until valid facts arrive', async () => {
  jest.useFakeTimers();
  const second = deferred<void>();
  let reads = 0,
    recovered = 0;
  const f = fixture(async (input) => {
    if (input.method !== 'settings.models.read') return null;
    if (++reads === 2) await second.promise;
    if (reads < 4) throw Error('network_unavailable');
    return structuredClone(facts);
  });
  try {
    await f.render(undefined, [], {
      onRecovered: () => {
        recovered++;
      },
    });
    const alert = f.element.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('network_unavailable');
    await advanceRecovery(249);
    expect(reads).toBe(1);
    await advanceRecovery(1);
    expect(reads).toBe(2);
    expect(f.element.querySelector('[role="alert"]')).toBe(alert);
    await advanceRecovery(10000);
    expect(reads).toBe(2);
    await act(async () => second.resolve());
    expect(f.element.querySelector('[role="alert"]')).toBe(alert);
    await advanceRecovery(999);
    expect(reads).toBe(2);
    await advanceRecovery(1);
    expect(reads).toBe(3);
    await advanceRecovery(2999);
    expect(reads).toBe(3);
    await advanceRecovery(1);
    expect(reads).toBe(4);
    expect(f.element.querySelector('[role="alert"]')).toBeNull();
    expect(f.toggle('c').disabled).toBe(false);
    expect(recovered).toBe(1);
    await act(async () => f.button('刷新配置').click());
    await advanceRecovery(10000);
    expect(reads).toBe(5);
    expect(recovered).toBe(1);
    expect(f.calls.every((input) => input.method === 'settings.models.read')).toBe(true);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

for (const conflict of [false, true])
  test(`transient proof read retry ${conflict ? 'discards the tail when authority changed' : 'keeps the tail under the same original proof'}`, async () => {
    jest.useFakeTimers();
    let current = structuredClone(facts),
      proofReads = 0,
      posts = 0,
      acquired = 0,
      released = 0;
    const first = deferred<NativeModelSettingsSubmission>();
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') {
        if (input.afterCommandId === 'transient-head') {
          if (++proofReads === 1) throw Error('network_unavailable');
          if (conflict) throw Error('configuration_continuation_changed');
        }
        return structuredClone(current);
      }
      if (input.method === 'settings.models.enabled') {
        if (++posts === 1) return first.promise;
        current = {
          ...current,
          observationId: current.observationId + 1,
          models: current.models.map((model) =>
            model.id === input.modelId ? { ...model, enabled: input.enabled } : model,
          ),
        };
        return {
          kind: 'settings.models.submission',
          commandId: 'later-new-or-tail',
          storeId: 'store',
          scope: 'user',
          observationId: input.observationId,
          operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
          phase: 'applied',
        };
      }
      return null;
    });
    try {
      await f.render(undefined, [], {
        acquireWrite: () => {
          acquired++;
          return () => {
            released++;
          };
        },
      });
      const row = f.toggle('b');
      await act(async () => {
        f.toggle('c').click();
        row.focus();
        row.click();
      });
      current = {
        ...current,
        observationId: 8,
        models: current.models.map((model) =>
          model.id === 'c' ? { ...model, enabled: true } : model,
        ),
      };
      await act(async () =>
        first.resolve({
          kind: 'settings.models.submission',
          commandId: 'transient-head',
          storeId: 'store',
          scope: 'user',
          observationId: 7,
          operation: { kind: 'enabled', modelId: 'c', enabled: true },
          phase: 'applied',
        }),
      );
      expect(row.disabled).toBe(false);
      expect(row.checked).toBe(false);
      expect(released).toBe(0);
      expect(f.dom.window.document.activeElement).toBe(row);
      await advanceRecovery(250);
      expect(proofReads).toBe(2);
      expect(
        f.calls.filter(
          (input) =>
            input.method === 'settings.models.read' && input.afterCommandId === 'transient-head',
        ),
      ).toHaveLength(2);
      if (conflict) {
        expect(posts).toBe(1);
        expect(row.checked).toBe(true);
        expect(row.disabled).toBe(true);
        await advanceRecovery(250);
        expect(row.disabled).toBe(false);
        expect(posts).toBe(1);
        expect(f.calls.filter((input) => input.method === 'settings.models.read').at(-1)).toEqual({
          method: 'settings.models.read',
          generation: 1,
          scope: 'user',
        });
        await act(async () => row.click());
      }
      expect(posts).toBe(2);
      expect(f.toggle('b')).toBe(row);
      expect(row.checked).toBe(false);
      expect(acquired).toBe(conflict ? 2 : 1);
      expect(released).toBe(acquired);
    } finally {
      jest.useRealTimers();
      await f.close();
    }
  });

for (const lifecycle of ['close', 'scope-change'] as const)
  test(`a proof retry ${lifecycle === 'close' ? 'continues accepted work after closing' : 'stops on identity change without leaking its tail'}`, async () => {
    jest.useFakeTimers();
    let current = structuredClone(facts),
      posts = 0,
      proofReads = 0;
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') {
        if (input.afterCommandId === 'lifecycle-1' && ++proofReads === 1)
          throw Error('network_unavailable');
        return structuredClone(current);
      }
      if (input.method === 'settings.models.enabled') {
        posts++;
        current = {
          ...current,
          observationId: 7 + posts,
          models: current.models.map((model) =>
            model.id === input.modelId ? { ...model, enabled: input.enabled } : model,
          ),
        };
        return {
          kind: 'settings.models.submission',
          commandId: `lifecycle-${posts}`,
          storeId: 'store',
          scope: 'user',
          observationId: input.observationId,
          operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
          phase: 'applied',
        };
      }
      return null;
    });
    try {
      await f.render(selected('old'));
      await act(async () => {
        f.toggle('c').click();
        f.toggle('b').click();
      });
      expect(proofReads).toBe(1);
      if (lifecycle === 'close') await f.hide();
      else await f.render(selected('new'));
      await advanceRecovery(10000);
      expect(posts).toBe(lifecycle === 'close' ? 2 : 1);
      expect(proofReads).toBe(lifecycle === 'close' ? 2 : 1);
      if (lifecycle === 'scope-change') expect(f.toggle('b').checked).toBe(true);
      expect(f.saved).toBe(1);
      expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(
        lifecycle === 'close' ? 1 : 0,
      );
    } finally {
      jest.useRealTimers();
      await f.close();
    }
  });

test('an applied watcher still invalidates the global model directory when its recovery reader is closed', async () => {
  jest.useFakeTimers();
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'terminal-before-close',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'enabled', modelId: 'c', enabled: true },
    phase: 'unknown',
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(facts);
    if (input.method === 'settings.models.enabled') return original;
    return null;
  });
  try {
    await f.render(selected('old'));
    await act(async () => f.toggle('c').click());
    await f.render(selected('old'), [{ ...original, phase: 'applied' }]);
    expect(f.saved).toBe(0);
    await f.hide();
    expect(f.saved).toBe(1);
    await advanceRecovery(10000);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test('a known failed head automatically reads new facts without replaying its discarded tail', async () => {
  jest.useFakeTimers();
  const response = deferred<NativeModelSettingsSubmission>();
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') {
      reads++;
      return structuredClone(facts);
    }
    if (input.method === 'settings.models.enabled') return response.promise;
    return null;
  });
  try {
    await f.render();
    await act(async () => {
      f.toggle('c').click();
      f.toggle('b').click();
    });
    await act(async () =>
      response.resolve({
        kind: 'settings.models.submission',
        commandId: 'recover-head',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'enabled', modelId: 'c', enabled: true },
        phase: 'failed',
        error: 'configuration_conflict',
      }),
    );
    expect(f.toggle('b').disabled).toBe(true);
    await advanceRecovery(250);
    expect(f.toggle('b').disabled).toBe(false);
    expect(f.toggle('b').checked).toBe(true);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(reads).toBe(2);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test('a hot unknown automatically queries only its original ID until terminal and never replays its tail', async () => {
  jest.useFakeTimers();
  const response = deferred<NativeModelSettingsSubmission>();
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'auto-original',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'enabled', modelId: 'c', enabled: true },
    phase: 'unknown',
  };
  let reads = 0,
    lookups = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') {
      reads++;
      expect(input.afterCommandId).toBeUndefined();
      return { ...facts, observationId: reads + 6 };
    }
    if (input.method === 'settings.models.enabled') return response.promise;
    if (input.method === 'settings.models.lookup')
      return ++lookups === 1 ? original : { ...original, phase: 'applied' };
    return null;
  });
  try {
    await f.render();
    await act(async () => {
      f.toggle('c').click();
      f.toggle('b').click();
      response.resolve(original);
    });
    expect(f.toggle('b').checked).toBe(true);
    await advanceRecovery(250);
    expect(lookups).toBe(1);
    expect(reads).toBe(1);
    expect(f.toggle('c').disabled).toBe(true);
    await advanceRecovery(1000);
    expect(lookups).toBe(2);
    expect(reads).toBe(2);
    expect(f.toggle('c').disabled).toBe(false);
    expect(
      f.calls
        .filter((input) => input.method === 'settings.models.lookup')
        .map((input) => input.commandId),
    ).toEqual(['auto-original', 'auto-original']);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(f.saved).toBe(1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

for (const origin of ['hot', 'cold', 'foreign'] as const)
  test(`${origin} unknown recovery keeps exact Store and page lifecycle boundaries`, async () => {
    jest.useFakeTimers();
    const original: NativeModelSettingsSubmission = {
      kind: 'settings.models.submission',
      commandId: `original-${origin}`,
      storeId: origin === 'foreign' ? 'foreign-store' : 'store',
      scope: 'user',
      observationId: 7,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
      phase: 'unknown',
    };
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') return structuredClone(facts);
      if (input.method === 'settings.models.enabled') return original;
      if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
      return null;
    });
    try {
      await f.render(selected('old'), origin === 'hot' ? [] : [original]);
      if (origin === 'hot') await act(async () => f.toggle('c').click());
      if (origin === 'foreign') {
        await advanceRecovery(10000);
        expect(f.toggle('c').disabled).toBe(false);
      }
      await f.hide();
      expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(
        origin === 'hot' ? 0 : 1,
      );
      await advanceRecovery(10000);
      expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual(
        origin === 'hot'
          ? [{ method: 'settings.models.lookup', generation: 1, commandId: original.commandId }]
          : [],
      );
      expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(
        origin === 'hot' ? 1 : 0,
      );
      expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(1);
      expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(1);
      expect(f.saved).toBe(origin === 'hot' ? 1 : 0);
    } finally {
      jest.useRealTimers();
      await f.close();
    }
  });

test('a current-Store cold original is automatically queried while active and terminal facts unlock only new clicks', async () => {
  jest.useFakeTimers();
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'current-cold',
    storeId: 'store',
    scope: 'user',
    observationId: 2,
    operation: { kind: 'enabled', modelId: 'c', enabled: true },
    phase: 'unknown',
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(facts);
    if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
    return null;
  });
  try {
    await f.render(selected('old'), [original]);
    expect(f.toggle('c').disabled).toBe(true);
    await advanceRecovery(250);
    expect(f.toggle('c').disabled).toBe(false);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: original.commandId },
    ]);
    expect(
      f.calls
        .filter((input) => input.method === 'settings.models.read')
        .map((input) => input.afterCommandId),
    ).toEqual([undefined, undefined]);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(0);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

for (const terminal of ['failed', 'applied'] as const)
  test(`an automatically confirmed ${terminal} result synchronizes its peer once using the appropriate callback`, async () => {
    jest.useFakeTimers();
    let recovered = 0;
    const original: NativeModelSettingsSubmission = {
      kind: 'settings.models.submission',
      commandId: 'callback-original',
      storeId: 'store',
      scope: 'user',
      observationId: 2,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
      phase: 'unknown',
    };
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') return structuredClone(facts);
      if (input.method === 'settings.models.lookup') return { ...original, phase: terminal };
      return null;
    });
    try {
      await f.render(selected('old'), [original], {
        onRecovered: () => {
          recovered++;
        },
      });
      await advanceRecovery(250);
      expect(recovered).toBe(terminal === 'failed' ? 1 : 0);
      expect(f.saved).toBe(terminal === 'applied' ? 1 : 0);
      expect(f.toggle('c').disabled).toBe(false);
      await act(async () => f.button('刷新配置').click());
      expect(recovered).toBe(terminal === 'failed' ? 1 : 0);
      expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(0);
    } finally {
      jest.useRealTimers();
      await f.close();
    }
  });

test('a thrown mutation uses only an exact trusted original watcher ID for automatic settlement', async () => {
  jest.useFakeTimers();
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'trusted-watcher-id',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'enabled', modelId: 'c', enabled: true },
    phase: 'unknown',
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(facts);
    if (input.method === 'settings.models.enabled') throw Error('network_outcome_unknown');
    if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
    return null;
  });
  try {
    await f.render(selected('old'));
    await act(async () => f.toggle('c').click());
    expect(f.toggle('c').disabled).toBe(true);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toHaveLength(0);
    await f.render(selected('old'), [original]);
    await advanceRecovery(250);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: original.commandId },
    ]);
    expect(f.toggle('c').disabled).toBe(false);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test('read-only diagnostics keep retrying without becoming writable and identity loss stops all further recovery', async () => {
  jest.useFakeTimers();
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method !== 'settings.models.read') return null;
    if (++reads >= 3) throw Error('native_generation_changed');
    return { ...facts, canWrite: false, errors: ['configuration_invalid'] };
  });
  try {
    await f.render();
    expect(f.toggle('c').disabled).toBe(true);
    await advanceRecovery(250);
    expect(reads).toBe(2);
    expect(f.toggle('c').disabled).toBe(true);
    await advanceRecovery(1000);
    expect(reads).toBe(3);
    await advanceRecovery(60000);
    expect(reads).toBe(3);
    expect(f.calls.every((input) => input.method === 'settings.models.read')).toBe(true);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test('accurate read-only facts without diagnostics stop polling and never notify a writable recovery', async () => {
  jest.useFakeTimers();
  let reads = 0,
    recovered = 0;
  const f = fixture(async (input) => {
    if (input.method !== 'settings.models.read') return null;
    reads++;
    return { ...facts, canWrite: false, errors: [] };
  });
  try {
    await f.render(undefined, [], {
      onRecovered: () => {
        recovered++;
      },
    });
    expect(f.toggle('c').disabled).toBe(true);
    await advanceRecovery(60000);
    expect(reads).toBe(1);
    expect(recovered).toBe(0);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test('an unresolved thrown mutation cannot guess a command ID or unlock from an ordinary GET alone', async () => {
  jest.useFakeTimers();
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') {
      reads++;
      return structuredClone(facts);
    }
    if (input.method === 'settings.models.enabled') throw Error('network_outcome_unknown');
    return null;
  });
  try {
    await f.render();
    await act(async () => f.toggle('c').click());
    await advanceRecovery(250);
    expect(reads).toBe(1);
    expect(f.toggle('c').disabled).toBe(true);
    expect(f.element.textContent).toContain('network_outcome_unknown');
    expect(f.calls.filter((input) => input.method === 'state')).toHaveLength(1);
    await act(async () => f.button('刷新配置').click());
    expect(reads).toBe(2);
    expect(f.toggle('c').disabled).toBe(true);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toHaveLength(0);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test('a missed watcher is recovered from Main state only after an exact original appears', async () => {
  jest.useFakeTimers();
  let states = 0;
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'state-owned-original',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'enabled', modelId: 'c', enabled: true },
    phase: 'unknown',
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(facts);
    if (input.method === 'settings.models.enabled') throw Error('network_outcome_unknown');
    if (input.method === 'state')
      return {
        generation: 1,
        directory: { storeId: 'store', workspaces: [], sessions: [] },
        creationSubmissions: [],
        inputSubmissions: [],
        permissionSubmissions: [],
        interactionSubmissions: [],
        modelSettingsSubmissions: [
          {
            ...original,
            commandId: 'wrong-operation',
            operation: { kind: 'enabled', modelId: 'b', enabled: false },
          },
          { ...original, commandId: 'foreign-original', storeId: 'other-store' },
          ...(++states > 1 ? [original] : []),
        ],
      };
    if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
    return null;
  });
  try {
    await f.render(selected('old'));
    await act(async () => f.toggle('c').click());
    await advanceRecovery(250);
    expect(states).toBe(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toHaveLength(0);
    expect(f.toggle('c').disabled).toBe(true);
    await advanceRecovery(1000);
    expect(states).toBe(2);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: 'state-owned-original' },
    ]);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(
      f.calls
        .filter((input) => input.method === 'settings.models.read')
        .map((input) => input.afterCommandId),
    ).toEqual([undefined, undefined]);
    expect(f.toggle('c').disabled).toBe(false);
    expect(f.saved).toBe(1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

for (const reply of ['empty', 'malformed'] as const)
  test(`a ${reply} mutation reply stays protected until Main supplies its exact original`, async () => {
    jest.useFakeTimers();
    let reads = 0,
      states = 0;
    const original: NativeModelSettingsSubmission = {
      kind: 'settings.models.submission',
      commandId: 'bad-reply-original',
      storeId: 'store',
      scope: 'user',
      observationId: 7,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
      phase: 'unknown',
    };
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') {
        reads++;
        return structuredClone(facts);
      }
      if (input.method === 'settings.models.enabled')
        return reply === 'empty' ? null : { ...original, commandId: '' };
      if (input.method === 'state')
        return {
          generation: 1,
          directory: { storeId: 'store', workspaces: [], sessions: [] },
          creationSubmissions: [],
          inputSubmissions: [],
          permissionSubmissions: [],
          interactionSubmissions: [],
          modelSettingsSubmissions:
            ++states === 1
              ? ([
                  { ...original, commandId: '' },
                  { ...original, commandId: 'wrong-kind', kind: 'settings.providers.submission' },
                  { ...original, commandId: 'wrong-phase', phase: 'invalid' },
                ] as unknown as NativeModelSettingsSubmission[])
              : [original],
        };
      if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
      return null;
    });
    try {
      await f.render(selected('old'));
      await act(async () => f.toggle('c').click());
      expect(f.toggle('c').disabled).toBe(true);
      await advanceRecovery(250);
      expect(reads).toBe(1);
      expect(f.toggle('c').disabled).toBe(true);
      expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toHaveLength(0);
      await advanceRecovery(1000);
      expect(reads).toBe(2);
      expect(f.toggle('c').disabled).toBe(false);
      expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
        { method: 'settings.models.lookup', generation: 1, commandId: original.commandId },
      ]);
      expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    } finally {
      jest.useRealTimers();
      await f.close();
    }
  });

for (const reopen of [false, true])
  test(`a hot original without its ID ${reopen ? 'stays locked across reopening until settlement' : 'settles while detached and notifies globally without another configuration GET'}`, async () => {
    jest.useFakeTimers();
    let reads = 0,
      states = 0;
    const original: NativeModelSettingsSubmission = {
      kind: 'settings.models.submission',
      commandId: 'detached-missed-original',
      storeId: 'store',
      scope: 'user',
      observationId: 7,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
      phase: reopen ? 'unknown' : 'applied',
    };
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') {
        reads++;
        return structuredClone(facts);
      }
      if (input.method === 'settings.models.enabled') return null;
      if (input.method === 'state') {
        states++;
        return {
          generation: 1,
          directory: { storeId: 'store', workspaces: [], sessions: [] },
          creationSubmissions: [],
          inputSubmissions: [],
          permissionSubmissions: [],
          interactionSubmissions: [],
          modelSettingsSubmissions: [original],
        };
      }
      if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
      return null;
    });
    try {
      await f.render(selected('old'));
      await act(async () => f.toggle('c').click());
      await f.hide();
      expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(0);
      if (reopen) {
        await f.render(selected('old'));
        expect(reads).toBe(1);
        expect(f.toggle('c').disabled).toBe(true);
      }
      await advanceRecovery(250);
      expect(states).toBe(1);
      expect(reads).toBe(reopen ? 2 : 1);
      expect(f.saved).toBe(1);
      expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
      expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toHaveLength(
        reopen ? 1 : 0,
      );
      expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(
        reopen ? 0 : 1,
      );
      if (reopen) expect(f.toggle('c').disabled).toBe(false);
    } finally {
      jest.useRealTimers();
      await f.close();
    }
  });

test('a failed original followed by a failed GET cannot unlock its stale observation while recovery waits', async () => {
  jest.useFakeTimers();
  let reads = 0;
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'failed-get-original',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'enabled', modelId: 'c', enabled: true },
    phase: 'unknown',
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') {
      if (++reads === 2) throw Error('network_unavailable');
      return structuredClone(facts);
    }
    if (input.method === 'settings.models.enabled') return original;
    if (input.method === 'settings.models.lookup') return { ...original, phase: 'failed' };
    return null;
  });
  try {
    await f.render();
    await act(async () => f.toggle('c').click());
    await advanceRecovery(250);
    expect(reads).toBe(2);
    expect(f.element.querySelector('[aria-label="待确认的模型更改"]')).toBeNull();
    expect(f.toggle('b').disabled).toBe(true);
    await act(async () => f.toggle('b').click());
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    await advanceRecovery(1000);
    expect(reads).toBe(3);
    expect(f.toggle('b').disabled).toBe(false);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

test('toggle intents stay interactive and ordered through serial POST, proof-bound reads and an asynchronous saved flush', async () => {
  let current = structuredClone(facts);
  const posts: Extract<NativeRequest, { method: 'settings.models.enabled' }>[] = [];
  const responses: ReturnType<typeof deferred<NativeModelSettingsSubmission>>[] = [];
  const continuation = deferred<NativeModelSettingsFacts>();
  const flush = deferred<void>();
  let acquired = 0,
    released = 0,
    saved = 0,
    activePosts = 0,
    maximumPosts = 0;
  const acquireWrite = () => {
    acquired++;
    return () => released++;
  };
  const onSaved = async () => {
    if (++saved === 1) await flush.promise;
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read')
      return input.afterCommandId === 'queued-1' ? continuation.promise : structuredClone(current);
    if (input.method === 'settings.models.enabled') {
      posts.push(input);
      activePosts++;
      maximumPosts = Math.max(maximumPosts, activePosts);
      const response = deferred<NativeModelSettingsSubmission>();
      responses.push(response);
      const result = await response.promise;
      activePosts--;
      return result;
    }
    return null;
  });
  async function apply(index: number) {
    const input = posts[index]!;
    current = {
      ...current,
      observationId: input.observationId + 1,
      models: current.models.map((model) =>
        model.id === input.modelId ? { ...model, enabled: input.enabled } : model,
      ),
    };
    await act(async () =>
      responses[index]!.resolve({
        kind: 'settings.models.submission',
        commandId: `queued-${index + 1}`,
        storeId: 'store',
        scope: 'user',
        observationId: input.observationId,
        operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
        phase: 'applied',
      }),
    );
  }
  try {
    await f.render(selected('old'), [], { acquireWrite, onSaved });
    const c = f.toggle('c'),
      b = f.toggle('b');
    await act(async () => {
      c.focus();
      c.click(); // Immutable head: C true.
      c.click(); // Pending C false keeps its first position.
      b.click(); // Pending B false follows C.
      c.click();
      c.click(); // Only the last pending C false survives.
    });
    expect(c.checked).toBe(false);
    expect(b.checked).toBe(false);
    expect(c.disabled).toBe(false);
    expect(b.disabled).toBe(false);
    expect(f.dom.window.document.activeElement === c).toBe(true);
    expect(posts.map((input) => [input.modelId, input.enabled, input.observationId])).toEqual([
      ['c', true, 7],
    ]);
    await f.render(selected('old'), [], { revision: 1, acquireWrite, onSaved });
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(1);
    await apply(0);
    expect(posts).toHaveLength(1);
    expect(c.checked).toBe(false);
    expect(c.disabled).toBe(false);
    expect(b.disabled).toBe(false);
    expect(f.calls.filter((input) => input.method === 'settings.models.read').at(-1)).toEqual({
      method: 'settings.models.read',
      generation: 1,
      scope: 'user',
      afterCommandId: 'queued-1',
    });
    await act(async () => {
      b.click();
      b.click();
      continuation.resolve(structuredClone(current));
    });
    expect(posts.map((input) => [input.modelId, input.enabled, input.observationId])).toEqual([
      ['c', true, 7],
      ['c', false, 8],
    ]);
    await apply(1);
    expect(posts.map((input) => [input.modelId, input.enabled, input.observationId])).toEqual([
      ['c', true, 7],
      ['c', false, 8],
      ['b', false, 9],
    ]);
    await apply(2);
    expect(saved).toBe(1);
    expect(released).toBe(0);
    expect(f.button('默认模型').disabled).toBe(true);
    await act(async () => c.click());
    expect(c.checked).toBe(true);
    expect(posts).toHaveLength(3);
    await act(async () => flush.resolve());
    expect(posts.map((input) => [input.modelId, input.enabled, input.observationId])).toEqual([
      ['c', true, 7],
      ['c', false, 8],
      ['b', false, 9],
      ['c', true, 10],
    ]);
    await apply(3);
    expect(saved).toBe(2);
    expect(acquired).toBe(1);
    expect(released).toBe(1);
    expect(maximumPosts).toBe(1);
    expect(c === f.toggle('c')).toBe(true);
    expect(b === f.toggle('b')).toBe(true);
    expect(c.checked).toBe(true);
    expect(b.checked).toBe(false);
    expect(f.dom.window.document.activeElement === c).toBe(true);
    expect(
      f.calls
        .filter((input) => input.method === 'settings.models.read')
        .map((input) => input.afterCommandId),
    ).toEqual([undefined, 'queued-1', 'queued-2', 'queued-3', 'queued-4']);
  } finally {
    await act(async () => flush.resolve());
    await f.close();
  }
});

test('a saved flush failure preserves the applied head and drops intents accepted while that flush was pending', async () => {
  jest.useFakeTimers();
  let current = structuredClone(facts),
    saved = 0,
    released = 0;
  const flush = deferred<void>();
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(current);
    if (input.method === 'settings.models.enabled') {
      current = {
        ...current,
        observationId: 8,
        models: current.models.map((model) =>
          model.id === input.modelId ? { ...model, enabled: input.enabled } : model,
        ),
      };
      return {
        kind: 'settings.models.submission',
        commandId: 'flush-failed-head',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
        phase: 'applied',
      };
    }
    return null;
  });
  try {
    await f.render(undefined, [], {
      acquireWrite: () => () => {
        released++;
      },
      onSaved: async () => {
        saved++;
        await flush.promise;
        throw Error('provider_read_failed');
      },
    });
    await act(async () => f.toggle('c').click());
    expect(saved).toBe(1);
    expect(released).toBe(0);
    expect(f.toggle('b').disabled).toBe(false);
    await act(async () => f.toggle('b').click());
    expect(f.toggle('b').checked).toBe(false);
    await act(async () => flush.resolve());
    expect(f.toggle('c').checked).toBe(true);
    expect(f.toggle('b').checked).toBe(true);
    expect(f.toggle('b').disabled).toBe(true);
    expect(released).toBe(1);
    expect(f.element.textContent).toContain('provider_read_failed');
    await advanceRecovery(250);
    expect(f.toggle('b').disabled).toBe(false);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(saved).toBe(1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});

for (const outcome of ['failed', 'unknown', 'continuation-conflict'] as const)
  test(`${outcome} clears unsent toggles without replay and preserves the original lookup or explicit read recovery`, async () => {
    const current = structuredClone(facts);
    const response = deferred<NativeModelSettingsSubmission>();
    const original: NativeModelSettingsSubmission = {
      kind: 'settings.models.submission',
      commandId: 'stopped-head',
      storeId: 'store',
      scope: 'user',
      observationId: 7,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
      phase: outcome === 'continuation-conflict' ? 'applied' : outcome,
      ...(outcome === 'failed' ? { error: 'configuration_conflict' } : {}),
    };
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') {
        if (input.afterCommandId && outcome === 'continuation-conflict')
          throw Error('configuration_continuation_changed');
        return structuredClone(current);
      }
      if (input.method === 'settings.models.enabled') return response.promise;
      if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
      return null;
    });
    try {
      await f.render();
      await act(async () => {
        f.toggle('c').click();
        f.toggle('b').click();
        f.toggle('c').click();
      });
      if (outcome !== 'failed') current.models.find((model) => model.id === 'c')!.enabled = true;
      await act(async () => response.resolve(original));
      expect(f.toggle('b').checked).toBe(true);
      expect(f.toggle('c').checked).toBe(outcome !== 'failed');
      expect(f.toggle('b').disabled).toBe(true);
      expect(f.toggle('c').disabled).toBe(true);
      expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
      if (outcome === 'unknown') {
        expect(f.element.textContent).toContain('模型启用更改结果待确认');
        await act(async () => f.button('查看结果').click());
        expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
          { method: 'settings.models.lookup', generation: 1, commandId: 'stopped-head' },
        ]);
      } else {
        if (outcome === 'continuation-conflict')
          expect(f.element.textContent).toContain('configuration_continuation_changed');
        await act(async () => f.button('刷新配置').click());
      }
      expect(f.toggle('b').disabled).toBe(false);
      expect(f.toggle('b').checked).toBe(true);
      expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test('closing and immediately reopening settings reuses the active queue and delays close until detached work finishes', async () => {
  let current = structuredClone(facts);
  const responses = [
    deferred<NativeModelSettingsSubmission>(),
    deferred<NativeModelSettingsSubmission>(),
  ];
  let posts = 0,
    firstSaved = 0,
    reopenedSaved = 0,
    acquired = 0,
    released = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(current);
    if (input.method === 'settings.models.enabled') return responses[posts++]!.promise;
    return null;
  });
  const acquireWrite = () => {
    acquired++;
    return () => released++;
  };
  try {
    await f.render(selected('old'), [], {
      acquireWrite,
      onSaved: () => {
        firstSaved++;
      },
    });
    await act(async () => {
      f.toggle('c').click();
      f.toggle('b').click();
    });
    await f.hide();
    expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(0);
    await f.render(selected('old'), [], {
      acquireWrite,
      onSaved: () => {
        reopenedSaved++;
      },
    });
    expect(f.toggle('c').checked).toBe(true);
    expect(f.toggle('b').checked).toBe(false);
    expect(f.toggle('b').disabled).toBe(false);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(1);
    expect(acquired).toBe(1);
    await f.hide();
    for (const [index, modelId] of ['c', 'b'].entries()) {
      current = {
        ...current,
        observationId: 8 + index,
        models: current.models.map((model) =>
          model.id === modelId ? { ...model, enabled: modelId === 'c' } : model,
        ),
      };
      await act(async () =>
        responses[index]!.resolve({
          kind: 'settings.models.submission',
          commandId: `detached-${index}`,
          storeId: 'store',
          scope: 'user',
          observationId: 7 + index,
          operation: { kind: 'enabled', modelId, enabled: modelId === 'c' },
          phase: 'applied',
        }),
      );
    }
    expect(posts).toBe(2);
    expect(released).toBe(1);
    expect(firstSaved).toBe(0);
    expect(reopenedSaved).toBe(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.close')).toEqual([
      { method: 'settings.models.close', generation: 1 },
    ]);
    expect(
      f.calls
        .filter((input) => input.method === 'settings.models.read')
        .map((input) => input.afterCommandId),
    ).toEqual([undefined, 'detached-0', 'detached-1']);
  } finally {
    await f.close();
  }
});

test('closing an ordinary reader releases it immediately and a late response cannot overwrite or close a reopened view', async () => {
  const late = deferred<NativeModelSettingsFacts>();
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read')
      return ++reads === 1 ? late.promise : { ...facts, observationId: 8 };
    return null;
  });
  try {
    await f.render(selected('old'));
    await f.hide();
    expect(f.calls).toEqual([
      { method: 'settings.models.read', generation: 1, scope: 'user' },
      { method: 'settings.models.close', generation: 1 },
    ]);
    await f.render(selected('old'));
    expect(reads).toBe(2);
    expect(f.toggle('c').disabled).toBe(false);
    await act(async () => late.resolve({ ...facts, defaultModelId: 'late-obsolete-default' }));
    expect(f.element.textContent).not.toContain('late-obsolete-default');
    expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(1);
    await act(async () => f.toggle('c').click());
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 8,
        modelId: 'c',
        enabled: true,
      },
    ]);
  } finally {
    await f.close();
  }
});

test('changing the selected identity discards the old unsent tail and never publishes its late facts into the new scope', async () => {
  const response = deferred<NativeModelSettingsSubmission>();
  let reads = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return { ...facts, observationId: ++reads + 6 };
    if (input.method === 'settings.models.enabled') return response.promise;
    return null;
  });
  try {
    await f.render(selected('old'));
    await act(async () => {
      f.toggle('c').click();
      f.toggle('b').click();
    });
    await f.render(selected('new'));
    const currentRow = f.toggle('c');
    expect(currentRow.checked).toBe(false);
    expect(f.toggle('b').checked).toBe(true);
    await act(async () =>
      response.resolve({
        kind: 'settings.models.submission',
        commandId: 'old-scope-head',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'enabled', modelId: 'c', enabled: true },
        phase: 'applied',
      }),
    );
    expect(f.toggle('c')).toBe(currentRow);
    expect(currentRow.checked).toBe(false);
    expect(f.toggle('b').checked).toBe(true);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(2);
    expect(f.calls.filter((input) => input.method === 'settings.models.close')).toHaveLength(0);
    expect(f.saved).toBe(1);
  } finally {
    await f.close();
  }
});

for (const foreign of [false, true])
  test(`${foreign ? 'foreign' : 'cold'} explicit lookup never resumes a queue or requires the original continuation proof`, async () => {
    const original: NativeModelSettingsSubmission = {
      kind: 'settings.models.submission',
      commandId: 'cold-original',
      storeId: foreign ? 'foreign-store' : 'store',
      scope: 'user',
      observationId: 2,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
      phase: 'unknown',
    };
    let reads = 0;
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') {
        expect(input.afterCommandId).toBeUndefined();
        reads++;
        return structuredClone(facts);
      }
      if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
      return null;
    });
    try {
      await f.render(selected('old'), [original]);
      expect(f.toggle('c').disabled).toBe(!foreign);
      await act(async () => f.button('查看结果').click());
      expect(reads).toBe(foreign ? 1 : 2);
      expect(f.saved).toBe(foreign ? 0 : 1);
      expect(f.toggle('c').disabled).toBe(false);
      expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(0);
      expect(f.element.querySelector('[aria-label="待确认的模型更改"]')).toBeNull();
    } finally {
      await f.close();
    }
  });

test('a real same-scope unknown watcher stops the healthy queue before the immutable head returns', async () => {
  const response = deferred<NativeModelSettingsSubmission>();
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'watcher-head',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'enabled', modelId: 'c', enabled: true },
    phase: 'unknown',
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(facts);
    if (input.method === 'settings.models.enabled') return response.promise;
    return null;
  });
  try {
    await f.render();
    await act(async () => {
      f.toggle('c').click();
      f.toggle('b').click();
    });
    expect(f.toggle('b').checked).toBe(false);
    await f.render(undefined, [original]);
    expect(f.toggle('b').disabled).toBe(true);
    expect(f.toggle('b').checked).toBe(true);
    await act(async () => response.resolve({ ...original, phase: 'applied' }));
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(f.toggle('b').checked).toBe(true);
    expect(f.toggle('b').disabled).toBe(false);
  } finally {
    await f.close();
  }
});

for (const peer of ['own-submitting', 'foreign-submitting', 'provider-submitting'] as const)
  test(`${peer} distinguishes this queue's normal submission from a genuine peer write`, async () => {
    let current = structuredClone(facts),
      posts = 0;
    const response = deferred<NativeModelSettingsSubmission>();
    const head: NativeModelSettingsSubmission = {
      kind: 'settings.models.submission',
      commandId: 'own-head',
      storeId: 'store',
      scope: 'user',
      observationId: 7,
      operation: { kind: 'enabled', modelId: 'c', enabled: true },
      phase: 'submitting',
    };
    const f = fixture(async (input) => {
      if (input.method === 'settings.models.read') return structuredClone(current);
      if (input.method === 'settings.models.enabled') {
        if (++posts === 1) return response.promise;
        return {
          ...head,
          commandId: 'second',
          observationId: input.observationId,
          operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
          phase: 'failed',
          error: 'fixture_second_finished',
        };
      }
      return null;
    });
    try {
      await f.render();
      await act(async () => {
        f.toggle('c').click();
        f.toggle('b').click();
      });
      await f.render(
        undefined,
        peer === 'provider-submitting'
          ? []
          : [
              {
                ...head,
                ...(peer === 'foreign-submitting'
                  ? {
                      commandId: 'peer-head',
                      operation: { kind: 'enabled' as const, modelId: 'b', enabled: false },
                    }
                  : {}),
              },
            ],
        { blocked: true, hardBlocked: peer === 'provider-submitting' },
      );
      expect(f.toggle('b').disabled).toBe(peer !== 'own-submitting');
      expect(f.toggle('b').checked).toBe(peer !== 'own-submitting');
      current = {
        ...current,
        observationId: 8,
        models: current.models.map((model) =>
          model.id === 'c' ? { ...model, enabled: true } : model,
        ),
      };
      await act(async () => response.resolve({ ...head, phase: 'applied' }));
      expect(posts).toBe(peer === 'own-submitting' ? 2 : 1);
      if (peer !== 'own-submitting') expect(f.toggle('b').checked).toBe(true);
    } finally {
      await f.close();
    }
  });

test('a large connection popover contains only its full exact model list and switches, retaining focus and position through one save', async () => {
  const many = Array.from({ length: 60 }, (_, index) => ({
    ...facts.models[0]!,
    id: `route-${String(index).padStart(3, '0')}`,
    model: `remote-${index}`,
    enabled: index % 2 === 0,
  }));
  let current = { ...facts, defaultModelId: 'route-000', models: many };
  const response = deferred<NativeModelSettingsSubmission>();
  const f = fixture(
    async (input) => {
      if (input.method === 'settings.models.read') return structuredClone(current);
      if (input.method === 'settings.models.enabled') return response.promise;
      return null;
    },
    many.map((model) => model.id),
    true,
  );
  try {
    await f.render();
    const trigger = f.button('管理 服务一 的模型');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toContain('60 个模型 · 已启用 30 个');
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(0);
    await act(async () => trigger.click());
    const popup = f.element.querySelector('[aria-label="服务一 的模型管理"]')!;
    const viewport = f.element.querySelector<HTMLDivElement>('[aria-label="服务一 的模型列表"]')!;
    expect(
      popup.querySelector('input[type="search"], select, .connection-models-toolbar'),
    ).toBeNull();
    expect(viewport.classList.contains('scroll-fade-y')).toBe(true);
    expect(viewport.getAttribute('tabindex')).toBe('0');
    expect(f.dom.window.document.activeElement === viewport).toBe(true);
    expect(
      [...popup.querySelectorAll('[role="switch"]')].map((node) => node.getAttribute('aria-label')),
    ).toEqual(many.map((model) => `启用模型 ${model.id}`));
    expect(f.toggle('route-000').disabled).toBe(false);
    expect(f.calls).toEqual([{ method: 'settings.models.read', generation: 1, scope: 'user' }]);
    const row = f.toggle('route-059');
    viewport.scrollTop = 180;
    await act(async () => {
      row.focus();
      row.click();
    });
    expect(f.toggle('route-059') === row).toBe(true);
    expect(row.checked).toBe(true);
    expect(row.disabled).toBe(false);
    expect(f.dom.window.document.activeElement === row).toBe(true);
    expect(f.element.querySelector('.connection-models-viewport') === viewport).toBe(true);
    expect(viewport.scrollTop).toBe(180);
    expect(popup.querySelectorAll('[role="switch"]')).toHaveLength(60);
    expect(trigger.textContent).toContain('60 个模型 · 已启用 31 个');
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 7,
        modelId: 'route-059',
        enabled: true,
      },
    ]);
    current = {
      ...current,
      observationId: 8,
      models: many.map((model) => (model.id === 'route-059' ? { ...model, enabled: true } : model)),
    };
    await act(async () =>
      response.resolve({
        kind: 'settings.models.submission',
        commandId: 'list-enable',
        storeId: 'store',
        scope: 'user',
        observationId: 7,
        operation: { kind: 'enabled', modelId: 'route-059', enabled: true },
        phase: 'applied',
      }),
    );
    expect(f.toggle('route-059') === row).toBe(true);
    expect(row.checked).toBe(true);
    expect(row.disabled).toBe(false);
    expect(f.dom.window.document.activeElement === row).toBe(true);
    expect(f.element.querySelector('.connection-models-viewport') === viewport).toBe(true);
    expect(viewport.scrollTop).toBe(180);
    expect(f.saved).toBe(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(2);
    await act(async () => trigger.click());
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(0);
    await act(async () => trigger.click());
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(60);
    expect(f.toggle('route-059').checked).toBe(true);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('default model search supports provider and ID matching without menu typeahead and preserves arrow and Escape navigation', async () => {
  const f = fixture(async (input) =>
    input.method === 'settings.models.read' ? structuredClone(facts) : null,
  );
  try {
    await f.render();
    await f.openMenu();
    const search = f.element.querySelector<HTMLInputElement>('[aria-label="搜索默认模型"]')!;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(f.dom.window.document.activeElement === search).toBe(true);
    await act(async () => {
      search.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'd', bubbles: true }));
      setField(f, '搜索默认模型', 'deepseek');
    });
    expect(f.dom.window.document.activeElement === search).toBe(true);
    expect(f.menuItem('a')).toBeNull();
    expect(f.menuItem('b')).not.toBeNull();
    expect(f.menuItem('c')).toBeNull();
    await act(async () =>
      search.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.dom.window.document.activeElement === f.menuItem('b')).toBe(true);
    await act(async () =>
      f.menuItem('b')!.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'ArrowUp',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.dom.window.document.activeElement === search).toBe(true);
    const viewport = f.element.querySelector<HTMLDivElement>('.settings-model-menu-viewport')!;
    viewport.scrollTop = 80;
    await act(async () => setField(f, '搜索默认模型', 'no-match'));
    expect(viewport.scrollTop).toBe(0);
    expect(f.element.textContent).toContain('没有匹配的可用模型');
    expect(f.element.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
    await act(async () => setField(f, '搜索默认模型', 'b'));
    expect(f.menuItem('b')).not.toBeNull();
    expect(
      f.element.querySelector('.settings-model-menu-viewport')?.classList.contains('scroll-fade-y'),
    ).toBe(true);
    await act(async () =>
      search.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.element.querySelector('[aria-label="搜索默认模型"]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(f.dom.window.document.activeElement === f.button('默认模型')).toBe(true);
    await f.openMenu();
    expect(f.menuItem('a')).not.toBeNull();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('connection summary waits for first facts and refresh retains the complete list and model viewport', async () => {
  const initial = deferred<NativeModelSettingsFacts>();
  const refreshing = deferred<NativeModelSettingsFacts>();
  let reads = 0;
  const f = fixture(
    async (input) =>
      input.method === 'settings.models.read'
        ? ++reads === 1
          ? initial.promise
          : refreshing.promise
        : null,
    ['a', 'b', 'c', 'broken'],
    true,
  );
  try {
    await f.render(selected('old'));
    const trigger = f.button('管理 服务一 的模型');
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain('正在读取模型…');
    expect(trigger.textContent).not.toContain('0 个模型');
    await act(async () => initial.resolve(structuredClone(facts)));
    expect(trigger.disabled).toBe(false);
    expect(trigger.textContent).toContain('4 个模型 · 已启用 3 个');
    await act(async () => trigger.click());
    const viewport = f.element.querySelector<HTMLDivElement>('.connection-models-viewport')!;
    viewport.scrollTop = 180;
    await f.render(selected('old'), [], { revision: 1 });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.disabled).toBe(false);
    expect(f.element.querySelector('.connection-models-viewport') === viewport).toBe(true);
    expect(viewport.scrollTop).toBe(180);
    await act(async () => refreshing.resolve({ ...facts, observationId: 8 }));
    expect(viewport.scrollTop).toBe(180);
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(4);
    expect(f.element.querySelector('.connection-models-toolbar')).toBeNull();
    expect(trigger.textContent).toContain('4 个模型 · 已启用 3 个');
    expect(reads).toBe(2);
    expect(f.calls.every((input) => input.method === 'settings.models.read')).toBe(true);
  } finally {
    await f.close();
  }
});

test('connection manager portals inside its settings dialog, closes only itself on Escape and keeps unknown tools read-only without another mutation', async () => {
  const f = fixture(
    async (input) => {
      if (input.method === 'settings.models.read') return structuredClone(facts);
      if (input.method === 'settings.models.enabled')
        return {
          kind: 'settings.models.submission',
          commandId: 'popover-unknown',
          storeId: 'store',
          scope: 'user',
          observationId: 7,
          operation: { kind: 'enabled', modelId: 'b', enabled: false },
          phase: 'unknown',
        };
      return null;
    },
    ['a', 'b', 'c', 'broken'],
    'dialog',
  );
  try {
    await f.render();
    const trigger = f.button('管理 服务一 的模型');
    const settings = f.element.querySelector('.desktop-settings')!;
    await act(async () => trigger.click());
    const popup = f.element.querySelector('[aria-label="服务一 的模型管理"]')!;
    expect(popup.getAttribute('role')).toBe('dialog');
    expect(popup.closest('.desktop-settings') === settings).toBe(true);
    expect(popup.closest('.fixture-provider-card')).toBeNull();
    expect(popup.closest('.connection-models')).toBeNull();
    expect(popup.parentElement === f.element).toBe(false);
    const viewport = f.element.querySelector<HTMLDivElement>('[aria-label="服务一 的模型列表"]')!;
    expect(f.dom.window.document.activeElement === viewport).toBe(true);
    expect(
      popup.querySelector('input[type="search"], select, .connection-models-toolbar'),
    ).toBeNull();
    await act(async () =>
      viewport.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(f.element.querySelector('[aria-label="服务一 的模型管理"]')).toBeNull();
    expect(f.element.querySelector('.desktop-settings') === settings).toBe(true);
    expect(f.dom.window.document.activeElement === trigger).toBe(true);
    expect(f.calls).toHaveLength(1);
    await act(async () => trigger.click());
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(4);
    await act(async () => f.toggle('b').click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(f.element.querySelector('[aria-label="服务一 的模型管理"]')).not.toBeNull();
    expect(f.toggle('b').disabled).toBe(true);
    expect(f.element.textContent).toContain('模型禁用更改结果待确认');
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    expect(f.toggle('b').disabled).toBe(true);
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(4);
    expect(f.element.querySelectorAll('[role="switch"]:disabled')).toHaveLength(4);
    expect(
      f.element.querySelector(
        '[aria-label="服务一 的模型管理"] input[type="search"], [aria-label="服务一 的模型管理"] select',
      ),
    ).toBeNull();
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 7,
        modelId: 'b',
        enabled: false,
      },
    ]);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('pointer dismissal of model popover leaves the outside settings control focused and never saves', async () => {
  const f = fixture(
    async (input) => (input.method === 'settings.models.read' ? structuredClone(facts) : null),
    ['a', 'b'],
    'dialog',
  );
  try {
    await f.render();
    await act(async () => f.button('管理 服务一 的模型').click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const outside = f.button('外部设置按钮');
    await act(async () => {
      outside.dispatchEvent(
        new f.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      outside.focus();
      outside.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(f.element.querySelector('[aria-label="服务一 的模型管理"]')).toBeNull();
    expect(f.element.querySelector('.desktop-settings')).not.toBeNull();
    expect(f.dom.window.document.activeElement === outside).toBe(true);
    expect(f.calls).toEqual([{ method: 'settings.models.read', generation: 1, scope: 'user' }]);
  } finally {
    await f.close();
  }
});

test('the default model can be disabled and re-enabled, including an all-disabled list, without an implicit default change', async () => {
  let current = structuredClone(facts);
  let count = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(current);
    if (input.method === 'settings.models.enabled') {
      current = {
        ...current,
        observationId: current.observationId + 1,
        models: current.models.map((model) =>
          model.id === input.modelId ? { ...model, enabled: input.enabled } : model,
        ),
      };
      return {
        kind: 'settings.models.submission',
        commandId: `enable-only-${++count}`,
        storeId: 'store',
        scope: 'user',
        observationId: input.observationId,
        operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
        phase: 'applied',
      };
    }
    return null;
  });
  try {
    await f.render();
    const defaultRow = f.toggle('a');
    expect(defaultRow.disabled).toBe(false);
    expect(defaultRow.closest('label')?.getAttribute('title') ?? '').not.toContain('不可禁用');
    await act(async () => defaultRow.click());
    expect(defaultRow.checked).toBe(false);
    expect(defaultRow.disabled).toBe(false);
    expect(current.defaultModelId).toBe('a');
    expect(f.button('默认模型').textContent).toContain('a · 当前不可用');
    await act(async () => f.toggle('b').click());
    await act(async () => f.toggle('broken').click());
    expect(current.models.every((model) => !model.enabled)).toBe(true);
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(4);
    expect(f.element.querySelectorAll('[role="switch"]:checked')).toHaveLength(0);
    expect(current.defaultModelId).toBe('a');
    expect(defaultRow.disabled).toBe(false);
    await act(async () => defaultRow.click());
    expect(f.toggle('a')).toBe(defaultRow);
    expect(defaultRow.checked).toBe(true);
    expect(current.defaultModelId).toBe('a');
    expect(f.calls.filter((input) => input.method === 'settings.models.default')).toHaveLength(0);
    expect(
      f.calls
        .filter((input) => input.method === 'settings.models.enabled')
        .map((input) => ({ modelId: input.modelId, enabled: input.enabled })),
    ).toEqual([
      { modelId: 'a', enabled: false },
      { modelId: 'b', enabled: false },
      { modelId: 'broken', enabled: false },
      { modelId: 'a', enabled: true },
    ]);
    expect(f.saved).toBe(4);
  } finally {
    await f.close();
  }
});

test('an unknown default-disable keeps its original intent, discards the queued tail and recovers only by original lookup', async () => {
  jest.useFakeTimers();
  let current = structuredClone(facts);
  const pending = deferred<NativeModelSettingsSubmission>();
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'unknown-default-disable',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'enabled', modelId: 'a', enabled: false },
    phase: 'unknown',
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.models.read') return structuredClone(current);
    if (input.method === 'settings.models.enabled') return pending.promise;
    if (input.method === 'settings.models.lookup') {
      current = {
        ...current,
        observationId: 8,
        models: current.models.map((model) =>
          model.id === 'a' ? { ...model, enabled: false } : model,
        ),
      };
      return { ...original, phase: 'applied' };
    }
    return null;
  });
  try {
    await f.render();
    await act(async () => {
      f.toggle('a').click();
      f.toggle('b').click();
    });
    expect(f.toggle('a').checked).toBe(false);
    expect(f.toggle('b').checked).toBe(false);
    await act(async () => pending.resolve(original));
    expect(f.toggle('a').disabled).toBe(true);
    expect(f.toggle('a').checked).toBe(false);
    expect(f.toggle('b').checked).toBe(true);
    await act(async () => f.toggle('a').click());
    await advanceRecovery(250);
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: original.commandId },
    ]);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 7,
        modelId: 'a',
        enabled: false,
      },
    ]);
    expect(f.calls.filter((input) => input.method === 'settings.models.default')).toHaveLength(0);
    expect(f.toggle('a').disabled).toBe(false);
    expect(f.toggle('a').checked).toBe(false);
    expect(f.toggle('b').checked).toBe(true);
    expect(current.defaultModelId).toBe('a');
    expect(f.saved).toBe(1);
  } finally {
    jest.useRealTimers();
    await f.close();
  }
});
