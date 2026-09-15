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
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(dom.window, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
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
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: TestResizeObserver,
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
test('full-height sibling panels move the sidebar toggle into the middle header when closed', async () => {
  const windowClicks: number[] = [];
  await render(
    <SessionPage
      workspaces={[]}
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
  expect(document.querySelectorAll('header')).toHaveLength(2);
  expect(document.querySelectorAll('[data-panel]')).toHaveLength(2);
  expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(document.querySelector('.session-header')?.textContent).toBe('Session t…');
  expect(document.querySelector('.breadcrumb strong')?.getAttribute('title')).toBe('Session title');
  expect(document.querySelector<HTMLElement>('.sidebar')).not.toBeNull();
  await click(document.querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')!);
  expect(document.querySelector<HTMLElement>('.sidebar')).toBeNull();
  expect(document.querySelectorAll('[data-panel]')).toHaveLength(1);
  await click(document.querySelector<HTMLButtonElement>('[aria-label="展开侧栏"]')!);
  expect(document.querySelector<HTMLElement>('.sidebar')).not.toBeNull();
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

test('settled user and Agent messages copy their original text', async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => Promise.reject(new Error('browser clipboard unavailable')) },
  });
  await render(
    <Conversation
      messages={[
        { id: 'u', role: 'user', text: '用户原文', settled: true },
        {
          id: 'a1',
          turnId: 'turn-1',
          role: 'assistant',
          text: '**Agent** 工具前说明',
          settled: true,
          finalReply: false,
        },
        {
          id: 'tool:t',
          turnId: 'turn-1',
          role: 'tool',
          text: '工具输出不复制',
          settled: true,
        },
        {
          id: 'a2',
          turnId: 'turn-1',
          role: 'assistant',
          text: 'Agent 最终回复',
          settled: true,
          finalReply: true,
        },
        {
          id: 'extra',
          turnId: 'turn-1',
          role: 'assistant',
          text: '同一 turn 的非最终文本',
          settled: true,
          finalReply: false,
        },
        { id: 'u2', role: 'user', text: '下一轮', settled: true },
        {
          id: 'stream',
          turnId: 'turn-2',
          role: 'assistant',
          text: '流式内容',
          settled: false,
        },
        {
          id: 'pending',
          role: 'user',
          text: '发送未定',
          settled: false,
          delivery: 'sending',
        },
      ]}
      loading={false}
      connected
      selected
      saveReading={() => {}}
      writeClipboardText={async (text) => {
        copied.push(text);
      }}
    />,
  );
  expect(document.querySelectorAll('.message-copy')).toHaveLength(3);
  expect(document.querySelectorAll('.message.assistant .message-copy')).toHaveLength(1);
  expect(document.querySelector('.message.assistant.responding .message-copy')).toBeNull();
  expect(document.querySelector('.message.user.sending .message-copy')).toBeNull();

  await click(document.querySelector<HTMLButtonElement>('[aria-label="复制本轮用户消息"]')!);
  await click(document.querySelector<HTMLButtonElement>('[aria-label="复制本轮Agent回复"]')!);
  expect(copied).toEqual(['用户原文', 'Agent 最终回复']);
  expect(document.querySelectorAll('[aria-label="已复制消息"]')).toHaveLength(2);
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

test('scrolling history stops live follow; returning restores reading and activity expansion', async () => {
  let saved: ReadingState | undefined;
  const messages: Message[] = [
    {
      id: 'tool:t',
      role: 'tool',
      text: 'output',
      title: 'shell',
      arguments: { command: 'pwd' },
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
  const viewport = document.querySelector<HTMLElement>('.conversation-viewport')!;
  expect(viewport.hasAttribute('data-radix-scroll-area-viewport')).toBe(true);
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 500 },
  });
  await act(async () => {
    viewport.scrollTop = 200;
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
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
    expanded: { 'activity:tool:t': true },
  });
  await act(() =>
    root!.render(<Conversation {...props} initialReading={saved} messages={updated} />),
  );
  expect(document.querySelector<HTMLElement>('.conversation-viewport')!.scrollTop).toBe(200);
  expect(document.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
    'true',
  );
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

test('loaded workspace without sessions shows the aligned empty chat label', async () => {
  await render(
    <Sidebar
      workspaces={[
        {
          id: 'w',
          label: 'Workspace',
          state: 'loaded',
          sessionCount: 0,
          sessions: [],
        },
      ]}
      actions={{}}
      connectionLabel=""
    />,
  );

  const empty = document.querySelector<HTMLElement>('.empty-list');
  expect(empty?.textContent).toBe('暂无聊天');
  expect(empty?.className).toBe('empty-list');
  expect(document.body.textContent).not.toContain('还没有会话');
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

test('tool activity keeps failures visible and groups adjacent tools without raw details', async () => {
  const read: Message = {
    id: 'tool:r',
    role: 'tool',
    toolName: 'read_file',
    presentation: 'exploration',
    presentationGroupId: 'group-1',
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
  expect(document.querySelector('.tool-activity-summary')).toBeNull();
  expect(document.querySelector('.tool-activity-step')?.textContent).toContain('读取');
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
            presentation: 'standalone',
            presentationGroupId: 'group-1',
            title: '独立命令',
            text: '输出',
            settled: true,
            status: 'completed',
          },
        ]}
      />,
    ),
  );
  expect(document.querySelectorAll('.tool-activity')).toHaveLength(2);
  expect(document.querySelector('.tool-step-status')?.textContent).toBe('失败');
  expect(document.querySelector('.tool-step-preview')).toBeNull();
  expect(document.querySelector('.tool-activity-step')?.textContent).toContain('a.ts');
  expect(document.querySelector('.shell-activity .tool-activity-summary')?.textContent).toContain(
    '运行',
  );
  expect(document.body.textContent).not.toContain('查看参数与输出');
  expect(document.querySelector('.tool-arguments')).toBeNull();
  expect(document.querySelector('.file-link')).toBeNull();
});

test('tool activity stays on its side of replies and preserves explicit folding during live updates', async () => {
  const read = (id: string): Message => ({
    id: `tool:${id}`,
    role: 'tool',
    toolName: 'read_file',
    presentation: 'exploration',
    presentationGroupId: id === 'a' || id === 'b' ? 'group-1' : 'group-2',
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
  expect(document.querySelectorAll('.tool-activity')).toHaveLength(2);
  const first = document.querySelector<HTMLButtonElement>('.tool-activity-summary')!;
  expect(first.textContent).toContain('读取 2 次');
  await click(first);
  await act(() => root!.render(<Conversation {...props} messages={[...messages, read('d')]} />));
  expect(first.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelectorAll('.tool-activity-summary')[1]?.textContent).toContain(
    '读取 2 次',
  );
});

test('a failed shell keeps its state visible and reveals its output on demand', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:failed',
          role: 'tool',
          toolName: 'shell_execute',
          title: '运行测试',
          text: 'many successful lines\nthe complete log',
          settled: true,
          status: 'failed',
          toolResult: {
            ok: false,
            stderr: 'Expected empty session, received cached profile',
            exitCode: 1,
          },
        },
      ]}
    />,
  );
  expect(document.querySelector('.tool-activity-summary')?.textContent).toContain('失败');
  expect(document.querySelector('.shell-output')).toBeNull();
  await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
  expect(document.querySelector('.shell-output pre')?.textContent).toContain(
    'Expected empty session, received cached profile',
  );
  expect(document.querySelector('.shell-result')?.textContent).toContain('退出码 1');
  expect(document.body.textContent).not.toContain('查看参数与输出');
});

