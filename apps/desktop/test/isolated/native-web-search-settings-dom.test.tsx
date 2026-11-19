import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  SearchProbe,
  SearchView,
  WebSearchSettingsPort,
} from '../../src/web-search-settings-model';
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
  draft: { providers: [], mode: 'auto' },
  route: { available: true, label: 'OpenAI 原生' },
};
test('opening only reads, double click costs one query, timeout never replays and stale result cannot enter reopened page', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true }),
    restore = prepareDesktopDom(dom);
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
  let reads = 0,
    probes = 0,
    saves = 0,
    resolve!: (v: SearchProbe) => void;
  const port: WebSearchSettingsPort = {
    read: async () => {
      reads++;
      return view;
    },
    save: async () => {
      saves++;
      return view;
    },
    test: async () => {
      probes++;
      return await new Promise((r) => {
        resolve = r;
      });
    },
  };
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((x) => x.textContent === label)!;
  try {
    await act(async () => {
      root.render(<NativeWebSearchSettings key="a" port={port} />);
    });
    expect(reads).toBe(1);
    expect(probes).toBe(0);
    expect(saves).toBe(0);
    await act(async () => {
      const b = button('测试搜索');
      b.click();
      b.click();
    });
    expect(probes).toBe(1);
    await act(async () => {
      root.render(<NativeWebSearchSettings key="b" port={port} />);
      resolve({ route: 'STALE', observed: true, sources: [] });
    });
    expect(host.textContent).not.toContain('STALE');
    expect(probes).toBe(1);
    await act(async () => {
      root.render(
        <NativeWebSearchSettings
          key="c"
          port={{
            ...port,
            test: async () => {
              probes++;
              throw Error('web_search_timeout');
            },
          }}
        />,
      );
    });
    await act(async () => {
      button('测试搜索').click();
    });
    expect(probes).toBe(2);
    expect(host.textContent).toContain('未自动重试');
    await act(async () => {
      button('添加搜索服务').click();
    });
    expect(button('测试搜索').disabled).toBe(true);
    await act(async () => {
      button('保存设置').click();
    });
    expect(saves).toBe(0);
    expect(host.textContent).toContain('API Key');
    await act(async () => {
      root.render(
        <NativeWebSearchSettings
          key="d"
          port={{ ...port, read: async () => ({ ...view, canWrite: false }) }}
        />,
      );
    });
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
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
