import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeRequest,
  NativeSelection,
} from '../../src/native-bridge';
import type { NativeModelChoice } from '../../src/native-model-picker';
import { prepareDesktopDom } from '../native-page-dom.fixture';

// Radix selects its layout effect at module load. Install a browser before loading the widget.
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
const { NativeModelPicker, nativeModelScope } = await import('../../src/native-model-picker');
Object.assign(globalThis, priorBootstrap);
bootstrap.window.close();

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    }),
    prior = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
    };
  const restoreLayout = prepareDesktopDom(dom);
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
    value: () => null,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: () => {} });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const element = dom.window.document.body,
    root = createRoot(dom.window.document.getElementById('root')!);
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (entry) => entry.textContent === name || entry.getAttribute('aria-label') === name,
    )!;
  return {
    dom,
    element,
    root,
    button,
    click: async (name: string) =>
      act(async () => {
        const target =
          button(name) ??
          [...element.querySelectorAll<HTMLElement>('[role="tab"], [role="option"]')].find(
            (entry) => entry.textContent === name || entry.getAttribute('aria-label') === name,
          )!;
        expect(target).toBeDefined();
        if (target.getAttribute('role') === 'tab')
          target.dispatchEvent(
            new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }),
          );
        else target.click();
      }),
    async close() {
      await act(async () => root.unmount());
      // FocusScope schedules its unmount event on the next timer turn, before browser globals restore.
      await new Promise((resolve) => setTimeout(resolve, 0));
      restoreLayout();
      Object.assign(globalThis, prior);
      dom.window.close();
    },
  };
}
const facts: NativeModelSettingsFacts = {
  kind: 'settings.models',
  observationId: 1,
  storeId: 'store',
  scope: 'user',
  canWrite: true,
  errors: [],
  defaultModelId: 'a',
  models: [
    {
      id: 'a',
      provider: 'openai',
      model: 'remote-a',
      enabled: true,
      configured: true,
      reasoningEffort: 'low',
      reasoningEffortChoices: ['low', 'medium', 'high', 'xhigh', 'max', 'ultar'],
      diagnostics: [],
    },
    {
      id: 'b',
      provider: 'deepseek',
      model: 'remote-b',
      enabled: true,
      configured: true,
      reasoningEffortChoices: ['low', 'medium', 'high', 'xhigh', 'max', 'ultar'],
      diagnostics: [],
    },
    {
      id: 'disabled',
      provider: 'openai',
      model: 'disabled',
      enabled: false,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'broken',
      provider: 'ollama',
      model: 'broken',
      enabled: true,
      configured: false,
      diagnostics: [],
    },
  ],
};
const selected = (id: string, viewSelection = 1) =>
  ({ storeId: 'store', session: { id }, viewSelection }) as NativeSelection;

