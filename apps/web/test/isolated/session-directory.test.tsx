import { expect, test } from 'bun:test';
import { ClientError, type SessionDirectoryActivity } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installGlobals } from '../globals.fixture';

function item(id: string, workspaceId = 'w', updatedAt: number | null = null) {
  return {
    seq: String(Number(id.replace(/\D/g, '')) + 1),
    session: {
      id,
      workspaceId,
      parentSessionId: null as string | null,
      title: `Title ${id}`,
      controlRevision: '1',
      contextSelectionId: 'selection',
      nextSeq: '0',
      deletedAt: null,
    },
    activity: {
      updatedAt,
      run: null,
      queued: false,
      pendingInteractions: 0,
    } as SessionDirectoryActivity,
  };
}
type Item = ReturnType<typeof item>;
async function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const restoreGlobals = installGlobals({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    CustomEvent: dom.window.CustomEvent,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { WebPage } = await import('../../src/page');
  const calls: string[] = [],
    signals: AbortSignal[] = [];
  const state = {
    entries: Array.from({ length: 17 }, (_, index) =>
      item(`s${index}`, 'w', index === 16 ? null : 1000 + index),
    ),
    fail: false,
    held: undefined as Promise<void> | undefined,
    late: undefined as Item[] | undefined,
  };
  const client = {
    serverInfo: { storeId: 'store', capabilities: [] },
    async listAllWorkspaces() {
      calls.push('workspaces');
      return [
        { id: 'w', name: 'Workspace' },
        { id: 'other', name: 'Other' },
      ];
    },
    async listAllSessionDirectory(options: { workspaceId: string; signal: AbortSignal }) {
      calls.push(`directory:${options.workspaceId}`);
      signals.push(options.signal);
      const held = state.held,
        late = state.late;
      if (held) await held;
      if (state.fail) throw new ClientError('directory_unavailable');
      return (
        late ??
        (options.workspaceId === 'w'
          ? state.entries
          : [item('other0', 'other', 9000), item('other1', 'other', 8000)])
      );
    },
    async getView(id: string) {
      calls.push(`view:${id}`);
      return {
        storeId: 'store',
        snapshotCursor: '1',
        session: item(id).session,
        runs: [],
        executions: [],
      };
    },
    async listMessages() {
      calls.push('messages');
      return [];
    },
  } as unknown as BrowserClient;
  const root = createRoot(dom.window.document.getElementById('root')!);
  async function pause(ms = 0) {
    await act(async () => {
      await Bun.sleep(ms);
    });
  }
  async function render(suspended = false) {
    await act(async () => {
      root.render(
        <WebPage
          client={client}
          window={dom.window as unknown as Window}
          suspended={suspended}
          pollIntervalMs={10000}
        />,
      );
      await Bun.sleep(0);
    });
  }
  await render();
  const document = dom.window.document;
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === name,
    )!;
  const section = (name = 'Workspace') => button(name).closest('section')!;
  const rows = (name = 'Workspace') => [
    ...section(name).querySelectorAll<HTMLAnchorElement>('li a'),
  ];
  async function click(element: Element) {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Bun.sleep(0);
    });
  }
  async function key(element: Element, key: string) {
    await act(async () => {
      element.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      await Bun.sleep(0);
    });
  }
  async function focus(element: HTMLElement) {
    await act(async () => {
      element.focus();
      await Bun.sleep(0);
    });
  }
  async function hover(element: Element, enter: boolean) {
    await act(async () => {
      for (const type of enter
        ? ['pointerover', 'pointermove', 'mouseover']
        : ['pointerout', 'pointerleave', 'mouseout']) {
        const event = new dom.window.MouseEvent(type, {
          bubbles: true,
          relatedTarget: enter ? null : document.body,
        });
        Object.defineProperty(event, 'pointerType', { value: 'mouse' });
        element.dispatchEvent(event);
      }
      await Bun.sleep(0);
    });
    if (!enter) {
      await act(async () => {
        document.body.dispatchEvent(
          new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 1000, clientY: 1000 }),
        );
        await Bun.sleep(0);
      });
    }
  }
  async function visibility(value: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    await act(async () => {
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
      await Bun.sleep(0);
    });
  }
  const tooltip = () => document.querySelector('[role="tooltip"]');
  return {
    state,
    calls,
    signals,
    document,
    button,
    section,
    rows,
    click,
    key,
    focus,
    hover,
    tooltip,
    visibility,
    pause,
    render,
    async close() {
      try {
        await act(async () => root.unmount());
      } finally {
        dom.window.close();
        restoreGlobals();
      }
    },
  };
}