test('tool activity preserves waiting, rejected and cancelled terminal states', async () => {
  const tool = (id: string, status: Message['status'], settled: boolean): Message => ({
    id: `tool:${id}`,
    role: 'tool',
    title: id,
    text: `${id} output`,
    settled,
    status,
    presentation: 'exploration',
    presentationGroupId: 'group',
  });
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        tool('waiting', 'waiting', false),
        tool('running', 'running', false),
        tool('rejected', 'rejected', true),
        tool('cancelled', 'cancelled', true),
        tool('unknown', 'unknown', true),
      ]}
    />,
  );
  const activity = document.querySelector('.tool-activity')!;
  expect(activity.querySelector('.tool-activity-summary')?.textContent).toContain('2 项异常');
  expect(activity.querySelector('.tool-activity-summary')?.textContent).not.toContain('进行中');
  expect(activity.textContent).toContain('等待交互');
  expect(activity.textContent).toContain('已拒绝');
  expect(activity.textContent).toContain('已停止');
  expect(activity.textContent).toContain('结果未知');
  expect(activity.querySelectorAll('.tool-activity-step')).toHaveLength(5);
  expect(document.querySelector('[aria-label="会话消息"]')?.getAttribute('aria-busy')).toBe('true');
});

test('tool activity does not combine adjacent tools owned by different turns', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:a',
          turnId: 'a',
          role: 'tool',
          text: 'a',
          settled: true,
          presentation: 'exploration',
          presentationGroupId: 'group',
        },
        {
          id: 'tool:b',
          turnId: 'b',
          role: 'tool',
          text: 'b',
          settled: true,
          presentation: 'exploration',
          presentationGroupId: 'group',
        },
      ]}
    />,
  );
  expect(document.querySelectorAll('.tool-activity')).toHaveLength(2);
});

