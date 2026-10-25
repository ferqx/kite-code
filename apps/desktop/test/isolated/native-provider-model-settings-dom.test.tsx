import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeModelSettingsSubmission,
  NativeProviderSettingsFacts,
  NativeProviderSubmission,
  NativeRequest,
  NativeSelection,
} from '../../src/native-bridge';
import { nativeModelToggleQueue } from '../../src/native-model-toggle-queue';
import { prepareDesktopDom } from '../native-page-dom.fixture';

// Import the real dropdown in a browser environment, as in the model settings tests.
const bootstrap = new JSDOM('<!doctype html><div></div>', { pretendToBeVisual: true });
const bootstrapPrior = {
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
const { NativeProviderModelSettings } = await import('../../src/native-provider-model-settings');
Object.assign(globalThis, bootstrapPrior);
bootstrap.window.close();

function configuration() {
  const providers: NativeProviderSettingsFacts = {
    kind: 'settings.providers',
    observationId: 7,
    storeId: 'store',
    canWrite: true,
    errors: [],
    providers: [
      {
        id: 'compatible',
        label: 'Compatible',
        defaultBaseURL: 'https://same.invalid/v1',
        requiresCredential: false,
        connections: [
          {
            id: 'connection-a',
            name: 'Same service',
            baseURL: 'https://same.invalid/v1',
            hasCredential: true,
            modelNames: ['same-model'],
            modelIds: ['a'],
            defaultModelIds: ['a'],
            canWrite: true,
          },
          {
            id: 'connection-b',
            name: 'Same service',
            baseURL: 'https://same.invalid/v1',
            hasCredential: true,
            modelNames: ['same-model'],
            modelIds: ['b', 'a'],
            defaultModelIds: [],
            canWrite: true,
          },
        ],
      },
    ],
  };
  const models: NativeModelSettingsFacts = {
    kind: 'settings.models',
    observationId: 11,
    storeId: 'store',
    scope: 'user',
    canWrite: true,
    errors: [],
    defaultModelId: 'a',
    models: [
      {
        id: 'a',
        provider: 'compatible',
        model: 'same-model',
        enabled: true,
        configured: true,
        diagnostics: [],
      },
      {
        id: 'b',
        provider: 'compatible',
        model: 'same-model',
        enabled: true,
        configured: true,
        diagnostics: [],
      },
      {
        id: 'unmapped',
        provider: 'compatible',
        model: 'unmapped-model',
        enabled: false,
        configured: true,
        diagnostics: [],
      },
    ],
  };
  return { providers, models };
}
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
  const dom = new JSDOM(
    '<!doctype html><div id="settings" class="desktop-settings"><main id="root" class="settings-content"></main><div id="panel"></div></div>',
    {
      url: 'http://localhost',
      pretendToBeVisual: true,
    },
  );
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restoreLayout = prepareDesktopDom(dom);
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const element = dom.window.document.getElementById('settings')!;
  const panelHost = dom.window.document.getElementById('panel')!;
  const root = createRoot(dom.window.document.getElementById('root')!);
  const calls: NativeRequest[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      return request(input);
    },
  };
  let saved = 0;
  const selection = {
    storeId: 'store',
    session: { id: 'selected', workspaceId: 'w' },
    viewSelection: 1,
  } as NativeSelection;
  const button = (name: string) =>
    [...element.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.getAttribute('aria-label') === name || node.textContent === name,
    )!;
  const toggle = (id: string) =>
    element.querySelector<HTMLInputElement>(`[role="switch"][aria-label="启用模型 ${id}"]`)!;
  const field = (name: string) =>
    element.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[aria-label="${name}"]`,
    )!;
  const render = (
    providerSubmissions: NativeProviderSubmission[] = [],
    modelSubmissions: NativeModelSettingsSubmission[] = [],
  ) =>
    act(async () =>
      root.render(
        <NativeProviderModelSettings
          bridge={bridge}
          generation={1}
          selection={selection}
          storeId="store"
          providerSubmissions={providerSubmissions}
          modelSubmissions={modelSubmissions}
          onSaved={() => saved++}
          panelHost={panelHost}
        />,
      ),
    );
  return {
    dom,
    element,
    panelHost,
    calls,
    bridge,
    button,
    toggle,
    field,
    render,
    hide: () => act(async () => root.render(null)),
    openModels: async (label: string, index = 0) => {
      const catalog = [...element.querySelectorAll<HTMLButtonElement>('button')].filter(
        (entry) => entry.getAttribute('aria-label') === `管理 ${label} 的模型`,
      )[index]!;
      expect(catalog.disabled).toBe(false);
      if (catalog.getAttribute('aria-expanded') !== 'true')
        await act(async () => {
          catalog.dispatchEvent(
            new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }),
          );
          catalog.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      const popup = element.querySelector<HTMLElement>(
        `[role="dialog"][aria-label="${label} 的模型管理"]`,
      )!;
      expect(popup).not.toBeNull();
      expect(element.querySelectorAll('.connection-models-popover[role="dialog"]')).toHaveLength(1);
      return popup;
    },
    get saved() {
      return saved;
    },
    click: (name: string) => act(async () => button(name).click()),
    edit: (name: string, value: string) =>
      act(async () => {
        const input = field(name);
        const prototype =
          input.tagName === 'TEXTAREA'
            ? dom.window.HTMLTextAreaElement.prototype
            : input.tagName === 'SELECT'
              ? dom.window.HTMLSelectElement.prototype
              : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(
          new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
        );
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

test('one settings surface assigns same-name same-endpoint connections by exact model IDs once and retains unmapped models', async () => {
  const state = configuration();
  const f = fixture(async (input) =>
    input.method === 'settings.providers.read'
      ? structuredClone(state.providers)
      : input.method === 'settings.models.read'
        ? structuredClone(state.models)
        : null,
  );
  try {
    await f.render();
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(
      f.element.querySelectorAll('button[aria-label^="管理 "][aria-label$=" 的模型"]'),
    ).toHaveLength(3);
    const connections = [...f.element.querySelectorAll('.provider-instance')];
    expect(connections).toHaveLength(2);
    const first = await f.openModels('Same service', 0);
    expect(first.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(first.querySelector('[aria-label="启用模型 a"]')).not.toBeNull();
    expect(connections[0]!.contains(first)).toBe(false);
    expect(f.element.querySelector('.settings-content')!.contains(first)).toBe(false);
    const second = await f.openModels('Same service', 1);
    expect(first.isConnected).toBe(false);
    expect(second.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(second.querySelector('[aria-label="启用模型 b"]')).not.toBeNull();
    expect(second.querySelector('[aria-label="启用模型 a"]')).toBeNull();
    const other = await f.openModels('其他模型');
    expect(second.isConnected).toBe(false);
    expect(other.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(other.querySelector('[aria-label="启用模型 unmapped"]')).not.toBeNull();
    expect(f.toggle('unmapped').closest('.provider-instance')).toBeNull();
    expect(f.element.textContent).toContain('其他模型');
    expect(f.element.querySelector('.settings-model-current')).toBeNull();
    expect(f.element.querySelector('[aria-label="刷新提供商与模型配置"]')).toBeNull();
    expect(f.element.querySelector('[aria-label="重新读取提供商与模型配置"]')).toBeNull();
    expect(
      f.element.querySelectorAll(
        '[aria-label="默认模型"], [aria-label="选择默认模型"], [aria-label="搜索默认模型"], [aria-label^="设为默认 "]',
      ),
    ).toHaveLength(0);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.providers.read')).toHaveLength(1);
    expect(
      f.calls.some((input) =>
        ['settings.providers.save', 'settings.models.default', 'settings.models.enabled'].includes(
          input.method,
        ),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('models arriving before connection facts do not flash as unassigned rows', async () => {
  const state = configuration();
  const reading = deferred<NativeProviderSettingsFacts>();
  const f = fixture(async (input) =>
    input.method === 'settings.providers.read'
      ? reading.promise
      : input.method === 'settings.models.read'
        ? structuredClone(state.models)
        : null,
  );
  try {
    await f.render();
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(f.element.querySelector('.provider-other-models')).toBeNull();
    await act(async () => reading.resolve(state.providers));
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(
      (await f.openModels('Same service', 0)).querySelector('[aria-label="启用模型 a"]'),
    ).not.toBeNull();
    expect(
      (await f.openModels('Same service', 1)).querySelector('[aria-label="启用模型 b"]'),
    ).not.toBeNull();
    expect(
      (await f.openModels('其他模型')).querySelector('[aria-label="启用模型 unmapped"]'),
    ).not.toBeNull();
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a provider save synchronously excludes a peer model write and each applied change refreshes both exact configurations', async () => {
  const state = configuration();
  const saving = deferred<NativeProviderSubmission>();
  let savedProvider: NativeProviderSubmission | undefined;
  const f = fixture(async (input) => {
    if (input.method === 'settings.providers.read') return structuredClone(state.providers);
    if (input.method === 'settings.models.read') return structuredClone(state.models);
    if (input.method === 'settings.providers.save') {
      savedProvider = {
        kind: 'settings.providers.submission',
        commandId: 'provider-save',
        storeId: 'store',
        observationId: input.observationId,
        operation: input.operation,
        phase: 'applied',
      };
      return saving.promise;
    }
    if (input.method === 'settings.models.enabled') {
      state.models.models.find((model) => model.id === input.modelId)!.enabled = input.enabled;
      state.models.observationId++;
      state.providers.observationId++;
      return {
        kind: 'settings.models.submission',
        commandId: 'model-save',
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
    await f.openModels('其他模型');
    await act(async () =>
      f.element
        .querySelector<HTMLButtonElement>('.provider-instance button[aria-label^="编辑 "]')!
        .click(),
    );
    await f.edit('模型名称', 'same-model\nnew-route');
    await f.openModels('其他模型');
    await act(async () => {
      f.button('保存提供商配置').click();
      f.toggle('unmapped').click();
    });
    expect(f.calls.filter((input) => input.method === 'settings.providers.save')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(0);
    expect(f.toggle('unmapped').disabled).toBe(true);
    state.providers.providers[0]!.connections[0]!.modelIds = ['a', 'new-route'];
    state.providers.providers[0]!.connections[0]!.modelNames.push('new-route');
    state.models.models.push({
      id: 'new-route',
      provider: 'compatible',
      model: 'new-route',
      configured: true,
      enabled: true,
      diagnostics: [],
    });
    state.models.observationId++;
    state.providers.observationId++;
    await act(async () => saving.resolve(savedProvider!));
    await f.openModels('Same service', 0);
    expect(f.toggle('new-route')).not.toBeNull();
    expect(f.panelHost.querySelector('form')).toBeNull();
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(2);
    expect(f.calls.filter((input) => input.method === 'settings.providers.read')).toHaveLength(2);
    await act(async () =>
      f.element
        .querySelector<HTMLButtonElement>('.provider-instance button[aria-label^="编辑 "]')!
        .click(),
    );
    await f.openModels('Same service', 1);
    await act(async () => {
      f.toggle('b').click();
      f.button('保存提供商配置').click();
    });
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await f.openModels('Same service', 1);
    expect(f.toggle('b').checked).toBe(false);
    await f.openModels('Same service', 0);
    expect(f.toggle('a').disabled).toBe(false);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(3);
    expect(f.calls.filter((input) => input.method === 'settings.providers.read')).toHaveLength(3);
    await act(async () =>
      f.element
        .querySelectorAll<HTMLButtonElement>('.provider-instance button[aria-label^="删除 "]')[0]!
        .click(),
    );
    expect(f.button('确认删除提供商').disabled).toBe(true);
    expect(f.saved).toBe(2);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: state.models.observationId - 1,
        modelId: 'b',
        enabled: false,
      },
    ]);
    expect(f.calls.filter((input) => input.method === 'settings.providers.save')).toHaveLength(1);
  } finally {
    saving.resolve(savedProvider!);
    await f.close();
  }
});

for (const owner of ['provider', 'model'] as const) {
  test(`an unknown ${owner} change locks both settings areas until its original lookup applies without a second mutation`, async () => {
    const state = configuration();
    let providerSubmission: NativeProviderSubmission | undefined;
    let modelSubmission: NativeModelSettingsSubmission | undefined;
    const f = fixture(async (input) => {
      if (input.method === 'settings.providers.read') return structuredClone(state.providers);
      if (input.method === 'settings.models.read') return structuredClone(state.models);
      if (input.method === 'settings.providers.save') {
        providerSubmission = {
          kind: 'settings.providers.submission',
          commandId: 'original-provider',
          storeId: 'store',
          observationId: input.observationId,
          operation: input.operation,
          phase: 'unknown',
          credentialState: 'outcome_unknown',
          configurationState: 'outcome_unknown',
        };
        return providerSubmission;
      }
      if (input.method === 'settings.models.enabled') {
        modelSubmission = {
          kind: 'settings.models.submission',
          commandId: 'original-model',
          storeId: 'store',
          scope: 'user',
          observationId: input.observationId,
          operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
          phase: 'unknown',
        };
        return modelSubmission;
      }
      if (input.method === 'settings.providers.lookup') {
        state.providers.observationId++;
        state.models.observationId++;
        return { ...providerSubmission!, phase: 'applied', configurationState: 'published' };
      }
      if (input.method === 'settings.models.lookup') {
        state.models.models.find((model) => model.id === 'unmapped')!.enabled = true;
        state.providers.observationId++;
        state.models.observationId++;
        return { ...modelSubmission!, phase: 'applied' };
      }
      return null;
    });
    const editFirst = () =>
      act(async () =>
        f.element
          .querySelector<HTMLButtonElement>('.provider-instance button[aria-label^="编辑 "]')!
          .click(),
      );
    try {
      await f.render();
      await f.openModels('其他模型');
      if (owner === 'provider') {
        await editFirst();
        await f.openModels('其他模型');
        await f.click('保存提供商配置');
      } else await act(async () => f.toggle('unmapped').click());
      // Reopening this read-only popup must not authorize a peer write.
      await f.openModels('其他模型');
      // The local response must lock peers before a later Native state observation arrives.
      expect(f.toggle('unmapped').disabled).toBe(true);
      // Main may still publish the original unknown observation after a terminal local lookup.
      await f.render(
        providerSubmission ? [providerSubmission] : [],
        modelSubmission ? [modelSubmission] : [],
      );
      if (owner === 'model') await editFirst();
      expect(f.button('保存提供商配置').disabled).toBe(true);
      await f.click('关闭');
      await editFirst();
      expect(f.button('保存提供商配置').disabled).toBe(true);
      const notice = f.element.querySelector(
        `[aria-label="待确认的${owner === 'provider' ? '提供商' : '模型'}更改"]`,
      )!;
      expect(notice).not.toBeNull();
      expect(f.calls.some((input) => input.method.endsWith('.lookup'))).toBe(false);
      await act(async () => notice.querySelector<HTMLButtonElement>('button')!.click());
      const lookups = f.calls.filter(
        (input) =>
          input.method === `settings.${owner === 'provider' ? 'providers' : 'models'}.lookup`,
      );
      expect(lookups).toEqual([
        {
          method: owner === 'provider' ? 'settings.providers.lookup' : 'settings.models.lookup',
          generation: 1,
          commandId: owner === 'provider' ? 'original-provider' : 'original-model',
        },
      ]);
      await f.openModels('其他模型');
      expect(f.toggle('unmapped').disabled).toBe(false);
      expect(
        f.element.querySelector(
          `[aria-label="待确认的${owner === 'provider' ? '提供商' : '模型'}更改"]`,
        ),
      ).toBeNull();
      expect(
        f.calls.filter(
          (input) =>
            input.method === 'settings.providers.save' ||
            input.method === 'settings.models.enabled',
        ),
      ).toHaveLength(1);
      expect(f.calls.filter((input) => input.method === 'settings.providers.read')).toHaveLength(2);
      expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(2);
      expect(f.saved).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test('a failed peer refresh has no recovery button and reopening settings reads without repeating the save', async () => {
  const state = configuration();
  let modelReads = 0;
  const recovery = deferred<NativeModelSettingsFacts>();
  const f = fixture(async (input) => {
    if (input.method === 'settings.providers.read') return structuredClone(state.providers);
    if (input.method === 'settings.models.read') {
      if (++modelReads === 2) throw Error('peer_model_read_unavailable');
      if (modelReads === 3) return recovery.promise;
      return structuredClone(state.models);
    }
    if (input.method === 'settings.providers.save')
      return {
        kind: 'settings.providers.submission',
        commandId: 'saved-once',
        storeId: 'store',
        observationId: input.observationId,
        operation: input.operation,
        phase: 'applied',
      };
    return null;
  });
  try {
    await f.render();
    await f.openModels('其他模型');
    await act(async () =>
      f.element
        .querySelector<HTMLButtonElement>('.provider-instance button[aria-label^="编辑 "]')!
        .click(),
    );
    await f.click('保存提供商配置');
    expect(f.panelHost.querySelector('form')).toBeNull();
    await f.openModels('其他模型');
    expect(f.toggle('unmapped').disabled).toBe(true);
    expect(f.element.textContent).toContain('peer_model_read_unavailable');
    expect(f.calls.filter((input) => input.method === 'settings.providers.save')).toHaveLength(1);
    expect(f.saved).toBe(1);
    expect(f.element.querySelector('[aria-label="重新读取提供商与模型配置"]')).toBeNull();
    expect(f.element.querySelector('.provider-read-recovery')).toBeNull();
    await f.hide();
    await f.render();
    expect(modelReads).toBe(3);
    await act(async () => recovery.resolve(structuredClone(state.models)));
    expect(f.element.querySelector('[aria-label="重新读取提供商与模型配置"]')).toBeNull();
    await f.openModels('其他模型');
    expect(f.toggle('unmapped').disabled).toBe(false);
    expect(modelReads).toBe(3);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(3);
    expect(f.calls.filter((input) => input.method === 'settings.providers.read')).toHaveLength(3);
    expect(f.calls.filter((input) => input.method === 'settings.providers.save')).toHaveLength(1);
    expect(f.saved).toBe(1);
  } finally {
    recovery.resolve(structuredClone(state.models));
    await f.close();
  }
});

test('continuous toggles keep peer rows interactive through model continuation and provider flush, with fresh serial observations', async () => {
  const state = configuration();
  state.models.models.push({
    id: 'c',
    model: 'model-c',
    enabled: false,
    configured: true,
    diagnostics: [],
  });
  state.providers.providers[0]!.connections[1]!.modelIds!.push('c');
  const post = deferred<NativeModelSettingsSubmission>();
  const continuation = deferred<NativeModelSettingsFacts>();
  const peer = deferred<NativeProviderSettingsFacts>();
  let first: Extract<NativeRequest, { method: 'settings.models.enabled' }> | undefined;
  let headReleased = false;
  let posts = 0,
    continuations = 0,
    flushes = 0;
  const publish = (
    input: Extract<NativeRequest, { method: 'settings.models.enabled' }>,
    id: string,
  ): NativeModelSettingsSubmission => {
    state.models.models.find((model) => model.id === input.modelId)!.enabled = input.enabled;
    state.models.observationId++;
    state.providers.observationId++;
    return {
      kind: 'settings.models.submission',
      commandId: id,
      storeId: 'store',
      scope: 'user',
      observationId: input.observationId,
      operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
      phase: 'applied',
    };
  };
  const releaseFirst = () => {
    if (first && !headReleased) {
      headReleased = true;
      post.resolve(publish(first, 'continuous-1'));
    }
  };
  const f = fixture(async (input) => {
    if (input.method === 'settings.providers.read') {
      if (posts && ++flushes === 1) return peer.promise;
      return structuredClone(state.providers);
    }
    if (input.method === 'settings.models.read') {
      if (input.afterCommandId && ++continuations === 1) return continuation.promise;
      return structuredClone(state.models);
    }
    if (input.method === 'settings.models.enabled') {
      posts++;
      if (posts === 1) {
        first = input;
        return post.promise;
      }
      return publish(input, `continuous-${posts}`);
    }
    return null;
  });
  try {
    await f.render();
    await act(async () =>
      f.element
        .querySelectorAll<HTMLButtonElement>('.provider-instance button[aria-label^="编辑 "]')[1]!
        .click(),
    );
    const popup = await f.openModels('Same service', 1);
    const b = f.toggle('b'),
      c = f.toggle('c');
    await act(async () => b.click());
    expect(posts).toBe(1);
    expect(b.checked).toBe(false);
    expect(b.disabled).toBe(false);
    expect(c.disabled).toBe(false);
    await act(async () => b.click());
    await act(async () => c.click());
    expect(b.checked).toBe(true);
    expect(c.checked).toBe(true);
    expect(posts).toBe(1);
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await act(async () => releaseFirst());
    expect(continuations).toBe(1);
    expect(b.checked).toBe(true); // Old confirmed false must not cover the newer intent.
    expect(b.disabled).toBe(false);
    expect(c.disabled).toBe(false);
    await act(async () => b.click()); // Collapse the unsent compensation back to applied false.
    expect(b.checked).toBe(false);
    expect(posts).toBe(1);
    await act(async () => continuation.resolve(structuredClone(state.models)));
    expect(posts).toBe(2);
    expect(flushes).toBe(1);
    expect(c.checked).toBe(true);
    expect(b.disabled).toBe(false);
    expect(c.disabled).toBe(false);
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await act(async () => b.click()); // The peer GET must not interrupt a new intent.
    expect(b.checked).toBe(true);
    expect(posts).toBe(2);
    await act(async () => peer.resolve(structuredClone(state.providers)));
    expect(posts).toBe(3);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 11,
        modelId: 'b',
        enabled: false,
      },
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 12,
        modelId: 'c',
        enabled: true,
      },
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 13,
        modelId: 'b',
        enabled: true,
      },
    ]);
    expect(
      f.calls.filter((input) => input.method === 'settings.models.read' && input.afterCommandId),
    ).toEqual([
      {
        method: 'settings.models.read',
        generation: 1,
        scope: 'user',
        afterCommandId: 'continuous-1',
      },
      {
        method: 'settings.models.read',
        generation: 1,
        scope: 'user',
        afterCommandId: 'continuous-2',
      },
      {
        method: 'settings.models.read',
        generation: 1,
        scope: 'user',
        afterCommandId: 'continuous-3',
      },
    ]);
    expect(f.toggle('b')).toBe(b);
    expect(f.toggle('c')).toBe(c);
    expect(popup.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(b.checked && c.checked).toBe(true);
    expect(b.disabled || c.disabled).toBe(false);
    expect(state.models.models.find((model) => model.id === 'b')!.enabled).toBe(true);
    expect(state.models.models.find((model) => model.id === 'c')!.enabled).toBe(true);
    expect(f.saved).toBe(2);
    // Refresh revoked the open editor's old basis; it must not borrow the new read-set.
    expect(f.button('保存提供商配置').disabled).toBe(true);
    expect(f.calls.some((input) => input.method === 'settings.providers.save')).toBe(false);
  } finally {
    peer.resolve(structuredClone(state.providers));
    continuation.resolve(structuredClone(state.models));
    releaseFirst();
    await f.close();
  }
});

test('a sixty-model connection opens only a scrollable model list, retains its reading state and submits the exact original route', async () => {
  const state = configuration();
  const routes = Array.from({ length: 60 }, (_, index) => ({
    id: `route-${String(index).padStart(3, '0')}`,
    provider: 'compatible',
    model: `Remote Model ${String(index).padStart(2, '0')}`,
    enabled: index % 2 === 0,
    configured: true,
    diagnostics: [],
  }));
  state.models.models = routes;
  state.models.defaultModelId = routes[0]!.id;
  state.models.observationId = 41;
  state.providers.providers[0]!.connections = [
    {
      ...state.providers.providers[0]!.connections[0]!,
      name: 'Catalog service',
      modelIds: routes.map((model) => model.id),
      modelNames: routes.map((model) => model.model),
      defaultModelIds: [routes[0]!.id],
    },
  ];
  let original: NativeModelSettingsSubmission | undefined;
  const f = fixture(async (input) => {
    if (input.method === 'settings.providers.read') return structuredClone(state.providers);
    if (input.method === 'settings.models.read') return structuredClone(state.models);
    if (input.method === 'settings.models.enabled') {
      original = {
        kind: 'settings.models.submission',
        commandId: 'catalog-original',
        storeId: 'store',
        scope: 'user',
        observationId: input.observationId,
        operation: { kind: 'enabled', modelId: input.modelId, enabled: input.enabled },
        phase: 'unknown',
      };
      return original;
    }
    if (input.method === 'settings.models.lookup') {
      state.models.models.find((model) => model.id === 'route-059')!.enabled = true;
      state.models.observationId++;
      state.providers.observationId++;
      return { ...original!, phase: 'applied' };
    }
    return null;
  });
  const switches = () => f.element.querySelectorAll('[role="switch"]');
  try {
    await f.render();
    const trigger = f.button('管理 Catalog service 的模型');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toContain('60 个模型 · 已启用 30 个');
    expect(switches()).toHaveLength(0);
    const popup = await f.openModels('Catalog service');
    expect(switches()).toHaveLength(60);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(
      popup.querySelector('input[type="search"], select, .connection-models-toolbar'),
    ).toBeNull();
    expect(popup.querySelector('[aria-label="搜索 Catalog service 的模型"]')).toBeNull();
    expect(popup.querySelector('[aria-label="筛选 Catalog service 的模型"]')).toBeNull();
    const viewport = popup.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"][aria-label="Catalog service 的模型列表"]',
    )!;
    expect(viewport.getAttribute('tabindex')).toBe('0');
    expect(f.dom.window.document.activeElement === viewport).toBe(true);
    const reads = f.calls.length;
    // JSDOM has no layout; retain a non-zero observed scroll position through the state transitions.
    await act(async () => {
      viewport.scrollTop = 1440;
      viewport.dispatchEvent(new f.dom.window.Event('scroll', { bubbles: true }));
    });
    expect(viewport.scrollTop).toBe(1440);
    expect(f.calls).toHaveLength(reads);
    const route = f.toggle('route-059');
    const row = route.closest('label');
    expect(route.checked).toBe(false);
    await act(async () => {
      route.focus({ preventScroll: true });
      route.click();
    });
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toEqual([
      {
        method: 'settings.models.enabled',
        generation: 1,
        observationId: 41,
        modelId: 'route-059',
        enabled: true,
      },
    ]);
    expect(switches()).toHaveLength(60);
    expect(f.toggle('route-059') === route).toBe(true);
    expect(route.closest('label') === row).toBe(true);
    expect(route.checked).toBe(true);
    expect(f.dom.window.document.activeElement === viewport).toBe(true);
    expect(viewport.scrollTop).toBe(1440);
    expect(f.toggle('route-059').disabled).toBe(true);
    expect(f.element.querySelector('.settings-model-current')).toBeNull();
    expect(f.calls.some((input) => input.method === 'settings.models.lookup')).toBe(false);
    expect(f.element.querySelector('[aria-label="刷新提供商与模型配置"]')).toBeNull();
    expect(f.element.querySelector('[aria-label="重新读取提供商与模型配置"]')).toBeNull();
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.providers.read')).toHaveLength(1);
    expect(f.button('管理 Catalog service 的模型') === trigger).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(popup.querySelector('[data-slot="scroll-area-viewport"]') === viewport).toBe(true);
    expect(viewport.scrollTop).toBe(1440);
    expect(switches()).toHaveLength(60);
    expect(f.toggle('route-059') === route).toBe(true);
    expect(f.toggle('route-059').disabled).toBe(true);
    const notice = f.element.querySelector('[aria-label="待确认的模型更改"]')!;
    await act(async () => notice.querySelector<HTMLButtonElement>('button')!.click());
    expect(f.calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: 'catalog-original' },
    ]);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(f.calls.filter((input) => input.method === 'settings.models.read')).toHaveLength(2);
    expect(f.calls.filter((input) => input.method === 'settings.providers.read')).toHaveLength(2);
    expect(popup.querySelector('[data-slot="scroll-area-viewport"]') === viewport).toBe(true);
    expect(viewport.scrollTop).toBe(1440);
    expect(switches()).toHaveLength(60);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(f.toggle('route-059') === route).toBe(true);
    expect(f.toggle('route-059').checked).toBe(true);
    expect(f.toggle('route-059').disabled).toBe(false);
    expect(trigger.textContent).toContain('60 个模型 · 已启用 31 个');
    expect(f.saved).toBe(1);
  } finally {
    await f.close();
  }
});

test('failed provider flush preserves applied model results and lets the accepted model queue continue', async () => {
  const state = configuration();
  const flush = deferred<void>();
  let posts = 0;
  const f = fixture(async (input) => {
    if (input.method === 'settings.providers.read') {
      if (posts) {
        await flush.promise;
        throw new Error('peer_model_read_unavailable');
      }
      return structuredClone(state.providers);
    }
    if (input.method === 'settings.models.read') return structuredClone(state.models);
    if (input.method === 'settings.models.enabled') {
      posts++;
      state.models.models.find((model) => model.id === input.modelId)!.enabled = input.enabled;
      state.models.observationId++;
      return {
        kind: 'settings.models.submission',
        commandId: 'applied-before-flush-failure',
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
    await f.openModels('Same service', 1);
    const b = f.toggle('b');
    await act(async () => b.click());
    expect(posts).toBe(1);
    expect(b.checked).toBe(false);
    expect(b.disabled).toBe(false);
    await act(async () => b.click());
    expect(b.checked).toBe(true);
    expect(posts).toBe(1);
    await act(async () => flush.resolve());
    expect(posts).toBe(2);
    expect(f.toggle('b').checked).toBe(true);
    expect(f.toggle('b').disabled).toBe(false);
    expect(state.models.models.find((model) => model.id === 'b')!.enabled).toBe(true);
    expect(f.saved).toBe(2);
    expect(f.element.textContent).toContain('peer_model_read_unavailable');
  } finally {
    flush.resolve();
    await f.close();
  }
});

function providerSyncClock() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let serial = 800000;
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if ([250, 1000, 3000, 10000].includes(delay ?? 0)) {
      const id = ++serial as unknown as ReturnType<typeof setTimeout>;
      timers.set(id, () => callback(...args));
      return id;
    }
    return originalSet(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    if (!timers.delete(id)) originalClear(id);
  }) as typeof clearTimeout;
  return {
    get pending() {
      return timers.size;
    },
    async fire() {
      const next = timers.entries().next().value;
      expect(next).not.toBeUndefined();
      timers.delete(next![0]);
      await act(async () => {
        next![1]();
        await Promise.resolve();
      });
    },
    close() {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
      timers.clear();
    },
  };
}

test('a model publication forces a newer Provider GET instead of borrowing an older automatic retry or rebasing a later draft', async () => {
  const clock = providerSyncClock();
  const state = configuration();
  const stale = deferred<NativeProviderSettingsFacts>();
  let reads = 0,
    posts = 0;
  let captured!: NativeProviderSettingsFacts;
  const f = fixture(async (input) => {
    if (input.method === 'settings.providers.read') {
      reads++;
      if (reads === 2) throw Error('peer_model_read_unavailable');
      if (reads === 3) {
        captured = structuredClone(state.providers);
        return stale.promise;
      }
      return structuredClone(state.providers);
    }
    if (input.method === 'settings.models.read') return structuredClone(state.models);
    if (input.method === 'settings.models.enabled') {
      posts++;
      state.models.models.find((model) => model.id === input.modelId)!.enabled = input.enabled;
      state.models.observationId++;
      if (posts === 2) {
        state.providers.providers[0]!.connections[1]!.name = 'Newest snapshot';
        state.providers.observationId = 20;
      }
      return {
        kind: 'settings.models.submission',
        commandId: `model-publication-${posts}`,
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
    await f.openModels('Same service', 1);
    const row = f.toggle('b');
    await act(async () => row.click());
    expect(posts).toBe(1);
    expect(row.checked).toBe(false);
    expect(row.disabled).toBe(false);
    expect(reads).toBe(2);
    expect(f.element.textContent).toContain('peer_model_read_unavailable');
    expect(clock.pending).toBe(1);
    await clock.fire();
    expect(reads).toBe(3);
    expect(clock.pending).toBe(0);
    expect(f.element.textContent).toContain('peer_model_read_unavailable');
    expect(row.disabled).toBe(false);
    await act(async () => row.click());
    expect(posts).toBe(2);
    expect(reads).toBe(4);
    expect(f.toggle('b') === row).toBe(true);
    expect(row.checked).toBe(true);
    expect(row.disabled).toBe(false);
    expect(f.element.textContent).not.toContain('peer_model_read_unavailable');
    expect(f.element.textContent).toContain('Newest snapshot');
    expect(f.saved).toBe(2);
    await act(async () => f.button('编辑 Newest snapshot').click());
    await f.edit('提供商名称', 'Keep latest draft');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    await act(async () => stale.resolve(captured));
    expect(f.field('提供商名称').value).toBe('Keep latest draft');
    expect(f.button('保存提供商配置').disabled).toBe(false);
    expect(f.element.textContent).toContain('Newest snapshot');
    expect(reads).toBe(4);
    expect(posts).toBe(2);
    expect(clock.pending).toBe(0);
  } finally {
    stale.resolve(captured ?? state.providers);
    await f.close();
    clock.close();
  }
});

test('a retained Provider request without an original ID hard-blocks ready model facts while the reopened Provider read is still pending', async () => {
  const state = configuration();
  const clock = providerSyncClock();
  const heldRead = deferred<void>();
  let hold = false;
  let original: NativeProviderSubmission | undefined;
  const f = fixture(async (input) => {
    if (input.method === 'settings.providers.read') {
      if (hold) await heldRead.promise;
      return structuredClone(state.providers);
    }
    if (input.method === 'settings.models.read') return structuredClone(state.models);
    if (input.method === 'settings.providers.save') {
      original = {
        kind: 'settings.providers.submission',
        commandId: 'retained-provider-original',
        storeId: 'store',
        observationId: input.observationId,
        operation: structuredClone(input.operation),
        phase: 'unknown',
      };
      throw Error('network_outcome_unknown');
    }
    if (input.method === 'state')
      return {
        generation: 1,
        directory: { storeId: 'store', workspaces: [], sessions: [] },
        creationSubmissions: [],
        inputSubmissions: [],
        permissionSubmissions: [],
        interactionSubmissions: [],
        providerSettingsSubmissions: [original!],
      };
    if (input.method === 'settings.providers.lookup') return { ...original!, phase: 'applied' };
    return null;
  });
  try {
    await f.render();
    await act(async () =>
      f.element
        .querySelector<HTMLButtonElement>('.provider-instance button[aria-label^="编辑 "]')!
        .click(),
    );
    await f.edit('提供商名称', 'Original request');
    await f.click('保存提供商配置');
    await f.hide();
    hold = true;
    await f.render();
    expect(f.calls.filter((call) => call.method === 'settings.models.read')).toHaveLength(2);
    const queue = nativeModelToggleQueue(f.bridge, 1, '1/store/selected/1', 'store');
    expect(queue.getSnapshot().facts?.models.find((model) => model.id === 'b')).toBeDefined();
    // Exercise the real queue behind this mounted Wrapper while its Provider
    // facts do not yet exist: the retained sent Store must still own the lock.
    await act(async () =>
      queue.toggle({
        method: 'settings.models.enabled',
        generation: 1,
        observationId: state.models.observationId,
        modelId: 'b',
        enabled: false,
      }),
    );
    expect(f.calls.filter((call) => call.method === 'settings.models.enabled')).toHaveLength(0);
    await act(async () => heldRead.resolve());
    await f.openModels('Same service', 1);
    expect(f.toggle('b').disabled).toBe(true);
    await act(async () => f.toggle('b').click());
    expect(f.calls.filter((call) => call.method === 'settings.models.enabled')).toHaveLength(0);
    await clock.fire();
    expect(f.calls.filter((call) => call.method === 'settings.providers.lookup')).toEqual([
      {
        method: 'settings.providers.lookup',
        generation: 1,
        commandId: 'retained-provider-original',
      },
    ]);
    expect(f.calls.filter((call) => call.method === 'settings.providers.save')).toHaveLength(1);
    expect(f.toggle('b').disabled).toBe(false);
    expect(f.saved).toBe(1);
  } finally {
    heldRead.resolve();
    await f.close();
    clock.close();
  }
});

test('a model mutation without a result or watcher blocks peer provider writes until its original is known', async () => {
  const state = configuration();
  const originalState = deferred<null>();
  const f = fixture(async (input) => {
    if (input.method === 'settings.providers.read') return structuredClone(state.providers);
    if (input.method === 'settings.models.read') return structuredClone(state.models);
    if (input.method === 'settings.models.enabled') throw Error('network_outcome_unknown');
    if (input.method === 'state') return originalState.promise;
    return null;
  });
  try {
    await f.render();
    await act(async () =>
      f.element
        .querySelector<HTMLButtonElement>('.provider-instance button[aria-label^="编辑 "]')!
        .click(),
    );
    expect(f.button('保存提供商配置').disabled).toBe(false);
    await f.openModels('其他模型');
    await act(async () => f.toggle('unmapped').click());
    expect(f.toggle('unmapped').disabled).toBe(true);
    expect(f.button('保存提供商配置').disabled).toBe(true);
    await f.click('保存提供商配置');
    expect(f.calls.filter((input) => input.method === 'settings.providers.save')).toHaveLength(0);
    expect(f.calls.filter((input) => input.method === 'settings.models.enabled')).toHaveLength(1);
    expect(f.saved).toBe(0);
  } finally {
    nativeModelToggleQueue(f.bridge, 1, '1/store/selected/1', 'store').detach(true);
    originalState.resolve(null);
    await f.close();
  }
});