test('complete directory sorts original activity before 5/+10 presentation and keyboard navigation keeps selection explicit', async () => {
  const f = await fixture();
  try {
    const child = item('child18', 'w', 99999);
    child.session.parentSessionId = 's0';
    f.state.entries.push(child, item('foreign19', 'other', 99999));
    await f.click(f.button('Workspace'));
    expect(f.rows().map((row) => row.childNodes[0]?.textContent)).toEqual([
      'Title s15',
      'Title s14',
      'Title s13',
      'Title s12',
      'Title s11',
    ]);
    expect(
      f
        .rows()
        .every(
          (row) =>
            row.childNodes[0]?.textContent ===
            row.getAttribute('href')?.split('/').at(-1)?.replace(/^/, 'Title '),
        ),
    ).toBe(true);
    await f.focus(f.button('Workspace'));
    expect(f.tooltip()!.querySelector('strong')!.textContent).toBe('Workspace');
    expect(f.tooltip()!.textContent).toContain('17');
    await f.key(f.button('Workspace'), 'Escape');
    await f.click(f.button('Show more'));
    expect(f.rows()).toHaveLength(15);
    await f.click(f.button('Show more'));
    expect(f.rows()).toHaveLength(17);
    expect(f.rows().at(-1)!.textContent).toBe('Title s16');
    expect(f.button('Show more')).toBeUndefined();
    await f.click(f.button('Other'));
    expect(f.rows('Other')).toHaveLength(2);
    await f.focus(f.button('Other'));
    await f.focus(f.button('Workspace'));
    expect(f.tooltip()).not.toBeNull();
    await f.click(f.button('Workspace'));
    expect(f.tooltip()).toBeNull();
    await f.click(f.button('Workspace'));
    expect(f.rows()).toHaveLength(5);
    const first = f.rows()[0]!;
    await f.focus(first);
    await f.key(first, 'ArrowDown');
    expect(f.document.activeElement).toBe(f.rows()[1]!);
    await f.key(f.rows()[1]!, 'End');
    expect(f.document.activeElement).toBe(f.rows('Other')[1]!);
    await f.key(f.rows('Other')[1]!, 'Home');
    expect(f.document.activeElement).toBe(f.button('Workspace'));
    expect(f.calls.some((call) => call.startsWith('view:'))).toBe(false);
    await f.click(first);
    const selectedReads = f.calls.filter((call) => call.startsWith('view:'));
    expect(selectedReads.length).toBeGreaterThan(0);
    expect(selectedReads.every((call) => call === 'view:s15')).toBe(true);
  } finally {
    await f.close();
  }
});

test('directory details use original activity and exact time with bounded hover, fast switching, focus and Escape', async () => {
  const f = await fixture();
  try {
    f.state.entries = [item('s0', 'w', 123456), item('s1', 'w', null)];
    f.state.entries[0]!.activity = {
      updatedAt: 123456,
      run: {
        id: 'original-run',
        status: 'waiting_execution',
        isActive: true,
        waitingForResults: true,
      },
      queued: true,
      pendingInteractions: 3,
    };
    await f.click(f.button('Workspace'));
    const [a, b] = f.rows();
    await f.hover(a!, true);
    await f.pause(200);
    await f.hover(a!, false);
    await f.pause(350);
    expect(f.tooltip()).toBeNull();
    await f.hover(a!, true);
    await f.pause(450);
    expect(f.tooltip()).toBeNull();
    await f.pause(90);
    expect(f.tooltip()).not.toBeNull();
    const details = f.tooltip()!.textContent!;
    expect(details).toContain('Waiting for execution');
    expect(f.tooltip()!.querySelector('time')!.getAttribute('datetime')).toBe(
      new Date(123456).toISOString(),
    );
    const field = (label: string) =>
      [...f.tooltip()!.querySelectorAll('dt')].find((element) => element.textContent === label)
        ?.nextElementSibling?.textContent;
    expect(field('Run')).toBe('Waiting for execution');
    expect(field('Activity')).toBe('Active');
    expect(field('Required results')).toBe('Waiting');
    expect(field('Queued work')).toBe('Yes');
    expect(field('Pending interactions')).toBe('3');
    expect(f.calls.some((call) => call.startsWith('view:'))).toBe(false);
    await f.hover(a!, false);
    await f.pause(40);
    await f.hover(b!, true);
    await f.pause(20);
    expect(f.tooltip()).not.toBeNull();
    expect(f.tooltip()!.textContent).toContain('Unknown');
    expect(field('Run')).toBe('No runs');
    expect(field('Activity')).toBe('Inactive');
    expect(field('Required results')).toBe('None');
    expect(field('Queued work')).toBe('No');
    expect(field('Pending interactions')).toBe('0');
    expect(f.tooltip()!.querySelector('time')).toBeNull();
    await f.hover(b!, false);
    await f.pause(350);
    await f.hover(a!, true);
    await f.pause(100);
    expect(f.tooltip()).toBeNull();
    await f.hover(a!, false);
    await f.focus(a!);
    expect(f.tooltip()).not.toBeNull();
    await f.key(a!, 'Escape');
    expect(f.tooltip()).toBeNull();
    await f.focus(b!);
    expect(f.tooltip()).not.toBeNull();
    await f.render(true);
    expect(f.tooltip()).toBeNull();
    await f.render(false);
    await f.focus(a!);
    expect(f.tooltip()).not.toBeNull();
    await f.visibility('hidden');
    expect(f.tooltip()).toBeNull();
    await f.visibility('visible');
    expect(f.rows().map((row) => row.childNodes[0]?.textContent)).toEqual(['Title s0', 'Title s1']);
  } finally {
    await f.close();
  }
});

