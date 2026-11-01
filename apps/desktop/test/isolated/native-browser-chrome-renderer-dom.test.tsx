import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBrowserChromeBridge,
  NativeBrowserChromeEnvelope,
  NativeBrowserChromeEvent,
  NativeBrowserChromeResult,
  NativeBrowserChromeSnapshot,
} from '../../src/native-browser-chrome-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

function initial(): NativeBrowserChromeEnvelope {
  return {
    attachment: 'geometry-one',
    pageToken: 'page-token-one',
    hosted: true,
    actionable: true,
    snapshot: {
      scope: { storeId: 'store', sessionId: 'session', generation: 1, viewSelection: 1 },
      revision: 1,
      theme: 'dark',
      material: 'vibrancy',
      interactive: true,
      covered: false,
      hosted: true,
      tabs: {
        scopeKey: 'store/session',
        tabs: [{ id: 'page', kind: 'browser', title: 'Original page' }],
        active: 'page',
        visible: true,
        present: true,
        restoring: false,
        restoreIssue: false,
      },
      toolbar: {
        id: 'page',
        address: 'https://example.com/original',
        readonlyURL: 'https://example.com/original',
        loading: false,
        hasPage: true,
        canGoBack: true,
        canGoForward: true,
        canNavigate: true,
        notesAvailable: true,
        notesOpen: false,
        optionsAvailable: true,
      },
      control: {
        id: 'browser',
        label: '人工',
        detail: '由你控制',
        handoffAvailable: false,
        closeAvailable: true,
        pending: false,
        details: ['由你控制'],
      },
    },
  };
}
async function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restore = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let current = initial();
  let receive: (value: NativeBrowserChromeEnvelope | null) => void = () => {};
  let watches = 0,
    unwatches = 0;
  let result: (event: NativeBrowserChromeEvent) => Promise<NativeBrowserChromeResult> = async () =>
    'forwarded';
  const events: NativeBrowserChromeEvent[] = [];
  const rendered: {
    proof: { attachment: string; pageToken: string; revision: number };
    theme?: string;
    address?: string;
    tabs: string[];
  }[] = [];
  const bridge: NativeBrowserChromeBridge = {
    read: async () => current,
    watch(listener) {
      receive = listener;
      watches++;
      return () => {
        unwatches++;
      };
    },
    async send(event) {
      events.push(event);
      return result(event);
    },
    async rendered(proof) {
      rendered.push({
        proof,
        theme: document.documentElement.dataset.theme,
        address: document.querySelector<HTMLInputElement>('.native-browser-address')?.value,
        tabs: [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent ?? ''),
      });
    },
  };
  Object.defineProperty(dom.window, 'kiteNative', {
    get() {
      throw Error('Chrome cannot access the Root business bridge');
    },
  });
  const { createRoot } = await import('react-dom/client');
  const { NativeBrowserChromeRenderer } = await import('../../src/native-browser-chrome-renderer');
  const root = createRoot(document.getElementById('root')!);
  const flush = (fn: () => void = () => {}) =>
    act(async () => {
      fn();
      await Bun.sleep(5);
    });
  const render = () => flush(() => root.render(<NativeBrowserChromeRenderer bridge={bridge} />));
  const address = () => document.querySelector<HTMLInputElement>('.native-browser-address')!;
  const input = (value: string) =>
    flush(() => {
      address().focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        address(),
        value,
      );
      address().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  const submit = () =>
    flush(() =>
      address()
        .closest('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
  const click = (label: string) =>
    flush(() => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  const update = (
    snapshot: Partial<NativeBrowserChromeSnapshot> = {},
    envelope: Partial<Omit<NativeBrowserChromeEnvelope, 'snapshot'>> = {},
  ) =>
    flush(() => {
      current = {
        ...current,
        ...envelope,
        snapshot: { ...current.snapshot, revision: current.snapshot.revision + 1, ...snapshot },
      };
      receive(current);
    });
  return {
    dom,
    bridge,
    events,
    rendered,
    render,
    input,
    submit,
    click,
    update,
    flush,
    address,
    get current() {
      return current;
    },
    get watches() {
      return watches;
    },
    get unwatches() {
      return unwatches;
    },
    set result(value: typeof result) {
      result = value;
    },
    null: () => flush(() => receive(null)),
    async close() {
      await act(() => root.unmount());
      restore();
      dom.window.close();
      Object.assign(globalThis, prior);
    },
  };
}
const navigations = (events: readonly NativeBrowserChromeEvent[]) =>
  events.filter((event) => event.part === 'toolbar' && event.action.type === 'navigate');

test('a cleared Chrome intent removes old controls and status while retaining an opaque themed strip', async () => {
  const f = await fixture();
  try {
    await f.render();
    f.result = async () => 'stale';
    await f.click('刷新网页');
    expect(document.body.textContent).toContain('Original page');
    expect(document.body.textContent).toContain('页面已变化');
    expect(f.address().value).toBe('https://example.com/original');
    const events = f.events.length,
      rendered = f.rendered.length;
    await f.null();
    const empty = document.querySelector<HTMLElement>('.native-browser-chrome-empty');
    expect(empty).not.toBeNull();
    expect(document.body.textContent).toBe('');
    expect(document.querySelector('button,input,[role="status"]')).toBeNull();
    expect(empty?.style.background).toBe('var(--background)');
    expect(empty?.style.position).toBe('fixed');
    expect(empty?.style.inset).toBe('0px');
    expect(empty?.style.pointerEvents).toBe('none');
    expect(empty?.hasAttribute('inert')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(f.events).toHaveLength(events);
    expect(f.rendered).toHaveLength(rendered);
  } finally {
    await f.close();
  }
});

test('Chrome reports its current rendered identity after DOM and theme commit without sending an action', async () => {
  const f = await fixture();
  try {
    await f.render();
    expect(f.rendered.length).toBeGreaterThan(0);
    expect(f.rendered.at(-1)).toMatchObject({
      proof: { attachment: 'geometry-one', pageToken: 'page-token-one', revision: 1 },
      theme: 'dark',
      address: 'https://example.com/original',
    });
    await f.update(
      {
        theme: 'light',
        hosted: false,
        tabs: {
          ...f.current.snapshot.tabs,
          tabs: [{ id: 'second', kind: 'browser', title: 'Second page' }],
          active: 'second',
        },
        toolbar: {
          ...f.current.snapshot.toolbar,
          id: 'second',
          address: 'https://example.com/second',
          readonlyURL: 'https://example.com/second',
        },
      },
      { attachment: 'second-attachment', pageToken: 'second-token', actionable: false },
    );
    expect(f.rendered.at(-1)).toEqual({
      proof: { attachment: 'second-attachment', pageToken: 'second-token', revision: 2 },
      theme: 'light',
      address: 'https://example.com/second',
      tabs: ['Second page'],
    });
    expect(f.events).toEqual([]);
    const count = f.rendered.length;
    await f.null();
    expect(f.rendered).toHaveLength(count);
    delete f.bridge.rendered;
  } finally {
    await f.close();
  }
});

test('page switches retain the toolbar DOM and page appearance while fresh input remains blocked', async () => {
  const f = await fixture();
  try {
    await f.render();
    const original = {
      header: document.querySelector('.session-tabs-heading'),
      form: document.querySelector('.native-browser-toolbar'),
      input: f.address(),
      reload: document.querySelector<HTMLButtonElement>('.native-browser-nav-reload')!,
      back: document.querySelector<HTMLButtonElement>('[aria-label="后退"]')!,
    };
    const glyph = original.reload.innerHTML;
    const tabs = [
      ...f.current.snapshot.tabs.tabs,
      { id: 'second', kind: 'browser' as const, title: 'Second page' },
    ];
    await f.update(
      {
        hosted: false,
        tabs: { ...f.current.snapshot.tabs, tabs, active: 'second' },
        toolbar: {
          ...f.current.snapshot.toolbar,
          id: 'second',
          address: 'https://example.com/second',
          readonlyURL: 'https://example.com/second',
        },
      },
      { attachment: 'second-binding', pageToken: 'second-token', actionable: false },
    );
    expect(document.querySelector('.session-tabs-heading') === original.header).toBe(true);
    expect(document.querySelector('.native-browser-toolbar') === original.form).toBe(true);
    expect(f.address() === original.input).toBe(true);
    expect(document.querySelector('.native-browser-nav-reload') === original.reload).toBe(true);
    expect(original.input.value).toBe('https://example.com/second');
    expect(original.input.readOnly).toBe(true);
    expect(original.reload.disabled).toBe(true);
    expect(original.reload.style.opacity).toBe('1');
    expect(original.back.disabled).toBe(true);
    expect(original.back.style.opacity).toBe('1');
    expect(original.reload.innerHTML).toBe(glyph);
    const count = f.events.length;
    await f.submit();
    await f.click('刷新网页');
    expect(f.events).toHaveLength(count);
    await f.update({ hosted: true }, { actionable: true });
    expect(f.address() === original.input).toBe(true);
    expect(original.reload.disabled).toBe(false);
    expect(original.reload.innerHTML).toBe(glyph);
    await f.update({ toolbar: { ...f.current.snapshot.toolbar, canNavigate: false } });
    expect(original.reload.disabled).toBe(true);
    expect(original.reload.style.opacity).toBe('');
    expect(original.input.readOnly).toBe(true);
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, canNavigate: true, loading: true },
    });
    expect(document.querySelector('.native-browser-nav-reload') === original.reload).toBe(true);
    expect(original.reload.innerHTML === glyph).toBe(false);
    expect(original.reload.disabled).toBe(false);
    await f.update({ toolbar: { ...f.current.snapshot.toolbar, hasPage: false } });
    expect(original.reload.disabled).toBe(true);
  } finally {
    await f.close();
  }
});

test('a different page retires its old editor, IME and pending navigation without replacing the address node', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush(() => f.address().focus());
    await f.input('https://example.com/old-draft');
    let finish!: (result: NativeBrowserChromeResult) => void;
    f.result = (event) =>
      event.part === 'toolbar' && event.action.type === 'address-change'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve('forwarded');
    await f.input('https://example.com/old-pending');
    await f.submit();
    const address = f.address();
    await f.flush(() =>
      address.dispatchEvent(
        new f.dom.window.CompositionEvent('compositionstart', { bubbles: true }),
      ),
    );
    await f.update(
      {
        tabs: {
          ...f.current.snapshot.tabs,
          tabs: [
            ...f.current.snapshot.tabs.tabs,
            { id: 'second', kind: 'browser', title: 'Second' },
          ],
          active: 'second',
        },
        toolbar: {
          ...f.current.snapshot.toolbar,
          id: 'second',
          address: 'https://example.com/second',
          readonlyURL: 'https://example.com/second',
        },
      },
      { attachment: 'second-binding', pageToken: 'second-token' },
    );
    expect(f.address() === address).toBe(true);
    expect(address.value).toBe('https://example.com/second');
    expect(document.activeElement === address).toBe(false);
    const count = f.events.length;
    await f.flush(() => finish('unconfirmed'));
    await f.flush(() =>
      address.dispatchEvent(
        new f.dom.window.CompositionEvent('compositionend', { bubbles: true, data: 'old text' }),
      ),
    );
    await f.flush(() => {
      Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        address,
        'old IME tail',
      );
      address.dispatchEvent(
        new f.dom.window.InputEvent('input', { bubbles: true, inputType: 'insertFromComposition' }),
      );
    });
    expect(f.events).toHaveLength(count);
    expect(navigations(f.events)).toHaveLength(0);
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(address.value).toBe('https://example.com/second');
  } finally {
    await f.close();
  }
});

