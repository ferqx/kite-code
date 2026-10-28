import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';

const dom = new JSDOM('<div id="root"></div>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
Object.assign(dom.window.Range.prototype, {
  getBoundingClientRect: () => new dom.window.DOMRect(),
  getClientRects: () => [],
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const { createRoot } = await import('react-dom/client');
const { QueuedMessages } = await import('../../src/desktop/QueuedMessages');
const { Composer } = await import('../../src/desktop/Composer');
let root: ReturnType<typeof createRoot> | undefined;
const host = () => document.getElementById('root')!;
const items = [
  {
    id: 'a',
    text: '**完整强调**\n\n`code` [链接](https://example.com) ![不加载图片](https://example.com/image.png)',
  },
  { id: 'b', text: '# 另一个任务' },
  { id: 'c', text: '末尾任务' },
];
async function render(node: React.ReactNode) {
  root ??= createRoot(host());
  await act(async () => root!.render(node));
}
const buttons = (label: string) => [
  ...host().querySelectorAll<HTMLButtonElement>(`[aria-label="${label}"]`),
];
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host().replaceChildren();
});
afterAll(() => {
  dom.window.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('only the explicit guidance button sends its exact queued input; pending and ineligible rows cannot steer', async () => {
  const sent: string[] = [];
  const props = {
    items: [
      { id: 'a', text: '进度？', steerable: true },
      { id: 'b', text: '计划', steerable: false },
    ],
    onEdit: () => {},
    onDelete: () => {},
    onReorder: () => {},
    onSteer: (id: string) => {
      sent.push(id);
    },
  };
  await render(<QueuedMessages {...props} />);
  expect(sent).toEqual([]);
  expect(buttons('引导发送排队消息')).toHaveLength(2);
  expect(buttons('引导发送排队消息')[1]!.disabled).toBe(true);
  await act(async () => buttons('引导发送排队消息')[0]!.click());
  expect(sent).toEqual(['a']);
  expect(host().querySelectorAll('[data-queued-prompt]')).toHaveLength(2);
  await render(<QueuedMessages {...props} pendingId="a" />);
  await act(async () => buttons('引导发送排队消息')[0]!.click());
  expect(sent).toEqual(['a']);
});

test('queue safely renders Markdown and delegates edits and deletion without optimistic withdrawal or edit state', async () => {
  const edits: string[] = [],
    deletes: string[] = [];
  const props = {
    items,
    onEdit: (id: string) => {
      edits.push(id);
    },
    onDelete: (id: string) => {
      deletes.push(id);
    },
    onReorder: () => {},
  };
  await render(<QueuedMessages {...props} />);
  expect(host().querySelectorAll('[data-queued-prompt]')).toHaveLength(3);
  expect(host().querySelector('.composer-queue-preview strong')?.textContent).toBe('完整强调');
  expect(host().querySelector('.composer-queue-preview code')?.textContent).toBe('code');
  expect(host().querySelector('img')).toBeNull();
  expect(host().querySelectorAll('ol')).toHaveLength(0);
  await act(async () => buttons('编辑排队消息')[0]!.click());
  await act(async () => buttons('删除排队消息')[1]!.click());
  expect(edits).toEqual(['a']);
  expect(deletes).toEqual(['b']);
  expect(host().querySelectorAll('[data-queued-prompt]')).toHaveLength(3);
  expect(host().textContent).not.toContain('取消');
  await render(<QueuedMessages {...props} items={items.slice(1)} />);
  expect(host().querySelector('[data-queued-prompt="a"]')).toBeNull();
  await render(<QueuedMessages {...props} items={[]} />);
  expect(host().textContent).toBe('');
});

test('dragging and keyboard request a full controlled permutation, reject changed source and block all mutations while pending', async () => {
  const orders: readonly string[][] = [];
  const changes: string[] = [];
  const props = {
    items,
    onEdit: () => {
      changes.push('edit');
    },
    onDelete: () => {
      changes.push('delete');
    },
    onReorder: (ids: readonly string[]) => {
      (orders as string[][]).push([...ids]);
    },
  };
  await render(<QueuedMessages {...props} />);
  const key = (index: number, name: string) =>
    buttons('移动排队消息')[index]!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: name,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  await act(async () => {
    key(0, 'ArrowUp');
    key(1, 'ArrowUp');
  });
  expect(orders).toEqual([['b', 'a', 'c']]);
  const transfer = { effectAllowed: '', dropEffect: '', setData: () => {} };
  const drag = (target: Element, type: string) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  };
  await act(async () => {
    drag(buttons('移动排队消息')[0]!, 'dragstart');
    drag(host().querySelector('[data-queued-prompt="c"]')!, 'drop');
  });
  expect(orders[1]).toEqual(['b', 'c', 'a']);
  expect(
    [...host().querySelectorAll('[data-queued-prompt]')].map((row) =>
      row.getAttribute('data-queued-prompt'),
    ),
  ).toEqual(['a', 'b', 'c']);
  await act(async () => drag(buttons('移动排队消息')[0]!, 'dragstart'));
  await render(<QueuedMessages {...props} items={[items[1]!, items[0]!, items[2]!]} />);
  await act(async () => drag(host().querySelector('[data-queued-prompt="c"]')!, 'drop'));
  expect(orders).toHaveLength(2);
  await render(<QueuedMessages {...props} pendingId="a" />);
  expect(buttons('编辑排队消息').every((button) => button.disabled)).toBe(true);
  expect(buttons('删除排队消息').every((button) => button.disabled)).toBe(true);
  expect(buttons('移动排队消息').every((button) => button.disabled && !button.draggable)).toBe(
    true,
  );
  await act(async () => {
    buttons('编辑排队消息')[0]!.click();
    buttons('删除排队消息')[0]!.click();
    key(0, 'ArrowDown');
  });
  expect(orders).toHaveLength(2);
  expect(changes).toEqual([]);
});

test('Composer integrates the queue above its editor and focuses only a host-confirmed same-scope withdrawal', async () => {
  const queue = { items, onEdit: () => {}, onDelete: () => {}, onReorder: () => {} };
  const props = {
    scopeKey: 'a',
    draft: '草稿',
    onChange: () => {},
    active: true,
    stopping: false,
    disabled: false,
    queue,
    inputLabel: '普通输入框',
  };
  await render(<Composer {...props} />);
  const editor = () => host().querySelector<HTMLElement>('[role="textbox"]')!;
  expect(host().querySelector('form > .composer-queue')).not.toBeNull();
  expect(host().querySelector('form')!.contains(editor())).toBe(true);
  expect(document.activeElement).not.toBe(editor());
  await render(
    <Composer
      {...props}
      draft={items[0]!.text}
      queueFocusKey={1}
      queue={{ ...queue, items: items.slice(1) }}
    />,
  );
  expect(document.activeElement).toBe(editor());
  expect(editor().textContent).toContain('完整强调');
  editor().blur();
  await render(<Composer {...props} scopeKey="b" queueFocusKey={2} />);
  expect(document.activeElement).not.toBe(editor());
  expect(host().textContent).not.toContain('取消编辑');
  await render(
    <Composer {...props} scopeKey="b" draft="取出后等待解锁" queueFocusKey={3} disabled />,
  );
  expect(document.activeElement).not.toBe(editor());
  await render(<Composer {...props} scopeKey="b" draft="取出后等待解锁" queueFocusKey={3} />);
  expect(document.activeElement === editor()).toBe(true);
});

test('full Markdown is available on focus and Escape closes the tooltip; collapsing retains host items', async () => {
  await render(
    <QueuedMessages items={items} onEdit={() => {}} onDelete={() => {}} onReorder={() => {}} />,
  );
  const preview = host().querySelector<HTMLElement>('.composer-queue-preview')!;
  await act(async () => preview.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('完整强调');
  expect(document.querySelector('.composer-queue-tooltip strong')?.textContent).toBe('完整强调');
  expect(document.querySelector('.composer-queue-tooltip code')?.textContent).toBe('code');
  expect(document.querySelector('.composer-queue-tooltip img')).toBeNull();
  await act(async () =>
    preview.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  const toggle = host().querySelector<HTMLButtonElement>('.composer-queue-heading')!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host().querySelectorAll('[data-queued-prompt]')).toHaveLength(0);
  await act(async () => toggle.click());
  expect(host().querySelectorAll('[data-queued-prompt]')).toHaveLength(3);
});
