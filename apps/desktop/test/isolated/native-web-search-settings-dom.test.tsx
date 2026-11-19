import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { SearchView } from '../../src/web-search-settings-model';
import { searchDraftIssue } from '../../src/web-search-settings-model';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>');
const previous = {
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
const { NativeWebSearchSettings } = await import('../../src/native-web-search-settings');
Object.assign(globalThis, previous);
bootstrap.window.close();
const view: SearchView = {
  revision: 'rev1',
  canWrite: true,
  accounts: [],
  draft: { mode: 'auto', providers: [] },
  derivedDeepSeek: { status: 'configured', label: '我的 DeepSeek' },
  route: { available: true, label: '自动（待核实）' },
};
test('passive settings follow reported selection, ambiguity, disablement and legacy; opening never searches or writes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const restore = prepareDesktopDom(dom);
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  let navigations = 0,
    reads = 0,
    writes = 0,
    tests = 0;
  const present = async (key: string, read: () => Promise<SearchView>) => {
    const port = {
      read: () => {
        reads++;
        return read();
      },
      save: () => {
        writes++;
        throw Error('never save');
      },
      test: () => {
        tests++;
        throw Error('never search');
      },
    };
    await act(async () =>
      root.render(
        <NativeWebSearchSettings key={key} port={port} onManageProviders={() => navigations++} />,
      ),
    );
  };
  const text = () => host.textContent || '';
  try {
    let late!: (x: SearchView) => void;
    await present(
      'pending',
      () =>
        new Promise((r) => {
          late = r;
        }),
    );
    await present('configured', async () => view);
    await act(async () =>
      late({ ...view, derivedDeepSeek: { status: 'configured', label: 'STALE' } }),
    );
    expect(text()).toContain('默认备用提供商为「我的 DeepSeek」');
    expect(text()).toContain('本次明确选择的模型有可用的 DeepSeek 提供商时优先使用');
    expect(text()).toContain('已配置');
    expect(text()).toContain('优先');
    expect(text()).not.toContain('STALE');
    expect(text()).not.toContain('已执行');
    expect(host.querySelector('input,select,[role=combobox],fieldset')).toBeNull();
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['管理提供商']);
    await act(async () => host.querySelector('button')?.click());
    expect(navigations).toBe(1);
    await present('ambiguous', async () => ({ ...view, derivedDeepSeek: { status: 'ambiguous' } }));
    expect(text()).toContain('按模型选择');
    expect(text()).not.toContain('未配置');
    await present('unavailable', async () => ({
      ...view,
      derivedDeepSeek: { status: 'unavailable' },
    }));
    expect(text()).toContain('未配置');
    expect(text()).not.toContain('已配置');
    await present('disabled', async () => ({
      ...view,
      draft: { mode: 'disabled', providers: [] },
    }));
    expect(text()).toContain('已关闭');
    expect(text()).not.toContain('我的 DeepSeek');
    expect(text()).not.toContain('已配置');
    await present('legacy', async () => ({
      ...view,
      derivedDeepSeek: undefined,
      accounts: [{ alias: 'old', name: 'NOT-PROOF', adapter: 'deepseek-search' }],
    }));
    expect(text()).toContain('未报告');
    expect(text()).not.toContain('NOT-PROOF');
    await present('legacy-provider', async () => ({
      ...view,
      draft: { mode: 'provider', providers: [] },
      derivedDeepSeek: undefined,
    }));
    expect(text()).toContain('未选用');
    expect(text()).toContain('未报告');
    let fail = true;
    await present('error', async () => {
      if (fail) throw Error('private');
      return view;
    });
    expect(host.querySelector('[role=alert]')?.textContent).toContain('无法读取');
    expect(text()).not.toContain('未配置');
    fail = false;
    await act(async () => host.querySelector('button')?.click());
    expect(text()).toContain('我的 DeepSeek');
    expect(reads).toBe(9);
    expect(writes).toBe(0);
    expect(tests).toBe(0);
  } finally {
    await act(async () => root.unmount());
    restore();
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
test('configuration validates provider selection, result bounds and existing dedicated credentials without exposing them', () => {
  const service = {
    id: 'p',
    name: 'P',
    adapter: 'perplexity-search' as const,
    account: { kind: 'dedicated' as const, hasCredential: true },
    maxResults: 5,
  };
  expect(searchDraftIssue({ mode: 'provider', providers: [] }, () => false)).toBeTruthy();
  expect(
    searchDraftIssue({ mode: 'provider', providerId: 'p', providers: [service] }, () => false),
  ).toBeUndefined();
  expect(
    searchDraftIssue({ mode: 'auto', providers: [{ ...service, maxResults: 11 }] }, () => false),
  ).toContain('1 至 10');
  expect(searchDraftIssue({ mode: 'disabled', providers: [] }, () => false)).toBeUndefined();
});

test('pre-text evidence paints real searching, stops refreshing on settlement, and discards a late prior session', async () => {
  const { NativeWebSearchActivity } = await import('../../src/native-web-search-evidence');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true }),
    restore = prepareDesktopDom(dom);
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const data = {
    executionId: 'ex',
    revision: 1,
    status: 'running' as const,
    query: 'Kite',
    sources: [],
    citations: [],
    blocks: [],
  };
  let reads = 0,
    late!: (value: typeof data) => void;
  try {
    const first = {
      scope: 's-a/ex',
      executionId: 'ex',
      live: true,
      read: async () => {
        reads++;
        return data;
      },
    };
    await act(async () => root.render(<NativeWebSearchActivity reader={first} />));
    expect(host.textContent).toContain('正在搜索');
    expect(reads).toBe(1);
    const second = {
      ...first,
      live: false,
      read: async () => {
        reads++;
        return { ...data, status: 'completed' as const, revision: 2 };
      },
    };
    await act(async () => root.render(<NativeWebSearchActivity reader={second} />));
    expect(host.textContent).toContain('搜索完成');
    await new Promise((r) => setTimeout(r, 1300));
    expect(reads).toBe(2);
    await act(async () =>
      root.render(
        <NativeWebSearchActivity
          reader={{
            ...first,
            scope: 'a-wait',
            read: () =>
              new Promise((r) => {
                late = r;
              }),
          }}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <NativeWebSearchActivity
          reader={{
            ...first,
            scope: 'b',
            executionId: 'other',
            live: false,
            read: async () => undefined,
          }}
        />,
      ),
    );
    await act(async () => late(data));
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    restore();
    Object.assign(globalThis, old);
    dom.window.close();
  }
});