test('directory failure retains complete facts and late paused or disposed responses cannot publish', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    await f.click(f.button('Workspace'));
    const original = f.rows().map((row) => row.childNodes[0]?.textContent);
    f.state.fail = true;
    await f.click(f.button('Refresh directory'));
    expect(f.rows().map((row) => row.childNodes[0]?.textContent)).toEqual(original);
    expect(f.section().textContent).toContain('directory_unavailable');
    f.state.fail = false;
    await f.click(f.button('Other'));
    const refreshStart = f.calls.length;
    await f.click(f.button('Refresh directory'));
    expect(f.calls.slice(refreshStart).filter((call) => !call.startsWith('view:'))).toEqual([
      'workspaces',
      'directory:w',
      'directory:other',
    ]);
    await f.click(f.button('Other'));
    f.state.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.late = [item('late0')];
    await f.click(f.button('Workspace'));
    await f.click(f.button('Workspace'));
    const signal = f.signals.at(-1)!;
    await f.click(f.button('Other'));
    await f.visibility('hidden');
    expect(signal.aborted).toBe(true);
    await f.render(true);
    expect(signal.aborted).toBe(true);
    release();
    await f.pause();
    expect(f.rows().map((row) => row.childNodes[0]?.textContent)).toEqual(original);
    expect(f.rows('Other').map((row) => row.childNodes[0]?.textContent)).not.toContain(
      'Title late0',
    );
    f.state.held = undefined;
    f.state.late = undefined;
    const resumeStart = f.calls.length;
    await f.visibility('visible');
    await f.render(false);
    expect(f.calls.slice(resumeStart)).toContain('directory:w');
    expect(f.calls.slice(resumeStart)).toContain('directory:other');
    f.state.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.click(f.button('Workspace'));
    await f.click(f.button('Workspace'));
    const disposed = f.signals.at(-1)!;
    await f.close();
    expect(disposed.aborted).toBe(true);
    release();
    expect(f.calls.every((call) => !call.startsWith('POST'))).toBe(true);
  } finally {
    release();
    if (f.document.getElementById('root')?.childNodes.length) await f.close();
  }
});

test('directory activity uses the original run, prioritizes waiting, and labels stale facts instead of showing a live spinner', async () => {
  const f = await fixture();
  try {
    f.state.entries[0]!.activity = {
      updatedAt: 50000,
      queued: false,
      pendingInteractions: 0,
      run: { id: 'r', status: 'running', isActive: true, waitingForResults: false },
    };
    f.state.entries[1]!.activity = {
      updatedAt: 49000,
      queued: false,
      pendingInteractions: 2,
      run: { id: 'r2', status: 'running', isActive: true, waitingForResults: false },
    };
    await f.click(f.button('Workspace'));
    expect(f.rows()[0]!.querySelector('[aria-label="正在运行"]')).not.toBeNull();
    expect(f.rows()[0]!.querySelector('[aria-label="正在运行"]')?.tagName).toBe('svg');
    expect(f.rows()[1]!.textContent).toContain('待用户输入');
    expect(f.rows()[1]!.querySelector('[aria-label="正在运行"]')).toBeNull();
    f.state.fail = true;
    await f.click(f.button('Refresh directory'));
    expect(f.rows()[0]!.querySelector('[aria-label="正在运行"]')).toBeNull();
    expect(f.rows()[0]!.textContent).toContain('上次读取');
  } finally {
    await f.close();
  }
});
