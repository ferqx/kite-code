import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { DirectoryProps } from '../../src/desktop/Sidebar';
import type { WorkspaceSummary } from '../../src/desktop/types';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: ResizeObserverStub,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
Object.assign(dom.window, { ResizeObserver: ResizeObserverStub });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const { Sidebar } = await import('../../src/desktop/Sidebar');
const { searchSessions } = await import('../../src/desktop/SessionSearch');
const host = document.getElementById('root')!;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function workspaces(): WorkspaceSummary[] {
  return ['one', 'two'].map((id, workspace) => ({
    id,
    label: 'Kite',
    rootUri: `file:///projects/${id}`,
    state: 'loaded',
    sessionCount: 205,
    sessions: Array.from({ length: 205 }, (_, index) => ({
      sessionId: `${id}-${index}`,
      displayName: index === 204 ? '旧部署记录' : `会话 ${index}`,
      status: index === 204 && workspace === 1 ? 'running' : 'idle',
      updatedAt: new Date(Date.UTC(2026, 0, 1) - index * 1000 - workspace).toISOString(),
    })),
  }));
}
async function fixture() {
  root = createRoot(host);
  const opened: string[] = [];
  const props: DirectoryProps = {
    workspaces: workspaces(),
    sessionSearch: { scope: 'store-a', available: true },
    onOpen: (id) => opened.push(id),
    defaultExpanded: true,
  };
  const render = async (update: Partial<DirectoryProps> = {}) => {
    Object.assign(props, update);
    await act(async () => root!.render(<Sidebar {...props} actions={{}} connectionLabel="" />));
  };
  await render();
  return { props, opened, render };
}
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="搜索会话"]')!;
const input = () => host.querySelector<HTMLInputElement>('[role="combobox"]')!;
const results = () => [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const click = async (button: HTMLButtonElement) => act(async () => button.click());
async function query(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      input(),
      text,
    );
    input().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function key(value: string, extra: KeyboardEventInit = {}) {
  await act(async () =>
    input().dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    ),
  );
}

test('search reaches old sessions beyond both directory and visible pages and disambiguates same-name projects', async () => {
  const f = await fixture();
  expect(host.textContent).not.toContain('旧部署记录');
  await click(trigger());
  expect(document.activeElement).toBe(input());
  expect(results()).toHaveLength(50);
  expect(host.textContent).toContain('410 个会话');
  await query('  kItE  旧部署  ');
  expect(results()).toHaveLength(2);
  expect(results()[0]!.textContent).toContain('file:///projects/one');
  expect(results()[1]!.textContent).toContain('file:///projects/two');
  expect(results()[1]!.textContent).toContain('正在工作');
  await key('ArrowDown');
  await key('Enter', { isComposing: true });
  await key('Enter', { keyCode: 229 });
  await key('Enter', { repeat: true });
  expect(f.opened).toEqual([]);
  await key('Enter');
  expect(f.opened).toEqual(['two-204']);
  expect(host.querySelector('[role="combobox"]')).toBeNull();
});

test('unavailable or prefix-only directories never claim no matches; recovery uses the retained query', async () => {
  const f = await fixture();
  await click(trigger());
  await query('旧部署');
  await f.render({ sessionSearch: { scope: 'store-a', available: false } });
  expect(results()).toHaveLength(0);
  expect(host.textContent).toContain('会话目录暂不可用');
  expect(host.textContent).not.toContain('未找到');
  await key('Enter');
  expect(f.opened).toEqual([]);
  await f.render({
    sessionSearch: { scope: 'store-a', available: true },
    workspaces: f.props.workspaces.map((w) => ({ ...w, sessions: w.sessions.slice(0, 200) })),
  });
  expect(host.textContent).toContain('会话目录暂不可用');
  await f.render({ workspaces: workspaces() });
  expect(input().value).toBe('旧部署');
  expect(results()).toHaveLength(2);
  await query('不存在');
  expect(host.textContent).toContain('未找到匹配的会话');
});

