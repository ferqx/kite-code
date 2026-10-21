import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeModelSettingsSubmission,
  NativeRequest,
  NativeSelection,
} from '../../src/native-bridge';
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
const { NativeModelSettings } = await import('../../src/native-model-settings');
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
function fixture(request: NativeBridge['request']) {
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
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
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
    render: (selection?: NativeSelection, submissions: NativeModelSettingsSubmission[] = []) =>
      act(async () =>
        root.render(
          <NativeModelSettings
            bridge={bridge}
            generation={1}
            selection={selection}
            submissions={submissions}
            onSaved={() => saved++}
          />,
        ),
      ),
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
    async close() {
      await act(async () => root.unmount());
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
    expect(f.element.textContent).toContain('正在读取原作用域配置');
    expect(f.button('默认模型').disabled).toBe(true);
    await act(async () => read.resolve(structuredClone(facts)));
    expect(f.element.querySelector('.settings-models .model-list')).not.toBeNull();
    expect(f.element.querySelectorAll('.settings-model-provider')).toHaveLength(2);
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(4);
    expect(f.button('默认模型').textContent).toContain('openai · remote-a');
    expect(f.element.querySelectorAll('.settings-model-default-badge')).toHaveLength(1);
    expect(f.toggle('a').disabled).toBe(true);
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
      f.toggle('c').click();
    });
    expect(f.toggle('c').checked).toBe(true);
    expect(f.toggle('c').disabled).toBe(true);
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
    expect(f.toggle('a').disabled).toBe(true);
    await act(async () => savedRefresh.resolve(structuredClone(current)));
    expect(f.button('默认模型').disabled).toBe(false);
    expect(f.button('刷新配置').disabled).toBe(false);
    expect(f.toggle('c').disabled).toBe(true);
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
    expect(f.saved).toBe(0);
    expect(f.element.textContent).toContain('原提交 original');
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
    expect(f.element.textContent).toContain('未决提交先查询原结果');
    await act(async () => f.button('查询原提交').click());
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: 'original' },
    ]);
    expect(f.saved).toBe(1);
    expect(reads).toBe(3);
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
    expect(f.element.textContent).toContain('尚无模型配置，请前往“提供商”连接');
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
      if (++reads === 2) throw Error('network_unavailable');
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
    expect(f.element.textContent).toContain('已保存模型配置，刷新失败');
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
