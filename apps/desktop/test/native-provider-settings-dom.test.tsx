import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeProviderSettingsFacts,
  NativeProviderSubmission,
  NativeRequest,
  NativeSelection,
} from '../src/native-bridge';
import { NativeProviderSettings } from '../src/native-provider-settings';

function fixture() {
  const dom = new JSDOM('<div id="root"></div>');
  // React's import-time event detection sees no browser in Bun; JSDOM has no legacy input-event hooks.
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const prior = {
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
  const field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    name: string,
  ) => element.querySelector<T>(`[aria-label="${name}"]`)!;
  async function edit(name: string, value: string) {
    await act(async () => {
      const input = field(name);
      input.value = value;
      input.dispatchEvent(
        new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
      );
    });
  }
  return {
    dom,
    element,
    root,
    button,
    field,
    edit,
    click: async (name: string) => act(async () => button(name).click()),
    async close() {
      await act(async () => root.unmount());
      Object.assign(globalThis, prior);
      dom.window.close();
    },
  };
}
const facts: NativeProviderSettingsFacts = {
  kind: 'settings.providers',
  observationId: 7,
  storeId: 'store',
  canWrite: true,
  errors: [],
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      defaultBaseURL: 'https://api.openai.com/v1',
      requiresCredential: true,
      connections: [],
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      defaultBaseURL: 'https://api.deepseek.com',
      requiresCredential: true,
      connections: [],
    },
    {
      id: 'compatible',
      label: 'OpenAI-compatible',
      defaultBaseURL: '',
      requiresCredential: false,
      connections: [
        {
          id: 'one',
          baseURL: 'https://one.invalid/v1',
          hasCredential: true,
          modelNames: ['remote-one'],
          canWrite: true,
        },
        {
          id: 'two',
          baseURL: 'https://two.invalid/v1',
          hasCredential: false,
          modelNames: ['remote-two'],
          canWrite: true,
        },
      ],
    },
    {
      id: 'ollama',
      label: 'Ollama',
      defaultBaseURL: 'http://localhost:11434/v1',
      requiresCredential: false,
      connections: [],
    },
  ],
};