test('a child of a hidden parent has a tool entry without its result prose', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:parent',
          role: 'tool',
          title: '内部委派',
          text: 'hidden',
          settled: true,
          presentation: 'hidden',
        },
        {
          id: 'subagent:child',
          role: 'subagent',
          parentToolCallId: 'parent',
          title: '审查',
          text: '发现一项问题',
          settled: true,
          status: 'completed',
        },
      ]}
    />,
  );
  expect(document.querySelector('.tool-activity')?.textContent).toContain('审查');
  expect(document.body.textContent).not.toContain('发现一项问题');
  expect(document.body.textContent).not.toContain('内部委派');
});

test('owned hidden terminal issues remain accessible when their parent is unavailable', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:hidden-rejected',
          role: 'tool',
          title: '受限操作',
          text: '权限不足',
          settled: true,
          presentation: 'hidden',
          presentationOwner: {
            subagentId: 'hidden-child',
            parentToolCallId: 'hidden-rejected',
          },
          status: 'rejected',
        },
        {
          id: 'subagent:hidden-child',
          role: 'subagent',
          parentToolCallId: 'hidden-rejected',
          title: '权限复核',
          text: '确认未执行',
          settled: true,
          status: 'completed',
        },
      ]}
    />,
  );
  expect(document.body.textContent).toContain('权限不足');
  expect(document.body.textContent).not.toContain('确认未执行');
});

test('legacy hidden terminal issues without an owner remain visible', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:legacy-hidden-failure',
          role: 'tool',
          title: '读取文件',
          text: '文件不存在',
          settled: true,
          presentation: 'hidden',
          status: 'failed',
        },
      ]}
    />,
  );
  expect(document.querySelector('.tool-activity')?.textContent).toContain('文件不存在');
});

test('parent disclosure shows only child tool steps and preserves explicit folding', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:parent',
          role: 'tool',
          title: '委派',
          text: '',
          settled: true,
          presentation: 'standalone',
          status: 'completed',
        },
        {
          id: 'subagent:child',
          role: 'subagent',
          parentToolCallId: 'parent',
          title: '审查',
          text: '复核完成',
          settled: true,
          status: 'completed',
          steps: [{ id: 'internal', text: '内部读取', status: 'completed' }],
        },
      ]}
    />,
  );
  expect(document.querySelector('.tool-activity-summary')?.getAttribute('aria-expanded')).toBe(
    'false',
  );
  expect(document.body.textContent).not.toContain('复核完成');
  expect(document.body.textContent).not.toContain('内部读取');
  await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
  expect(document.querySelector('.subagent-process')?.textContent).toContain('内部读取');
  expect(document.body.textContent).not.toContain('复核完成');
  await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
  expect(document.querySelector('.subagent-process')).toBeNull();
  await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
  expect(document.querySelector('.subagent-process')?.textContent).toContain('内部读取');
});

