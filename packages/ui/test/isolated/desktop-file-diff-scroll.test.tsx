import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
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
