import { afterAll, expect, mock, test } from 'bun:test';
import { Folder01Icon, Folder02Icon } from '@hugeicons/core-free-icons';
import { JSDOM } from 'jsdom';
import { act, type ComponentProps } from 'react';
import type { DirectoryProps, PageActions } from '../../src/desktop/Sidebar';
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
const hugeicons = await import('@hugeicons/react');
const OriginalIcon = hugeicons.HugeiconsIcon;
let headerRenders = 0;
// Preserve the actual icon renderer while counting the folder render owned only
// by each Workspace header. No component internals or React Fiber are inspected.
mock.module('@hugeicons/react', () => ({
  ...hugeicons,
  HugeiconsIcon: (props: ComponentProps<typeof OriginalIcon>) => {
    if (props.icon === Folder01Icon || props.icon === Folder02Icon) headerRenders++;
    return <OriginalIcon {...props} />;
  },
}));
const { createRoot } = await import('react-dom/client');
const { Sidebar } = await import('../../src/desktop/Sidebar');
afterAll(() => {
  mock.restore();
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function fixture() {
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const rowReads = new Map<string, number>();
  const calls: string[] = [];
  const session = (id: string, pendingInteractions = 0) => ({
    sessionId: id,
    status: 'idle',
    pendingInteractions,
    get displayName() {
      rowReads.set(id, (rowReads.get(id) ?? 0) + 1);
      return `Session ${id}`;
    },
  });
  let workspaces: WorkspaceSummary[] = ['a', 'b', 'c'].map((id) => ({
    id,
    label: `Workspace ${id}`,
    state: 'loaded',
    sessionCount: 5,
    sessions: Array.from({ length: 5 }, (_, index) => session(`${id}${index}`)),
  }));
  const defaultOpen = (id: string) => calls.push(`open:${id}`);
  const props: DirectoryProps & { actions: PageActions; connectionLabel: string } = {
    workspaces,
    actions: {},
    connectionLabel: '',
    selected: 'a0',
    onOpen: defaultOpen,
  };
  return {
    host,
    calls,
    rowReads,
    row: (id: string) => host.querySelector<HTMLButtonElement>(`[aria-label="Session ${id}"]`)!,
    reset() {
      headerRenders = 0;
      rowReads.clear();
    },
    changePending(id: string) {
      workspaces = workspaces.map((workspace) =>
        workspace.sessions.some((entry) => entry.sessionId === id)
          ? {
              ...workspace,
              sessions: workspace.sessions.map((entry) =>
                entry.sessionId === id ? session(id, 2) : entry,
              ),
            }
          : workspace,
      );
      props.workspaces = workspaces;
    },
    async render(updates: Partial<typeof props> = {}) {
      Object.assign(props, updates);
      await act(async () => root.render(<Sidebar {...props} />));
    },
    async close() {
      await act(async () => root.unmount());
    },
  };
}

test('session selection renders only the previous and next rows without rebuilding Workspace headers', async () => {
  const f = await fixture();
  try {
    await f.render();
    expect(headerRenders).toBe(3);
    const originalA = f.row('a0');
    const originalB = f.row('b3');
    f.reset();
    await f.render({ selected: 'a1' });
    expect([...f.rowReads.keys()].sort()).toEqual(['a0', 'a1']);
    expect(headerRenders).toBe(0);
    expect(f.row('a0')).toBe(originalA);
    expect(f.row('a0').getAttribute('aria-current')).toBeNull();
    expect(f.row('a1').getAttribute('aria-current')).toBe('page');
    f.reset();
    await f.render({ selected: 'b3' });
    expect([...f.rowReads.keys()].sort()).toEqual(['a1', 'b3']);
    expect(headerRenders).toBe(0);
    expect(f.row('b3')).toBe(originalB);
    expect(f.row('b3').getAttribute('aria-current')).toBe('page');
    f.changePending('a2');
    f.reset();
    await f.render();
    expect([...f.rowReads.keys()]).toEqual(['a2']);
    expect(headerRenders).toBe(0);
    expect(f.row('a2').getAttribute('aria-description')).toBe('待用户输入');
    expect(f.row('a2').textContent).toContain('待用户输入');
  } finally {
    await f.close();
  }
});

test('row and header memo boundaries preserve current callbacks, keyboard navigation and withdrawn operations', async () => {
  const f = await fixture();
  try {
    await f.render({ actions: { newWorkspaceSession: (id) => f.calls.push(`old-new:${id}`) } });
    const row = f.row('a0');
    const create = f.host.querySelector<HTMLButtonElement>(
      '[aria-label="在 Workspace a 中新建对话"]',
    )!;
    await f.render({
      onOpen: (id) => f.calls.push(`latest:${id}`),
      actions: { newWorkspaceSession: (id) => f.calls.push(`latest-new:${id}`) },
    });
    expect(f.row('a0')).toBe(row);
    expect(f.host.querySelector('[aria-label="在 Workspace a 中新建对话"]')).toBe(create);
    await act(async () => {
      row.focus();
      row.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(f.row('a1'));
    await act(async () => {
      f.row('a1').dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      create.click();
    });
    expect(f.calls).toEqual(['latest:a1', 'latest-new:a']);
    await f.render({ onOpen: undefined, actions: {} });
    expect(row.disabled).toBe(true);
    expect(f.host.querySelector('[aria-label="在 Workspace a 中新建对话"]')).toBeNull();
    await act(async () => row.click());
    expect(f.calls).toEqual(['latest:a1', 'latest-new:a']);
  } finally {
    await f.close();
  }
});
