import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge } from '../../src/native-bridge';
import type {
  NativeBrowserBridge,
  NativeBrowserRequest,
  NativeBrowserRestoreScope,
  NativeBrowserState,
} from '../../src/native-browser-bridge';
import { prepareDesktopDom, promptValue, setPromptText } from '../native-page-dom.fixture';
import { sessionSwitchBridge } from '../session-switch-bridge.fixture';

const bootstrap = new JSDOM('<!doctype html><div></div>', { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { NativeDesktop } = await import('../../src/native');
bootstrap.window.close();

test('prepared Native close confirms the committed Root marker then removes it before finish without replay', async () => {
  const dom = new JSDOM('<!doctype html><main id="target">Committed target</main>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    }),
    restoreDom = prepareDesktopDom(dom),
    events: string[] = [];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
  });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({
    fillStyle: '',
    fillRect() {},
  })) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  let confirm!: () => void, finish!: () => void;
  const confirmed = new Promise<void>((resolve) => {
      confirm = resolve;
    }),
    finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
  Object.assign(window, {
    kiteNative: {
      async prepareBrowserClose() {
        events.push('prepare');
        return {
          key: '00112233445566778899aabbccddeeff',
          witness: '00112233445566778899aabb',
          bounds: { x: 600, y: 0, width: 400, height: 74, radius: 0 },
          width: 1000,
          height: 800,
        };
      },
      async confirmBrowserClose() {
        events.push('confirm');
        expect(document.querySelector('[data-native-browser-close-witness]')).not.toBeNull();
        expect(document.getElementById('target')?.textContent).toBe('Committed target');
        await confirmed;
      },
      async finishBrowserClose() {
        events.push('finish');
        expect(document.querySelector('[data-native-browser-close-witness]')).toBeNull();
        await finished;
      },
      async cancelBrowserClose() {
        events.push('cancel');
      },
      async browserRequest() {
        events.push('ordinary-request');
        return null;
      },
    },
  });
  const session = await import('../../src/native-browser-session');
  try {
    await session.prepareNativeBrowserClose('page', '00112233445566778899aabbccddeeff');
    const closing = session.closeNativeBrowserTab('page', '00112233445566778899aabbccddeeff');
    await Promise.resolve();
    expect(events).toEqual(['prepare', 'confirm']);
    confirm();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(['prepare', 'confirm', 'finish']);
    finish();
    await closing;
    expect(document.querySelector('[data-native-browser-close-witness]')).toBeNull();
  } finally {
    confirm();
    finish();
    session.cancelNativeBrowserCloses();
    restoreDom();
    dom.window.close();
  }
});

test('a refused prepared close reads its original state once, refreshes retained hints and never repeats close', async () => {
  const dom = new JSDOM('<!doctype html><main>Current Root</main>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    }),
    restoreDom = prepareDesktopDom(dom),
    draft = '00112233445566778899aabbccddeeff',
    requests: NativeBrowserRequest[] = [],
    page: NativeBrowserState = {
      id: 'cached-page',
      title: 'Preserved page',
      url: 'https://example.test/current',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
  let confirmations = 0,
    finishes = 0,
    cancellations = 0;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
  });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({
    fillStyle: '',
    fillRect() {},
  })) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  Object.assign(window, {
    kiteNative: {
      async restoreBrowserDraft() {
        return { pages: [{ ...page, title: 'Earlier title' }], activeId: page.id };
      },
      async prepareBrowserClose() {
        return {
          key: '00112233445566778899aabbccddeeff',
          witness: '00112233445566778899aabb',
          bounds: { x: 600, y: 0, width: 400, height: 74, radius: 0 },
          width: 1000,
          height: 800,
        };
      },
      async confirmBrowserClose() {
        confirmations++;
        throw Error('private Root proof rejected');
      },
      async finishBrowserClose() {
        finishes++;
      },
      async cancelBrowserClose() {
        cancellations++;
      },
      async browserRequest(input: NativeBrowserRequest) {
        requests.push(input);
        return page;
      },
    },
  });
  const session = await import('../../src/native-browser-session');
  try {
    await session.restoreNativeBrowserDraft(draft);
    await session.prepareNativeBrowserClose(page.id, draft);
    await expect(session.closeNativeBrowserTab(page.id, draft)).rejects.toThrow(
      '未能确认网页已关闭',
    );
    expect(confirmations).toBe(1);
    expect(finishes).toBe(0);
    expect(cancellations).toBe(1);
    expect(requests).toEqual([{ action: 'state', id: page.id, draft }]);
    expect(session.nativeBrowserDisplayHint(page.id, undefined, draft)).toEqual(page);
    expect(document.querySelector('[data-native-browser-close-witness]')).toBeNull();
  } finally {
    session.cancelNativeBrowserCloses();
    restoreDom();
    dom.window.close();
  }
});