test('Chrome uses only its restricted bridge and renders eight mixed tabs, menus and appearance', async () => {
  const f = await fixture();
  try {
    await f.render();
    const tabs: NativeBrowserChromeSnapshot['tabs']['tabs'] = [
      ...f.current.snapshot.tabs.tabs,
      { id: 'changes', kind: 'changes', title: '变更' },
      {
        id: 'child',
        kind: 'child',
        title: 'Child',
        sessionId: 'child-session',
        childAgentIdentity: 'code',
      },
      { id: 'workspace', kind: 'workspace', title: 'Managed' },
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `extra-${i}`,
        kind: 'browser' as const,
        title: `Extra ${i}`,
      })),
    ];
    await f.update({
      tabs: { ...f.current.snapshot.tabs, tabs },
      theme: 'light',
      material: 'mica',
    });
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(8);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')!.disabled).toBe(
      true,
    );
    expect(document.querySelector('.session-tab-content')).toBeNull();
    expect(document.querySelector('.conversation')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.windowMaterial).toBe('mica');
    const options = document.querySelector<HTMLElement>('[aria-label="页面选项"]')!;
    options.getBoundingClientRect = () => new f.dom.window.DOMRect(241, 49, 28, 30);
    await f.click('页面选项');
    expect(f.events.at(-1)).toMatchObject({
      part: 'toolbar',
      action: { type: 'show-options', anchor: { x: 241, y: 49, width: 28, height: 30 } },
      revision: f.current.snapshot.revision,
    });
    await f.click('浏览器控制');
    expect(f.events.at(-1)).toMatchObject({ part: 'control', action: { type: 'show-menu' } });
    expect(f.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(f.watches).toBe(1);
  } finally {
    await f.close();
  }
  expect(f.unwatches).toBe(1);
});

