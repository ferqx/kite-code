import { expect, test } from 'bun:test';
import type { AgentClient, HostMutation, ProviderSettingsRequest } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeProviderSettings as ProviderManager } from '../electron/provider-settings';
import type {
  NativeBridge,
  NativeProviderSettingsFacts,
  NativeProviderSubmission,
  NativeRequest,
  NativeSelection,
} from '../src/native-bridge';
import { NativeProviderSettings } from '../src/native-provider-settings';
import { memoryPrivateData } from './private-data.fixture';

function fixture() {
  const dom = new JSDOM('<div id="settings"><main id="root"></main><div id="panel"></div></div>');
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
  const element = dom.window.document.getElementById('settings')!,
    main = dom.window.document.getElementById('root')!,
    panelHost = dom.window.document.getElementById('panel')!,
    root = createRoot(main);
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
    main,
    panelHost,
    root,
    button,
    field,
    edit,
    click: async (name: string) => act(async () => button(name).click()),
    async addPreset(name: string) {
      await act(async () => button('新增提供商').click());
      const presets: Record<string, string> = {
        OpenAI: 'openai',
        DeepSeek: 'deepseek',
        自定义服务商: 'compatible',
        Ollama: 'ollama',
      };
      const preset = presets[name];
      if (!preset) throw Error(`Unknown preset: ${name}`);
      if (field('服务商预设').value !== preset) await edit('服务商预设', preset);
    },
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
    {
      id: 'codex',
      label: 'ChatGPT / Codex',
      defaultBaseURL: 'https://chatgpt.com/backend-api/codex',
      requiresCredential: false,
      connections: [],
    },
  ],
};

test('Provider settings show the automatic local Codex source without manual connection controls or a Codex preset', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  const state = structuredClone(facts);
  const codex = state.providers.find((provider) => provider.id === 'codex')!;
  codex.connections = [
    {
      id: 'local-codex',
      name: 'ChatGPT / Codex（本机）',
      baseURL: codex.defaultBaseURL,
      protocol: 'responses',
      hasCredential: true,
      modelNames: ['fixture-codex-model'],
      canWrite: false,
    },
  ];
  // Source order cannot turn the automatic connection into the default manual template.
  state.providers = [codex, ...state.providers.filter((provider) => provider.id !== 'codex')];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      return input.method === 'settings.providers.read' ? structuredClone(state) : null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          bridge={bridge}
          generation={1}
          submissions={[]}
          panelHost={f.panelHost}
        />,
      ),
    );
    const row = [...f.element.querySelectorAll('.provider-instance')].find((element) =>
      element.textContent?.includes('ChatGPT / Codex（本机）'),
    )!;
    expect(row).toBeDefined();
    expect(row.textContent).toContain('Responses');
    expect(row.textContent).toContain('自动接入');
    expect(row.textContent).toContain('由本机 Codex 登录管理');
    expect(row.querySelector('button')).toBeNull();
    expect(f.field('API key')).toBeNull();
    expect(f.field('服务地址')).toBeNull();
    await f.click('刷新提供商配置');
    expect(f.element.contains(row)).toBe(true);
    await f.click('新增提供商');
    expect(f.field<HTMLSelectElement>('服务商预设').value).toBe('openai');
    expect(
      [...f.field<HTMLSelectElement>('服务商预设').options].map((option) => option.value),
    ).toEqual(['openai', 'deepseek', 'compatible', 'ollama']);
    expect(calls.some((input) => input.method === 'settings.providers.save')).toBe(false);
  } finally {
    await f.close();
  }
});

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
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
          onSaved={() => applied++}
        />,
      ),
    );
    expect(f.element.querySelectorAll('[aria-label="提供商列表"] li')).toHaveLength(2);
    await f.addPreset('OpenAI');
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
    await f.edit('API 协议', 'responses');
    await f.edit('服务商预设', 'deepseek');
    expect(f.field('API key').value).toBe('');
    expect(f.field('模型名称').value).toBe('');
    expect(f.field('服务地址').value).toBe('https://api.deepseek.com');
    expect(f.field('API 协议')).toBeNull();
    await f.edit('服务商预设', 'openai');
    expect(f.field('API 协议').value).toBe('chat-completions');
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
          kind: 'upsert',
          name: 'OpenAI',
          provider: 'openai',
          protocol: 'chat-completions',
          connectionId: null,
          baseURL: 'https://api.openai.com/v1',
          modelNames: ['exact-a', 'exact-b'],
          credential: 'replace',
        },
        secret: 'saved-secret',
      },
    ]);
    const origin = f.button('新增提供商');
    await f.click('关闭');
    expect(f.dom.window.document.activeElement).toBe(origin);
    await f.addPreset('OpenAI');
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await f.click('刷新提供商配置');
    expect(f.button('保存提供商配置').disabled).toBe(true);
    expect(calls.filter((input) => input.method === 'settings.providers.lookup')).toHaveLength(0);
    expect(f.element.textContent).toContain('OpenAI：保存结果待确认。');
    expect(f.element.textContent).not.toContain('save-one');
    expect(f.element.textContent).not.toContain('API key 保存结果待核实');
    expect(f.element.textContent).not.toContain('模型配置未保存；凭证保存结果单独显示');
    await f.click('查看结果');
    expect(calls.filter((input) => input.method === 'settings.providers.lookup')).toEqual([
      { method: 'settings.providers.lookup', generation: 1, commandId: 'save-one' },
    ]);
    expect(applied).toBe(1);
    expect(f.element.textContent).not.toContain('API key 已存入凭证库');
    expect(f.element.textContent).not.toContain('模型配置已保存，用于下一次新运行');
    expect(f.element.querySelector('[aria-label="待确认的提供商更改"]')).toBeNull();
    expect(f.element.textContent).toContain('已保存提供商配置。');
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
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.click('编辑 OpenAI-compatible 1');
    expect(f.element.querySelectorAll('.provider-instance')).toHaveLength(2);
    expect(f.field('凭据处理').value).toBe('keep');
    await f.click('编辑 OpenAI-compatible 2');
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
          kind: 'upsert',
          name: 'OpenAI-compatible 2',
          provider: 'compatible',
          protocol: 'chat-completions',
          connectionId: 'two',
          baseURL: 'https://two.invalid/v1',
          modelNames: [],
          credential: 'none',
        },
      },
    ]);
    expect(f.element.textContent).toContain('已保存，刷新配置失败');
    expect(f.element.textContent).toContain('无需重复保存');
    expect(f.element.textContent).not.toContain('applied');
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
          panelHost={f.panelHost}
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
          panelHost={f.panelHost}
          bridge={bridge}
          generation={2}
          selection={selection('new')}
          submissions={[old]}
        />,
      ),
    );
    await act(async () => release({ ...facts, providers: [] }));
    expect(f.element.querySelectorAll('[aria-label="提供商列表"] li')).toHaveLength(2);
    await f.addPreset('Ollama');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    expect(f.panelHost.textContent).not.toContain('原提交 old');
    expect(f.panelHost.textContent).toContain('OpenAI：保存结果待确认。');
    expect(f.panelHost.textContent).toContain('此更改来自先前的数据源。');
    expect(f.button('查看结果').disabled).toBe(false);
    await f.click('关闭');
    expect(f.element.textContent).not.toContain('原提交 old');
    expect(f.main.textContent).toContain('OpenAI：保存结果待确认。');
  } finally {
    await f.close();
  }
});

