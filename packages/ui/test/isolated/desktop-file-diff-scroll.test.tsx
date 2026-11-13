import { JSDOM } from 'jsdom';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from '#kite-test';
import { NativeScrollbars, ScrollArea } from '../../src/desktop/components/ui/scroll-area';
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

test('native nested readers leave boundary wheels to the browser without moving an ancestor in JavaScript', async () => {
  await withDom(async ({ host, render }) => {
    await render(
      <NativeScrollbars>
        <div data-outer style={{ overflowY: 'auto' }}>
          <ScrollArea chainScroll viewportClassName="native-group">
            <ScrollArea chainScroll viewportClassName="native-detail">
              <span data-target>original output</span>
            </ScrollArea>
          </ScrollArea>
        </div>
      </NativeScrollbars>,
    );
    const outer = host.querySelector<HTMLElement>('[data-outer]')!;
    const group = host.querySelector<HTMLElement>('.native-group')!;
    const detail = host.querySelector<HTMLElement>('.native-detail')!;
    for (const node of [outer, group, detail]) {
      Object.defineProperties(node, {
        clientHeight: { value: 100, configurable: true },
        scrollHeight: { value: 400, configurable: true },
      });
      node.style.overflowY = 'auto';
    }
    const target = host.querySelector('[data-target]')!;
    for (const [position, deltaY] of [
      [300, 30],
      [0, -30],
    ] as const) {
      detail.scrollTop = group.scrollTop = position;
      outer.scrollTop = 150;
      const event = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
      await act(async () => target.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(detail.scrollTop).toBe(position);
      expect(group.scrollTop).toBe(position);
      expect(outer.scrollTop).toBe(150);
    }
    expect(host.querySelector('[data-radix-scroll-area-viewport]') === null).toBe(true);
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
    const pre = viewport.querySelector('.diff-output')!;
    expect([...pre.children].map((row) => row.textContent).join('\n')).toBe(diff);
    expect(pre.getAttribute('role')).toBeNull();
    expect(pre.getAttribute('tabindex')).toBeNull();
    // A headerless legacy body is readable plain text, never an invented Git hunk.
    expect(pre.querySelector('.diff-added')).toBeNull();
    expect(pre.querySelector('.diff-removed')).toBeNull();
    expect(host.querySelector('[data-format="plain"]')).not.toBeNull();
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(1);
    expect(host.querySelectorAll('.diff-output')).toHaveLength(1);
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
    expect(details.querySelector('.diff-output')?.textContent).toBe('+first complete diff');
    await click(details.querySelector<HTMLButtonElement>('button.file-link')!);
    expect(opened).toEqual(['src/first.ts']);
    await act(async () => {
      details.open = false;
      details.dispatchEvent(new details.ownerDocument.defaultView!.Event('toggle'));
    });
    expect(host.querySelector('[aria-label="文件差异"]')).toBeNull();
  });
});

test('legacy or oversized diff bodies keep a bounded DOM and explicitly report omitted rows and long lines', async () => {
  await withDom(async ({ host, render }) => {
    await render(
      <FileDiff
        message={message('huge', `1 +${'🙂'.repeat(10000)}\n${'2 -line\n'.repeat(100000)}`)}
      />,
    );
    expect(host.querySelector('.diff-output')!.children.length).toBeLessThanOrEqual(400);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('400 行');
    expect(host.querySelector('.diff-added')!.textContent!.length).toBeLessThan(2060);
    expect(host.querySelector('.diff-added')!.textContent).not.toContain('\uFFFD');
    expect(host.querySelector('.diff-removed')).not.toBeNull();
    await render(<FileDiff message={message('small', '1 -before\n1 +after')} />);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('.diff-removed')!.textContent).toContain('before');
    expect(host.querySelector('.diff-added')!.textContent).toContain('after');
  });
});