test('address echo and forwarded receipt are both required before a single navigate; unrelated snapshots preserve caret', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush(() => f.address().focus());
    let acknowledge!: (value: NativeBrowserChromeResult) => void;
    f.result = (event) =>
      event.part === 'toolbar' && event.action.type === 'address-change'
        ? new Promise((resolve) => {
            acknowledge = resolve;
          })
        : Promise.resolve('forwarded');
    await f.input('https://example.com/typed');
    expect(f.address().value).toBe('https://example.com/typed');
    expect(f.events.at(-1)).toMatchObject({
      action: { type: 'address-change', value: 'https://example.com/typed' },
    });
    f.address().setSelectionRange(8, 13);
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, loading: true },
      tabs: {
        ...f.current.snapshot.tabs,
        tabs: [{ id: 'page', kind: 'browser', title: 'New title' }],
      },
    });
    expect(f.address().value).toBe('https://example.com/typed');
    expect([f.address().selectionStart, f.address().selectionEnd]).toEqual([8, 13]);
    await f.submit();
    await f.submit();
    expect(navigations(f.events)).toHaveLength(0);
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, address: 'https://example.com/typed' },
    });
    expect(navigations(f.events)).toHaveLength(0);
    await f.flush(() => acknowledge('forwarded'));
    expect(navigations(f.events)).toHaveLength(1);
    expect(navigations(f.events)[0]!.revision).toBe(f.current.snapshot.revision);
    expect(new Set(f.events.map((event) => event.sequence)).size).toBe(f.events.length);
  } finally {
    await f.close();
  }
});