test('Provider protocol defaults legacy connections, survives repeated save and edit, and resets across providers', async () => {
  const f = fixture();
  const saved: Extract<NativeRequest, { method: 'settings.providers.save' }>[] = [];
  const state = structuredClone(facts);
  const compatible = state.providers.find((provider) => provider.id === 'compatible')!;
  compatible.connections.push({
    ...compatible.connections[0]!,
    id: 'responses-one',
    protocol: 'responses',
    modelNames: ['responses-model'],
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      if (input.method === 'settings.providers.read') return structuredClone(state);
      if (input.method === 'settings.providers.save') {
        saved.push(input);
        const provider = state.providers.find((entry) => entry.id === input.operation.provider)!;
        const existing = provider.connections.find(
          (entry) => entry.id === input.operation.connectionId,
        );
        const connection = {
          id: existing?.id ?? `new-${saved.length}`,
          name: input.operation.name,
          baseURL: input.operation.baseURL,
          protocol: input.operation.protocol ?? ('chat-completions' as const),
          hasCredential: input.operation.credential !== 'none',
          modelNames: input.operation.modelNames,
          canWrite: true,
        };
        if (existing) Object.assign(existing, connection);
        else provider.connections.push(connection);
        return {
          kind: 'settings.providers.submission',
          commandId: `save-${saved.length}`,
          storeId: 'store',
          observationId: 7,
          operation: input.operation,
          phase: 'applied',
        };
      }
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.click('编辑 OpenAI-compatible 1');
    expect(f.field('API 协议').value).toBe('chat-completions');
    expect(f.main.querySelector('.provider-instance')!.textContent).toContain('Chat Completions');
    await f.click('编辑 OpenAI-compatible 3');
    expect(f.field('API 协议').value).toBe('responses');
    expect(f.field('模型名称').value).toBe('responses-model');
    await f.click('保存提供商配置');
    expect(f.panelHost.querySelector('form')).toBeNull();
    await f.click('编辑 OpenAI-compatible 1');
    await f.click('编辑 OpenAI-compatible 3');
    expect(f.field('提供商名称').value).toBe('OpenAI-compatible 3');
    expect(f.field('API 协议').value).toBe('responses');
    await f.click('保存提供商配置');
    expect(saved.map((entry) => entry.operation.connectionId)).toEqual([
      'responses-one',
      'responses-one',
    ]);
    expect(saved.every((entry) => entry.operation.protocol === 'responses')).toBe(true);
    await f.click('编辑 OpenAI-compatible 1');
    await f.click('编辑 OpenAI-compatible 3');
    expect(f.field('API 协议').value).toBe('responses');
    await f.addPreset('自定义服务商');
    expect(f.field('API 协议').value).toBe('chat-completions');
    await f.edit('API 协议', 'responses');
    await f.edit('服务地址', 'https://new.invalid/v1');
    await f.edit('模型名称', 'new-model');
    await f.click('保存提供商配置');
    expect(saved.at(-1)!.operation.protocol).toBe('responses');
    expect(f.panelHost.querySelector('form')).toBeNull();
    await f.click('编辑 OpenAI-compatible 1');
    await f.click('编辑 自定义服务商');
    expect(f.field('提供商名称').value).toBe('自定义服务商');
    await f.addPreset('DeepSeek');
    expect(f.field('API 协议')).toBeNull();
    await f.addPreset('Ollama');
    expect(f.field('API 协议')).toBeNull();
    await f.edit('模型名称', 'local-model');
    await f.click('保存提供商配置');
    expect(saved.at(-1)!.operation.protocol).toBeUndefined();
    await f.addPreset('OpenAI');
    expect(f.field('API 协议').value).toBe('chat-completions');
    await f.edit('API 协议', 'responses');
    await f.edit('服务地址', 'invalid');
    await f.click('保存提供商配置');
    expect(saved).toHaveLength(4);
    expect(f.dom.window.document.activeElement).toBe(f.field('服务地址'));
    await f.edit('服务地址', 'https://api.openai.com/v1');
    await f.click('保存提供商配置');
    expect(saved).toHaveLength(4);
    expect(f.dom.window.document.activeElement).toBe(f.field('API key'));
    expect(f.field('API 协议').value).toBe('responses');
  } finally {
    await f.close();
  }
});

test('Provider instance rows expose configuration state and selected editing, with named sections and accessible field help', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') return structuredClone(facts);
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    expect(f.element.querySelectorAll('.provider-instance')).toHaveLength(2);
    expect(f.button('新增提供商').getAttribute('aria-expanded')).toBe('false');
    expect(f.main.querySelector('.provider-instance')!.textContent).toContain('已配置');
    expect(f.main.querySelector('.provider-instance')!.textContent).toContain('1 个模型');
    expect(f.element.querySelector('form')).toBeNull();
    await f.click('编辑 OpenAI-compatible 1');
    expect(f.button('编辑 OpenAI-compatible 1').getAttribute('aria-expanded')).toBe('true');
    expect(f.element.querySelectorAll('form section[aria-labelledby]')).toHaveLength(3);
    for (const section of f.element.querySelectorAll('form section[aria-labelledby]')) {
      expect(
        f.dom.window.document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent,
      ).toBeTruthy();
    }
    expect(f.field('凭据处理').value).toBe('keep');
    expect(f.field('API key')).toBeNull();
    await f.edit('凭据处理', 'replace');
    expect(f.field<HTMLInputElement>('API key').type).toBe('password');
    for (const label of ['API 协议', '服务地址', 'API key', '模型名称']) {
      const control = f.field(label);
      expect(
        f.dom.window.document.getElementById(control.getAttribute('aria-describedby')!)
          ?.textContent,
      ).toBeTruthy();
    }
    await f.edit('服务地址', 'invalid');
    await f.click('保存提供商配置');
    const error = f.dom.window.document.getElementById(
      f.field('服务地址').getAttribute('aria-describedby')!,
    );
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('HTTP 或 HTTPS');
    await f.addPreset('Ollama');
    expect(f.button('编辑 OpenAI-compatible 1').getAttribute('aria-expanded')).toBe('false');
    expect(f.button('新增提供商').getAttribute('aria-expanded')).toBe('true');
    expect(f.field('API 协议')).toBeNull();
    expect(f.field('凭据处理').value).toBe('none');
    await f.click('关闭');
    expect(f.dom.window.document.activeElement === f.button('新增提供商')).toBe(true);
    expect(f.element.querySelector('form')).toBeNull();
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
  } finally {
    await f.close();
  }
});

test('Provider editor portals into the sibling rail; cancel and close clear drafts without replacing the list', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      return input.method === 'settings.providers.read' ? structuredClone(facts) : null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    const cards = [...f.main.querySelectorAll('.provider-instance')];
    const origin = f.button('新增提供商');
    expect(f.main.parentElement).toBe(f.panelHost.parentElement);
    expect(f.main.contains(f.panelHost)).toBe(false);
    for (const dismiss of ['取消', '关闭']) {
      await f.addPreset('OpenAI');
      const sidebar = f.panelHost.querySelector('aside.right-sidebar')!;
      expect(sidebar.getAttribute('aria-label')).toBe('OpenAI 配置');
      expect(sidebar.id).toBe(origin.getAttribute('aria-controls')!);
      expect(origin.getAttribute('aria-expanded')).toBe('true');
      expect(f.panelHost.querySelectorAll('form')).toHaveLength(1);
      expect(f.main.querySelector('form')).toBeNull();
      expect(f.main.querySelector('.has-editor')).toBeNull();
      expect([...f.main.querySelectorAll('.provider-instance')]).toEqual(cards);
      expect(f.dom.window.document.activeElement).toBe(f.field('服务商预设'));
      expect(f.field('API key').value).toBe('');
      expect(f.field('模型名称').value).toBe('');
      await f.edit('API key', `unsaved-${dismiss}`);
      await f.edit('模型名称', 'unsaved-model');
      await f.edit('服务地址', 'https://draft.invalid/v1');
      await f.click(dismiss);
      expect(f.panelHost.childElementCount).toBe(0);
      expect([...f.main.querySelectorAll('.provider-instance')]).toEqual(cards);
      expect(f.dom.window.document.activeElement).toBe(origin);
      expect(origin.getAttribute('aria-expanded')).toBe('false');
      expect(origin.hasAttribute('aria-controls')).toBe(false);
    }
    await f.addPreset('OpenAI');
    expect(f.field('API key').value).toBe('');
    expect(f.field('模型名称').value).toBe('');
    expect(f.field('服务地址').value).toBe('https://api.openai.com/v1');
    expect(calls.filter((call) => call.method === 'settings.providers.close')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'settings.providers.read')).toHaveLength(1);
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
  } finally {
    await f.close();
  }
});