test('picker filters disabled routes, preserves transient effort through observer rerenders, and model change clears it', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [],
    ready: boolean[] = [],
    changes: NativeModelChoice[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      return facts;
    },
  };
  const resolved: (NativeModelChoice | undefined)[] = [];
  let observed: NativeModelChoice = {};
  function Host({ revision }: { revision?: string }) {
    const [value, setValue] = useState<NativeModelChoice>({});
    observed = value;
    return (
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={selected('s')}
        revision={revision}
        value={value}
        onChange={(choice) => {
          changes.push(choice);
          setValue(choice);
        }}
        onReady={(value, choice) => {
          ready.push(value);
          resolved.push(choice);
        }}
      />
    );
  }
  try {
    await act(async () => f.root.render(<Host />));
    expect(ready.at(-1)).toBe(true);
    expect(changes).toHaveLength(0);
    expect(resolved.at(-1)).toEqual({ modelId: 'a' });
    await f.click('模型：remote-a，思考程度：轻度');
    const effort = f.element.querySelector<HTMLElement>('[role="slider"]')!;
    expect(effort.getAttribute('aria-valuemin')).toBe('0');
    expect(effort.getAttribute('aria-valuemax')).toBe('5');
    expect(f.button('配置默认')).toBeUndefined();
    expect(f.button('关闭思考')).toBeUndefined();
    await act(async () => {
      effort.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    await act(async () => {
      effort.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(observed).toEqual({ modelId: 'a', reasoningEffort: 'high' });
    expect(resolved.at(-1)).toEqual({ modelId: 'a', reasoningEffort: 'high' });
    await act(async () => f.root.render(<Host />));
    expect(observed.reasoningEffort).toBe('high');
    expect(calls).toHaveLength(1);
    await f.click('选择模型，当前 openai / remote-a');
    expect(f.element.querySelector('[aria-label="选择模型 disabled"]')).toBeNull();
    expect(f.element.querySelector('[aria-label="选择模型 broken"]')).toBeNull();
    expect(f.element.querySelectorAll('[data-provider-scroll]').length).toBe(1);
    expect(f.element.querySelectorAll('[data-model-scroll]')).toHaveLength(1);
    await f.click('deepseek');
    await f.click('选择模型 b');
    expect(observed).toEqual({ modelId: 'b' });
    expect(resolved.at(-1)).toEqual({ modelId: 'b' });
    const deepseekEffort = f.element.querySelector<HTMLElement>('[role="slider"]')!;
    expect(deepseekEffort).not.toBeNull();
    expect(f.button('关闭思考')).toBeUndefined();
    await act(async () => {
      deepseekEffort.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(observed).toEqual({ modelId: 'b', reasoningEffort: 'ultar' });
    expect(resolved.at(-1)).toEqual({ modelId: 'b', reasoningEffort: 'ultar' });
    expect(ready.at(-1)).toBe(true);
  } finally {
    await f.close();
  }
});

test('ordinary pending catalogue reads keep a compact busy control and genuine failures remain visible', async () => {
  const f = fixture(),
    ready: boolean[] = [];
  let rejectRead!: (cause: Error) => void;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeModelPicker
          bridge={bridge}
          generation={1}
          preparing={{ storeId: 'store' }}
          value={{}}
          onChange={() => {
            throw Error('unexpected_model_change');
          }}
          onReady={(value) => ready.push(value)}
        />,
      ),
    );
    const picker = f.element.querySelector('[aria-label="下一轮模型选择"]')!;
    expect(picker.getAttribute('aria-busy')).toBe('true');
    expect(picker.querySelector('[role="status"]')).toBeNull();
    expect(picker.querySelector<HTMLButtonElement>('[data-model-trigger]')!.disabled).toBe(true);
    expect(ready.at(-1)).toBe(false);
    await act(async () => rejectRead(Error('model_catalogue_unavailable')));
    expect(picker.hasAttribute('aria-busy')).toBe(false);
    expect(picker.querySelector('[role="alert"]')?.textContent).toContain('模型目录不可用');
    expect(ready.at(-1)).toBe(false);
  } finally {
    await f.close();
  }
});

test('returning to a cached Session retains its model button while rereading, and late catalogues cannot replace the next Session', async () => {
  const f = fixture(),
    ready: boolean[] = [],
    changes: NativeModelChoice[] = [];
  let id = 'a',
    hold = false,
    release: (() => void) | undefined;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async () => {
      const original = id;
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { ...facts, selectedModelId: original };
    },
  };
  const render = (target: string, view: number, generation = 1) => {
    id = target;
    return act(async () =>
      f.root.render(
        <NativeModelPicker
          bridge={bridge}
          generation={generation}
          selection={selected(target, view)}
          value={{}}
          onChange={(value) => changes.push(value)}
          onReady={(value) => ready.push(value)}
        />,
      ),
    );
  };
  try {
    await render('a', 1);
    const button = f.element.querySelector('[data-model-trigger]');
    await render('b', 2);
    expect(f.element.querySelector('[data-model-trigger]')).toBe(button);
    expect(button?.textContent).toContain('remote-b');
    hold = true;
    await render('a', 3);
    expect(f.element.querySelector('[data-model-trigger]')).toBe(button);
    expect(button?.textContent).toContain('remote-a');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(ready.at(-1)).toBe(false);
    await render('b', 4);
    expect(button?.textContent).toContain('remote-b');
    await act(async () => release!());
    expect(button?.textContent).toContain('remote-b');
    expect(ready.at(-1)).toBe(true);
    hold = true;
    await render('a', 5, 2);
    expect(button?.textContent).toBe('选择模型');
    expect(ready.at(-1)).toBe(false);
    await act(async () => release!());
    expect(button?.textContent).toContain('remote-a');
    expect(changes).toEqual([]);
  } finally {
    await f.close();
  }
});

test('explicit missing selection after configuration refresh stays unavailable without switching to default', async () => {
  const f = fixture(),
    ready: boolean[] = [],
    changes: NativeModelChoice[] = [];
  let reads = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async () => {
      return ++reads === 1
        ? facts
        : {
            ...facts,
            models: facts.models.map((model) =>
              model.id === 'a' ? { ...model, enabled: false } : model,
            ),
            defaultModelId: 'b',
          };
    },
  };
  const render = (revision: string) =>
    f.root.render(
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={selected('s')}
        revision={revision}
        value={{ modelId: 'a', reasoningEffort: 'high' }}
        onChange={(choice) => changes.push(choice)}
        onReady={(value) => ready.push(value)}
      />,
    );
  try {
    await act(async () => render('one'));
    expect(ready.at(-1)).toBe(true);
    await act(async () => render('two'));
    expect(ready.at(-1)).toBe(false);
    expect(f.element.textContent).toContain('所选模型 a 当前不可用');
    expect(f.element.textContent).not.toContain('模型：remote-b');
    expect(changes).toHaveLength(0);
    expect(reads).toBe(2);
  } finally {
    await f.close();
  }
});