test('geometry attachments preserve the same address DOM, draft and IME while cancelling old pending navigate', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush(() => f.address().focus());
    await f.input('https://example.com/draft');
    await f.submit();
    const original = f.address();
    original.setSelectionRange(5, 10);
    await f.flush(() =>
      original.dispatchEvent(
        new f.dom.window.CompositionEvent('compositionstart', { bubbles: true, data: '中' }),
      ),
    );
    await f.update({}, { attachment: 'geometry-two', actionable: false });
    expect(f.address()).toBe(original);
    expect(original.value).toBe('https://example.com/draft');
    expect([original.selectionStart, original.selectionEnd]).toEqual([5, 10]);
    expect(original.readOnly).toBe(false);
    await f.input('https://example.com/中文');
    expect(original.value).toBe('https://example.com/中文');
    await f.update(
      { toolbar: { ...f.current.snapshot.toolbar, address: 'https://example.com/new-document' } },
      { actionable: true, pageToken: 'page-token-two' },
    );
    expect(original.value).toBe('https://example.com/中文');
    await f.submit();
    expect(navigations(f.events)).toHaveLength(0);
    await f.flush(() =>
      original.dispatchEvent(
        new f.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '中文' }),
      ),
    );
    expect(navigations(f.events)).toHaveLength(0);
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, address: 'https://example.com/中文' },
    });
    expect(navigations(f.events)).toHaveLength(0);
    await f.submit();
    expect(navigations(f.events)).toHaveLength(1);
    expect(navigations(f.events)[0]).toMatchObject({
      attachment: 'geometry-two',
      pageToken: 'page-token-two',
    });
    const next = f.events.filter((event) => event.attachment === 'geometry-two');
    expect(next.map((event) => event.sequence)).toEqual(next.map((_, i) => i + 1));
  } finally {
    await f.close();
  }
});