test('split diff aligns replacements, preserves plain markup and switches to genuine unified line numbers', async () => {
  await withDom(async ({ host, render, click }) => {
    await render(
      <FileDiff
        scope="workspace"
        path="src/renamed file.ts"
        message={message(
          'split',
          [
            'diff --git a/old.ts b/renamed file.ts',
            'rename from old.ts',
            'rename to renamed file.ts',
            '--- a/old.ts',
            '+++ b/renamed file.ts',
            '@@ -3,2 +7,3 @@',
            ' const same = true;',
            '-const old = "<script>alert(1)</script>";',
            '+const next = "<img src=x onerror=alert(1)>";',
            '+const extra = 42;',
          ].join('\n'),
        )}
      />,
    );
    expect(host.querySelector('.file-diff')?.getAttribute('data-layout')).toBe('split');
    expect(host.querySelector('.file-diff-path')?.textContent).toBe('src/renamed file.ts');
    expect(host.querySelector('.file-diff-counts')?.textContent).toBe('预览 +2 -1');
    expect(host.querySelectorAll('script, img')).toHaveLength(0);
    expect(host.querySelectorAll('.file-diff-empty')).toHaveLength(1);
    const replacement = host.querySelector('.file-diff-split-row:has(.diff-removed)')!;
    expect(replacement.querySelector('.diff-removed .file-diff-number')?.textContent).toBe('4');
    expect(replacement.querySelector('.diff-added .file-diff-number')?.textContent).toBe('8');
    expect(replacement.querySelector('.diff-added')?.textContent).toContain(
      '<img src=x onerror=alert(1)>',
    );
    expect(host.querySelectorAll('.file-diff-token-keyword').length).toBeGreaterThan(0);
    const viewport = host.querySelector<HTMLElement>('.tool-diff-viewport')!;
    const unified = [...host.querySelectorAll<HTMLButtonElement>('.file-diff-layout button')].find(
      (button) => button.textContent === '统一',
    )!;
    await click(unified);
    expect(unified.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.file-diff')?.getAttribute('data-layout')).toBe('unified');
    expect(host.querySelector('.tool-diff-viewport')).toBe(viewport);
    expect(host.querySelectorAll('.file-diff-unified-row')).toHaveLength(4);
    expect(host.querySelectorAll('.file-diff-empty')).toHaveLength(0);
    const removed = host.querySelector('.file-diff-unified-row:has(.diff-removed)')!;
    expect(removed.querySelector('.file-diff-old-number')?.textContent).toBe('4');
    expect(removed.querySelector('.file-diff-number')?.textContent).toBe('');
    const added = host.querySelector('.file-diff-unified-row:has(.diff-added)')!;
    expect(added.querySelector('.file-diff-old-number')?.textContent).toBe('');
    expect(added.querySelector('.file-diff-number')?.textContent).toBe('8');
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(1);
  });
});

test('fold controls expand only retained context, keep the 400 row bound, and clear on body or identity change', async () => {
  await withDom(async ({ host, render, click }) => {
    const body = [
      '@@ -1,399 +1,399 @@',
      ...Array.from({ length: 399 }, (_, i) => ` context_${i}`),
    ].join('\n');
    const tree = (id: string, stdout = body) => <FileDiff message={message(id, stdout)} />;
    await render(tree('first'));
    const fold = host.querySelector<HTMLButtonElement>('.file-diff-fold')!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.textContent).toContain('393 行未变更');
    await click(fold);
    expect(host.querySelector('.file-diff-fold')).toBeNull();
    expect(host.querySelector('.diff-output')!.children.length).toBe(400);
    await click(
      host.querySelector<HTMLButtonElement>('.file-diff-layout button[aria-pressed="true"]')!,
    );
    expect(host.querySelector('.file-diff-fold')).toBeNull();
    // Repeated clicks on the active layout must not discard expanded reading context.
    host.querySelector<HTMLElement>('.tool-diff-viewport')!.focus();
    expect(host.ownerDocument.activeElement).toBe(host.querySelector('.tool-diff-viewport'));
    await click(host.querySelector<HTMLButtonElement>('.file-diff-collapse')!);
    expect(host.querySelector('.file-diff-fold')).not.toBeNull();
    await click(host.querySelector<HTMLButtonElement>('.file-diff-fold')!);
    await render(tree('first', body.replaceAll('context_', 'refreshed_')));
    expect(host.querySelector('.file-diff-fold')).not.toBeNull();
    expect(host.textContent).not.toContain('context_');
    await click(host.querySelector<HTMLButtonElement>('.file-diff-fold')!);
    await render(tree('second'));
    expect(host.querySelector('.file-diff-fold')).not.toBeNull();
    expect(host.textContent).not.toContain('refreshed_');
    await render(
      tree(
        'omitted',
        'Line diff (bounded alignment; unchanged gaps omitted)\n... unchanged lines omitted ...\n9 -old\n9 +new',
      ),
    );
    expect(host.querySelector('.file-diff-fold')).toBeNull();
    expect(host.querySelector('.file-diff-omitted')?.textContent).toContain('无法展开');
    await render(null);
    expect(host.querySelector('.file-diff')).toBeNull();
    await render(tree('first'));
    expect(host.querySelector('.file-diff-fold')).not.toBeNull();
  });
});