test('Provider save failure stays in the rail with its non-secret draft and actionable error', async () => {
  const f = fixture();
  const saves: Extract<NativeRequest, { method: 'settings.providers.save' }>[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      if (input.method === 'settings.providers.read') return structuredClone(facts);
      if (input.method === 'settings.providers.save') {
        saves.push(input);
        return {
          kind: 'settings.providers.submission',
          commandId: 'failed-save',
          storeId: 'store',
          observationId: 7,
          operation: input.operation,
          phase: 'failed',
          error: 'configuration_conflict',
        };
      }
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.addPreset('OpenAI');
    await f.edit('服务地址', 'https://failed.invalid/v1');
    await f.edit('API key', 'one-attempt-secret');
    await f.edit('模型名称', 'draft-model');
    const form = f.panelHost.querySelector('form');
    await f.click('保存提供商配置');
    expect(f.panelHost.querySelector('form')).toBe(form);
    expect(f.panelHost.querySelector('[role="alert"]')?.textContent).toContain(
      '保存失败：configuration_conflict',
    );
    expect(f.main.querySelector('[role="alert"]')).toBeNull();
    expect(f.field('服务地址').value).toBe('https://failed.invalid/v1');
    expect(f.field('模型名称').value).toBe('draft-model');
    expect(f.field('API key').value).toBe('');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    await f.click('保存提供商配置');
    expect(f.dom.window.document.activeElement).toBe(f.field('API key'));
    expect(saves).toHaveLength(1);
    expect(saves[0]!.secret).toBe('one-attempt-secret');
  } finally {
    await f.close();
  }
});

test('Provider successful save refreshes the list, closes the rail and restores focus to Add', async () => {
  const f = fixture(),
    state = structuredClone(facts),
    calls: NativeRequest[] = [];
  let applied = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') return structuredClone(state);
      if (input.method === 'settings.providers.save') {
        state.providers[0]!.connections.push({
          id: 'saved-openai',
          name: input.operation.name,
          baseURL: input.operation.baseURL,
          protocol: input.operation.protocol,
          modelNames: input.operation.modelNames,
          hasCredential: true,
          canWrite: true,
        });
        return {
          kind: 'settings.providers.submission',
          commandId: 'applied-save',
          storeId: 'store',
          observationId: 7,
          operation: input.operation,
          phase: 'applied',
          credentialState: 'stored',
          configurationState: 'published',
        };
      }
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
          onSaved={() => applied++}
        />,
      ),
    );
    const origin = f.button('新增提供商');
    await f.addPreset('OpenAI');
    await f.edit('API key', 'saved-once-secret');
    await f.edit('模型名称', 'saved-model');
    await f.click('保存提供商配置');
    expect(applied).toBe(1);
    expect(calls.filter((call) => call.method === 'settings.providers.save')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'settings.providers.read')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'settings.providers.close')).toHaveLength(1);
    expect(f.panelHost.childElementCount).toBe(0);
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(3);
    expect(f.button('编辑 OpenAI')).not.toBe(origin);
    expect(f.button('编辑 OpenAI').closest('.provider-instance')!.textContent).toContain(
      '1 个模型',
    );
    expect(f.dom.window.document.activeElement).toBe(origin);
    expect(f.main.textContent).toContain('已保存提供商配置。');
    expect(f.main.textContent).not.toContain('applied-save');
    await f.click('编辑 OpenAI');
    expect(f.field('凭据处理').value).toBe('keep');
    expect(f.field('API key')).toBeNull();
    expect(f.field('模型名称').value).toBe('saved-model');
  } finally {
    await f.close();
  }
});

for (const staleResult of ['success', 'failure'] as const) {
  test(`Provider close during refresh unlocks a new read and ignores stale ${staleResult}`, async () => {
    const f = fixture();
    let reads = 0;
    let release!: (value: NativeProviderSettingsFacts) => void;
    let reject!: (cause: Error) => void;
    const bridge: NativeBridge = {
      watch: () => () => {},
      request: async (input) => {
        if (input.method === 'settings.providers.read') {
          if (++reads === 2)
            return new Promise<NativeProviderSettingsFacts>((resolve, fail) => {
              release = resolve;
              reject = fail;
            });
          return structuredClone(facts);
        }
        return null;
      },
    };
    try {
      await act(async () =>
        f.root.render(
          <NativeProviderSettings
            panelHost={f.panelHost}
            bridge={bridge}
            generation={1}
            submissions={[]}
          />,
        ),
      );
      await f.click('编辑 OpenAI-compatible 1');
      await f.click('刷新提供商配置');
      expect(reads).toBe(2);
      expect(f.button('刷新提供商配置').disabled).toBe(true);
      await f.click('关闭');
      expect(f.panelHost.childElementCount).toBe(0);
      expect(f.button('刷新提供商配置').disabled).toBe(false);
      await f.click('刷新提供商配置');
      expect(reads).toBe(3);
      await f.click('编辑 OpenAI-compatible 1');
      await act(async () => {
        if (staleResult === 'success') release({ ...facts, canWrite: false, providers: [] });
        else reject(Error('stale_read_failed'));
      });
      expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(2);
      expect(f.panelHost.querySelector('form')?.getAttribute('aria-label')).toBe(
        'OpenAI-compatible 1 配置',
      );
      expect(f.field('服务地址').value).toBe('https://one.invalid/v1');
      expect(f.button('刷新提供商配置').disabled).toBe(false);
      expect(f.button('保存提供商配置').disabled).toBe(false);
      expect(f.element.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await f.close();
    }
  });
}

for (const pendingStage of ['save', 'after-save read'] as const) {
  for (const nextProvider of ['same', 'different'] as const) {
    test(`Provider ${pendingStage} completion cannot close or rebind a ${nextProvider}-provider editor opened meanwhile`, async () => {
      const f = fixture(),
        refreshed = structuredClone(facts);
      let reads = 0,
        applied = 0;
      let submitted!: NativeProviderSubmission;
      let releaseSave!: (value: NativeProviderSubmission) => void;
      let releaseRead!: (value: NativeProviderSettingsFacts) => void;
      const bridge: NativeBridge = {
        watch: () => () => {},
        request: async (input) => {
          if (input.method === 'settings.providers.read') {
            if (++reads > 1 && pendingStage === 'after-save read')
              return new Promise<NativeProviderSettingsFacts>((resolve) => {
                releaseRead = resolve;
              });
            return structuredClone(facts);
          }
          if (input.method === 'settings.providers.save') {
            Object.assign(refreshed.providers[2]!.connections[0]!, {
              protocol: input.operation.protocol,
              modelNames: input.operation.modelNames,
            });
            submitted = {
              kind: 'settings.providers.submission',
              commandId: 'late-applied-save',
              storeId: 'store',
              observationId: 7,
              operation: input.operation,
              phase: 'applied',
            };
            if (pendingStage === 'save')
              return new Promise<NativeProviderSubmission>((resolve) => {
                releaseSave = resolve;
              });
            return submitted;
          }
          return null;
        },
      };
      try {
        await act(async () =>
          f.root.render(
            <NativeProviderSettings
              panelHost={f.panelHost}
              bridge={bridge}
              generation={1}
              submissions={[]}
              onSaved={() => applied++}
            />,
          ),
        );
        await f.click('编辑 OpenAI-compatible 1');
        await f.edit('API 协议', 'responses');
        await f.edit('模型名称', 'saved-old-editor-model');
        await f.click('保存提供商配置');
        expect(f.button('正在保存…').disabled).toBe(true);
        expect(reads).toBe(pendingStage === 'save' ? 1 : 2);
        const trigger = nextProvider === 'same' ? '编辑 OpenAI-compatible 1' : '新增提供商';
        if (nextProvider === 'same') await f.click(trigger);
        else await f.addPreset('DeepSeek');
        expect(f.field('模型名称').value).toBe(nextProvider === 'same' ? 'remote-one' : '');
        await act(async () => {
          if (pendingStage === 'save') releaseSave(submitted);
          else releaseRead(refreshed);
        });
        expect(applied).toBe(1);
        expect(f.panelHost.querySelector('form')?.getAttribute('aria-label')).toBe(
          nextProvider === 'same' ? 'OpenAI-compatible 1 配置' : 'DeepSeek 配置',
        );
        expect(f.button(trigger).getAttribute('aria-expanded')).toBe('true');
        expect(f.field('服务地址').value).toBe(
          nextProvider === 'same' ? 'https://one.invalid/v1' : 'https://api.deepseek.com',
        );
        expect(f.field('模型名称').value).toBe(nextProvider === 'same' ? 'remote-one' : '');
        if (nextProvider === 'same') {
          expect(f.field('提供商名称').value).toBe('OpenAI-compatible 1');
          expect(f.field('API 协议').value).toBe('chat-completions');
          expect(f.field('凭据处理').value).toBe('keep');
        } else {
          expect(f.field('API key').value).toBe('');
          expect(f.field('提供商名称').value).toBe('DeepSeek');
        }
        const changedDraft = pendingStage === 'after-save read' && nextProvider === 'same';
        expect(f.button('保存提供商配置').disabled).toBe(changedDraft);
        if (changedDraft)
          expect(f.panelHost.textContent).toContain('已重新读取配置，当前草稿已保留');
        expect(f.panelHost.textContent).not.toContain('late-applied-save');
        expect(f.panelHost.textContent).not.toContain('已保存提供商配置。');
        expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(2);
        await f.click('关闭');
        expect(f.main.textContent).not.toContain('late-applied-save');
      } finally {
        await f.close();
      }
    });
  }
}

test('Provider closing an active refresh cannot restore the old write observation on reopen', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  let reads = 0;
  let release!: (value: NativeProviderSettingsFacts) => void;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') {
        if (++reads === 2)
          return new Promise<NativeProviderSettingsFacts>((resolve) => {
            release = resolve;
          });
        return structuredClone(facts);
      }
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.click('编辑 OpenAI-compatible 1');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    await f.click('刷新提供商配置');
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await f.click('关闭');
    await f.click('编辑 OpenAI-compatible 1');
    expect(reads).toBe(2);
    expect(f.button('刷新提供商配置').disabled).toBe(false);
    expect(f.button('保存提供商配置').disabled).toBe(true);
    expect(f.panelHost.textContent).toContain('当前配置只读，请刷新');
    await f.click('保存提供商配置');
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
    await act(async () => release(structuredClone(facts)));
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await f.click('刷新提供商配置');
    expect(reads).toBe(3);
    expect(f.button('保存提供商配置').disabled).toBe(false);
    expect(f.panelHost.textContent).not.toContain('当前配置只读，请刷新');
  } finally {
    await f.close();
  }
});

