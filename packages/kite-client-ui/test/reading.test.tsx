import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { Conversation, type ReadingState } from '../src/Conversation';
import { MessageContent } from '../src/MessageContent';
import { SessionPage } from '../src/SessionPage';
import { Sidebar } from '../src/Sidebar';
import type { Message } from '../src/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
});
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node,
  Element: dom.window.Element,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
    writable: true,
  });
}
// React DOM must observe a DOM when it initializes its input event support.
const { createRoot } = await import('react-dom/client');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root!.render(element));
}
function button(text: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}
test('one application header moves the sidebar toggle between its visual regions', async () => {
  const windowClicks: number[] = [];
  await render(
    <SessionPage
      workspaces={[]}
      workspaceLabel="Workspace"
      sessionLabel="Session title"
      readingKey="workspace/session"
      messages={[]}
      loading={false}
      connected
      connectionLabel=""
      actions={{}}
      onHeaderMouseDown={(clickCount) => windowClicks.push(clickCount)}
    />,
  );
  expect(document.querySelectorAll('header')).toHaveLength(1);
  expect(document.querySelector('.session-header')?.textContent).toContain('Session title');
  const sidebar = document.querySelector<HTMLElement>('.sidebar')!;
  expect(sidebar.hidden).toBe(false);
  await click(document.querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')!);
  expect(sidebar.hidden).toBe(true);
  await click(document.querySelector<HTMLButtonElement>('[aria-label="展开侧栏"]')!);
  expect(sidebar.hidden).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')).not.toBeNull();
  const header = document.querySelector<HTMLElement>('.session-header')!;
  header.dispatchEvent(
    new dom.window.MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true }),
  );
  header.dispatchEvent(
    new dom.window.MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true }),
  );
  document
    .querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')!
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true }));
  expect(windowClicks).toEqual([1, 2]);
});
test('select all stays in visible message text and leaves editable fields to the browser', async () => {
  await render(
    <>
      <header>页面标题不可选</header>
      <Conversation
        messages={[
          { id: 'u', role: 'user', text: '你好', settled: true },
          {
            id: 'a',
            role: 'assistant',
            text: '回答正文\n\n- 第一项\n- 最后一项',
            settled: true,
          },
          {
            id: 'tool:t',
            role: 'tool',
            title: '折叠工具标题',
            text: '隐藏的输出',
            settled: true,
          },
        ]}
        loading={false}
        connected
        selected
        saveReading={() => {}}
      />
      <textarea defaultValue="独立草稿" />
    </>,
  );
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'a',
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => document.body.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const selection = document.getSelection()!;
    expect(selection.anchorNode?.textContent).toBe('你好');
    expect(selection.focusNode?.textContent).toBe('最后一项');
    expect(selection.toString()).not.toMatch(/页面标题|独立草稿|折叠工具|隐藏的输出/);
  }
  const input = document.querySelector('textarea')!;
  input.focus();
  const event = new dom.window.KeyboardEvent('keydown', {
    key: 'a',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(() => input.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  await act(() => root!.unmount());
  root = undefined;
  const after = new dom.window.KeyboardEvent('keydown', {
    key: 'a',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

test('Markdown renders code and tables without executing HTML, loading images or enabling unsafe links', async () => {
  const paths: string[] = [];
  await render(
    <MessageContent
      text={
        '# 标题\n\n- 第一项\n- 第二项\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```\nconst x = 1;\n```\n\n[源码](src/app.ts) [bad](javascript:alert(1))\n\n<img src="x" onerror="alert(1)" />\n\n![远程图片](https://example.com/x.png)'
      }
      openFile={(path) => paths.push(path)}
    />,
  );
  expect(document.querySelector('h1')?.textContent).toBe('标题');
  expect(document.querySelector('.typeset.typeset-chat')).not.toBeNull();
  expect(document.querySelector('.typeset-chat')?.classList).not.toContain('max-w-[42em]');
  expect(document.querySelector('.markdown')).toBeNull();
  for (const selector of ['h1', 'ul', 'li', 'table', 'pre', 'pre code']) {
    expect(document.querySelector(selector)?.getAttribute('class')).toBeNull();
  }
  expect(document.querySelectorAll('ul li')).toHaveLength(2);
  expect(document.querySelectorAll('table td')).toHaveLength(2);
  expect(document.querySelector('pre code')?.textContent).toContain('const x = 1');
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('[href^="javascript:"]')).toBeNull();
  await click(button('源码'));
  expect(paths).toEqual(['src/app.ts']);
});

test('scrolling history stops live follow; returning to a conversation restores reading and tool expansion', async () => {
  let saved: ReadingState | undefined;
  const messages: Message[] = [
    {
      id: 'tool:t',
      role: 'tool',
      text: 'output',
      title: 'shell',
      settled: true,
    },
  ];
  const props = {
    loading: false,
    selected: true,
    connected: true,
    saveReading: (value: ReadingState) => {
      saved = value;
    },
    openFile: () => {},
    onProject: () => {},
  };
  await render(<Conversation {...props} messages={messages} />);
  const viewport = document.querySelector<HTMLElement>('.conversation')!;
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 500 },
  });
  await act(async () => {
    viewport.scrollTop = 200;
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    const details = document.querySelector('details')!;
    details.open = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const updated: Message[] = [
    ...messages,
    { id: 'model:r', role: 'assistant', text: '更新内容', settled: false },
  ];
  await act(() => root!.render(<Conversation {...props} messages={updated} />));
  expect(viewport.scrollTop).toBe(200);
  expect(button('回到最新消息')).toBeDefined();
  await act(() => root!.render(<div />));
  expect(saved).toMatchObject({
    top: 200,
    follow: false,
    expanded: { 'tool:t': true },
  });
  await act(() =>
    root!.render(<Conversation {...props} initialReading={saved} messages={updated} />),
  );
  expect(document.querySelector<HTMLElement>('.conversation')!.scrollTop).toBe(200);
  expect(document.querySelector('details')?.open).toBe(true);
  await click(button('回到最新消息'));
  expect(document.querySelector('.jump-latest')).toBeNull();
});

test('shared directory opens on click and preserves full names under read-only access', async () => {
  const name = '修复一个非常长的会话名称并确保它不会把左侧工作区列表横向撑出可视区域';
  const opened: string[] = [];
  await render(
    <Sidebar
      workspaces={[
        {
          id: 'w',
          label: 'Workspace',
          state: 'loaded',
          sessionCount: 1,
          sessions: [{ sessionId: 's', displayName: name, status: 'idle' }],
        },
      ]}
      actions={{}}
      connectionLabel="只读"
      onOpen={(id) => opened.push(id)}
    />,
  );
  const row = document.querySelector<HTMLButtonElement>('.session-row')!;
  expect(row.textContent).toBe(name);
  expect(row.title).toBe('');
  await click(row);
  expect(opened).toEqual(['s']);
  expect(document.querySelector('input[type=search]')).toBeNull();
  expect(document.body.textContent).not.toContain('新建会话');
  expect(document.body.textContent).not.toContain('模型与 Provider 设置');
});

test('shared directory distinguishes running sessions from sessions awaiting input', async () => {
  await render(
    <Sidebar
      workspaces={[
        {
          id: 'w',
          label: 'Workspace',
          state: 'loaded',
          sessionCount: 4,
          sessions: [
            {
              sessionId: 'running',
              displayName: '正在运行',
              status: 'running',
            },
            {
              sessionId: 'waiting',
              displayName: '等待回答',
              status: 'waiting',
            },
            {
              sessionId: 'pending',
              displayName: '运行时请求输入',
              status: 'running',
              pendingInteractions: 1,
            },
            { sessionId: 'done', displayName: '已经完成', status: 'completed' },
          ],
        },
      ]}
      actions={{}}
      connectionLabel=""
      onOpen={() => {}}
    />,
  );
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.session-row'));
  expect(rows[0]?.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('会话运行中');
  expect(rows[0]?.textContent).toBe('正在运行');
  expect(rows[1]?.textContent).toBe('等待回答待用户输入');
  expect(rows[1]?.querySelector('[role="status"]')).toBeNull();
  expect(rows[2]?.textContent).toBe('运行时请求输入待用户输入');
  expect(rows[2]?.querySelector('[role="status"]')).toBeNull();
  expect(rows[3]?.textContent).toBe('已经完成');
  expect(rows[3]?.querySelector('[role="status"]')).toBeNull();
});

test('exploration collapses after completion, keeps failures visible in its summary and never absorbs shell', async () => {
  const read: Message = {
    id: 'tool:r',
    role: 'tool',
    toolName: 'read_file',
    arguments: { path: 'a.ts' },
    text: '',
    settled: false,
    status: 'running',
  };
  const props = {
    loading: false,
    selected: true,
    connected: true,
    saveReading: () => {},
  };
  await render(<Conversation {...props} messages={[read]} />);
  expect(document.querySelector('.exploration-summary')?.getAttribute('aria-expanded')).toBe(
    'true',
  );
  await act(() =>
    root!.render(
      <Conversation
        {...props}
        messages={[
          { ...read, settled: true, status: 'failed', text: '读取失败' },
          {
            id: 'tool:s',
            role: 'tool',
            toolName: 'shell_execute',
            title: '独立命令',
            text: '输出',
            settled: true,
            status: 'completed',
          },
        ]}
      />,
    ),
  );
  expect(document.querySelector('.exploration-summary')?.getAttribute('aria-expanded')).toBe(
    'false',
  );
  expect(document.querySelector('.exploration-summary')?.textContent).toContain('1 项未成功');
  expect(document.querySelectorAll('.exploration')).toHaveLength(1);
  expect(document.querySelector('.message.tool')?.textContent).toContain('独立命令');
  await click(document.querySelector<HTMLButtonElement>('.exploration-summary')!);
  expect(document.querySelector('.exploration-steps')?.textContent).toContain('读取失败');
  expect(document.querySelector('.exploration-steps')?.textContent).toContain('a.ts');
  expect(document.querySelector('.file-link')).toBeNull();
});

test('exploration stays on its side of replies and preserves explicit user folding during live updates', async () => {
  const read = (id: string): Message => ({
    id: `tool:${id}`,
    role: 'tool',
    toolName: 'read_file',
    arguments: { path: id },
    text: '内容',
    settled: false,
    status: 'running',
  });
  const props = {
    loading: false,
    selected: true,
    connected: true,
    saveReading: () => {},
  };
  const messages: Message[] = [
    read('a'),
    read('b'),
    { id: 'reply', role: 'assistant', text: '阶段回复', settled: true },
    read('c'),
  ];
  await render(<Conversation {...props} messages={messages} />);
  expect(document.querySelectorAll('.exploration')).toHaveLength(2);
  const first = document.querySelector<HTMLButtonElement>('.exploration-summary')!;
  expect(first.textContent).toContain('读取 2 次');
  await click(first);
  await act(() => root!.render(<Conversation {...props} messages={[...messages, read('d')]} />));
  expect(first.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelectorAll('.exploration-summary')[1]?.textContent).toContain('读取 2 次');
});