test('both layouts stay at most 400 rows for replacements and syntax spans have a global cap', async () => {
  await withDom(async ({ host, render, click }) => {
    const body = Array.from(
      { length: 200 },
      (_, i) => `${i + 1} -const Old = "x";\n${i + 1} +const New = "y";`,
    ).join('\n');
    await render(<FileDiff path="a.ts" message={message('large', body)} />);
    expect(host.querySelector('.diff-output')!.children.length).toBe(200);
    const unified = [...host.querySelectorAll<HTMLButtonElement>('.file-diff-layout button')].find(
      (button) => button.textContent === '统一',
    )!;
    await click(unified);
    expect(host.querySelector('.diff-output')!.children.length).toBe(400);
    expect(host.querySelectorAll('.file-diff-code > span').length).toBeLessThanOrEqual(2048);
    expect(host.querySelectorAll('.tool-diff-viewport')).toHaveLength(1);
    expect(host.querySelectorAll('.file-diff-row [data-slot="scroll-area-viewport"]')).toHaveLength(
      0,
    );
  });
});

test('controlled layout remains the workspace choice across files and narrow controls remain named', async () => {
  await withDom(async ({ host, render, click }) => {
    const choices: string[] = [];
    const tree = (id: string, layout: 'split' | 'unified') => (
      <div style={{ width: 280 }}>
        <FileDiff
          message={message(id, '1 -before\n1 +after')}
          path={`src/${id}.ts`}
          scope="workspace"
          layout={layout}
          onLayoutChange={(next) => choices.push(next)}
        />
      </div>
    );
    await render(tree('first', 'unified'));
    expect(host.querySelector('.file-diff')?.getAttribute('data-layout')).toBe('unified');
    const split = [...host.querySelectorAll<HTMLButtonElement>('.file-diff-layout button')].find(
      (button) => button.textContent === '双栏',
    )!;
    await click(split);
    expect(choices).toEqual(['split']);
    expect(host.querySelector('.file-diff')?.getAttribute('data-layout')).toBe('unified');
    await render(tree('second', 'unified'));
    expect(host.querySelector('.file-diff')?.getAttribute('data-layout')).toBe('unified');
    expect(host.querySelector('fieldset')?.getAttribute('aria-label')).toBe('差异布局');
    expect(host.querySelector('.tool-diff-viewport')?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('.tool-diff-viewport')?.getAttribute('aria-label')).toBe('文件差异');
    await render(tree('second', 'split'));
    expect(host.querySelector('.file-diff')?.getAttribute('data-layout')).toBe('split');
  });
});

test('wide CJK, emoji and tabs reserve shared scroll width without crossing the other side', async () => {
  await withDom(async ({ host, render }) => {
    for (const [text, minimumColumns] of [
      ['中'.repeat(200), 820],
      ['漢🙂\t'.repeat(100), 1620],
    ] as const) {
      await render(<FileDiff message={message('wide', `1 -${text}\n1 +short`)} />);
      const surface = host.querySelector<HTMLElement>('.diff-output')!;
      expect(Number(surface.style.getPropertyValue('--file-diff-columns'))).toBeGreaterThanOrEqual(
        minimumColumns,
      );
      expect(host.querySelector('.diff-removed .file-diff-code')?.textContent).toBe(text);
      expect(host.querySelector('.diff-added .file-diff-code')?.textContent).toBe('short');
      expect(host.querySelectorAll('.tool-diff-viewport')).toHaveLength(1);
      expect(host.querySelectorAll('.file-diff-cell [data-slot="scroll-area"]')).toHaveLength(0);
    }
  });
});