test('subagent processes stay collapsed through progress and failure until explicitly expanded', async () => {
  const child: Message = {
    id: 'subagent:live',
    role: 'subagent',
    title: '探查',
    text: '',
    settled: false,
    status: 'running',
    steps: [{ id: 'read', text: '读取配置', status: 'started' }],
  };
  const props = { loading: false, selected: true, connected: true, saveReading: () => {} };
  await render(<Conversation {...props} messages={[child]} />);
  const process = () => document.querySelector<HTMLButtonElement>('.tool-activity-summary')!;
  expect(process().getAttribute('aria-expanded')).toBe('false');
  const failed: Message = {
    ...child,
    steps: [{ id: 'read', text: '文件不存在', status: 'failed' }],
  };
  await act(() => root!.render(<Conversation {...props} messages={[failed]} />));
  expect(process().getAttribute('aria-expanded')).toBe('false');
  await click(process());
  expect(process().getAttribute('aria-expanded')).toBe('true');
  await act(() =>
    root!.render(
      <Conversation
        {...props}
        messages={[{ ...failed, settled: true, status: 'completed', text: '已核对' }]}
      />,
    ),
  );
  expect(process().getAttribute('aria-expanded')).toBe('true');
  await click(process());
  expect(process().getAttribute('aria-expanded')).toBe('false');
});

test('running and failed subagents do not claim that a result was sent to the main agent', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'subagent:running',
          role: 'subagent',
          title: '运行检查',
          text: '',
          settled: false,
          status: 'running',
        },
        {
          id: 'subagent:failed',
          role: 'subagent',
          title: '失败检查',
          text: '模型调用失败',
          settled: true,
          status: 'failed',
        },
      ]}
    />,
  );
  const subagents = [...document.querySelectorAll('.tool-activity')];
  expect(subagents).toHaveLength(2);
  expect(subagents[0]?.textContent).toContain('正在工作');
  expect(subagents[1]?.textContent).toContain('失败');
  expect(subagents.every((item) => !item.textContent?.includes('已发送给主 Agent'))).toBe(true);
});

test('reasoning and plan progress remain readable without raw tool metadata', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        { id: 'thinking:r:s', role: 'thinking', text: '正在核对状态', settled: false },
        {
          id: 'plan:p',
          role: 'system',
          title: '计划进度',
          text: '执行第 2 步',
          settled: false,
          status: 'running',
        },
        {
          id: 'tool:limited',
          role: 'tool',
          title: '读取大文件',
          text: '片段',
          settled: true,
          status: 'completed',
          toolResult: {
            ok: true,
            stdout: '片段',
            exitCode: 0,
            status: 'exhausted',
            totalLines: 420,
          },
        },
      ]}
    />,
  );
  expect(document.body.textContent).toContain('思考过程');
  expect(document.body.textContent).toContain('计划进度');
  expect(document.body.textContent).toContain('正在工作');
  expect(document.querySelector('[aria-label="会话消息"]')?.getAttribute('aria-busy')).toBe('true');
  expect(document.body.textContent).not.toContain('共 420 行');
  expect(document.body.textContent).not.toContain('输出已达到工具限制');
});