test('Provider hides submission history and technical identities, but unknown stays queryable across every editor', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  const applied: NativeProviderSubmission = {
    kind: 'settings.providers.submission',
    commandId: '7bd966f8-511a-4d69-b8b5-1d490a8356dd',
    storeId: 'private-store-id',
    observationId: 7,
    operation: {
      name: 'Historical applied service',
      provider: 'ollama',
      connectionId: null,
      baseURL: 'http://localhost:11434/v1',
      modelNames: ['historical-private-model'],
      credential: 'none',
    },
    phase: 'applied',
    credentialState: 'stored',
    configurationState: 'published',
  };
  const failed: NativeProviderSubmission = {
    ...applied,
    commandId: 'd8c91df0-e959-41bd-aed0-b533c9509ee1',
    operation: { ...applied.operation, name: 'Historical failed service' },
    phase: 'failed',
    error: 'historical_private_error',
  };
  const submitting: NativeProviderSubmission = {
    ...applied,
    commandId: 'c2ccbb9a-69ae-456e-9998-eb1df869f036',
    operation: { ...applied.operation, name: 'Historical submitting service' },
    phase: 'submitting',
  };
  const unknown: NativeProviderSubmission = {
    ...applied,
    commandId: '43c2ab5f-81f4-48a9-997a-b758a71b0fd2',
    storeId: 'store',
    operation: {
      ...applied.operation,
      name: 'Pending OpenAI service',
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      credential: 'replace',
    },
    phase: 'unknown',
    credentialState: 'outcome_unknown',
    configurationState: 'outcome_unknown',
  };
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') return structuredClone(facts);
      if (input.method === 'settings.providers.lookup') return { ...unknown, phase: 'applied' };
      return null;
    },
  };
  const assertNoHistory = () => {
    expect(f.element.querySelector('[aria-label="提供商原提交"]')).toBeNull();
    expect(f.element.querySelector('details')).toBeNull();
    for (const hidden of [
      '提供商提交结果',
      '技术详情',
      '原 Store',
      'private-store-id',
      'Historical applied service',
      'Historical failed service',
      'Historical submitting service',
      'historical_private_error',
      'historical-private-model',
      'API key 已存入凭证库',
      '模型配置已保存，用于下一次新运行',
      applied.commandId,
      failed.commandId,
      submitting.commandId,
      unknown.commandId,
    ])
      expect(f.element.textContent).not.toContain(hidden);
    expect(f.button('返回列表查看未决提交')).toBeUndefined();
  };
  const assertUnknown = (host: HTMLElement) => {
    const notice = host.querySelector('[aria-label="待确认的提供商更改"]')!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('Pending OpenAI service：保存结果待确认。');
    expect(notice.querySelectorAll('button')).toHaveLength(1);
    expect(notice.querySelector('button')!.textContent).toBe('查看结果');
    expect(f.button('查看结果').disabled).toBe(false);
    assertNoHistory();
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[applied, failed, submitting, unknown]}
        />,
      ),
    );
    assertUnknown(f.main);
    await f.addPreset('DeepSeek');
    expect(f.button('保存提供商配置').disabled).toBe(true);
    assertUnknown(f.panelHost);
    await f.click('编辑 OpenAI-compatible 1');
    expect(f.field('服务商预设')).toBeNull();
    expect(f.button('保存提供商配置').disabled).toBe(true);
    assertUnknown(f.panelHost);
    await f.click('删除 OpenAI-compatible 1');
    expect(f.field('服务商预设')).toBeNull();
    expect(f.button('确认删除提供商').disabled).toBe(true);
    assertUnknown(f.panelHost);
    await f.click('关闭');
    assertUnknown(f.main);
    await f.addPreset('DeepSeek');
    await f.click('查看结果');
    expect(calls.filter((call) => call.method === 'settings.providers.lookup')).toEqual([
      { method: 'settings.providers.lookup', generation: 1, commandId: unknown.commandId },
    ]);
    expect(f.element.querySelector('[aria-label="待确认的提供商更改"]')).toBeNull();
    expect(f.button('保存提供商配置').disabled).toBe(false);
    assertNoHistory();
    await f.click('关闭');
    expect(f.element.querySelector('[aria-label="待确认的提供商更改"]')).toBeNull();
    assertNoHistory();
  } finally {
    await f.close();
  }
});