test('real NativeDesktop keeps manual draft pages separate and restores the same draft after Session changes or a Root remount', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    }),
    restoreDom = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const control = sessionSwitchBridge({ active: false }),
    requests: NativeBrowserRequest[] = [],
    methods: string[] = [],
    drafts: string[] = [],
    inventory = new Map<string, NativeBrowserState[]>(),
    listeners = new Set<(page: NativeBrowserState) => void>();
  dom.window.sessionStorage.setItem(
    'kite.browserDraft:"foreign-store"',
    'ffeeddccbbaa99887766554433221100',
  );
  dom.window.sessionStorage.setItem('kite.browserDraft:"store"', 'invalid-token');
  const bridge = {
    ...control.bridge,
    async request(input: Parameters<NativeBridge['request']>[0]) {
      methods.push(input.method);
      return control.bridge.request(input);
    },
    async restoreBrowser(scope: NativeBrowserRestoreScope) {
      return { scope, page: null };
    },
    async restoreBrowserDraft(draft: string) {
      drafts.push(draft);
      const pages = inventory.get(draft) ?? [];
      return { pages, ...(pages[0] ? { activeId: pages[0].id } : {}) };
    },
    async browserRequest(input: NativeBrowserRequest) {
      requests.push(input);
      if (!('draft' in input) || !input.draft) return null;
      const pages = inventory.get(input.draft) ?? [];
      let page = 'id' in input ? pages.find((page) => page.id === input.id) : undefined;
      if (input.action === 'navigate') {
        page = {
          id: input.id,
          title: '草稿百度',
          url: input.input,
          loading: false,
          canGoBack: false,
          canGoForward: false,
        };
        inventory.set(input.draft, [...pages.filter((page) => page.id !== input.id), page]);
        for (const listener of listeners) listener(page);
      }
      if (input.action === 'close')
        inventory.set(
          input.draft,
          pages.filter((page) => page.id !== input.id),
        );
      return page ?? null;
    },
    watchBrowser(listener: (page: NativeBrowserState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge, writable: true });
  const host = document.getElementById('root')!;
  let root = createRoot(host);
  const flush = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(35);
    });
  const until = async (check: () => boolean) => {
    const end = Date.now() + 2500;
    while (!check()) {
      if (Date.now() > end) throw Error('draft_root_transition_timeout');
      await flush();
    }
  };
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === label,
    )!;
  try {
    await flush(() => root.render(<NativeDesktop />));
    await until(() => !!button('新对话'));
    await flush(() => button('新对话').click());
    await until(() => drafts.length > 0);
    const draft = drafts[0]!;
    expect(draft).toMatch(/^[a-f0-9]{32}$/);
    expect(draft).not.toBe('ffeeddccbbaa99887766554433221100');
    await flush(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="标签页"]')!.click(),
    );
    await until(() => !!host.querySelector('.native-browser-address'));
    await flush(() => {
      const address = host.querySelector<HTMLInputElement>('.native-browser-address')!;
      address.focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        address,
        'https://www.baidu.com/',
      );
      address.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      address
        .closest('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await until(() => host.textContent?.includes('草稿百度') === true);
    const navigation = requests.find((request) => request.action === 'navigate')!;
    expect(navigation).toMatchObject({ draft, input: 'https://www.baidu.com/' });
    expect('scope' in navigation).toBe(false);
    expect(inventory.get(draft)?.[0]?.control).toBeUndefined();
    await flush(() => button('Session A').click());
    await until(() => !host.querySelector('.new-conversation-welcome'));
    expect(
      requests.some(
        (request) =>
          request.action === 'present' && request.bounds === null && request.draft === draft,
      ),
    ).toBe(true);
    expect(host.textContent).not.toContain('草稿百度');
    await flush(() => button('新对话').click());
    await until(() => host.textContent?.includes('草稿百度') === true);
    expect(new Set(drafts).size).toBe(1);
    expect(requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
    expect(methods).not.toContain('conversation.send');
    expect(methods).not.toContain('session.create');
    expect(requests.some((request) => request.action === 'grant')).toBe(false);
    expect(dom.window.sessionStorage.getItem('kite.browserDraft:"store"')).toBe(draft);
    await act(() => root.unmount());
    root = createRoot(host);
    await flush(() => root.render(<NativeDesktop />));
    await until(() => !!button('新对话'));
    await flush(() => button('新对话').click());
    await until(() => host.textContent?.includes('草稿百度') === true);
    expect(new Set(drafts).size).toBe(1);
    expect(requests.filter((request) => request.action === 'navigate')).toHaveLength(1);
    expect(methods).not.toContain('conversation.send');
    await flush(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="关闭标签页：草稿百度"]')!.click(),
    );
    expect(requests.filter((request) => request.action === 'close')).toEqual([
      {
        action: 'close',
        id: inventory.get(draft)?.[0]?.id ?? ('id' in navigation ? navigation.id : ''),
        draft,
      },
    ]);
    expect(inventory.get(draft)).toHaveLength(0);
  } finally {
    await act(() => root.unmount());
    restoreDom();
    dom.window.close();
  }
});