test('the closed tool display vocabulary renders through one safe activity path', async () => {
  const names = [
    'ask_user',
    'edit_file',
    'glob',
    'list_mcp_resources',
    'list_mcp_tools',
    'mcp_tool',
    'read_file',
    'read_mcp_resource',
    'request_plan_review',
    'search_content',
    'search_files',
    'shell_execute',
    'skill',
    'task',
    'tool_search',
    'update_plan',
    'web_fetch',
    'write_file',
    'write_plan',
    'other',
  ];
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={names.map((toolName, index) => ({
        id: `tool:vocabulary-${index}`,
        role: 'tool' as const,
        toolName,
        title: toolName === 'other' ? '<untrusted label>' : toolName,
        text: index === 0 ? '' : `result ${index}`,
        settled: true,
        status: index === 0 ? ('unknown' as const) : ('completed' as const),
        presentation: 'standalone' as const,
      }))}
    />,
  );
  expect(document.querySelectorAll('.tool-activity')).toHaveLength(names.length);
  expect(document.querySelector('.tool-activity-summary')?.textContent).toContain('结果未知');
  expect(document.body.textContent).toContain('<untrusted label>');
  expect(document.body.innerHTML).not.toContain('<untrusted label></untrusted>');
});

test('tool activities translate internal tool names and remove redundant completed labels', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:shell',
          role: 'tool',
          toolName: 'shell_execute',
          title: 'shell_execute',
          text: 'total 328',
          arguments: { description: 'List workspace root' },
          settled: true,
          status: 'completed',
          presentation: 'standalone',
        },
      ]}
    />,
  );
  expect(document.querySelector('.tool-activity-title')?.textContent).toBe('运行');
  await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
  expect(document.querySelector('.shell-output')).not.toBeNull();
  expect(document.querySelector('.tool-activity-state')).toBeNull();
  expect(document.querySelector('.tool-step-status')).toBeNull();
  expect(document.querySelectorAll('.tool-activity-kind-icon')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('shell_execute');
});

test('workspace sessions reveal five then ten at a time and reset independently on collapse', async () => {
  const sessions = Array.from({ length: 28 }, (_, index) => ({
    sessionId: `session-${index}`,
    displayName: `会话 ${index + 1}`,
    status: 'idle',
  }));
  await render(
    <Sidebar
      workspaces={[
        { id: 'a', label: '空间 A', sessions, sessionCount: 28, state: 'loaded' },
        { id: 'b', label: '空间 B', sessions, sessionCount: 28, state: 'loaded' },
        {
          id: 'c',
          label: '空间 C',
          sessions: sessions.slice(0, 5),
          sessionCount: 5,
          state: 'loaded',
        },
      ]}
      actions={{}}
      connectionLabel=""
      onOpen={() => {}}
    />,
  );
  const groups = Array.from(document.querySelectorAll<HTMLElement>('.workspace-group'));
  expect(groups[0]!.querySelector('[data-icon="folder-open"]')).not.toBeNull();
  expect(
    document.querySelector('.workspace-directory [data-radix-scroll-area-viewport]'),
  ).not.toBeNull();
  const rows = (index: number) =>
    groups[index]!.querySelectorAll('.session-row:not(.session-load-more)');
  const more = () => groups[0]!.querySelector<HTMLButtonElement>('.session-load-more')!;
  expect(rows(0)).toHaveLength(5);
  expect(rows(1)).toHaveLength(5);
  expect(groups[2]!.querySelector('.session-load-more')).toBeNull();
  await click(more());
  expect(rows(0)).toHaveLength(15);
  expect(rows(1)).toHaveLength(5);
  await click(more());
  expect(rows(0)).toHaveLength(25);
  await click(more());
  expect(rows(0)).toHaveLength(28);
  expect(more()).toBeNull();
  await click(button('空间 A'));
  expect(groups[0]!.querySelector('[data-icon="folder-closed"]')).not.toBeNull();
  expect(groups[0]!.querySelector('.sidebar-sessions')?.hasAttribute('hidden')).toBe(true);
  await click(button('空间 A'));
  expect(groups[0]!.querySelector('[data-icon="folder-open"]')).not.toBeNull();
  expect(rows(0)).toHaveLength(5);
  expect(more().textContent?.trim()).toBe('展开更多');
  await click(more());
  expect(rows(0)).toHaveLength(15);
});