test('picker rejects late scope facts and preserves configured none without extra actions', async () => {
  const f = fixture(),
    ready: boolean[] = [],
    changes: NativeModelChoice[] = [];
  let release!: (value: NativeModelSettingsFacts) => void,
    reads = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async () => {
      if (++reads === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      return {
        ...facts,
        models: [
          {
            ...facts.models[0]!,
            model: 'current',
            reasoningEffort: 'none',
            reasoningEffortChoices: ['none', 'low'],
          },
        ],
      };
    },
  };
  const render = (id: string) =>
    f.root.render(
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={selected(id, id === 'old' ? 1 : 2)}
        value={{}}
        onChange={(choice) => changes.push(choice)}
        onReady={(value) => ready.push(value)}
      />,
    );
  try {
    await act(async () => render('old'));
    expect(ready.at(-1)).toBe(false);
    await act(async () => render('new'));
    expect(ready.at(-1)).toBe(true);
    await act(async () =>
      release({ ...facts, models: [{ ...facts.models[0]!, model: 'old-route' }] }),
    );
    expect(f.element.textContent).toContain('current');
    expect(f.element.textContent).not.toContain('old-route');
    await f.click('模型：current，思考程度：关闭');
    expect(f.element.querySelector('[role="slider"]')).toBeNull();
    expect(f.button('轻度')).toBeDefined();
    expect(f.button('配置默认')).toBeUndefined();
    expect(f.button('关闭思考')).toBeUndefined();
    expect(changes).toEqual([]);
    await f.click('轻度');
    expect(changes).toEqual([{ modelId: 'a', reasoningEffort: 'low' }]);
  } finally {
    await f.close();
  }
});

test('picker honors durable Session route before global default and does not replace a missing durable route', async () => {
  const f = fixture(),
    ready: boolean[] = [];
  let reads = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async () =>
      ++reads === 1 ? { ...facts, selectedModelId: 'b' } : { ...facts, selectedModelId: 'missing' },
  };
  const render = (revision: string) =>
    f.root.render(
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={selected('s')}
        revision={revision}
        value={{}}
        onChange={() => {
          throw Error('unexpected_default_change');
        }}
        onReady={(value) => ready.push(value)}
      />,
    );
  try {
    await act(async () => render('one'));
    expect(f.element.querySelector('[data-model-trigger]')?.textContent).toContain('remote-b');
    expect(ready.at(-1)).toBe(true);
    await act(async () => render('two'));
    expect(f.element.textContent).toContain('所选模型 missing 当前不可用');
    expect(ready.at(-1)).toBe(false);
  } finally {
    await f.close();
  }
});

test('same-provider duplicate names retain exact route IDs; sparse effort changes stay transient and model changes clear them', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  const routes: NativeModelSettingsFacts = {
    ...facts,
    selectedModelId: 'second',
    models: ['first', 'second'].map((id) => ({
      ...facts.models[0]!,
      id,
      model: 'same-name',
      reasoningEffort: 'high',
      reasoningEffortChoices: ['none', 'low', 'high', 'ultar'],
    })),
  };
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      calls.push(request);
      return routes;
    },
  };
  let observed: NativeModelChoice = {},
    resolved: NativeModelChoice | undefined;
  function Host() {
    const [value, setValue] = useState<NativeModelChoice>({});
    observed = value;
    return (
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={selected('s')}
        value={value}
        onChange={setValue}
        onReady={(_ready, choice) => {
          resolved = choice;
        }}
      />
    );
  }
  try {
    await act(async () => f.root.render(<Host />));
    expect(resolved).toEqual({ modelId: 'second' });
    await f.click('模型：same-name，思考程度：高');
    await f.click('选择模型，当前 openai / same-name');
    const entries = [...f.element.querySelectorAll('[role="option"]')];
    expect(entries.map((entry) => entry.textContent)).toEqual([
      'same-name · first',
      'same-name · second',
    ]);
    expect(entries[0]!.querySelector('[aria-label="当前模型"]')).toBeNull();
    expect(entries[1]!.querySelector('[aria-label="当前模型"]')).not.toBeNull();
    await f.click('选择模型 first');
    expect(observed).toEqual({ modelId: 'first' });
    expect(resolved).toEqual({ modelId: 'first' });
    const slider = f.element.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.getAttribute('aria-valuemax')).toBe('2');
    const key = async (key: string) =>
      act(async () => {
        slider.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
      });
    await key('Home');
    expect(observed).toEqual({ modelId: 'first', reasoningEffort: 'low' });
    await key('ArrowRight');
    expect(observed.reasoningEffort).toBe('high');
    await key('ArrowRight');
    expect(observed.reasoningEffort).toBe('ultar');
    expect(f.element.querySelector('.effort-value')?.textContent).toBe('Ultar');
    expect(f.button('关闭思考')).toBeUndefined();
    expect(f.button('配置默认')).toBeUndefined();
    await f.click('选择模型，当前 openai / same-name');
    await f.click('选择模型 second');
    expect(observed).toEqual({ modelId: 'second' });
    expect(resolved).toEqual({ modelId: 'second' });
    expect(f.element.querySelector('.effort-value')?.textContent).toBe('高');
    expect(calls).toEqual([{ method: 'input.models.read', generation: 1 }]);
  } finally {
    await f.close();
  }
});