test('real NativeDesktop never restores A into the immediately presented B tree before Main select B is confirmed', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const restoreDom = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const control = sessionSwitchBridge({ active: false, protocol: 'chat-completions' });
  const events: string[] = [];
  const pageListeners = new Set<(page: NativeBrowserState) => void>();
  let current: NativeBrowserRestoreScope = {
    storeId: 'store',
    sessionId: 'a',
    generation: 1,
    viewSelection: 1,
  };
  let holdB = false,
    releaseB!: () => void,
    failRestore = false,
    withholdSelection = false;
  let unavailable: 'caller' | 'background' | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  const page = (sessionId: string): NativeBrowserState => ({
    id: `page-${sessionId}`,
    title: `RETAINED PAGE ${sessionId.toUpperCase()}`,
    url: `http://localhost/${sessionId}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    control: {
      sessionId,
      phase: 'human',
      incarnation: `inc-${sessionId}`,
      browserId: `browser-${sessionId}`,
      navigation: 0,
    },
  });
  const bridge = {
    ...control.bridge,
    async request(request: Parameters<NativeBridge['request']>[0]) {
      if (request.method === 'select') {
        events.push(`select-start:${request.sessionId}`);
        if (request.sessionId === 'b' && holdB) await gate;
      }
      const value = await control.bridge.request(request);
      if (value && 'generation' in value && 'selection' in value && value.selection) {
        current = {
          storeId: value.selection.storeId,
          sessionId: value.selection.session.id,
          generation: value.generation,
          viewSelection: value.selection.viewSelection ?? value.selection.viewGeneration,
        };
        if (request.method === 'select') events.push(`select-confirmed:${current.sessionId}`);
      }
      if (value && 'generation' in value && withholdSelection)
        return { ...value, selection: undefined };
      return value && 'generation' in value && 'selection' in value && unavailable
        ? { ...value, [`${unavailable}Unavailable`]: true }
        : value;
    },
    async restoreBrowser(scope: NativeBrowserRestoreScope) {
      events.push(`restore:${scope.sessionId}/main:${current.sessionId}`);
      if (failRestore) {
        failRestore = false;
        throw Error('browser_page_scope_denied');
      }
      if (
        Object.keys(scope).some(
          (key) =>
            scope[key as keyof NativeBrowserRestoreScope] !==
            current[key as keyof NativeBrowserRestoreScope],
        )
      )
        throw Error('browser_page_scope_denied');
      return { scope: { ...scope }, page: page(scope.sessionId) };
    },
    async browserRequest(request: NativeBrowserRequest) {
      if (request.action === 'state') return page(request.id.replace('page-', ''));
      return null;
    },
    watchBrowser(listener: (page: NativeBrowserState) => void) {
      pageListeners.add(listener);
      return () => pageListeners.delete(listener);
    },
  } as NativeBridge;
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge, writable: true });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const flush = async (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(35);
    });
  const until = async (check: () => boolean) => {
    const end = Date.now() + 3500;
    while (!check()) {
      if (Date.now() >= end) throw Error(`root_restore_timeout:${host.textContent}`);
      await flush();
    }
  };
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((row) => row.textContent === text)!;
  const tabTitle = (text: string) =>
    [...host.querySelectorAll('[role="tab"]')].some((row) => row.textContent === text);
  try {
    control.refresh(true);
    await flush(() => root.render(<NativeDesktop />));
    await until(() => !!button('Session A'));
    expect(events.some((value) => value.startsWith('restore:'))).toBe(false);
    expect(host.textContent).toContain('正在核对保留页面');
    await flush(() => control.refresh(false));
    await flush(() => button('Session A').click());
    await until(() => tabTitle('RETAINED PAGE A'));
    const originalTab = [...host.querySelectorAll('[role="tab"]')].find(
      (node) => node.textContent === 'RETAINED PAGE A',
    );
    const originalPage = host.querySelector('.native-browser-page'),
      originalViewport = host.querySelector('.native-browser-viewport');
    expect(originalPage).not.toBeNull();
    expect(originalViewport).not.toBeNull();
    let settledRestores = events.filter((value) => value.startsWith('restore:')).length;
    const insertedStatuses: string[] = [];
    const insertedRestoreIssues: string[] = [];
    const observer = new dom.window.MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (node instanceof dom.window.Element && node.textContent?.includes('正在核对保留页面'))
            insertedStatuses.push(node.textContent);
          if (node instanceof dom.window.Element && node.textContent?.includes('保留页面尚未核实'))
            insertedRestoreIssues.push(node.textContent);
        }
    });
    observer.observe(host, { childList: true, subtree: true });
    for (let cycle = 0; cycle < 3; cycle++) {
      await flush(() => control.refresh(true));
      expect(current.sessionId).toBe('a');
      expect(host.textContent).not.toContain('正在核对保留页面');
      expect(
        [...host.querySelectorAll('[role="tab"]')].find(
          (node) => node.textContent === 'RETAINED PAGE A',
        ),
      ).toBe(originalTab);
      await flush(() => control.refresh(false));
      expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(settledRestores);
      expect(host.textContent).not.toContain('正在核对保留页面');
      expect(host.textContent).not.toContain('保留页面尚未核实');
      expect(host.querySelector('.native-browser-page')).toBe(originalPage);
      expect(host.querySelector('.native-browser-viewport')).toBe(originalViewport);
    }
    if (host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded') !== 'true')
      await flush(() => host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click());
    withholdSelection = true;
    await flush(() => control.refresh(true));
    expect(host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.native-browser-page')).toBe(originalPage);
    expect(tabTitle('RETAINED PAGE A')).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')?.disabled).toBe(true);
    withholdSelection = false;
    await flush(() => control.refresh(false));
    expect(host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.native-browser-page')).toBe(originalPage);
    expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(
      settledRestores + 1,
    );
    settledRestores++;
    const newLease = {
      ...page('a'),
      control: { ...page('a').control!, phase: 'agent' as const, browserId: 'new-lease-a' },
    };
    await flush(() => {
      for (const listener of pageListeners) listener(newLease);
    });
    expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(
      settledRestores + 1,
    );
    settledRestores++;
    expect(
      [...host.querySelectorAll('[role="tab"]')].find(
        (node) => node.textContent === 'RETAINED PAGE A',
      ),
    ).toBe(originalTab);
    await flush(() => {
      for (const listener of pageListeners) {
        listener(newLease);
        listener({
          ...page('b'),
          control: { ...page('b').control!, phase: 'agent', browserId: 'background-lease-b' },
        });
      }
    });
    expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(settledRestores);
    observer.disconnect();
    expect(insertedStatuses).toEqual([]);
    expect(insertedRestoreIssues).toEqual([]);
    expect(host.querySelector('.native-browser-page')).toBe(originalPage);
    expect(host.querySelector('.native-browser-viewport')).toBe(originalViewport);
    failRestore = true;
    await flush(() => {
      for (const listener of pageListeners)
        listener({
          ...newLease,
          control: { ...newLease.control!, browserId: 'failed-read-lease-a' },
        });
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('保留页面尚未核实');
    expect(host.querySelector('.native-browser-page')).toBe(originalPage);
    const retry = [...host.querySelectorAll('button')].find(
      (node) => node.textContent === '重查保留页面',
    );
    expect(retry).toBeDefined();
    await flush(() => retry!.click());
    await until(() => !host.textContent?.includes('保留页面尚未核实'));
    settledRestores += 2;
    expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(settledRestores);
    expect(host.querySelector('.native-browser-page')).toBe(originalPage);
    const retainedButBlocked = () => {
      expect(host.textContent).not.toContain('正在核对保留页面');
      expect(host.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')?.disabled).toBe(
        true,
      );
      expect(
        [...host.querySelectorAll('[role="tab"]')].find(
          (node) => node.textContent === 'RETAINED PAGE A',
        ),
      ).toBe(originalTab);
    };
    for (const failure of ['caller', 'background'] as const) {
      unavailable = failure;
      await flush(() => control.refresh(true));
      retainedButBlocked();
      expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(settledRestores);
      unavailable = undefined;
      await flush(() => control.refresh(false));
      await until(
        () => tabTitle('RETAINED PAGE A') && !host.textContent?.includes('正在核对保留页面'),
      );
      expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(
        settledRestores + 1,
      );
      settledRestores++;
    }
    await flush(() => control.fail(true));
    retainedButBlocked();
    expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(settledRestores);
    await flush(() => control.fail(false));
    await until(
      () => tabTitle('RETAINED PAGE A') && !host.textContent?.includes('正在核对保留页面'),
    );
    expect(events.filter((value) => value.startsWith('restore:'))).toHaveLength(
      settledRestores + 1,
    );
    await flush(() => button('Session B').click());
    await until(() => tabTitle('RETAINED PAGE B'));
    await flush(() => button('Session A').click());
    await until(() => tabTitle('RETAINED PAGE A'));
    const before = events.length;
    holdB = true;
    await flush(() => button('Session B').click());
    await until(() => events.slice(before).includes('select-start:b'));
    expect(current.sessionId).toBe('a');
    expect(host.textContent).toContain('Reply b');
    expect(tabTitle('RETAINED PAGE A')).toBe(false);
    expect(events.slice(before).some((value) => value.startsWith('restore:'))).toBe(false);
    releaseB();
    await until(() => tabTitle('RETAINED PAGE B'));
    const tail = events.slice(before);
    expect(tail.indexOf('restore:b/main:b')).toBeGreaterThan(tail.indexOf('select-confirmed:b'));
    expect(tail.filter((value) => value === 'restore:b/main:b')).toHaveLength(1);
    expect(tail.some((value) => value === 'restore:a/main:a')).toBe(false);
    expect(tabTitle('RETAINED PAGE A')).toBe(false);
    expect(current.sessionId).toBe('b');
  } finally {
    releaseB();
    await act(() => root.unmount());
    restoreDom();
    dom.window.close();
  }
});

test('a fresh Root rebuilds the selected conversation and retained page from the new Caller generation', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const restoreDom = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const control = sessionSwitchBridge({ active: false });
  const page: NativeBrowserState = {
    id: 'original-tab',
    title: 'ORIGINAL RETAINED PAGE',
    url: 'https://example.com/original',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    control: { sessionId: 'a', phase: 'human', incarnation: 'original-incarnation', navigation: 4 },
  };
  let generation = 0,
    selectedGeneration = 0,
    reveal = false;
  const events: string[] = [];
  const rebase = (value: unknown, current: number): unknown => {
    if (Array.isArray(value)) return value.map((item) => rebase(item, current));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'generation' ? current : rebase(item, current),
      ]),
    );
  };
  const bridge: NativeBridge & NativeBrowserBridge = {
    ...control.bridge,
    watch(listener) {
      return control.bridge.watch((event) =>
        listener(event.kind === 'changed' ? { ...event, generation } : event),
      );
    },
    async request(request) {
      if (request.method === 'attach') generation++;
      if (request.method === 'detach') {
        events.push(`detach:${request.generation}`);
        generation++;
        return null;
      }
      const current = generation;
      events.push(`${request.method}:${current}`);
      const value = await control.bridge.request(request);
      if (request.method === 'select') selectedGeneration = current;
      return rebase(value, current) as Awaited<ReturnType<NativeBridge['request']>>;
    },
    async restoreBrowser(scope) {
      expect(scope.generation).toBe(generation);
      expect(selectedGeneration).toBe(generation);
      expect(scope.sessionId).toBe('a');
      events.push(`restore:${scope.generation}`);
      return {
        scope: { ...scope },
        page,
        activeId: page.id,
        ...(reveal ? { reveal: true as const } : {}),
      };
    },
    async browserRequest(request) {
      events.push(`browser:${request.action}`);
      return request.action === 'state' ? page : null;
    },
    watchBrowser: () => () => {},
  };
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge, writable: true });
  const host = dom.window.document.getElementById('root')!;
  let root = createRoot(host);
  const flush = async (action: () => void = () => {}) =>
    act(async () => {
      action();
      await Bun.sleep(35);
    });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3500;
    while (!check()) {
      if (Date.now() >= deadline) throw Error(`reattach_root_timeout:${host.textContent}`);
      await flush();
    }
  };
  const restored = () =>
    [...host.querySelectorAll('[role="tab"]')].some((node) => node.textContent === page.title) &&
    host.textContent?.includes('Reply a') === true;
  try {
    await flush(() => root.render(<NativeDesktop />));
    await until(restored);
    await flush(() => host.querySelector<HTMLButtonElement>('[aria-label="标签页"]')!.click());
    expect(host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded')).toBe('true');
    const oldGeneration = generation;
    const before = events.length;
    await act(() => root.unmount());
    reveal = true;
    root = createRoot(host);
    await flush(() => root.render(<NativeDesktop />));
    await until(restored);
    await until(
      () => host.querySelector('[aria-label="标签页"]')?.getAttribute('aria-expanded') === 'true',
    );
    expect(generation).toBeGreaterThan(oldGeneration);
    const tail = events.slice(before);
    expect(tail.indexOf(`restore:${generation}`)).toBeGreaterThan(
      tail.indexOf(`select:${generation}`),
    );
    expect(tail).toContain(`messages:${generation}`);
    expect(tail).toContain(`draft.read:${generation}`);
    expect(tail).toContain(`input.models.read:${generation}`);
    expect(events).not.toContain('browser:navigate');
    expect(events).not.toContain('browser:create');
    expect(host.textContent).not.toContain('准备新对话');
    expect(page.control?.incarnation).toBe('original-incarnation');
    expect(page.control?.navigation).toBe(4);
    await flush(() =>
      [...host.querySelectorAll('button')].find((node) => node.textContent === '新对话')!.click(),
    );
    const preparation = () => host.querySelector('[role="textbox"][aria-label="新对话草稿"]');
    await until(() => !!preparation());
    await act(() => setPromptText(preparation()!, 'keep this unsent preparation'));
    const beforePreparation = events.length,
      beforeGeneration = generation;
    // Bridge replacement restarts Root effects while React preserves its local
    // preparation, as Fast Refresh does. It must not select the old conversation.
    await flush(() => {
      Object.defineProperty(dom.window, 'kiteNative', { value: { ...bridge }, writable: true });
      root.render(<NativeDesktop />);
    });
    await until(() => generation > beforeGeneration && !!preparation());
    expect(promptValue(preparation())).toBe('keep this unsent preparation');
    expect(events.slice(beforePreparation)).not.toContain(`select:${generation}`);
  } finally {
    await act(() => root.unmount());
    restoreDom();
    dom.window.close();
  }
});