test('workspace sorts by latest timestamp before paging and responds to updated directory data', async () => {
  const sessions = [
    { sessionId: 'missing', displayName: '缺少时间', status: 'idle' },
    ...Array.from({ length: 7 }, (_, index) => ({
      sessionId: `s${index}`,
      displayName: `会话 ${index}`,
      status: 'idle',
      updatedAt: `2026-09-12T0${index}:00:00Z`,
    })),
    {
      sessionId: 'tie',
      displayName: '相同时间',
      status: 'idle',
      updatedAt: '2026-09-12T14:00:00+08:00',
    },
    { sessionId: 'invalid', displayName: '无效时间', status: 'idle', updatedAt: 'invalid' },
  ];
  const original = sessions.map((session) => session.sessionId);
  const page = () => (
    <Sidebar
      workspaces={[
        { id: 'a', label: '空间', sessions, sessionCount: sessions.length, state: 'loaded' },
      ]}
      actions={{}}
      connectionLabel=""
      onOpen={() => {}}
    />
  );
  const titles = () =>
    Array.from(document.querySelectorAll('.session-row strong')).map((row) => row.textContent);
  await render(page());
  expect(titles()).toEqual(['会话 6', '相同时间', '会话 5', '会话 4', '会话 3']);
  await click(button('展开更多'));
  expect(titles()).toEqual([
    '会话 6',
    '相同时间',
    '会话 5',
    '会话 4',
    '会话 3',
    '会话 2',
    '会话 1',
    '会话 0',
    '缺少时间',
    '无效时间',
  ]);
  expect(sessions.map((session) => session.sessionId)).toEqual(original);
  sessions[1] = { ...sessions[1]!, updatedAt: '2026-09-13T00:00:00Z' };
  await act(() => root!.render(page()));
  expect(titles()[0]).toBe('会话 0');
  await click(button('空间'));
  await click(button('空间'));
  expect(titles()).toEqual(['会话 0', '会话 6', '相同时间', '会话 5', '会话 4']);
});

test('file reads open only through filenames while edits reveal the confirmed tool diff', async () => {
  const opened: string[] = [];
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      openFile={(path) => opened.push(path)}
      messages={[
        {
          id: 'tool:read',
          role: 'tool',
          toolName: 'read_file',
          arguments: { path: 'src/a.ts' },
          status: 'completed',
          settled: true,
          text: 'private file contents',
        },
        {
          id: 'tool:edit',
          role: 'tool',
          toolName: 'edit_file',
          changedFile: 'src/a.ts',
          changeConfirmed: true,
          status: 'completed',
          settled: true,
          text: 'changed',
          toolResult: { ok: true, stdout: '1 -old\n1 +new' },
        },
      ]}
    />,
  );
  await click(document.querySelector<HTMLElement>('.tool-step-title')!);
  expect(opened).toEqual([]);
  await click(document.querySelector<HTMLButtonElement>('.file-link')!);
  expect(opened).toEqual(['src/a.ts']);
  expect(document.body.textContent).not.toContain('private file contents');
  expect(document.querySelector('.diff-output')).toBeNull();
  await click(document.querySelector<HTMLButtonElement>('.tool-diff-toggle')!);
  expect(document.querySelector('.diff-added')?.textContent).toContain('+new');
  expect(document.querySelector('.diff-removed')?.textContent).toContain('-old');
});