test('unconfirmed sends are never replayed; a retired binding permits new UI editing but not old navigate', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush(() => f.address().focus());
    f.result = async () => 'unconfirmed';
    await f.input('https://example.com/unknown');
    expect(document.querySelector('[role="status"]')?.getAttribute('title')).toContain(
      '不会自动重发',
    );
    const count = f.events.length;
    await f.submit();
    await f.click('刷新网页');
    expect(f.events).toHaveLength(count);
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, address: 'https://example.com/unknown' },
    });
    expect(f.events).toHaveLength(count);
    expect(navigations(f.events)).toHaveLength(0);
    f.result = async () => 'forwarded';
    await f.update({}, { attachment: 'new-geometry' });
    expect(f.address().value).toBe('https://example.com/unknown');
    expect(navigations(f.events)).toHaveLength(0);
    await f.input('https://example.com/new-intent');
    expect(f.events.at(-1)).toMatchObject({
      attachment: 'new-geometry',
      action: { type: 'address-change', value: 'https://example.com/new-intent' },
    });
    expect(navigations(f.events)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('readonly URL remains selectable; inactive authority blocks actions and Tab/Escape return focus to Root', async () => {
  const f = await fixture();
  try {
    await f.render();
    const url = `https://example.com/${'x'.repeat(2500)}`;
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, canNavigate: false, readonlyURL: url },
    });
    expect(f.address().readOnly).toBe(true);
    expect(f.address().disabled).toBe(false);
    expect(f.address().value).toBe(url);
    await f.flush(() => {
      f.address().focus();
      f.address().setSelectionRange(0, url.length);
    });
    expect(f.address().selectionEnd).toBe(url.length);
    await f.click('刷新网页');
    expect(navigations(f.events)).toHaveLength(0);
    await f.update({}, { actionable: false });
    const count = f.events.length;
    await f.click('页面选项');
    await f.click('浏览器控制');
    await f.click('新建标签页');
    expect(f.events).toHaveLength(count);
    const last = document.querySelector<HTMLButtonElement>('[aria-label="页面选项"]')!;
    await f.flush(() => {
      last.focus();
      last.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
    });
    expect(f.events.at(-1)?.part).toBe('focus-root');
    await f.flush(() =>
      last.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    // First Escape leaves a focused address edit; a subsequent Escape reaches Root.
    await f.flush(() =>
      last.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.events.at(-1)?.part).toBe('escape');
  } finally {
    await f.close();
  }
});

test('a new owner cancels an old echo barrier and cannot inherit pending navigation', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush(() => f.address().focus());
    await f.input('https://example.com/old-intent');
    await f.submit();
    const prior = f.address();
    await f.update(
      {
        scope: { ...f.current.snapshot.scope, sessionId: 'another-session', viewSelection: 2 },
        tabs: { ...f.current.snapshot.tabs, scopeKey: 'store/another-session' },
        toolbar: {
          ...f.current.snapshot.toolbar,
          address: 'https://example.com/new-owner',
          readonlyURL: 'https://example.com/new-owner',
        },
      },
      { attachment: 'new-owner', pageToken: 'new-owner-page' },
    );
    expect(f.address()).not.toBe(prior);
    expect(f.address().value).toBe('https://example.com/new-owner');
    expect(navigations(f.events)).toHaveLength(0);
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, address: 'https://example.com/old-intent' },
    });
    expect(navigations(f.events)).toHaveLength(0);
    await f.null();
    expect(document.querySelector('.native-browser-address')).toBeNull();
  } finally {
    await f.close();
  }
});

