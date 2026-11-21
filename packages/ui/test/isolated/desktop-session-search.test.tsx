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
  NodeFilter: dom.window.NodeFilter,
  HTMLInputElement: dom.window.HTMLInputElement,
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
const { searchSessions, sessionSearchActivityTime } = await import(
  '../../src/desktop/SessionSearch'
);
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
const palette = () => document.querySelector<HTMLElement>('.session-search');
const input = () => palette()!.querySelector<HTMLInputElement>('[role="combobox"]')!;
const results = () => [
  ...(palette()?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []),
];
const focusSettled = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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
  expect(document.activeElement === input()).toBe(true);
  expect(palette()?.parentElement === document.body).toBe(true);
  expect(palette()?.getAttribute('role')).toBe('dialog');
  expect(palette()?.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(trigger().getAttribute('aria-controls')!) === palette()).toBe(
    true,
  );
  expect(host.querySelector<HTMLElement>('.workspace-directory')?.style.display).not.toBe('none');
  expect(results()).toHaveLength(50);
  expect(palette()?.textContent).not.toContain('最近会话');
  expect(palette()?.querySelector('[role="status"]')).toBeNull();
  expect(palette()?.querySelector('kbd')).toBeNull();
  await query('  kItE  旧部署  ');
  expect(results()).toHaveLength(2);
  expect(palette()?.querySelector('[role="status"]')).toBeNull();
  expect(results()[0]!.textContent).toContain('file:///projects/one');
  expect(results()[1]!.textContent).toContain('file:///projects/two');
  expect(results()[1]!.textContent).toContain('正在工作');
  await key('ArrowDown');
  await key('Escape', { isComposing: true });
  await key('Escape', { keyCode: 229 });
  expect(document.activeElement === input()).toBe(true);
  await key('Enter', { isComposing: true });
  await key('Enter', { keyCode: 229 });
  await key('Enter', { repeat: true });
  expect(f.opened).toEqual([]);
  await key('Enter');
  expect(f.opened).toEqual(['two-204']);
  expect(palette() === null).toBe(true);
});

test('unavailable or prefix-only directories never claim no matches; recovery uses the retained query', async () => {
  const f = await fixture();
  await click(trigger());
  await query('旧部署');
  await f.render({ sessionSearch: { scope: 'store-a', available: false } });
  expect(results()).toHaveLength(0);
  expect(palette()?.textContent).toContain('会话目录暂不可用');
  expect(palette()?.textContent).not.toContain('未找到');
  await key('Enter');
  expect(f.opened).toEqual([]);
  await f.render({
    sessionSearch: { scope: 'store-a', available: true },
    workspaces: f.props.workspaces.map((w) => ({ ...w, sessions: w.sessions.slice(0, 200) })),
  });
  expect(palette()?.textContent).toContain('会话目录暂不可用');
  await f.render({ workspaces: workspaces() });
  expect(input().value).toBe('旧部署');
  expect(results()).toHaveLength(2);
  await query('不存在');
  expect(palette()?.textContent).toContain('未找到匹配的会话');
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
  await focusSettled();
  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement === trigger()).toBe(true);
  expect(host.querySelector('[aria-label="会话 0"]') === original).toBe(true);
  expect(f.opened).toEqual([]);
  await click(trigger());
  await query('旧部署');
  await f.render({ sessionSearch: { scope: 'store-b', available: true }, workspaces: [] });
  expect(palette() === null).toBe(true);
  await click(trigger());
  expect(input().value).toBe('');
  expect(palette()?.textContent).toContain('暂无会话');
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
  const cancel = palette()!.querySelector<HTMLButtonElement>('[aria-label="关闭会话搜索"]')!;
  cancel.focus();
  const escapeEvent = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  await act(async () => cancel.dispatchEvent(escapeEvent));
  await focusSettled();
  expect(escapeEvent.defaultPrevented).toBe(true);
  expect(document.activeElement === trigger()).toBe(true);
  expect(palette() === null).toBe(true);
  await click(trigger());
  await query('旧部署');
  await f.render({ sessionSearch: { scope: 'store-b', available: true } });
  await f.render({ sessionSearch: { scope: 'store-a', available: true } });
  expect(palette() === null).toBe(true);
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

test('the close control dismisses only the palette and a fresh open restores autofocus', async () => {
  const f = await fixture();
  await click(trigger());
  const original = input();
  expect(document.activeElement === original).toBe(true);
  await query('旧部署');
  await click(palette()!.querySelector<HTMLButtonElement>('[aria-label="关闭会话搜索"]')!);
  await focusSettled();
  expect(palette() === null).toBe(true);
  expect(document.activeElement === trigger()).toBe(true);
  expect(f.opened).toEqual([]);
  await click(trigger());
  expect(input() === original).toBe(false);
  expect(input().value).toBe('');
  expect(document.activeElement === input()).toBe(true);
});

test('activity display uses the ranked timestamp and omits invalid time without losing the row', async () => {
  const f = await fixture();
  const now = Date.now();
  const one = workspaces()[0]!;
  const iso = (elapsed: number) => new Date(now - elapsed).toISOString();
  const sessions = [
    { ...one.sessions[0]!, displayName: 'Hour row', updatedAt: iso(36_010_000) },
    { ...one.sessions[1]!, displayName: 'Minute row', updatedAt: iso(310_000) },
    { ...one.sessions[2]!, displayName: 'Unknown row', updatedAt: 'not-an-iso-date' },
    { ...one.sessions[3]!, displayName: 'Recent row', updatedAt: iso(10_000) },
  ];
  await f.render({ workspaces: [{ ...one, sessions, sessionCount: sessions.length }] });
  await click(trigger());
  const rows = results();
  expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
    'Recent row',
    'Minute row',
    'Hour row',
    'Unknown row',
  ]);
  expect(rows.map((row) => row.querySelector('time')?.textContent)).toEqual([
    '刚刚',
    '5 分钟前',
    '10 小时前',
    undefined,
  ]);
  expect(rows[1]!.querySelector('time')!.dateTime).toBe(sessions[1]!.updatedAt);
  expect(rows[1]!.querySelector('time')!.title).toMatch(/年/);
  expect(rows[3]!.textContent).not.toContain('Invalid Date');
});

test('activity time handles thresholds, daylight-independent elapsed days and old local dates', () => {
  const now = new Date(2026, 10, 21, 12).getTime();
  const label = (timestamp: number) => sessionSearchActivityTime(timestamp, now)?.label;
  expect(label(now - 59_999)).toBe('刚刚');
  expect(label(now - 60_000)).toBe('1 分钟前');
  expect(label(now - 3_600_000)).toBe('1 小时前');
  expect(label(now - 86_400_000)).toBe('1 天前');
  expect(label(new Date(2026, 10, 10, 12).getTime())).toBe('11月10日');
  expect(label(new Date(2025, 10, 10, 12).getTime())).toBe('2025年11月10日');
  expect(label(Number.NaN)).toBeUndefined();
  expect(label(8_640_000_000_000_001)).toBeUndefined();
});