test('prepared scopes paint their final route immediately and publish readiness even when the route is unchanged, without duplicate reads', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [],
    ready: unknown[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      calls.push(request);
      return null;
    },
  };
  const render = (id: string, view: number) =>
    act(async () => {
      const selection = selected(id, view),
        scope = nativeModelScope(1, selection, undefined, 'settings');
      f.root.render(
        <NativeModelPicker
          bridge={bridge}
          generation={1}
          selection={selection}
          revision="settings"
          value={{}}
          prepared={{ key: scope.readKey, facts, error: '' }}
          onChange={() => {
            throw Error('unexpected choice');
          }}
          onReady={(value, choice) => ready.push([id, value, choice?.modelId])}
        />,
      );
    });
  try {
    await render('a', 1);
    const button = f.element.querySelector('[data-model-trigger]');
    await render('b', 2);
    expect(f.element.querySelector('[data-model-trigger]')).toBe(button);
    expect(button?.textContent).toBe('remote-a轻度');
    expect(ready).toEqual([
      ['a', true, 'a'],
      ['b', true, 'a'],
    ]);
    expect(calls).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a prepared catalogue from another Store cannot qualify the current picker', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [],
    ready: boolean[] = [];
  const selection = selected('current'),
    scope = nativeModelScope(1, selection);
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      calls.push(request);
      return { ...facts, selectedModelId: 'b' };
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeModelPicker
          bridge={bridge}
          generation={1}
          selection={selection}
          value={{}}
          prepared={{ key: scope.readKey, facts: { ...facts, storeId: 'foreign' }, error: '' }}
          onChange={() => {
            throw Error('unexpected choice');
          }}
          onReady={(value) => ready.push(value)}
        />,
      ),
    );
    expect(f.element.querySelector('[data-model-trigger]')?.textContent).toBe('remote-b未指定');
    expect(calls).toEqual([{ method: 'input.models.read', generation: 1 }]);
    expect(ready[0]).toBe(false);
    expect(ready.at(-1)).toBe(true);
  } finally {
    await f.close();
  }
});

function previousRun(
  effort: unknown,
  overrides: Partial<NativeSelection['runs'][number]> = {},
): NativeSelection['runs'][number] {
  return {
    id: 'last-run',
    sessionId: 's',
    originStoreId: 'store',
    originCommandId: 'last-command',
    status: 'completed',
    isActive: false,
    createdAt: 20,
    finishedAt: 21,
    reason: null,
    configuration: {
      modelId: 'a',
      snapshot: {
        version: 1,
        digest: 'f'.repeat(64),
        configuration: {
          models: [
            {
              id: 'a',
              provider: 'compatible',
              model: 'remote-a',
              options: effort === undefined ? {} : { reasoningEffort: effort },
            },
          ],
        },
      },
    },
    ...overrides,
  } as NativeSelection['runs'][number];
}

