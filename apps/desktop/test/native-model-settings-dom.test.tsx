import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeModelSettingsSubmission,
  NativeRequest,
  NativeSelection,
} from '../src/native-bridge';
import { NativeModelSettings } from '../src/native-model-settings';

test('Native model settings DOM sends one finite intent and retains original unknown lookup across views without late facts', async () => {
  const dom = new JSDOM('<div id="root"></div>');
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
    root = createRoot(element),
    calls: NativeRequest[] = [];
  const facts: NativeModelSettingsFacts = {
    kind: 'settings.models',
    observationId: 7,
    storeId: 'store',
    scope: 'user',
    canWrite: true,
    errors: [],
    defaultModelId: 'a',
    models: [
      { id: 'a', enabled: true, configured: true, diagnostics: [] },
      { id: 'b', enabled: true, configured: true, diagnostics: [] },
      { id: 'c', enabled: false, configured: false, diagnostics: ['model_unconfigured'] },
    ],
  };
  const original: NativeModelSettingsSubmission = {
    kind: 'settings.models.submission',
    commandId: 'original',
    storeId: 'store',
    scope: 'user',
    observationId: 7,
    operation: { kind: 'default', modelId: 'b' },
    phase: 'unknown',
  };
  let release!: (value: NativeModelSettingsSubmission) => void,
    releaseRead!: (value: NativeModelSettingsFacts) => void;
  const pending = new Promise<NativeModelSettingsSubmission>((resolve) => {
    release = resolve;
  });
  const delayedRead = new Promise<NativeModelSettingsFacts>((resolve) => {
    releaseRead = resolve;
  });
  let reads = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method === 'settings.models.read')
        return ++reads === 2 ? delayedRead : structuredClone(facts);
      if (input.method === 'settings.models.default') return pending;
      if (input.method === 'settings.models.lookup') return { ...original, phase: 'applied' };
      return null;
    },
  };
  const selected = (id: string) =>
    ({ storeId: 'store', session: { id }, viewSelection: id === 'old' ? 1 : 2 }) as NativeSelection;
  const render = (id: string, submissions: NativeModelSettingsSubmission[] = []) =>
    root.render(
      <NativeModelSettings
        bridge={bridge}
        generation={1}
        selection={selected(id)}
        submissions={submissions}
      />,
    );
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (value) => value.getAttribute('aria-label') === name || value.textContent === name,
    )!;
  try {
    await act(async () => render('old'));
    await act(async () => button('读取用户模型配置').click());
    expect(button('禁用模型 a').disabled).toBe(true);
    expect(button('设为默认 c').disabled).toBe(true);
    await act(async () => {
      button('设为默认 b').click();
      button('设为默认 b').click();
    });
    expect(calls.filter((input) => input.method === 'settings.models.default')).toEqual([
      { method: 'settings.models.default', generation: 1, observationId: 7, modelId: 'b' },
    ]);
    await act(async () => render('new', [original]));
    await act(async () => release({ ...original, phase: 'applied' }));
    expect(reads).toBe(1);
    expect(element.textContent).not.toContain('当前期望默认模型');
    expect(element.textContent).toContain('原提交 original');
    await act(async () => button('查询原提交').click());
    expect(calls.filter((input) => input.method === 'settings.models.lookup')).toEqual([
      { method: 'settings.models.lookup', generation: 1, commandId: 'original' },
    ]);
    expect(reads).toBe(1);
    await act(async () => button('读取用户模型配置').click());
    await act(async () => render('old', [original]));
    await act(async () => releaseRead({ ...facts, defaultModelId: 'stale-new-view' }));
    expect(element.textContent).not.toContain('stale-new-view');
    await act(async () => button('读取用户模型配置').click());
    expect(button('设为默认 b').disabled).toBe(true);
    expect(button('禁用模型 b').disabled).toBe(true);
    expect(element.textContent).toContain('未决提交先查询原结果');
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