test('Empty provider list opens the actual Add form with a native preset select that resets each draft', async () => {
  const f = fixture(),
    state = structuredClone(facts),
    calls: NativeRequest[] = [];
  for (const provider of state.providers) provider.connections = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      return input.method === 'settings.providers.read' ? structuredClone(state) : null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    expect(f.main.querySelectorAll('[aria-label="提供商列表"] li')).toHaveLength(0);
    expect(f.main.textContent).toContain('尚未添加提供商');
    for (const label of ['OpenAI', 'DeepSeek', 'Ollama', '自定义服务商'])
      expect(f.main.textContent).not.toContain(label);
    await f.click('添加第一个提供商');
    const form = f.panelHost.querySelector('form');
    const select = f.field<HTMLSelectElement>('服务商预设');
    expect(form).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('openai');
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ['openai', 'OpenAI'],
      ['deepseek', 'DeepSeek'],
      ['compatible', '自定义服务商'],
      ['ollama', 'Ollama'],
    ]);
    expect(f.panelHost.querySelectorAll('.provider-preset')).toHaveLength(0);
    expect(f.button('更换预设')).toBeUndefined();
    expect(f.button('选择 OpenAI')).toBeUndefined();
    expect(f.dom.window.document.activeElement).toBe(select);
    expect(f.field('提供商名称').value).toBe('OpenAI');
    expect(f.field('服务地址').value).toBe('https://api.openai.com/v1');
    expect(f.field('API 协议').value).toBe('chat-completions');
    for (const [id, label, url, credential] of [
      ['deepseek', 'DeepSeek', 'https://api.deepseek.com', 'replace'],
      ['openai', 'OpenAI', 'https://api.openai.com/v1', 'replace'],
      ['ollama', 'Ollama', 'http://localhost:11434/v1', 'none'],
      ['compatible', '自定义服务商', '', 'none'],
      ['openai', 'OpenAI', 'https://api.openai.com/v1', 'replace'],
    ]) {
      await f.edit('提供商名称', 'unsaved-name');
      await f.edit('服务地址', 'https://unsaved.invalid/v1');
      await f.edit('凭据处理', 'replace');
      await f.edit('API key', 'unsaved-secret');
      await f.edit('模型名称', 'unsaved-model');
      if (f.field('API 协议')) await f.edit('API 协议', 'responses');
      await f.edit('服务商预设', id!);
      expect(f.panelHost.querySelector('form')).toBe(form);
      expect(f.field('服务商预设')).toBe(select);
      expect(f.dom.window.document.activeElement).toBe(select);
      expect(f.field('提供商名称').value).toBe(label!);
      expect(f.field('服务地址').value).toBe(url!);
      expect(f.field('凭据处理').value).toBe(credential!);
      expect(f.field('API key')?.value ?? '').toBe('');
      expect(f.field('模型名称').value).toBe('');
      if (id === 'openai' || id === 'compatible')
        expect(f.field('API 协议').value).toBe('chat-completions');
      else expect(f.field('API 协议')).toBeNull();
      expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(0);
    }
    await f.click('取消');
    expect(f.panelHost.childElementCount).toBe(0);
    expect(f.dom.window.document.activeElement).toBe(f.button('添加第一个提供商'));
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
  } finally {
    await f.close();
  }
});