for (const source of [
  { protocol: 'chat-completions', provider: 'compatible', expected: 'Chat Completions' },
  { protocol: 'responses', provider: 'openai', expected: 'Responses' },
  { protocol: undefined, provider: 'codex', expected: 'Responses' },
] as const)
  test(`the first actual Run limits only protocol family while same-family model and effort remain selectable (${source.expected}/${source.provider})`, async () => {
    const f = fixture();
    const family = source.expected === 'Responses' ? 'responses' : 'chat-completions';
    const opposite = family === 'responses' ? 'chat-completions' : 'responses';
    const catalogue: NativeModelSettingsFacts = {
      ...facts,
      defaultModelId: 'first',
      selectedModelId: 'first',
      models: [
        {
          ...facts.models[0]!,
          id: 'first',
          provider: source.provider,
          model: 'first-model',
          protocol: family,
        },
        {
          ...facts.models[0]!,
          id: 'same',
          provider: source.provider,
          model: 'same-family-model',
          protocol: family,
        },
        { ...facts.models[0]!, id: 'opposite', model: 'opposite-family-model', protocol: opposite },
      ],
    };
    const first = previousRun('high', {
      id: 'first-actual-run',
      originStoreId: source.provider === 'codex' ? 'restored-origin-store' : 'store',
      status: source.provider === 'codex' ? 'cancelled' : 'completed',
      configuration: {
        modelId: 'first',
        snapshot: {
          version: 1,
          digest: 'a'.repeat(64),
          configuration: {
            models: [
              {
                id: 'first',
                provider: source.provider,
                model: 'first-model',
                ...(source.protocol ? { protocol: source.protocol } : {}),
              },
            ],
          },
        },
      },
    });
    const later = previousRun('low', {
      id: 'later-different-protocol',
      createdAt: 30,
      configuration: {
        modelId: 'opposite',
        snapshot: {
          version: 1,
          digest: 'b'.repeat(64),
          configuration: {
            models: [
              {
                id: 'opposite',
                provider: 'compatible',
                model: 'opposite-family-model',
                protocol: opposite,
              },
            ],
          },
        },
      },
    });
    if (source.provider === 'codex')
      first.configuration = {
        modelId: 'first',
        snapshot: {
          kind: 'human_input_processing',
          originalConfiguration: (first.configuration as { snapshot: never }).snapshot,
        },
      };
    const original = structuredClone(first);
    const calls: NativeRequest[] = [];
    const bridge: NativeBridge = {
      watch: () => () => {},
      request: async (request) => {
        calls.push(request);
        return catalogue;
      },
    };
    let observed: NativeModelChoice = {},
      resolved: NativeModelChoice | undefined;
    function Host() {
      const [value, setValue] = useState<NativeModelChoice>({});
      observed = value;
      return (
        <NativeModelPicker
          bridge={bridge}
          generation={1}
          selection={{ ...selected('s'), runs: [first, later] }}
          value={value}
          onChange={setValue}
          onReady={(_ready, choice) => {
            resolved = choice;
          }}
        />
      );
    }
    try {
      await act(async () => f.root.render(<Host />));
      expect(resolved).toEqual({ modelId: 'first' });
      await f.click('模型：first-model，思考程度：轻度');
      expect(f.element.querySelector('.model-selection-hint')).toBeNull();
      expect(f.element.textContent).not.toContain('切换协议请新建会话');
      await f.click(`选择模型，当前 ${source.provider} / first-model`);
      expect(f.element.querySelector('.model-selection-hint')?.textContent).toBe(
        '仅显示当前对话可用的模型',
      );
      expect(f.element.querySelector('[aria-label="选择模型 opposite"]')).toBeNull();
      expect(f.element.querySelector('[aria-label="选择模型 same"]')).not.toBeNull();
      await f.click('选择模型 same');
      expect(resolved).toEqual({ modelId: 'same' });
      const slider = f.element.querySelector<HTMLElement>('[role="slider"]')!;
      await act(async () =>
        slider.dispatchEvent(
          new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        ),
      );
      expect(observed).toEqual({ modelId: 'same', reasoningEffort: 'medium' });
      expect(resolved).toEqual(observed);
      expect(f.element.querySelector('.model-effort-summary')?.textContent).toBe('中');
      expect(first).toEqual(original);
      expect(calls).toEqual([{ method: 'input.models.read', generation: 1 }]);
    } finally {
      await f.close();
    }
  });

test('an admitted input without an actual Run does not limit protocol choice, including new-conversation preparation', async () => {
  const f = fixture();
  const catalogue: NativeModelSettingsFacts = {
    ...facts,
    selectedModelId: 'a',
    models: [
      { ...facts.models[0]!, protocol: 'chat-completions' },
      { ...facts.models[1]!, provider: 'compatible', protocol: 'responses' },
    ],
  };
  const bridge: NativeBridge = { watch: () => () => {}, request: async () => catalogue };
  const render = (preparing = false) =>
    act(async () =>
      f.root.render(
        <NativeModelPicker
          bridge={bridge}
          generation={1}
          selection={{ ...selected('s', preparing ? 2 : 1), runs: [] }}
          preparing={preparing ? { storeId: 'store' } : undefined}
          value={{}}
          onChange={() => {}}
          onReady={() => {}}
        />,
      ),
    );
  try {
    for (const preparing of [false, true]) {
      await render(preparing);
      expect(f.element.textContent).not.toContain('切换协议请新建会话');
      await f.click('模型：remote-a，思考程度：轻度');
      await f.click('选择模型，当前 openai / remote-a');
      await f.click('compatible');
      expect(f.element.querySelector('[aria-label="选择模型 b"]')).not.toBeNull();
      await f.click('模型：remote-a，思考程度：轻度');
    }
  } finally {
    await f.close();
  }
});