test('Escape cancels address intent immediately and does not navigate or close the sidebar', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.flush(() => f.address().focus());
    await f.input('https://example.com/abandoned');
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, address: 'https://example.com/abandoned' },
    });
    await f.flush(() =>
      f.address().dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.address().value).toBe('https://example.com/original');
    expect(f.events.filter((event) => event.part === 'escape')).toHaveLength(0);
    expect(navigations(f.events)).toHaveLength(0);
    expect(f.events.slice(-2)).toMatchObject([
      {
        part: 'toolbar',
        action: { type: 'address-change', value: 'https://example.com/original' },
      },
      { part: 'toolbar', action: { type: 'address-focus', focused: false } },
    ]);
    await f.update({
      toolbar: { ...f.current.snapshot.toolbar, address: 'https://example.com/original' },
    });
    expect(f.address().value).toBe('https://example.com/original');
    await f.flush(() =>
      f.address().dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(f.events.at(-1)?.part).toBe('escape');
    await f.input('https://example.com/resumed-edit');
    expect(f.events.slice(-2)).toMatchObject([
      { part: 'toolbar', action: { type: 'address-focus', focused: true } },
      {
        part: 'toolbar',
        action: { type: 'address-change', value: 'https://example.com/resumed-edit' },
      },
    ]);
    await f.update({ toolbar: { ...f.current.snapshot.toolbar, loading: true } });
    expect(f.address().value).toBe('https://example.com/resumed-edit');
  } finally {
    await f.close();
  }
});

test('a late initial read cannot roll back a newer watch binding and read/watch are released', async () => {
  const f = await fixture();
  const original = initial();
  let resolve!: (value: NativeBrowserChromeEnvelope) => void;
  f.bridge.read = () =>
    new Promise((done) => {
      resolve = done;
    });
  const watch = f.bridge.watch;
  f.bridge.watch = (receive) => {
    const stop = watch(receive);
    receive({
      ...original,
      attachment: 'newest-geometry',
      snapshot: {
        ...original.snapshot,
        revision: 2,
        toolbar: {
          ...original.snapshot.toolbar,
          address: 'https://example.com/newest',
          readonlyURL: 'https://example.com/newest',
        },
      },
    });
    return stop;
  };
  try {
    await f.render();
    expect(f.address().value).toBe('https://example.com/newest');
    const address = f.address();
    await f.flush(() => resolve(original));
    expect(f.address()).toBe(address);
    expect(address.value).toBe('https://example.com/newest');
    await f.click('页面选项');
    expect(f.events.at(-1)?.attachment).toBe('newest-geometry');
    expect(f.events.at(-1)?.sequence).toBe(1);
  } finally {
    await f.close();
  }
  expect(f.unwatches).toBe(1);
});

test('stale actions report non-delivery and only a new explicit action uses the latest revision', async () => {
  const f = await fixture();
  try {
    await f.render();
    f.result = async () => 'stale';
    await f.click('刷新网页');
    expect(f.events).toHaveLength(1);
    expect(document.querySelector('[role="status"]')?.getAttribute('title')).toContain(
      '原操作未发送',
    );
    await f.update();
    expect(f.events).toHaveLength(1);
    f.result = async () => 'forwarded';
    await f.click('页面选项');
    expect(f.events).toHaveLength(2);
    expect(f.events.at(-1)).toMatchObject({
      revision: f.current.snapshot.revision,
      sequence: 2,
      action: { type: 'show-options' },
    });
    expect(document.querySelector('[role="status"]')).toBeNull();
  } finally {
    await f.close();
  }
});