test('Named instances of one preset remain separate even at the same endpoint; edit keeps exact identity', async () => {
  const f = fixture(),
    state = structuredClone(facts),
    saves: Extract<NativeRequest, { method: 'settings.providers.save' }>[] = [];
  for (const provider of state.providers) provider.connections = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      if (input.method === 'settings.providers.read') return structuredClone(state);
      if (input.method === 'settings.providers.save') {
        saves.push(input);
        const provider = state.providers.find((entry) => entry.id === input.operation.provider)!;
        const existing = provider.connections.find(
          (entry) => entry.id === input.operation.connectionId,
        );
        const entry = {
          id: existing?.id ?? `private-instance-${saves.length}`,
          name: input.operation.name,
          baseURL: input.operation.baseURL,
          modelNames: input.operation.modelNames,
          protocol: input.operation.protocol,
          hasCredential: true,
          canWrite: true,
        };
        if (existing) Object.assign(existing, entry);
        else provider.connections.push(entry);
        return {
          kind: 'settings.providers.submission',
          commandId: `named-${saves.length}`,
          storeId: 'store',
          observationId: 7,
          operation: input.operation,
          phase: 'applied',
        };
      }
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    for (const name of ['研发服务', '个人服务']) {
      await f.addPreset('DeepSeek');
      await f.edit('提供商名称', '');
      await f.click('保存提供商配置');
      expect(f.dom.window.document.activeElement).toBe(f.field('提供商名称'));
      await f.edit('提供商名称', name);
      await f.edit('API key', `fixture-secret-${name}`);
      await f.edit('模型名称', 'deepseek-chat');
      await f.click('保存提供商配置');
    }
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(2);
    expect(saves.map((save) => save.operation.connectionId)).toEqual([null, null]);
    expect(new Set(saves.map((save) => save.operation.baseURL)).size).toBe(1);
    expect(f.main.querySelector('[aria-label="提供商列表"]')!.textContent).not.toContain(
      'private-instance',
    );
    await f.click('编辑 个人服务');
    expect(f.field('提供商名称').value).toBe('个人服务');
    expect(f.field('凭据处理').value).toBe('keep');
    await f.edit('提供商名称', '个人服务改名');
    await f.click('保存提供商配置');
    expect(saves.at(-1)!.operation.connectionId).toBe('private-instance-2');
    expect(saves.at(-1)!.operation.name).toBe('个人服务改名');
    expect(saves.at(-1)!.secret).toBeUndefined();
    expect(f.button('编辑 研发服务')).toBeDefined();
    expect(f.button('编辑 个人服务改名')).toBeDefined();
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const impact of ['default', 'schedule', 'both'] as const) {
  test(`Deletion confirms model and ${impact} impact and blocks referenced instances without sending`, async () => {
    const f = fixture(),
      state = structuredClone(facts),
      calls: NativeRequest[] = [];
    const connection = state.providers[2]!.connections[0]!;
    connection.name = '生产服务';
    connection.modelNames = ['model-a', 'model-b'];
    connection.modelIds = ['private-model-a', 'private-model-b'];
    if (impact !== 'schedule') connection.defaultModelIds = ['private-model-a'];
    if (impact !== 'default') connection.scheduledTaskNames = ['每日报告', '每周总结'];
    const bridge: NativeBridge = {
      watch: () => () => {},
      request: async (input) => {
        calls.push(input);
        return input.method === 'settings.providers.read' ? structuredClone(state) : null;
      },
    };
    try {
      await act(async () =>
        f.root.render(
          <NativeProviderSettings
            panelHost={f.panelHost}
            bridge={bridge}
            generation={1}
            submissions={[]}
          />,
        ),
      );
      const origin = f.button('删除 生产服务');
      await f.click('删除 生产服务');
      expect(f.panelHost.querySelector('form')!.getAttribute('aria-label')).toBe(
        '删除 生产服务 确认',
      );
      expect(f.panelHost.textContent).toContain('将删除 2 个关联模型');
      expect(f.panelHost.textContent).toContain('model-a');
      expect(f.panelHost.textContent).toContain('model-b');
      expect(f.panelHost.textContent).toContain('系统凭证库中的 API key 会保留');
      expect(f.panelHost.textContent).toContain('不会自动选择替代模型');
      expect(f.panelHost.textContent).not.toContain('private-model');
      expect(f.dom.window.document.activeElement).toBe(f.button('取消'));
      if (impact !== 'schedule')
        expect(f.panelHost.textContent).toContain('请先在“模型”设置中选择其他默认模型');
      if (impact !== 'default') {
        expect(f.panelHost.textContent).toContain('每日报告');
        expect(f.panelHost.textContent).toContain('每周总结');
        expect(f.panelHost.textContent).toContain('请先修改或删除这些任务');
      }
      expect(f.button('确认删除提供商').disabled).toBe(true);
      await act(async () => {
        f.panelHost
          .querySelector('form')!
          .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
      await f.click('取消');
      expect(f.dom.window.document.activeElement).toBe(origin);
      expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
}

test('Delete requires explicit confirmation, submits once without secret, refreshes list and focuses Add', async () => {
  const f = fixture(),
    state = structuredClone(facts),
    calls: NativeRequest[] = [];
  state.providers[2]!.connections[0]!.name = '可删除服务';
  let release!: () => void;
  let applied = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') return structuredClone(state);
      if (input.method === 'settings.providers.save') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        state.providers[2]!.connections = state.providers[2]!.connections.filter(
          (entry) => entry.id !== input.operation.connectionId,
        );
        return {
          kind: 'settings.providers.submission',
          commandId: 'remove-once',
          storeId: 'store',
          observationId: 7,
          operation: input.operation,
          phase: 'applied',
          configurationState: 'published',
        };
      }
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
          onSaved={() => applied++}
        />,
      ),
    );
    await f.click('删除 可删除服务');
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
    expect(f.field('API key')).toBeNull();
    expect(f.panelHost.textContent).toContain('不影响当前全局默认模型');
    expect(f.panelHost.textContent).toContain('没有定时任务引用');
    await f.click('取消');
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
    await f.click('删除 可删除服务');
    await act(async () => {
      f.button('确认删除提供商').click();
      f.button('确认删除提供商').click();
    });
    expect(calls.filter((call) => call.method === 'settings.providers.save')).toEqual([
      {
        method: 'settings.providers.save',
        generation: 1,
        observationId: 7,
        operation: {
          kind: 'remove',
          provider: 'compatible',
          connectionId: 'one',
          protocol: 'chat-completions',
          baseURL: 'https://one.invalid/v1',
          modelNames: [],
          credential: 'none',
        },
      },
    ]);
    expect(f.button('正在删除…').disabled).toBe(true);
    await act(async () => release());
    expect(applied).toBe(1);
    expect(f.panelHost.childElementCount).toBe(0);
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(1);
    expect(f.main.querySelector('[aria-label="提供商列表"]')!.textContent).not.toContain(
      '可删除服务',
    );
    expect(f.main.textContent).toContain('已删除提供商。');
    expect(f.main.textContent).not.toContain('连接及其模型配置已删除，凭证库中的密钥保留。');
    expect(f.dom.window.document.activeElement === f.button('新增提供商')).toBe(true);
    expect(calls.filter((call) => call.method === 'settings.providers.read')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const outcome of ['failed', 'unknown'] as const) {
  test(`Delete ${outcome} preserves its confirmation and never chooses a fallback`, async () => {
    const f = fixture(),
      calls: NativeRequest[] = [];
    const bridge: NativeBridge = {
      watch: () => () => {},
      request: async (input) => {
        calls.push(input);
        if (input.method === 'settings.providers.read') return structuredClone(facts);
        if (input.method === 'settings.providers.save')
          return {
            kind: 'settings.providers.submission',
            commandId: 'remove-outcome',
            storeId: 'store',
            observationId: 7,
            operation: input.operation,
            phase: outcome,
            ...(outcome === 'failed' ? { error: 'configuration_conflict' } : {}),
          };
        return null;
      },
    };
    try {
      await act(async () =>
        f.root.render(
          <NativeProviderSettings
            panelHost={f.panelHost}
            bridge={bridge}
            generation={1}
            submissions={[]}
          />,
        ),
      );
      await f.click('删除 OpenAI-compatible 1');
      await f.click('确认删除提供商');
      expect(f.panelHost.querySelector('form')!.getAttribute('aria-label')).toBe(
        '删除 OpenAI-compatible 1 确认',
      );
      expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(2);
      expect(f.panelHost.textContent).toContain(
        outcome === 'failed' ? '删除失败：configuration_conflict' : '删除结果待确认',
      );
      expect(f.button('确认删除提供商').disabled).toBe(outcome === 'unknown');
      expect(calls.filter((call) => call.method === 'settings.providers.save')).toHaveLength(1);
      expect(calls.every((call) => call.method.startsWith('settings.providers.'))).toBe(true);
    } finally {
      await f.close();
    }
  });
}

for (const outcome of ['applied', 'failed', 'unknown', 'throw'] as const) {
  test(`Late delete ${outcome} cannot close or overwrite a newer instance editor`, async () => {
    const f = fixture();
    let release!: () => void;
    const bridge: NativeBridge = {
      watch: () => () => {},
      request: async (input) => {
        if (input.method === 'settings.providers.read') return structuredClone(facts);
        if (input.method === 'settings.providers.save') {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (outcome === 'throw') throw Error('late_delete_failed');
          return {
            kind: 'settings.providers.submission',
            commandId: 'late-delete',
            storeId: 'store',
            observationId: 7,
            operation: input.operation,
            phase: outcome,
            ...(outcome === 'failed' ? { error: 'late_delete_failed' } : {}),
          };
        }
        return null;
      },
    };
    try {
      await act(async () =>
        f.root.render(
          <NativeProviderSettings
            panelHost={f.panelHost}
            bridge={bridge}
            generation={1}
            submissions={[]}
          />,
        ),
      );
      await f.click('删除 OpenAI-compatible 1');
      await f.click('确认删除提供商');
      await f.click('编辑 OpenAI-compatible 2');
      await act(async () => release());
      expect(f.panelHost.querySelector('form')!.getAttribute('aria-label')).toBe(
        'OpenAI-compatible 2 配置',
      );
      expect(f.field('提供商名称').value).toBe('OpenAI-compatible 2');
      expect(f.field('服务地址').value).toBe('https://two.invalid/v1');
      expect(f.panelHost.textContent).not.toContain('late_delete_failed');
      expect(f.panelHost.textContent).not.toContain('late-delete');
      expect(f.panelHost.textContent).not.toContain('已删除提供商');
      expect(f.button('保存提供商配置').disabled).toBe(outcome === 'unknown');
    } finally {
      await f.close();
    }
  });
}

test('Refresh removing an edited instance cannot turn stale form into a new writable connection', async () => {
  const f = fixture(),
    state = structuredClone(facts),
    calls: NativeRequest[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      return input.method === 'settings.providers.read' ? structuredClone(state) : null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.click('编辑 OpenAI-compatible 1');
    state.providers[2]!.connections.shift();
    await f.click('刷新提供商配置');
    expect(f.panelHost.textContent).toContain('此提供商已不在最新配置中');
    expect(f.panelHost.querySelector('form')).toBeNull();
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
    await f.click('返回列表');
    expect(f.panelHost.childElementCount).toBe(0);
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const dismissal of ['close', 'unmount', 'generation'] as const) {
  test(`An in-flight delete after ${dismissal} cannot reopen a dismissed rail or notify a replaced view`, async () => {
    const f = fixture();
    let release!: () => void;
    let applied = 0;
    const bridge: NativeBridge = {
      watch: () => () => {},
      request: async (input) => {
        if (input.method === 'settings.providers.read') return structuredClone(facts);
        if (input.method === 'settings.providers.save') {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            kind: 'settings.providers.submission',
            commandId: 'dismissed-delete',
            storeId: 'store',
            observationId: 7,
            operation: input.operation,
            phase: 'applied',
          };
        }
        return null;
      },
    };
    const render = (generation: number) =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={generation}
          submissions={[]}
          onSaved={() => applied++}
        />,
      );
    try {
      await act(async () => render(1));
      await f.click('删除 OpenAI-compatible 1');
      await f.click('确认删除提供商');
      if (dismissal === 'close') await f.click('关闭');
      else if (dismissal === 'unmount') await act(async () => f.root.unmount());
      else await act(async () => render(2));
      await act(async () => release());
      expect(f.panelHost.childElementCount).toBe(0);
      expect(applied).toBe(dismissal === 'close' ? 1 : 0);
      expect(f.main.textContent).not.toContain('dismissed-delete');
      expect(f.main.textContent).not.toContain('已删除提供商。');
    } finally {
      await f.close();
    }
  });
}

test('Repeated Add submission is synchronously blocked while its original request is pending', async () => {
  const f = fixture(),
    calls: NativeRequest[] = [];
  let release!: () => void;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') return structuredClone(facts);
      if (input.method === 'settings.providers.save') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          kind: 'settings.providers.submission',
          commandId: 'duplicate-add',
          storeId: 'store',
          observationId: 7,
          operation: input.operation,
          phase: 'failed',
          error: 'configuration_conflict',
        };
      }
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.addPreset('Ollama');
    await f.edit('模型名称', 'fixture-model');
    await act(async () => {
      f.button('保存提供商配置').click();
      f.button('保存提供商配置').click();
    });
    expect(calls.filter((call) => call.method === 'settings.providers.save')).toHaveLength(1);
    await act(async () => release());
    expect(f.button('保存提供商配置').disabled).toBe(false);
    expect(f.field('模型名称').value).toBe('fixture-model');
  } finally {
    await f.close();
  }
});

test('Refreshing an externally changed endpoint preserves the draft but cannot rebase it onto a newer write observation', async () => {
  const f = fixture(),
    state = structuredClone(facts),
    calls: NativeRequest[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') return structuredClone(state);
      if (input.method === 'settings.providers.save')
        return {
          kind: 'settings.providers.submission',
          commandId: 'safe-refresh',
          storeId: 'store',
          observationId: input.observationId,
          operation: input.operation,
          phase: 'failed',
          error: 'test_only_no_effect',
        };
      return null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.click('编辑 OpenAI-compatible 1');
    await f.edit('提供商名称', 'My label');
    await f.edit('模型名称', 'my-unsaved-model');
    state.observationId = 8;
    state.providers[2]!.connections[0]!.baseURL = 'https://externally-updated.invalid/v1';
    await f.click('刷新提供商配置');
    expect(f.field('提供商名称').value).toBe('My label');
    expect(f.field('模型名称').value).toBe('my-unsaved-model');
    expect(f.field('服务地址').value).toBe('https://one.invalid/v1');
    expect(f.panelHost.textContent).toContain('已重新读取配置，当前草稿已保留');
    expect(f.panelHost.textContent).toContain('请从列表重新打开此提供商');
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await act(async () => {
      f.panelHost
        .querySelector('form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
    await f.click('编辑 OpenAI-compatible 1');
    expect(f.field('服务地址').value).toBe('https://externally-updated.invalid/v1');
    expect(f.field('提供商名称').value).toBe('OpenAI-compatible 1');
    expect(f.field('模型名称').value).toBe('remote-one');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    expect(f.panelHost.textContent).not.toContain('已重新读取配置');
    await f.click('保存提供商配置');
    const saves = calls.filter((call) => call.method === 'settings.providers.save');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.observationId).toBe(8);
    expect(saves[0]!.operation.baseURL).toBe('https://externally-updated.invalid/v1');
  } finally {
    await f.close();
  }
});

for (const changed of [
  'name',
  'protocol',
  'models',
  'modelIds',
  'credential',
  'default',
] as const) {
  test(`A changed ${changed} snapshot blocks an initialized draft until explicit reopening`, async () => {
    const f = fixture(),
      state = structuredClone(facts),
      calls: NativeRequest[] = [];
    const bridge: NativeBridge = {
      watch: () => () => {},
      request: async (input) => {
        calls.push(input);
        return input.method === 'settings.providers.read' ? structuredClone(state) : null;
      },
    };
    try {
      await act(async () =>
        f.root.render(
          <NativeProviderSettings
            panelHost={f.panelHost}
            bridge={bridge}
            generation={1}
            submissions={[]}
          />,
        ),
      );
      await f.click('编辑 OpenAI-compatible 1');
      await f.edit('提供商名称', 'unsaved-label');
      const connection = state.providers[2]!.connections[0]!;
      state.observationId++;
      if (changed === 'name') connection.name = 'external-label';
      if (changed === 'protocol') connection.protocol = 'responses';
      if (changed === 'models') connection.modelNames = ['external-model'];
      if (changed === 'modelIds') connection.modelIds = ['external-model-id'];
      if (changed === 'credential') connection.hasCredential = false;
      if (changed === 'default') connection.defaultModelIds = ['new-default-model-id'];
      await f.click('刷新提供商配置');
      expect(f.field('提供商名称').value).toBe('unsaved-label');
      expect(f.button('保存提供商配置').disabled).toBe(true);
      expect(f.panelHost.textContent).toContain('已重新读取配置，当前草稿已保留');
      await f.click('保存提供商配置');
      expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
      await f.click(`编辑 ${connection.name ?? 'OpenAI-compatible 1'}`);
      expect(f.button('保存提供商配置').disabled).toBe(false);
      expect(f.panelHost.textContent).not.toContain('已重新读取配置');
    } finally {
      await f.close();
    }
  });
}

test('Every new observation locks existing drafts even when credentials and public facts look unchanged; Add remains independent', async () => {
  const f = fixture(),
    state = structuredClone(facts),
    calls: NativeRequest[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      return input.method === 'settings.providers.read' ? structuredClone(state) : null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.click('编辑 OpenAI-compatible 1');
    await f.edit('提供商名称', 'unsaved-name');
    await f.edit('服务地址', 'https://draft-endpoint.invalid/v1');
    // A credential reference can change in the host without changing hasCredential or any public field.
    state.observationId++;
    await f.click('刷新提供商配置');
    expect(f.field('提供商名称').value).toBe('unsaved-name');
    expect(f.field('服务地址').value).toBe('https://draft-endpoint.invalid/v1');
    expect(f.field('凭据处理').value).toBe('keep');
    expect(f.button('保存提供商配置').disabled).toBe(true);
    expect(f.panelHost.textContent).toContain('已重新读取配置，当前草稿已保留');
    await act(async () => {
      f.panelHost
        .querySelector('form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
    await f.click('编辑 OpenAI-compatible 1');
    expect(f.field('服务地址').value).toBe('https://one.invalid/v1');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    await f.addPreset('OpenAI');
    await f.edit('提供商名称', 'new-connection');
    await f.edit('API key', 'explicit-new-secret');
    state.observationId++;
    await f.click('刷新提供商配置');
    expect(f.field('提供商名称').value).toBe('new-connection');
    expect(f.field('API key').value).toBe('explicit-new-secret');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    expect(f.panelHost.textContent).not.toContain('已重新读取配置');
  } finally {
    await f.close();
  }
});

test('A refreshed deletion confirmation requires reopening and always shows current task/default guards', async () => {
  const f = fixture(),
    state = structuredClone(facts),
    calls: NativeRequest[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      return input.method === 'settings.providers.read' ? structuredClone(state) : null;
    },
  };
  try {
    await act(async () =>
      f.root.render(
        <NativeProviderSettings
          panelHost={f.panelHost}
          bridge={bridge}
          generation={1}
          submissions={[]}
        />,
      ),
    );
    await f.click('删除 OpenAI-compatible 1');
    expect(f.button('确认删除提供商').disabled).toBe(false);
    state.observationId++;
    state.providers[2]!.connections[0]!.scheduledTaskNames = ['new-task'];
    await f.click('刷新提供商配置');
    expect(f.button('确认删除提供商').disabled).toBe(true);
    expect(f.panelHost.textContent).toContain('new-task');
    expect(f.panelHost.textContent).toContain('请从列表重新打开此提供商，重新确认删除影响');
    await f.click('删除 OpenAI-compatible 1');
    expect(f.button('确认删除提供商').disabled).toBe(true);
    expect(f.panelHost.textContent).not.toContain('已重新读取配置');
    state.observationId++;
    state.providers[2]!.connections[0]!.scheduledTaskNames = [];
    await f.click('刷新提供商配置');
    expect(f.button('确认删除提供商').disabled).toBe(true);
    expect(f.panelHost.textContent).not.toContain('new-task');
    await f.click('删除 OpenAI-compatible 1');
    expect(f.button('确认删除提供商').disabled).toBe(false);
    state.observationId++;
    state.providers[2]!.connections[0]!.defaultModelIds = ['new-global-default'];
    await f.click('刷新提供商配置');
    expect(f.button('确认删除提供商').disabled).toBe(true);
    expect(f.panelHost.textContent).toContain('请从列表重新打开此提供商，重新确认删除影响');
    expect(f.panelHost.textContent).toContain('当前全局默认模型');
    expect(calls.some((call) => call.method === 'settings.providers.save')).toBe(false);
  } finally {
    await f.close();
  }
});

function unknownDeletionFixture(
  options: { beforeLookup?: () => Promise<void>; beforeReread?: () => Promise<void> } = {},
) {
  const f = fixture(),
    calls: NativeRequest[] = [];
  const state = structuredClone(facts);
  const data = memoryPrivateData();
  state.providers[2]!.connections[0]!.id = 'a'.repeat(64);
  state.providers[2]!.connections[0]!.name = 'Deleted connection';
  state.providers[2]!.connections[1]!.name = 'Other connection';
  const readSet = {
    userEtag: 'b'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'c'.repeat(64),
    effectiveDigest: 'd'.repeat(64),
  };
  let removed = false,
    reads = 0,
    posts = 0,
    saved = 0;
  let submitted!: ProviderSettingsRequest;
  const receipt = (status: 'applied' | 'outcome_unknown'): HostMutation => ({
    commandId: submitted.commandId,
    originStoreId: 'store',
    scope: 'user',
    ifMatch: submitted.expectedReadSet.userEtag,
    kind: 'provider_settings.update',
    providerSettings: {
      expectedReadSet: submitted.expectedReadSet,
      operation: submitted.operation,
    },
    state: status,
    receipt:
      status === 'applied'
        ? {
            status: 'applied',
            etag: 'e'.repeat(64),
            credentialState: 'unchanged',
            configurationState: 'published',
          }
        : {
            status: 'outcome_unknown',
            code: 'network_outcome_unknown',
            credentialState: 'unchanged',
            configurationState: 'outcome_unknown',
          },
  });
  const manager = new ProviderManager(
    {
      getProviderSettings: async () => {
        if (++reads > 1) await options.beforeReread?.();
        const view = structuredClone(state);
        if (removed) view.providers[2]!.connections.shift();
        return { ...view, readSet };
      },
      updateProviderSettings: async (input: ProviderSettingsRequest) => {
        submitted = input;
        posts++;
        removed = true;
        return receipt('outcome_unknown');
      },
      getHostMutation: async () => {
        await options.beforeLookup?.();
        return receipt('applied');
      },
    } as unknown as AgentClient,
    () => ({ generation: 1, selection: 1, storeId: 'store' }),
    () => {},
    data,
  );
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.providers.read') return manager.read();
      if (input.method === 'settings.providers.save')
        return manager.submit(input.observationId, input.operation, input.secret);
      if (input.method === 'settings.providers.lookup') return manager.lookup(input.commandId);
      if (input.method === 'settings.providers.close') manager.cancelRead();
      return null;
    },
  };
  return {
    ...f,
    calls,
    manager,
    counts: () => ({ reads, posts, saved }),
    async close() {
      try {
        await f.close();
      } finally {
        data.close();
      }
    },
    async render(generation = 1) {
      await act(async () =>
        f.root.render(
          <NativeProviderSettings
            panelHost={f.panelHost}
            bridge={bridge}
            generation={generation}
            submissions={[]}
            onSaved={() => saved++}
          />,
        ),
      );
    },
    async remove() {
      await f.click('删除 Deleted connection');
      await f.click('确认删除提供商');
      expect(manager.submissions[0]!.phase).toBe('unknown');
    },
  };
}

test('Original unknown deletion confirmed by Main refreshes facts, closes its panel and never submits twice', async () => {
  const f = unknownDeletionFixture();
  try {
    await f.render();
    await f.remove();
    await f.click('查看结果');
    expect(f.manager.submissions[0]!.phase).toBe('applied');
    expect(f.counts()).toEqual({ reads: 2, posts: 1, saved: 1 });
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(1);
    expect(f.main.textContent).not.toContain('Deleted connection');
    expect(f.panelHost.childElementCount).toBe(0);
    expect(f.button('确认删除提供商')).toBeUndefined();
    expect(f.button('查看结果')).toBeUndefined();
    expect(f.dom.window.document.activeElement).toBe(f.button('新增提供商'));
  } finally {
    await f.close();
  }
});

test('Confirmed unknown deletion keeps a refresh failure read-only and allows an explicit reread without another POST', async () => {
  let fail = true;
  const f = unknownDeletionFixture({
    beforeReread: async () => {
      if (fail) throw Error('configuration_unavailable');
    },
  });
  try {
    await f.render();
    await f.remove();
    await f.click('查看结果');
    expect(f.manager.submissions[0]!.phase).toBe('applied');
    expect(f.panelHost.textContent).toContain('已删除，刷新配置失败；请刷新列表，无需重复删除。');
    expect(f.button('确认删除提供商').disabled).toBe(true);
    await f.click('确认删除提供商');
    fail = false;
    await f.click('刷新提供商配置');
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(1);
    expect(f.counts()).toEqual({ reads: 3, posts: 1, saved: 1 });
  } finally {
    await f.close();
  }
});

for (const stage of ['lookup', 'after-lookup read'] as const) {
  for (const next of [
    'same instance',
    'other instance',
    'close',
    'generation',
    'unmount',
  ] as const) {
    test(`Original deletion ${stage} cannot close, overwrite or refocus a later ${next}`, async () => {
      let release!: () => void;
      let pending = true;
      const wait = () => {
        if (!pending) return Promise.resolve();
        pending = false;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      const f = unknownDeletionFixture(
        stage === 'lookup' ? { beforeLookup: wait } : { beforeReread: wait },
      );
      try {
        await f.render();
        await f.remove();
        await f.click('查看结果');
        expect(f.counts().reads).toBe(stage === 'lookup' ? 1 : 2);
        if (next === 'unmount') await act(async () => f.root.render(null));
        else if (next === 'generation') await f.render(2);
        else if (next === 'close') await f.click('关闭');
        else {
          await f.click(
            `编辑 ${next === 'same instance' ? 'Deleted connection' : 'Other connection'}`,
          );
          await f.edit('提供商名称', 'Keep this newer draft');
        }
        if (next === 'same instance' && stage === 'after-lookup read') f.button('关闭').focus();
        const focus = f.dom.window.document.activeElement;
        await act(async () => release());
        expect(f.manager.submissions[0]!.phase).toBe('applied');
        expect(f.counts().posts).toBe(1);
        if (next === 'same instance' && stage === 'after-lookup read') {
          expect(f.panelHost.textContent).toContain('此提供商已不在最新配置中');
          expect(f.panelHost.querySelector('form')).toBeNull();
          expect(f.button('返回列表')).toBeDefined();
        } else if (next === 'same instance' || next === 'other instance') {
          expect(f.field('提供商名称').value).toBe('Keep this newer draft');
          expect(f.panelHost.querySelector('form')).not.toBeNull();
          expect(f.panelHost.textContent).not.toContain('已删除提供商。');
        } else expect(f.panelHost.childElementCount).toBe(0);
        expect(f.dom.window.document.activeElement).toBe(focus);
      } finally {
        await f.close();
      }
    });
  }
}

test('Querying an original deletion from another instance refreshes the list without closing that editor', async () => {
  const f = unknownDeletionFixture();
  try {
    await f.render();
    await f.remove();
    await f.click('编辑 Other connection');
    await f.edit('提供商名称', 'Keep other draft');
    await f.click('查看结果');
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(1);
    expect(f.field('提供商名称').value).toBe('Keep other draft');
    expect(f.panelHost.querySelector('form')).not.toBeNull();
    expect(f.counts()).toEqual({ reads: 2, posts: 1, saved: 1 });
  } finally {
    await f.close();
  }
});

test('Querying an unknown deletion from the closed list refreshes it without reopening an editor', async () => {
  const f = unknownDeletionFixture();
  try {
    await f.render();
    await f.remove();
    await f.click('关闭');
    await f.click('查看结果');
    expect(f.main.querySelectorAll('.provider-instance')).toHaveLength(1);
    expect(f.panelHost.childElementCount).toBe(0);
    expect(f.main.textContent).toContain('已删除提供商。');
    expect(f.counts()).toEqual({ reads: 2, posts: 1, saved: 1 });
  } finally {
    await f.close();
  }
});