test('shell output preserves reader scroll across progress and follows only on request', async () => {
  const props = { loading: false, selected: true, connected: true, saveReading: () => {} };
  const message: Message = {
    id: 'tool:stream',
    role: 'tool',
    toolName: 'shell_execute',
    arguments: { command: 'pnpm test' },
    text: '',
    settled: false,
    status: 'running',
    toolProgress: { stdout: 'first' },
  };
  await render(<Conversation {...props} messages={[message]} />);
  expect(document.querySelector('.tool-command')?.textContent).toBe('pnpm test');
  await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
  const output = document.querySelector<HTMLElement>('.shell-output pre')!;
  Object.defineProperties(output, {
    scrollHeight: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 256 },
  });
  output.scrollTop = 80;
  await act(() => output.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })));
  await act(() =>
    root!.render(
      <Conversation
        {...props}
        messages={[{ ...message, toolProgress: { stdout: 'first\nsecond' } }]}
      />,
    ),
  );
  expect(output.scrollTop).toBe(80);
  expect(output.textContent).toContain('second');
  await click(document.querySelector<HTMLButtonElement>('.shell-latest')!);
  expect(output.scrollTop).toBe(900);
  await act(() =>
    root!.render(
      <Conversation
        {...props}
        messages={[
          {
            ...message,
            settled: true,
            status: 'cancelled',
            text: '用户停止',
            toolProgress: { stdout: 'first\nsecond' },
            approval: { source: 'user', state: 'approved', grant: 'same_command' },
          },
        ]}
      />,
    ),
  );
  expect(document.querySelector('.tool-approval')?.textContent).toContain('本会话相同命令');
  expect(output.textContent).toContain('first\nsecond');
  expect(document.querySelector('.shell-result')?.textContent).toContain('已停止');
});

test('compaction uses an inline marker and Ask history discloses the recorded answer', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'compact',
          role: 'system',
          systemKind: 'compaction',
          title: '上下文自动压缩失败',
          text: '请求超时',
          status: 'failed',
          settled: true,
        },
        {
          id: 'ask',
          role: 'system',
          systemKind: 'ask',
          title: '回答已提交',
          text: '展示间距？\n\n舒适间距',
          settled: true,
        },
      ]}
    />,
  );
  expect(document.querySelector('.context-compacted [role="status"]')?.textContent).toBe(
    '上下文自动压缩失败',
  );
  expect(document.querySelector('.context-compacted')?.textContent).toContain('请求超时');
  expect(document.querySelector('.tool-detail')).toBeNull();
  await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
  expect(document.querySelector('.tool-detail')?.textContent).toContain('舒适间距');
});

test('file tools retain their approval state and the service refusal reason', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={['read_file', 'edit_file'].map((toolName, index) => ({
        id: `tool:approval-${index}`,
        role: 'tool' as const,
        toolName,
        arguments: { path: 'src/style.css' },
        text: '',
        settled: true,
        status: 'rejected' as const,
        approval: {
          state: 'rejected' as const,
          source: 'auto' as const,
          reason: '文件超出授权范围，请选择项目内文件。',
        },
      }))}
    />,
  );
  expect(document.querySelectorAll('.tool-approval')).toHaveLength(2);
  expect(
    Array.from(document.querySelectorAll('.tool-step-preview')).map((item) => item.textContent),
  ).toEqual(['文件超出授权范围，请选择项目内文件。', '文件超出授权范围，请选择项目内文件。']);
  expect(document.querySelector('.tool-diff-toggle')).toBeNull();
});

test('an exploration shell opens its output and keeps its disclosure when the group is folded', async () => {
  const messages: Message[] = [
    {
      id: 'tool:ls',
      role: 'tool',
      toolName: 'shell_execute',
      arguments: { command: 'ls -la' },
      presentation: 'exploration',
      presentationGroupId: 'inspect',
      settled: true,
      status: 'completed',
      text: '',
      toolResult: { ok: true, stdout: 'total 8\npackage.json', stderr: '', exitCode: 0 },
    },
    {
      id: 'tool:find',
      role: 'tool',
      toolName: 'search_files',
      arguments: { pattern: '*.json' },
      presentation: 'exploration',
      presentationGroupId: 'inspect',
      settled: true,
      status: 'completed',
      text: '',
    },
  ];
  await render(
    <Conversation loading={false} selected connected saveReading={() => {}} messages={messages} />,
  );
  const group = document.querySelector<HTMLButtonElement>('.tool-activity-summary')!;
  await click(group);
  const command = document.querySelector<HTMLButtonElement>(
    '.shell-activity .tool-activity-summary',
  )!;
  expect(command.tagName).toBe('BUTTON');
  await click(command);
  expect(document.querySelector('.shell-output pre')?.textContent).toContain('package.json');
  expect(document.querySelector('.shell-result')?.textContent).toContain('退出码 0');
  await click(group);
  expect(document.querySelector('.shell-output')).toBeNull();
  await click(group);
  expect(document.querySelector('.shell-output pre')?.textContent).toContain('package.json');
});

