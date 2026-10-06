import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeRequest,
  NativeSelection,
} from '../src/native-bridge';
import { type NativeModelChoice, NativeModelPicker } from '../src/native-model-picker';

function fixture() {
  const dom = new JSDOM('<div id="root"></div>'),
    prior = {
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
  const element = dom.window.document.getElementById('root')!,
    root = createRoot(element);
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (entry) => entry.textContent === name || entry.getAttribute('aria-label') === name,
    )!;
  return {
    dom,
    element,
    root,
    button,
    click: async (name: string) => act(async () => button(name).click()),
    async close() {
      await act(async () => root.unmount());
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
    await f.click('模型：remote-a · 思考：低');
    const effort = f.element.querySelector<HTMLSelectElement>('[aria-label="思考强度"]')!;
    expect([...effort.options].map((option) => option.value)).toEqual([
      '',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    await act(async () => {
      effort.value = 'high';
      effort.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    });
    expect(observed).toEqual({ modelId: 'a', reasoningEffort: 'high' });
    expect(resolved.at(-1)).toEqual({ modelId: 'a', reasoningEffort: 'high' });
    await act(async () => f.root.render(<Host />));
    expect(observed.reasoningEffort).toBe('high');
    expect(calls).toHaveLength(1);
    await f.click('remote-a');
    expect(f.element.querySelector('[aria-label="选择模型 disabled"]')).toBeNull();
    expect(f.element.querySelector('[aria-label="选择模型 broken"]')).toBeNull();
    expect(
      (f.element.querySelector('[aria-label="提供商模型"]')!.parentElement as HTMLElement).style
        .height,
    ).toBe('280px');
    await f.click('deepseek');
    await f.click('选择模型 b');
    expect(observed).toEqual({ modelId: 'b' });
    expect(resolved.at(-1)).toEqual({ modelId: 'b' });
    expect(f.element.textContent).toContain('此模型不支持思考调节');
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
    await f.click('模型：current · 思考：低');
    const effort = f.element.querySelector<HTMLSelectElement>('[aria-label="思考强度"]')!;
    expect([...effort.options].map((option) => option.value)).toEqual(['', 'none', 'low']);
    await act(async () => {
      effort.value = 'none';
      effort.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    });
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
    expect(f.element.textContent).toContain('模型：remote-b');
    expect(ready.at(-1)).toBe(true);
    await act(async () => render('two'));
    expect(f.element.textContent).toContain('所选模型 missing 当前不可用');
    expect(ready.at(-1)).toBe(false);
  } finally {
    await f.close();
  }
});
