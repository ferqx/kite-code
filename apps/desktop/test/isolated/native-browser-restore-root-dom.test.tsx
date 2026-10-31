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
