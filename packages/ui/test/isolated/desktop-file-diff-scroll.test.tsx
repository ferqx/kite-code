import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ScrollArea } from '../../src/desktop/components/ui/scroll-area';
import { FileChanges, FileDiff } from '../../src/desktop/FileChanges';
import type { Message } from '../../src/desktop/types';

async function withDom(
  inspect: (fixture: {
    host: HTMLElement;
    render: (content: ReactNode) => Promise<void>;
    click: (element: HTMLElement) => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'ResizeObserver',
  ] as const;
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  }))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await inspect({
      host,
      render: (content) =>
        act(async () => {
          root.render(content);
        }),
      click: (element) =>
        act(async () => {
          element.click();
        }),
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function message(id: string, stdout: string): Message {
  return {
    id,
    role: 'tool',
    text: '',
    settled: true,
    status: 'completed',
    toolName: 'edit_file',
    changedFile: `src/${id}.ts`,
    toolResult: { ok: true, stdout },
  };
}

test('nested tool wheels retain native scrolling and hand edge input to one capable ancestor', async () => {
  await withDom(async ({ host, render }) => {
    const tree = (enabled: boolean) => (
      <div data-outer style={{ overflowY: 'auto' }}>
        <ScrollArea chainScroll={enabled} viewportClassName="group">
          <ScrollArea
            chainScroll={enabled}
            viewportClassName="detail"
            viewportProps={{ style: { lineHeight: '20px' } }}
          >
            <span data-target>complete tool output</span>
          </ScrollArea>
        </ScrollArea>
      </div>
    );
    await render(tree(true));
    const outer = host.querySelector<HTMLElement>('[data-outer]')!;
    const group = host.querySelector<HTMLElement>('.group')!;
    const detail = host.querySelector<HTMLElement>('.detail')!;
    const target = host.querySelector<HTMLElement>('[data-target]')!;
    for (const [node, height, content] of [
      [outer, 200, 1000],
      [group, 100, 400],
      [detail, 100, 400],
    ] as const)
      Object.defineProperties(node, {
        clientHeight: { value: height, configurable: true },
        scrollHeight: { value: content, configurable: true },
      });
    const wheel = async (options: WheelEventInit = {}) => {
      const event = new target.ownerDocument.defaultView!.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 25,
        ...options,
      });
      await act(async () => target.dispatchEvent(event));
      return event.defaultPrevented;
    };
    detail.scrollTop = 50;
    group.scrollTop = 50;
    outer.scrollTop = 100;
    expect(await wheel()).toBe(false);
    expect(group.scrollTop).toBe(50);
    expect(outer.scrollTop).toBe(100);
    detail.scrollTop = 300;
    expect(await wheel()).toBe(true);
    expect(group.scrollTop).toBe(75);
    expect(outer.scrollTop).toBe(100);
    group.scrollTop = 300;
    expect(await wheel()).toBe(true);
    expect(outer.scrollTop).toBe(125);
    detail.scrollTop = group.scrollTop = 0;
    expect(await wheel({ deltaY: -25 })).toBe(true);
    expect(outer.scrollTop).toBe(100);
    Object.defineProperty(detail, 'scrollHeight', { value: 100, configurable: true });
    Object.defineProperty(group, 'scrollHeight', { value: 100, configurable: true });
    expect(await wheel({ deltaMode: 1, deltaY: 2 })).toBe(true);
    expect(outer.scrollTop).toBe(140);
    expect(await wheel({ deltaMode: 2, deltaY: 1 })).toBe(true);
    expect(outer.scrollTop).toBe(340);
    for (const options of [
      { ctrlKey: true },
      { shiftKey: true },
      { deltaX: 50 },
      { deltaX: 5 },
      { cancelable: false },
    ])
      expect(await wheel(options)).toBe(false);
    expect(outer.scrollTop).toBe(340);
    outer.scrollTop = 800;
    expect(await wheel()).toBe(false);
    await render(tree(false));
    outer.scrollTop = 100;
    expect(await wheel()).toBe(false);
    expect(outer.scrollTop).toBe(100);
    await render(tree(true));
    await render(null);
    expect(await wheel()).toBe(false);
    expect(outer.scrollTop).toBe(100);
  });
});

test('tool diff keeps complete lines in a named focusable shared viewport with vertical fade', async () => {
  await withDom(async ({ host, render }) => {
    const diff = `--- before\n+++ after\n-old 漢字🙂\n+new 漢字🙂\n${' unchanged '.repeat(100)}\nTAIL_DIFF_SENTINEL`;
    await render(<FileDiff message={message('change', diff)} />);
    const viewport = host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    expect(viewport).not.toBeNull();
    expect(viewport.classList.contains('tool-diff-viewport')).toBe(true);
    expect(viewport.classList.contains('scroll-fade-y')).toBe(true);
    expect(viewport.getAttribute('role')).toBe('region');
    expect(viewport.getAttribute('aria-label')).toBe('文件差异');
    expect(viewport.getAttribute('tabindex')).toBe('0');
    expect(viewport.style.overflowX).toBe('scroll');
    expect(viewport.style.overflowY).toBe('scroll');
    viewport.focus();
    expect(viewport.ownerDocument.activeElement).toBe(viewport);
    const key = new viewport.ownerDocument.defaultView!.KeyboardEvent('keydown', {
      key: 'PageDown',
      bubbles: true,
      cancelable: true,
    });
    viewport.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    const pre = viewport.querySelector('pre.diff-output')!;
    expect(pre.textContent).toBe(`${diff}\n`);
    expect(pre.getAttribute('role')).toBeNull();
    expect(pre.getAttribute('tabindex')).toBeNull();
    expect(pre.querySelector('.diff-added')?.textContent).toBe('+new 漢字🙂\n');
    expect(pre.querySelector('.diff-removed')?.textContent).toBe('-old 漢字🙂\n');
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(1);
    expect(host.querySelectorAll('pre')).toHaveLength(1);
    expect(host.querySelector('.tool-diff-scroll')?.contains(viewport)).toBe(true);
  });
});