test('an existing selected route of the other protocol stays unavailable without using the global default', async () => {
  const f = fixture();
  const catalogue: NativeModelSettingsFacts = {
    ...facts,
    selectedModelId: 'b',
    defaultModelId: 'a',
    models: [
      { ...facts.models[0]!, protocol: 'chat-completions' },
      { ...facts.models[1]!, provider: 'compatible', protocol: 'responses' },
    ],
  };
  const bridge: NativeBridge = { watch: () => () => {}, request: async () => catalogue };
  let ready = true,
    resolved: NativeModelChoice | undefined;
  function Host() {
    const [value, setValue] = useState<NativeModelChoice>({});
    return (
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={{ ...selected('s'), runs: [previousRun('low')] }}
        value={value}
        onChange={setValue}
        onReady={(available, choice) => {
          ready = available;
          resolved = choice;
        }}
      />
    );
  }
  try {
    await act(async () => f.root.render(<Host />));
    expect(ready).toBe(false);
    expect(resolved).toBeUndefined();
    expect(f.element.textContent).toContain('所选模型 b 当前不可用');
    await f.click('模型：选择模型');
    await f.click('选择模型，当前 未选择');
    expect(f.element.querySelector('[aria-label="选择模型 b"]')).toBeNull();
    await f.click('选择模型 a');
    expect(ready).toBe(true);
    expect(resolved).toEqual({ modelId: 'a', reasoningEffort: 'low' });
  } finally {
    await f.close();
  }
});

test('an unverified first Run blocks sending and does not infer its protocol from a later Run', async () => {
  const f = fixture();
  const bridge: NativeBridge = { watch: () => () => {}, request: async () => facts };
  const original = previousRun('high');
  const firstCases = [
    { ...original, configuration: undefined },
    { ...original, sessionId: 'another-session' },
    {
      ...original,
      configuration: {
        modelId: 'a',
        snapshot: {
          version: 1,
          digest: 'a'.repeat(64),
          configuration: { models: [{ id: 'a', protocol: 'responses' }] },
        },
      },
    },
    {
      ...original,
      configuration: {
        modelId: 'a',
        snapshot: {
          version: 2,
          digest: 'a',
          configuration: { models: [{ id: 'a', protocol: 'responses' }] },
        },
      },
    },
    {
      ...original,
      configuration: {
        modelId: 'a',
        snapshot: {
          version: 1,
          digest: 'a',
          configuration: {
            models: [
              { id: 'a', protocol: 'responses' },
              { id: 'a', protocol: 'responses' },
            ],
          },
        },
      },
    },
    {
      ...original,
      configuration: {
        modelId: 'a',
        snapshot: {
          version: 1,
          digest: 'a',
          configuration: { models: [{ id: 'a', protocol: 'unknown-protocol' }] },
        },
      },
    },
    {
      ...original,
      configuration: {
        modelId: 'a',
        snapshot: {
          version: 1,
          digest: 'a',
          configuration: { models: [{ id: 'a', provider: 'codex', protocol: 'chat-completions' }] },
        },
      },
    },
    {
      ...original,
      configuration: {
        modelId: 'a',
        snapshot: {
          version: 1,
          digest: 'a',
          configuration: { models: [{ id: 'a', provider: 'deepseek', protocol: 'responses' }] },
        },
      },
    },
  ];
  let ready = true,
    resolved: NativeModelChoice | undefined;
  try {
    for (const [index, first] of firstCases.entries()) {
      await act(async () =>
        f.root.render(
          <NativeModelPicker
            bridge={bridge}
            generation={1}
            selection={{
              ...selected('s', index + 1),
              runs: [first, previousRun('low', { id: 'later' })],
            }}
            value={{}}
            onChange={() => {
              throw Error('unverified_run_must_not_change_model');
            }}
            onReady={(available, choice) => {
              ready = available;
              resolved = choice;
            }}
          />,
        ),
      );
      expect(ready).toBe(false);
      expect(resolved).toBeUndefined();
      expect(f.element.querySelector('[data-model-trigger]')?.textContent).toContain('remote-a');
      expect(f.element.querySelector<HTMLButtonElement>('[data-model-trigger]')?.disabled).toBe(
        true,
      );
      expect(f.element.querySelector('[role="alert"]')?.textContent).toBe(
        '无法确认此会话首次运行的模型协议，暂时无法发送。',
      );
    }
  } finally {
    await f.close();
  }
});