test('a failed file read keeps its failure status without a redundant error paragraph', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:missing',
          role: 'tool',
          toolName: 'read_file',
          arguments: { path: 'missing.txt' },
          settled: true,
          status: 'failed',
          text: 'File not found.',
        },
      ]}
    />,
  );
  expect(document.querySelector('.tool-step-status')?.textContent).toBe('失败');
  expect(document.querySelector('.tool-step-preview')).toBeNull();
  expect(document.body.textContent).not.toContain('File not found.');
});

test('Ask renders one paired history record instead of the owned raw tool result', async () => {
  await render(
    <Conversation
      loading={false}
      selected
      connected
      saveReading={() => {}}
      messages={[
        {
          id: 'tool:ask-1',
          role: 'tool',
          toolName: 'ask_user',
          settled: true,
          status: 'completed',
          text: 'Completed.\n{"answer":"stop","answers":{"q1":"stop"}}',
        },
        {
          id: 'interaction:ask-1',
          role: 'system',
          systemKind: 'ask',
          title: '回答已提交',
          status: 'completed',
          settled: true,
          text: 'Next?\nstop',
          ask: {
            toolCallId: 'ask-1',
            questions: [
              { id: 'q1', question: '接下来要我做什么？' },
              { id: 'q2', question: '范围？' },
            ],
            answers: { q1: '先不动，到此为止', q2: '当前会话' },
          },
        },
        {
          id: 'tool:ask-unrelated',
          role: 'tool',
          toolName: 'ask_user',
          settled: true,
          status: 'failed',
          text: '问题格式无效',
        },
      ]}
    />,
  );
  expect(document.body.textContent).not.toContain('Completed.');
  expect(document.body.textContent).not.toContain('"answers"');
  expect(document.body.textContent).toContain('问题格式无效');
  expect(document.body.textContent).toContain('询问用户 · 已回答 2 项');
  const button = document.querySelector<HTMLButtonElement>('.tool-activity-summary')!;
  await click(button);
  expect(
    Array.from(document.querySelectorAll('.tool-ask-answers > div')).map(
      (item) => item.textContent,
    ),
  ).toEqual(['1. 接下来要我做什么？：先不动，到此为止', '2. 范围？：当前会话']);
  expect(document.querySelector('.tool-ask-answers pre')).toBeNull();
});

test('single Ask keeps its question in the heading and cancelled Ask hides answer content', async () => {
  const message: Message = {
    id: 'interaction:single',
    role: 'system',
    systemKind: 'ask',
    status: 'completed',
    settled: true,
    text: '',
    ask: {
      questions: [{ id: 'q1', question: '接下来做什么？' }],
      answers: { q1: '自定义回答\n'.repeat(8) },
    },
  };
  await render(
    <Conversation messages={[message]} selected connected loading={false} saveReading={() => {}} />,
  );
  expect(document.body.textContent).toContain('接下来做什么？');
  await click(document.querySelector<HTMLButtonElement>('.tool-activity-summary')!);
  expect(document.querySelector('.tool-ask-prefix')?.textContent).toBe('回答：');
  expect(document.querySelector('.tool-ask-text')?.textContent).toBe('自定义回答\n'.repeat(8));
  await act(() =>
    root!.render(
      <Conversation
        messages={[{ ...message, status: 'cancelled' }]}
        selected
        connected
        loading={false}
        saveReading={() => {}}
      />,
    ),
  );
  expect(document.querySelector('.tool-ask-answers')?.textContent).toBe('已取消');
  expect(document.querySelector('.tool-ask-prefix')).toBeNull();
});