test('Home and End reveal the focused reader edge in enclosing scroll windows without handling child controls', async () => {
  await withDom(async ({ host, render }) => {
    await render(
      <div data-outer style={{ overflowY: 'auto' }}>
        <ScrollArea chainScroll viewportClassName="detail" viewportProps={{ tabIndex: 0 }}>
          <button type="button">child control</button>
          complete result
        </ScrollArea>
      </div>,
    );
    const outer = host.querySelector<HTMLElement>('[data-outer]')!;
    const detail = host.querySelector<HTMLElement>('.detail')!;
    Object.defineProperty(outer, 'clientHeight', { value: 300 });
    outer.getBoundingClientRect = () => ({ top: 100, bottom: 400 }) as DOMRect;
    let edge = 'end';
    detail.getBoundingClientRect = () =>
      (edge === 'end'
        ? { top: 140, bottom: 412 - outer.scrollTop }
        : { top: 88 - outer.scrollTop, bottom: 360 }) as DOMRect;
    const key = async (target: HTMLElement, options: KeyboardEventInit) => {
      const event = new target.ownerDocument.defaultView!.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...options,
      });
      await act(async () => {
        target.dispatchEvent(event);
        await new Promise((resolve) => setTimeout(resolve, 35));
      });
      expect(event.defaultPrevented).toBe(false);
    };
    detail.focus();
    await key(detail, { key: 'End' });
    expect(outer.scrollTop).toBe(12);
    await key(detail, { key: 'End' });
    expect(outer.scrollTop).toBe(12);
    edge = 'home';
    outer.scrollTop = 0;
    await key(detail, { key: 'Home' });
    expect(outer.scrollTop).toBe(-12);
    outer.scrollTop = 0;
    await key(detail, { key: 'Home', shiftKey: true });
    await key(detail.querySelector('button')!, { key: 'End' });
    expect(outer.scrollTop).toBe(0);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    outer.getAnimations = () =>
      [
        {
          finished: new Promise(() => {}),
          timeline: {},
          playState: 'running',
          effect: { getComputedTiming: () => ({ endTime: 300 }) },
        },
        {
          finished,
          timeline: outer.ownerDocument.timeline,
          playState: 'running',
          effect: { getComputedTiming: () => ({ endTime: 300 }) },
        },
      ] as unknown as Animation[];
    edge = 'end';
    await key(detail, { key: 'End' });
    expect(outer.scrollTop).toBe(12);
    detail.getBoundingClientRect = () => ({ top: 140, bottom: 447 - outer.scrollTop }) as DOMRect;
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(outer.scrollTop).toBe(47);
    const later = new Promise<void>((resolve) => {
      finish = resolve;
    });
    outer.getAnimations = () =>
      [
        {
          finished: later,
          timeline: outer.ownerDocument.timeline,
          playState: 'running',
          effect: { getComputedTiming: () => ({ endTime: 300 }) },
        },
      ] as unknown as Animation[];
    await key(detail, { key: 'End' });
    detail.dispatchEvent(
      new detail.ownerDocument.defaultView!.Event('pointerdown', { bubbles: true }),
    );
    detail.getBoundingClientRect = () => ({ top: 140, bottom: 482 - outer.scrollTop }) as DOMRect;
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(outer.scrollTop).toBe(47);
  });
});

test('file changes retain exact open actions and lazy original detail mounting', async () => {
  await withDom(async ({ host, render, click }) => {
    const opened: string[] = [];
    const rendered: string[] = [];
    const messages = [
      message('first', '+first complete diff'),
      message('second', '+second complete diff'),
    ];
    await render(
      <FileChanges
        messages={messages}
        openFile={(path) => opened.push(path)}
        renderDetail={(entry) => {
          rendered.push(entry.id);
          return <FileDiff message={entry} />;
        }}
      />,
    );
    expect(rendered).toEqual([]);
    expect(host.querySelector('[aria-label="文件差异"]')).toBeNull();
    const details = host.querySelector<HTMLDetailsElement>('.file-change')!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new details.ownerDocument.defaultView!.Event('toggle'));
    });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.every((id) => id === 'first')).toBe(true);
    expect(host.querySelectorAll('[aria-label="文件差异"]')).toHaveLength(1);
    expect(details.querySelector('pre')?.textContent).toBe('+first complete diff\n');
    await click(details.querySelector<HTMLButtonElement>('button.file-link')!);
    expect(opened).toEqual(['src/first.ts']);
    await act(async () => {
      details.open = false;
      details.dispatchEvent(new details.ownerDocument.defaultView!.Event('toggle'));
    });
    expect(host.querySelector('[aria-label="文件差异"]')).toBeNull();
  });
});