test('Escape restores the original sidebar nodes and focus; Store changes discard the old search', async () => {
  const f = await fixture();
  const original = host.querySelector('[aria-label="会话 0"]');
  await click(trigger());
  await query('旧部署');
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => input().dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(trigger());
  expect(host.querySelector('[aria-label="会话 0"]')).toBe(original);
  expect(f.opened).toEqual([]);
  await click(trigger());
  await query('旧部署');
  await f.render({ sessionSearch: { scope: 'store-b', available: true }, workspaces: [] });
  expect(host.querySelector('[role="combobox"]')).toBeNull();
  await click(trigger());
  expect(input().value).toBe('');
  expect(host.textContent).toContain('暂无会话');
});

test('keyboard traverses beyond the first rendered page and preserves the selected identity across updates', async () => {
  const f = await fixture();
  await click(trigger());
  for (let i = 0; i < 55; i++) await key('ArrowDown');
  expect(results()).toHaveLength(56);
  const selected = results().find((row) => row.getAttribute('aria-selected') === 'true')!;
  const title = selected.title;
  await f.render({
    workspaces: f.props.workspaces.map((w) => ({ ...w, sessions: [...w.sessions].reverse() })),
  });
  expect(results().find((row) => row.getAttribute('aria-selected') === 'true')!.title).toBe(title);
  await key('ArrowUp');
  await key('Enter');
  expect(f.opened).toHaveLength(1);
  expect(f.opened[0]).toBe('one-27');
});

test('unopted hosts do not expose search and title plus project words match without merging identities', async () => {
  const f = await fixture();
  await f.render({ sessionSearch: undefined });
  expect(trigger()).toBeNull();
  expect(searchSessions(workspaces(), 'KITE 旧部署').map((row) => row.session.sessionId)).toEqual([
    'one-204',
    'two-204',
  ]);
});

test('Escape from a search button is scoped and an A-B-A directory change cannot resurrect search', async () => {
  const f = await fixture();
  await click(trigger());
  const cancel = host.querySelector<HTMLButtonElement>('[aria-label="关闭会话搜索"]')!;
  cancel.focus();
  const escapeEvent = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => cancel.dispatchEvent(escapeEvent));
  expect(escapeEvent.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(trigger());
  expect(host.querySelector('[role="combobox"]')).toBeNull();
  await click(trigger());
  await query('旧部署');
  await f.render({ sessionSearch: { scope: 'store-b', available: true } });
  await f.render({ sessionSearch: { scope: 'store-a', available: true } });
  expect(host.querySelector('[role="combobox"]')).toBeNull();
  await click(trigger());
  expect(input().value).toBe('');
});

test('a selected result that moves during directory refresh is scrolled back into view without changing identity', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    'scrollIntoView',
  );
  const scrolled: string[] = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: HTMLElement) {
      scrolled.push(this.id);
    },
  });
  try {
    const f = await fixture();
    await click(trigger());
    for (let i = 0; i < 55; i++) await key('ArrowDown');
    const selected = results().find((row) => row.getAttribute('aria-selected') === 'true')!;
    const title = selected.title;
    const count = scrolled.length;
    await f.render({
      workspaces: f.props.workspaces.map((w) => ({
        ...w,
        sessions: w.sessions.map((session) =>
          session.sessionId === 'two-27'
            ? { ...session, updatedAt: '2027-01-01T00:00:00.000Z' }
            : session,
        ),
      })),
    });
    expect(results()[0]!.title).toBe(title);
    expect(results()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(scrolled.length).toBe(count + 1);
    expect(scrolled.at(-1)).toBe(results()[0]!.id);
    await key('Enter');
    expect(f.opened).toEqual(['two-27']);
  } finally {
    if (descriptor)
      Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', descriptor);
    else Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'scrollIntoView');
  }
});