test.each([
  false,
  true,
])('an unspecified effort stays out of the next input until the slider is moved (preparing: %s)', async (preparing) => {
  const f = fixture(),
    selection = { ...selected('s'), runs: [] },
    calls: NativeRequest[] = [],
    changes: NativeModelChoice[] = [];
  const catalogue: NativeModelSettingsFacts = {
    ...facts,
    models: facts.models.map((model) => ({ ...model, reasoningEffort: undefined })),
  };
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      calls.push(request);
      return catalogue;
    },
  };
  let resolved: NativeModelChoice | undefined;
  function Host() {
    const [value, setValue] = useState<NativeModelChoice>({});
    return (
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={selection}
        preparing={preparing ? { storeId: 'store' } : undefined}
        value={value}
        onChange={(choice) => {
          changes.push(choice);
          setValue(choice);
        }}
        onReady={(_ready, choice) => {
          resolved = choice;
        }}
      />
    );
  }
  try {
    const { nativeTextIntent } = await import('../../src/native-input');
    await act(async () => f.root.render(<Host />));
    expect(f.element.querySelector('.model-effort-summary')?.textContent).toBe('未指定');
    expect(resolved).toEqual({ modelId: 'a' });
    expect(
      nativeTextIntent(selection, 'before-drag', 'first input', false, resolved),
    ).not.toHaveProperty('reasoningEffort');
    expect(changes).toEqual([]);
    await f.click('模型：remote-a，思考程度：未指定');
    const label = () => f.element.querySelector('.effort-value')?.textContent,
      slider = f.element.querySelector<HTMLElement>('[role="slider"]')!,
      rail = f.element.querySelector<HTMLElement>('.gem-slider')!;
    expect(label()).toBe('未指定');
    expect(slider.getAttribute('aria-valuetext')).toBe('未指定');
    rail.getBoundingClientRect = () => new f.dom.window.DOMRect(0, 0, 120, 32);
    Object.assign(rail, {
      setPointerCapture() {},
      hasPointerCapture: () => true,
      releasePointerCapture() {},
    });
    const pointer = (type: string, clientX: number) => {
      const event = new f.dom.window.MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        clientY: 16,
      });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        pointerType: { value: 'mouse' },
      });
      rail.dispatchEvent(event);
    };
    await act(async () => pointer('pointerdown', 24));
    await act(async () => pointer('pointermove', 48));
    await act(async () => pointer('pointerup', 48));
    expect(changes.at(-1)).toEqual({ modelId: 'a', reasoningEffort: 'high' });
    expect(resolved).toEqual({ modelId: 'a', reasoningEffort: 'high' });
    expect(label()).toBe('高');
    expect(f.element.querySelector('.model-effort-summary')?.textContent).toBe('高');
    expect(slider.getAttribute('aria-valuetext')).toBe('高');
    expect(nativeTextIntent(selection, 'after-drag', 'next input', false, resolved)).toMatchObject({
      kind: 'run.start',
      modelId: 'a',
      reasoningEffort: 'high',
    });
    expect(calls).toEqual([
      {
        method: preparing ? 'conversation.models.read' : 'input.models.read',
        generation: 1,
      },
    ]);
  } finally {
    await f.close();
  }
});

test('the first paint restores the Session effort and hands the same value to the next input before any slider interaction', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [],
    changes: NativeModelChoice[] = [];
  const selection = {
    ...selected('s'),
    runs: [
      previousRun('low', { id: 'older', createdAt: 10 }),
      previousRun('max', { id: 'foreign-store', originStoreId: 'other', createdAt: 40 }),
      previousRun('high', { id: 'other-session', sessionId: 'other', createdAt: 30 }),
      previousRun('xhigh'),
    ],
  };
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      calls.push(request);
      return facts;
    },
  };
  let observed: NativeModelChoice = {},
    resolved: NativeModelChoice | undefined;
  function Host() {
    const [value, setValue] = useState<NativeModelChoice>({});
    observed = value;
    return (
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={selection}
        value={value}
        onChange={(choice) => {
          changes.push(choice);
          setValue(choice);
        }}
        onReady={(_ready, choice) => {
          resolved = choice;
        }}
      />
    );
  }
  try {
    await act(async () => f.root.render(<Host />));
    expect(f.element.querySelector('.model-effort-summary')?.textContent).toBe('极高');
    expect(resolved).toEqual({ modelId: 'a', reasoningEffort: 'xhigh' });
    expect(observed).toEqual({});
    expect(changes).toEqual([]);
    const { nativeTextIntent } = await import('../../src/native-input');
    expect(
      nativeTextIntent(selection, 'next-command', 'next input', false, resolved),
    ).toMatchObject({
      kind: 'run.start',
      modelId: 'a',
      reasoningEffort: 'xhigh',
    });
    await f.click('模型：remote-a，思考程度：极高');
    expect(f.element.querySelector('.effort-value')?.textContent).toBe('极高');
    const slider = f.element.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.getAttribute('aria-valuetext')).toBe('极高');
    expect(slider.getAttribute('aria-valuenow')).toBe('3');
    expect(f.element.textContent).not.toContain('默认');
    expect(changes).toEqual([]);
    await act(async () => {
      slider.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
    });
    expect(observed).toEqual({ modelId: 'a', reasoningEffort: 'low' });
    expect(resolved).toEqual(observed);
    expect(f.element.querySelector('.effort-value')?.textContent).toBe('轻度');
    await act(async () => f.root.render(<Host />));
    expect(resolved?.reasoningEffort).toBe('low');
    expect(calls).toEqual([{ method: 'input.models.read', generation: 1 }]);
  } finally {
    await f.close();
  }
});

