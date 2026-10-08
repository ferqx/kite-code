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
const { NativeModelPicker } = await import('../../src/native-model-picker');
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
      reasoningEffortChoices: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      diagnostics: [],
    },
    {
      id: 'b',
      provider: 'deepseek',
      model: 'remote-b',
      enabled: true,
      configured: true,
      reasoningEffortChoices: [],
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
    await f.click('模型：remote-a，思考程度：低');
    const effort = f.element.querySelector<HTMLElement>('[role="slider"]')!;
    expect(effort.getAttribute('aria-valuemin')).toBe('0');
    expect(effort.getAttribute('aria-valuemax')).toBe('5');
    expect(f.button('配置默认')).toBeDefined();
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
    expect(f.element.textContent).toContain('当前模型不支持思考程度调节');
    expect(ready.at(-1)).toBe(true);
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

test('picker rejects late scope facts and accepts none only when Service explicitly offers it', async () => {
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
          { ...facts.models[0]!, model: 'current', reasoningEffortChoices: ['none', 'low'] },
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
    await f.click('模型：current，思考程度：低');
    expect(f.element.querySelector('[role="slider"]')).toBeNull();
    expect(f.button('低')).toBeDefined();
    expect(f.button('配置默认')).toBeDefined();
    await f.click('关闭思考');
    expect(changes).toEqual([{ modelId: 'a', reasoningEffort: 'none' }]);
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

test('same-provider duplicate names retain exact route IDs; sparse effort choices, none and reset never manufacture a model or configured change', async () => {
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
      reasoningEffortChoices: ['none', 'minimal', 'high', 'max'],
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
    expect(observed).toEqual({ modelId: 'first', reasoningEffort: 'minimal' });
    await key('ArrowRight');
    expect(observed.reasoningEffort).toBe('high');
    await key('ArrowRight');
    expect(observed.reasoningEffort).toBe('max');
    await f.click('关闭思考');
    expect(observed.reasoningEffort).toBe('none');
    await f.click('配置默认');
    expect(observed).toEqual({ modelId: 'first', reasoningEffort: undefined });
    expect(resolved).toEqual({ modelId: 'first' });
    expect(f.element.querySelector('.effort-value')?.textContent).toBe('高');
    expect(calls).toEqual([{ method: 'input.models.read', generation: 1 }]);
  } finally {
    await f.close();
  }
});