test('Provider form validates inline with focus, clears switched drafts and sends secret once; unknown locks across close and refresh', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  let original: NativeProviderSubmission | undefined;
  let applied = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') return structuredClone(facts);
      if (input.method === 'settings.providers.save') {
        original = {
          kind: 'settings.providers.submission',
          commandId: 'save-one',
          storeId: 'store',
          observationId: 7,
          operation: input.operation,
          phase: 'unknown',
          credentialState: 'outcome_unknown',
          configurationState: 'not_attempted',
        };
        return original;
      }
      if (input.method === 'settings.providers.lookup')
        return {
          ...original!,
          phase: 'applied',
          credentialState: 'stored',
          configurationState: 'published',
        };
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          bridge={bridge}
          generation={1}
          submissions={[]}
          onSaved={() => applied++}
        />,
      ),
    );
    expect(f.element.querySelectorAll('[aria-label="提供商列表"] li')).toHaveLength(4);
    await f.click('配置 OpenAI');
    expect(f.element.querySelector('form')!.noValidate).toBe(true);
    await f.edit('服务地址', 'not-a-url');
    await f.click('保存提供商配置');
    expect(f.dom.window.document.activeElement).toBe(f.field('服务地址'));
    expect(calls.some((input) => input.method === 'settings.providers.save')).toBe(false);
    await f.edit('服务地址', 'https://openai.invalid/v1');
    await f.click('保存提供商配置');
    expect(f.dom.window.document.activeElement).toBe(f.field('API key'));
    await f.edit('API key', 'unsaved-secret');
    await f.edit('模型名称', 'unsaved-model');
    await f.click('配置 DeepSeek');
    expect(f.field('API key').value).toBe('');
    expect(f.field('模型名称').value).toBe('');
    expect(f.field('服务地址').value).toBe('https://api.deepseek.com');
    await f.click('配置 OpenAI');
    await f.edit('API key', 'saved-secret');
    await f.edit('模型名称', 'exact-a\nexact-b');
    await f.click('保存提供商配置');
    expect(f.field('API key').value).toBe('');
    expect(calls.filter((input) => input.method === 'settings.providers.save')).toEqual([
      {
        method: 'settings.providers.save',
        generation: 1,
        observationId: 7,
        operation: {
          provider: 'openai',
          connectionId: null,
          baseURL: 'https://api.openai.com/v1',
          modelNames: ['exact-a', 'exact-b'],
          credential: 'replace',
        },
        secret: 'saved-secret',
      },
    ]);
    const origin = f.button('配置 OpenAI');
    await f.click('关闭提供商配置');
    expect(f.dom.window.document.activeElement).toBe(origin);
    await f.click('配置 OpenAI');
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await f.click('刷新提供商配置');
    expect(f.button('保存提供商配置').disabled).toBe(true);
    expect(calls.filter((input) => input.method === 'settings.providers.lookup')).toHaveLength(0);
    expect(f.element.textContent).toContain('unknown');
    expect(f.element.textContent).toContain('API key 保存结果待核实');
    expect(f.element.textContent).toContain('模型配置未保存；凭证保存结果单独显示');
    await f.click('查询原提供商提交');
    expect(calls.filter((input) => input.method === 'settings.providers.lookup')).toEqual([
      { method: 'settings.providers.lookup', generation: 1, commandId: 'save-one' },
    ]);
    expect(applied).toBe(1);
    expect(f.element.textContent).toContain('API key 已存入凭证库');
    expect(f.element.textContent).toContain('模型配置已保存，用于下一次新运行');
    expect(calls.filter((input) => input.method === 'settings.providers.save')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('Provider keeps distinct endpoint connection intent, discovery uses empty names and saved refresh failure is distinct', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  let reads = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') {
        if (++reads === 2) throw Error('configuration_unavailable');
        return facts;
      }
      if (input.method === 'settings.providers.save')
        return {
          kind: 'settings.providers.submission',
          commandId: 'existing',
          storeId: 'store',
          observationId: 7,
          operation: input.operation,
          phase: 'applied',
        };
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(<NativeProviderSettings bridge={bridge} generation={1} submissions={[]} />),
    );
    await f.click('编辑 OpenAI-compatible');
    expect(f.field<HTMLSelectElement>('提供商连接').options).toHaveLength(3);
    expect(f.field('凭据处理').value).toBe('keep');
    await f.edit('提供商连接', 'two');
    expect(f.field('服务地址').value).toBe('https://two.invalid/v1');
    expect(f.field('凭据处理').value).toBe('none');
    await f.edit('模型名称', '');
    await f.click('保存提供商配置');
    expect(calls.filter((input) => input.method === 'settings.providers.save')).toEqual([
      {
        method: 'settings.providers.save',
        generation: 1,
        observationId: 7,
        operation: {
          provider: 'compatible',
          connectionId: 'two',
          baseURL: 'https://two.invalid/v1',
          modelNames: [],
          credential: 'none',
        },
      },
    ]);
    expect(f.element.textContent).toContain('已保存，刷新配置失败');
    expect(f.element.textContent).toContain('无需重复保存');
    expect(f.element.textContent).toContain('applied');
  } finally {
    await f.close();
  }
});

test('late Provider reads cannot replace the selected Store and only its unknown submissions lock saves', async () => {
  const f = fixture();
  let release!: (value: NativeProviderSettingsFacts) => void;
  let reads = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      if (input.method === 'settings.providers.read') {
        if (++reads === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        return { ...facts, storeId: 'new' };
      }
      return null;
    },
  };
  const old: NativeProviderSubmission = {
    kind: 'settings.providers.submission',
    commandId: 'old',
    storeId: 'old',
    observationId: 1,
    operation: {
      provider: 'openai',
      connectionId: null,
      baseURL: '',
      modelNames: [],
      credential: 'replace',
    },
    phase: 'unknown',
  };
  const selection = (storeId: string) =>
    ({ storeId, session: { id: 's' }, viewSelection: 1 }) as NativeSelection;
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          bridge={bridge}
          generation={1}
          selection={selection('old')}
          submissions={[old]}
        />,
      ),
    );
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          bridge={bridge}
          generation={2}
          selection={selection('new')}
          submissions={[old]}
        />,
      ),
    );
    await act(async () => release({ ...facts, providers: [] }));
    expect(f.element.querySelectorAll('[aria-label="提供商列表"] li')).toHaveLength(4);
    await f.click('配置 Ollama');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    expect(f.element.textContent).toContain('原提交 old');
  } finally {
    await f.close();
  }
});