test('new conversations use configured effort while foreign, stale and malformed history cannot supply a Session choice', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [],
    changes: NativeModelChoice[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      calls.push(request);
      return facts;
    },
  };
  let view = 0,
    resolved: NativeModelChoice | undefined;
  const render = (runs: NativeSelection['runs'], preparing = false) =>
    act(async () => {
      f.root.render(
        <NativeModelPicker
          bridge={bridge}
          generation={1}
          selection={{ ...selected('s', ++view), runs }}
          preparing={preparing ? { storeId: 'store' } : undefined}
          value={{}}
          onChange={(value) => changes.push(value)}
          onReady={(_ready, value) => {
            resolved = value;
          }}
        />,
      );
    });
  try {
    const histories: { runs: NativeSelection['runs']; available: boolean }[] = [
      { runs: [], available: true },
      { runs: [previousRun('max', { sessionId: 'foreign' })], available: false },
      { runs: [previousRun('max', { originStoreId: 'foreign' })], available: true },
      { runs: [previousRun('max', { configuration: { modelId: 'b' } })], available: false },
      {
        runs: [previousRun('max', { id: 'older', createdAt: 10 }), previousRun(undefined)],
        available: true,
      },
      { runs: [previousRun('provider-only')], available: true },
      {
        runs: [previousRun('max', { configuration: { modelId: 'a', snapshot: { version: 2 } } })],
        available: false,
      },
      {
        runs: [
          previousRun('max', {
            configuration: {
              modelId: 'a',
              snapshot: {
                version: 1,
                digest: 'f',
                configuration: {
                  models: [{ id: 'a', options: { reasoningEffort: 'max' } }, { id: 'a' }],
                },
              },
            },
          }),
        ],
        available: false,
      },
    ];
    for (const history of histories) {
      await render(history.runs);
      expect(f.element.querySelector('.model-effort-summary')?.textContent).toBe('轻度');
      expect(resolved).toEqual(history.available ? { modelId: 'a' } : undefined);
      if (!history.available)
        expect(f.element.querySelector('[role="alert"]')?.textContent).toContain(
          '无法确认此会话首次运行的模型协议',
        );
    }
    await render([previousRun('max')]);
    expect(f.element.querySelector('.model-effort-summary')?.textContent).toBe('Max');
    expect(resolved).toEqual({ modelId: 'a', reasoningEffort: 'max' });
    await render([previousRun('max')], true);
    expect(f.element.querySelector('.model-effort-summary')?.textContent).toBe('轻度');
    expect(resolved).toEqual({ modelId: 'a' });
    await f.click('模型：remote-a，思考程度：轻度');
    expect(f.element.querySelector('.effort-value')?.textContent).toBe('轻度');
    expect(f.element.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('轻度');
    expect(calls.at(-1)).toEqual({ method: 'conversation.models.read', generation: 1 });
    expect(changes).toEqual([]);
  } finally {
    await f.close();
  }
});

test('restored legacy effort remains usable and an unavailable saved level requires a supported replacement', async () => {
  const f = fixture();
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async () => ({
      ...facts,
      models: [{ ...facts.models[0]!, reasoningEffortChoices: ['low', 'high'] }],
    }),
  };
  let ready = false,
    resolved: NativeModelChoice | undefined;
  function Host({ previous }: { previous: string }) {
    const [value, setValue] = useState<NativeModelChoice>({});
    return (
      <NativeModelPicker
        bridge={bridge}
        generation={1}
        selection={{ ...selected('s'), runs: [previousRun(previous)] }}
        value={value}
        onChange={setValue}
        onReady={(isReady, choice) => {
          ready = isReady;
          resolved = choice;
        }}
      />
    );
  }
  try {
    for (const previous of ['none', 'minimal'] as const) {
      await act(async () => f.root.render(<Host key={previous} previous={previous} />));
      expect(ready).toBe(true);
      expect(resolved).toEqual({ modelId: 'a', reasoningEffort: previous });
      expect(f.element.querySelector('.model-effort-summary')?.textContent).toBe(
        previous === 'none' ? '关闭' : 'minimal',
      );
    }
    await act(async () => f.root.render(<Host key="max" previous="max" />));
    expect(ready).toBe(false);
    expect(resolved).toBeUndefined();
    expect(f.element.textContent).toContain('原临时思考档位当前不可用');
    await f.click('模型：remote-a，思考程度：Max');
    const slider = f.element.querySelector<HTMLElement>('[role="slider"]')!;
    await act(async () => {
      slider.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(ready).toBe(true);
    expect(resolved).toEqual({ modelId: 'a', reasoningEffort: 'high' });
    expect(f.element.querySelector('.effort-value')?.textContent).toBe('高');
  } finally {
    await f.close();
  }
});
