import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BookOpen01Icon, BulbIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/desktop/Conversation';
import { MessageContent } from '../src/desktop/MessageContent';
import type { Message } from '../src/desktop/types';

function traceHeadings(root: ParentNode) {
  return [...root.querySelectorAll('.conversation-trace')].map(
    (trace) => trace.querySelector<HTMLElement>('[data-trace-line]')!,
  );
}

async function withConversationRoot(
  check: (host: HTMLElement, root: ReturnType<typeof createRoot>) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  const originals = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, globals);
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await check(host, root);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const user = (id: string): Message => ({ id, role: 'user', text: id, settled: true });
const thinking = (turnId: string): Message => ({
  id: `thinking:${turnId}`,
  turnId,
  role: 'thinking',
  text: 'PRIVATE REASONING',
  settled: false,
});
const terminal = (turnId: string, status: NonNullable<Message['turnTerminalStatus']>): Message => ({
  id: `terminal:${turnId}`,
  turnId,
  role: 'system',
  systemKind: 'turn_terminal',
  text: '',
  settled: true,
  turnTerminalStatus: status,
});
function render(messages: Message[], host = false, running = false) {
  const calls: string[] = [];
  const html = renderToStaticMarkup(
    <Conversation
      messages={messages}
      loading={false}
      selected
      connected
      saveReading={() => {}}
      turnActivity={running ? { turnId: 'run', status: 'running' } : undefined}
      renderMessage={
        host
          ? (message) => {
              calls.push(message.id);
              return message.text;
            }
          : undefined
      }
    />,
  );
  return { calls, html, document: new JSDOM(html).window.document };
}

test('reasoning-only terminal turns retain their facts and elapsed summary between the original user messages', () => {
  for (const status of ['completed', 'cancelled', 'aborted'] as const) {
    const { document, html } = render([
      user('first'),
      thinking('run'),
      terminal('run', status),
      user('second'),
    ]);
    const turn = document.querySelector('.agent-turn');
    expect(turn?.getAttribute('data-turn-status')).toBe(status);
    expect(turn?.textContent).toBe('用时未知');
    expect(turn?.querySelector('button')).toBeNull();
    expect(turn?.querySelector('.agent-turn-process-messages')).toBeNull();
    expect(document.querySelector('[aria-label="会话消息"]')?.getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(html.indexOf('first')).toBeLessThan(html.indexOf('agent-turn'));
    expect(html.indexOf('agent-turn')).toBeLessThan(html.indexOf('second'));
    expect(html).not.toContain('PRIVATE REASONING');
    expect(html).not.toContain('正在思考');
  }
});

test('active reasoning is an activity marker and never calls the host body renderer', () => {
  const { calls, html, document } = render([user('first'), thinking('run')], true, true);
  expect(html).toContain('正在思考');
  expect(calls).toEqual(['first']);
  expect(html).not.toContain('PRIVATE REASONING');
  expect(html).not.toContain('thinking 消息');
  expect(document.querySelector('.agent-turn button')).toBeNull();
  expect(document.querySelector('.agent-turn [role="status"]')?.textContent).toContain('正在思考');
  expect(document.querySelector('[aria-label="会话消息"]')?.getAttribute('aria-busy')).toBe('true');
  const inferred = render([user('first'), thinking('run')]);
  expect(inferred.document.querySelector('.agent-turn [role="status"]')?.textContent).toContain(
    '正在思考',
  );
  expect(inferred.document.querySelector('.agent-turn button')).toBeNull();
});

test('a created child keeps one standalone tool row in the original position among Trace steps', () => {
  const tool = (id: string, toolName: string): Message => ({
    id,
    turnId: 'run',
    role: 'tool',
    toolName,
    text: '',
    settled: true,
    status: 'completed',
  });
  const html = renderToStaticMarkup(
    <Conversation
      traceTurns
      messages={[
        {
          ...tool('shell', 'shell_execute'),
          shell: { operation: 'execute', jobStatus: 'succeeded' },
        },
        tool('child', 'spawn_agent'),
        tool('read', 'read_file'),
      ]}
      selected
      connected
      loading={false}
      turnActivity={{ turnId: 'run', status: 'running' }}
      saveReading={() => {}}
      renderToolActivity={([message]) => <span data-tool={message?.id}>{message?.toolName}</span>}
    />,
  );
  const document = new JSDOM(html).window.document;
  expect(document.querySelectorAll('[data-tool="child"]')).toHaveLength(1);
  expect(document.querySelector('[data-tool="child"]')?.closest('.conversation-trace')).toBeNull();
  expect(
    [...document.querySelectorAll('[data-tool]')].map((node) => node.getAttribute('data-tool')),
  ).toEqual(['shell', 'child', 'read']);
  expect(document.querySelectorAll('.conversation-trace-trigger')).toHaveLength(0);
});

test('a single file tool exposes its original target and approval on its first visible row', async () => {
  const file: Message = {
    id: 'live-file',
    presentationKey: 'original-file',
    turnId: 'run',
    role: 'tool',
    toolName: 'read_file',
    target: 'docs/notes.md',
    text: '',
    status: 'completed',
    settled: true,
    approval: { source: 'auto', state: 'approved' },
  };
  await withConversationRoot(async (host, root) => {
    const opened: string[] = [];
    await act(async () =>
      root.render(
        <Conversation
          traceTurns
          messages={[file, { ...thinking('run'), text: '', tracePending: 'reasoning' }]}
          loading={false}
          selected
          connected
          saveReading={() => {}}
          openFile={(path) => opened.push(path)}
          turnActivity={{ turnId: 'run', status: 'running' }}
        />,
      ),
    );
    const trace = host.querySelector('.conversation-trace')!;
    expect(trace.querySelectorAll(':scope > .conversation-trace-trigger')).toHaveLength(0);
    expect(trace.querySelectorAll('[data-trace-line]')).toHaveLength(1);
    const link = trace.querySelector<HTMLButtonElement>('button.file-link')!;
    expect(link.textContent).toBe(file.target!);
    expect(trace.querySelector('.tool-approval-approved')?.getAttribute('aria-label')).toBe(
      '已自动批准',
    );
    expect(trace.querySelector('button[aria-expanded]')).toBeNull();
    await act(async () => link.click());
    expect(opened).toEqual(['docs/notes.md']);
  });
});

test('a single Agent wait in the current trace opens directly to its result', () => {
  const wait: Message = {
    id: 'wait',
    turnId: 'run',
    role: 'tool',
    toolName: 'wait_agent_events',
    title: '等待 Agent 事件',
    text: '等待期间暂无新事件',
    agentWait: true,
    status: 'completed',
    settled: true,
  };
  const renderWait = (message: Message, open: boolean) =>
    new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[message]}
          selected
          connected
          loading={false}
          initialReading={{
            top: 0,
            follow: true,
            expanded: { 'turn:run:complete': true, 'activity:wait': open },
          }}
          turnActivity={{ turnId: 'run', status: 'running' }}
          saveReading={() => {}}
        />,
      ),
    ).window.document;

  for (const open of [false, true]) {
    const document = renderWait(wait, open);
    const headings = document.querySelectorAll('.conversation-trace [data-trace-line]');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(wait.title!);
    expect(headings[0]?.getAttribute('aria-expanded')).toBe(String(open));
    expect(document.querySelector('.conversation-trace-steps')).toBeNull();
    expect(document.querySelector('.tool-detail')?.textContent).toBe(open ? wait.text : undefined);
  }

  const pending = renderWait({ ...wait, text: '', status: 'running', settled: false }, false);
  expect(pending.querySelector('.conversation-trace [aria-expanded]')).toBeNull();
  expect(pending.querySelector('.conversation-trace [data-status="running"]')?.textContent).toBe(
    wait.title!,
  );
  const failed: Message = {
    ...wait,
    text: '事件游标无效，子 Agent 可继续运行。',
    status: 'failed',
  };
  for (const open of [false, true]) {
    const document = renderWait(failed, open);
    expect(document.querySelector('.conversation-trace [data-status="error"]')?.textContent).toBe(
      wait.title!,
    );
    expect(document.querySelector('.tool-detail-status')?.textContent).toBe(
      open ? failed.text : undefined,
    );
    expect(document.querySelector('.tool-detail-scroll')).toBeNull();
  }
});

test('a new multi-step trace stays closed and restores the previously open tool on demand', async () => {
  await withConversationRoot(async (host, root) => {
    const later: Message = {
      id: 'later',
      turnId: 'run',
      role: 'tool',
      toolName: 'read_file',
      target: 'later.md',
      status: 'running',
      settled: false,
      text: '',
    };
    for (const toolName of ['wait_agent_events', 'edit_file', 'shell_execute'] as const) {
      const isEdit = toolName === 'edit_file';
      const output = 'stable original result';
      const earlier: Message = {
        ...later,
        id: toolName,
        toolName,
        title: isEdit ? '编辑文件' : toolName === 'shell_execute' ? '运行命令' : '等待 Agent 事件',
        target: isEdit ? 'original.md' : undefined,
        status: 'completed',
        settled: true,
        text: isEdit ? '' : output,
        agentWait: toolName === 'wait_agent_events' || undefined,
        shell:
          toolName === 'shell_execute'
            ? { operation: 'execute', jobStatus: 'succeeded', command: 'printf example', output }
            : undefined,
        changeConfirmed: isEdit,
        toolResult: isEdit ? { ok: true, stdout: `+${output}` } : undefined,
      };
      const draw = (messages: Message[]) =>
        act(async () => {
          root.render(
            <Conversation
              key={toolName}
              traceTurns
              messages={messages}
              selected
              connected
              loading={false}
              saveReading={() => {}}
              turnActivity={{ turnId: 'run', status: 'running' }}
            />,
          );
        });
      await draw([earlier]);
      const trace = host.querySelector('.conversation-trace')!;
      expect(trace.querySelector(':scope > .conversation-trace-trigger')).toBeNull();
      const tool = trace.querySelector('.tool-activity')!;
      const toggle = tool.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
      await act(async () => toggle.click());
      const detail = tool.querySelector('.tool-activity-content')!;
      expect(detail.textContent).toContain(output);
      await draw([earlier, later]);
      expect(host.querySelector('.conversation-trace') === trace).toBe(true);
      const groupToggle = trace.querySelector<HTMLButtonElement>(
        ':scope > .conversation-trace-trigger',
      )!;
      expect(groupToggle.getAttribute('aria-expanded')).toBe('false');
      expect(trace.querySelectorAll('.conversation-trace-steps').length).toBe(0);
      expect(trace.querySelectorAll('.tool-activity').length).toBe(0);
      await act(async () => groupToggle.click());
      expect(trace.querySelectorAll('.conversation-trace-steps > .tool-activity')).toHaveLength(2);
      const firstTool = trace.querySelector('.conversation-trace-steps > .tool-activity')!;
      const firstToggle = firstTool.querySelector('button[aria-expanded]')!;
      const firstDetail = firstTool.querySelector('.tool-activity-content')!;
      expect(firstToggle.getAttribute('aria-expanded')).toBe('true');
      expect(firstDetail.textContent).toContain(output);
      await draw([earlier, { ...later, status: 'completed', settled: true }]);
      expect(trace.querySelector('.conversation-trace-steps > .tool-activity') === firstTool).toBe(
        true,
      );
      expect(firstTool.querySelector('button[aria-expanded]') === firstToggle).toBe(true);
      expect(firstTool.querySelector('.tool-activity-content') === firstDetail).toBe(true);
      expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
      await act(async () => groupToggle.click());
      expect(groupToggle.getAttribute('aria-expanded')).toBe('false');
      await act(async () => groupToggle.click());
      expect(trace.querySelector('.tool-activity-content')?.textContent).toContain(output);
    }
  });
});

test('conversation trace keeps the first tool icon as the active title changes and uses a bulb for reasoning', () => {
  const thought = { ...thinking('run'), reasoningSource: 'original-thought' };
  const read: Message = {
    id: 'read',
    turnId: 'run',
    role: 'tool',
    text: '',
    toolName: 'read_file',
    status: 'running',
    settled: false,
    toolStartOrder: 1,
  };
  const shell: Message = {
    ...read,
    id: 'shell',
    toolName: 'shell_execute',
    toolStartOrder: 2,
  };
  const complete = (message: Message): Message => ({
    ...message,
    settled: true,
    status: 'completed',
  });
  const renderTrace = (messages: Message[], open = false) =>
    new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={messages}
          loading={false}
          selected
          connected
          initialReading={{
            top: 0,
            follow: true,
            expanded: {
              'turn:run:complete': true,
              'trace-turn:turn:run': open,
              [thought.id]: open,
              'activity:shell': open,
            },
          }}
          turnActivity={{
            turnId: 'run',
            status: messages.some((message) => !message.settled) ? 'running' : 'completed',
          }}
          renderReasoning={() => <p>已保存的思考摘要</p>}
          saveReading={() => {}}
        />,
      ),
    ).window.document;
  const summary = '.conversation-trace > button > .conversation-trace-line';
  const paths = (node: ParentNode) =>
    [...node.querySelectorAll('path')].map((path) => path.getAttribute('d'));
  const expectIcon = (line: Element, icon: typeof BulbIcon) => {
    const marker = line.firstElementChild!;
    expect(line.hasAttribute('data-trace-line')).toBe(true);
    expect(marker.getAttribute('data-slot')).toBe('trace-icon');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(paths(marker)).toEqual(
      paths(new JSDOM(renderToStaticMarkup(<HugeiconsIcon icon={icon} />)).window.document),
    );
  };

  expectIcon(traceHeadings(renderTrace([thought]))[0]!, BulbIcon);
  const completedThought = traceHeadings(renderTrace([complete(thought)]))[0]!;
  expect(completedThought.textContent).toBe('处理过程');
  expectIcon(completedThought, BulbIcon);
  expectIcon(traceHeadings(renderTrace([complete(read)]))[0]!, BookOpen01Icon);
  const running = renderTrace([complete(thought), read, shell]).querySelector(summary)!;
  expect(running.textContent).toBe('运行命令');
  expect(running.getAttribute('data-status')).toBe('running');
  expectIcon(running, BookOpen01Icon);
  expectIcon(
    renderTrace([complete(thought), read, complete(shell)]).querySelector(summary)!,
    BookOpen01Icon,
  );

  const grouped = renderTrace([complete(thought), complete(read), complete(shell)], true);
  expectIcon(grouped.querySelector(summary)!, BookOpen01Icon);
  const reasoningLine = grouped.querySelector('.conversation-reasoning .conversation-trace-line')!;
  expectIcon(reasoningLine, BulbIcon);
  expect(reasoningLine.textContent).toBe('已思考');
  expectIcon(
    grouped.querySelector('.conversation-trace-steps .tool-activity-step')!,
    BookOpen01Icon,
  );
  expectIcon(
    grouped.querySelector('.conversation-trace-steps .shell-activity .tool-activity-summary')!,
    TerminalIcon,
  );
  const css = readFileSync(new URL('../src/desktop/style.css', import.meta.url), 'utf8');
  const guideSelector = css.match(/([^{}]+)\{\s*--trace-guide-width:/)?.[1];
  expect(guideSelector).toBeDefined();
  const guides = (document: Document) => {
    document.body.classList.add('kite-client');
    return document.querySelectorAll(guideSelector!.replaceAll('::before', ''));
  };
  expect(guides(renderTrace([complete(thought)]))).toHaveLength(0);
  expect(guides(renderTrace([complete(thought)], true))).toHaveLength(1);
  expect(guides(renderTrace([complete(shell)], true))).toHaveLength(1);
  expect(guides(grouped)).toHaveLength(3);
});

test('host-confirmed hidden non-tool records never create a row or invoke the body renderer', () => {
  const { calls, document } = render(
    [
      user('first'),
      {
        id: 'tool-model',
        role: 'assistant',
        turnId: 'run',
        text: '',
        settled: false,
        presentation: 'hidden',
      },
      {
        id: 'tool:failure',
        role: 'tool',
        turnId: 'run',
        text: 'Real failure',
        settled: true,
        presentation: 'hidden',
        status: 'failed',
      },
    ],
    true,
    true,
  );
  expect(calls).toEqual(['first', 'tool:failure']);
  expect(document.querySelector('.message.assistant')).toBeNull();
  expect(document.body.textContent).toContain('Real failure');
  expect(document.querySelector('.agent-turn-status-label')?.textContent).toBe('进行中');
  expect(document.querySelector('.response-status')).toBeNull();
});

test('timing-only completed turns keep exact identities and never render private markers through the host', () => {
  const timing: Message = {
    id: 'timing:first',
    turnId: 'first-run',
    role: 'system',
    systemKind: 'turn_timing',
    text: 'PRIVATE TIMING',
    settled: true,
    turnStartedAtMs: 1000,
    turnFinishedAtMs: 4000,
  };
  const result = render(
    [
      user('first-user'),
      timing,
      terminal('first-run', 'completed'),
      user('second-user'),
      thinking('second-run'),
      terminal('second-run', 'cancelled'),
    ],
    true,
  );
  expect(result.calls).toEqual(['first-user', 'second-user']);
  expect(
    [...result.document.querySelectorAll('.agent-turn')].map((turn) =>
      turn.getAttribute('data-turn-status'),
    ),
  ).toEqual(['completed', 'cancelled']);
  expect(result.document.querySelector('.agent-turn')?.textContent).toContain('3 秒');
  expect(result.document.querySelector('.agent-turn button')).toBeNull();
  expect(result.html.indexOf('first-user')).toBeLessThan(result.html.indexOf('agent-turn'));
  expect(result.html.indexOf('agent-turn')).toBeLessThan(result.html.indexOf('second-user'));
  expect(result.html).not.toContain('PRIVATE');
});

for (const markerFirst of [true, false]) {
  test(`a structural timing marker keeps immediately running status below its original input (marker first: ${markerFirst})`, () => {
    const first: Message = { ...user('original'), turnId: 'run' };
    const timing: Message = {
      id: 'timing',
      turnId: 'run',
      role: 'system',
      systemKind: 'turn_timing',
      text: '',
      settled: false,
    };
    const later: Message = { ...user('later'), turnId: 'later-turn' };
    const rows = markerFirst ? [timing, first] : [first, timing];
    const { document } = render([...rows, later, terminal('later-turn', 'completed')], false, true);
    const entries = [...document.querySelectorAll('.message.user,.agent-turn')].map((el) =>
      el.classList.contains('agent-turn')
        ? el.getAttribute('data-turn-status')
        : el.getAttribute('data-message-id'),
    );
    expect(entries).toEqual(['original', 'running', 'later', 'completed']);
    expect(document.querySelector('.agent-turn-status-label')?.textContent).toBe('进行中');
  });
}

test('Native immediately shows one running status below an unacknowledged original, then retains order on durable handoff', () => {
  const timing: Message = {
    id: 'native-run-timing',
    turnId: 'run',
    presentationKey: 'new-command',
    role: 'system',
    systemKind: 'turn_timing',
    text: '',
    settled: false,
  };
  const pending: Message = { ...user('new-command'), text: 'same input', delivery: 'unknown' };
  const saved: Message = {
    ...user('saved-message'),
    turnId: 'run',
    presentationKey: 'new-command',
    text: 'same input',
  };
  const prior: Message = { ...user('other-command'), text: 'same input', turnId: 'prior' };
  for (const input of [pending, saved])
    for (const pair of [
      [timing, input],
      [input, timing],
    ]) {
      const html = renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[prior, terminal('prior', 'completed'), ...pair]}
          loading={false}
          selected
          connected
          saveReading={() => {}}
          turnActivity={{ turnId: 'run', status: 'running' }}
        />,
      );
      const doc = new JSDOM(html).window.document;
      const entries = [...doc.querySelectorAll('.message.user,.agent-turn')].map(
        (el) => el.getAttribute('data-message-id') ?? el.getAttribute('data-turn-status'),
      );
      expect(entries).toEqual(['other-command', 'completed', input.id, 'running']);
      expect(doc.querySelector('.agent-turn[data-turn-status=running]')?.textContent).toContain(
        '进行中',
      );
    }
});

test('late Native terminal markers anchor a no-output turn after its exact original user', () => {
  const firstUser: Message = { ...user('first-user'), turnId: 'first-run' };
  const secondUser: Message = { ...user('second-user'), turnId: 'second-run' };
  const reply: Message = {
    id: 'reply',
    turnId: 'second-run',
    role: 'assistant',
    text: 'Second reply',
    settled: true,
    finalReply: true,
  };
  const timing: Message = {
    id: 'timing:first',
    turnId: 'first-run',
    role: 'system',
    systemKind: 'turn_timing',
    text: '',
    settled: true,
    turnStartedAtMs: 1000,
    turnFinishedAtMs: 2000,
  };
  const { document } = render([
    firstUser,
    secondUser,
    reply,
    timing,
    terminal('first-run', 'cancelled'),
    terminal('second-run', 'completed'),
  ]);
  const ordered = [...document.querySelectorAll('.message.user, .agent-turn')];
  expect(
    ordered.map((element) =>
      element.classList.contains('agent-turn')
        ? element.getAttribute('data-turn-status')
        : element.querySelector('.user-message-body')?.textContent?.trim(),
    ),
  ).toEqual(['first-user', 'cancelled', 'second-user', 'completed']);
  expect(
    [...document.querySelectorAll('.message.user .message-time')].map((time) => time.textContent),
  ).toEqual(['时间未知', '时间未知']);
  expect(document.querySelector('.agent-turn .message.user')).toBeNull();
  expect(document.querySelector('.agent-turn')?.querySelector('button') === null).toBe(true);
  expect(render([firstUser]).document.querySelector('.agent-turn') === null).toBe(true);
});

test('hidden reasoning does not split adjacent exploration calls and failure receipts stay in their Turn process', () => {
  const tool = (id: string): Message => ({
    id,
    turnId: 'run',
    role: 'tool',
    text: '',
    settled: false,
    presentation: 'exploration',
    presentationGroupId: id,
    toolName: 'files.read',
    status: 'running',
  });
  const grouped: number[] = [];
  const html = renderToStaticMarkup(
    <Conversation
      messages={[user('first'), tool('tool:a'), thinking('run'), tool('tool:b')]}
      selected
      connected
      loading={false}
      saveReading={() => {}}
      renderToolActivity={(messages) => {
        grouped.push(messages.length);
        return <span>tools</span>;
      }}
    />,
  );
  expect(grouped).toEqual([2]);
  const document = new JSDOM(html).window.document;
  expect(document.querySelector('.agent-turn button')).toBeNull();
  expect(document.querySelector('.agent-turn-process')?.getAttribute('data-state')).toBe('open');
  expect(html).not.toContain('PRIVATE REASONING');
  const failure: Message = {
    id: 'failure:run',
    turnId: 'run',
    role: 'system',
    systemKind: 'turn_failure',
    text: 'Actual failure',
    status: 'failed',
    settled: true,
  };
  const failed = render([user('first'), thinking('run'), failure]);
  expect(failed.document.querySelector('.agent-turn')?.getAttribute('data-turn-status')).toBe(
    'failed',
  );
  expect(failed.document.querySelector('.agent-turn-summary')?.textContent).toBe('用时未知');
  expect(failed.document.querySelector('.agent-turn-failure')).toBeNull();
  expect(failed.document.querySelector('.agent-turn-process')?.getAttribute('data-state')).toBe(
    'open',
  );
  expect(failed.document.querySelector('.turn-failure')?.textContent).toContain('Actual failure');
  expect(failed.document.querySelector('.turn-failure')?.getAttribute('role')).toBe('alert');
  expect(failed.document.querySelector('.turn-failure')?.classList.contains('message')).toBe(false);
  const expanded = new JSDOM(
    renderToStaticMarkup(
      <Conversation
        messages={[user('first'), thinking('run'), failure]}
        loading={false}
        selected
        connected
        initialReading={{ top: 0, follow: false, expanded: { 'turn:run:complete': true } }}
        saveReading={() => {}}
      />,
    ),
  );
  try {
    expect(
      expanded.window.document.querySelector('.agent-turn-process-messages .turn-failure')
        ?.textContent,
    ).toContain('Actual failure');
  } finally {
    expanded.window.close();
  }
});

test('cold and restored active processes start fully expanded without replaying an opening animation', () => {
  const messages: Message[] = [
    {
      id: 'reply',
      role: 'assistant',
      turnId: 'run',
      text: 'Working',
      settled: false,
    },
  ];
  for (const restored of [false, true]) {
    const html = renderToStaticMarkup(
      <Conversation
        messages={messages}
        loading={false}
        selected
        connected
        turnActivity={{ turnId: 'run', status: 'running' }}
        initialReading={
          restored ? { top: 42, follow: false, expanded: { 'turn:run:process': false } } : undefined
        }
        saveReading={() => {}}
      />,
    );
    const dom = new JSDOM(html);
    try {
      expect(
        dom.window.document.querySelector('.agent-turn-process')?.getAttribute('data-state'),
      ).toBe('open');
      expect(dom.window.document.querySelector('button.agent-turn-summary')).toBeNull();
      expect(dom.window.document.querySelector('.agent-turn-chevron')).toBeNull();
      expect(
        dom.window.document
          .querySelector('.agent-turn-process')
          ?.getAttribute('data-restored-expanded'),
      ).toBe('true');
      expect(
        dom.window.document.querySelector('.agent-turn-process-messages')?.textContent,
      ).toContain('Working');
    } finally {
      dom.window.close();
    }
  }
});

test('only exact Turn guidance joins the process; first input and failed or unknown deliveries retain their original boundary', () => {
  const guidance: Message = {
    id: 'steer',
    turnId: 'run',
    inputKind: 'input.steer',
    role: 'user',
    text: '真实引导',
    settled: true,
  };
  for (const delivery of [undefined, 'sending', 'failed', 'unknown'] as const) {
    const first: Message = { ...user('first'), turnId: 'run' };
    const candidate = { ...guidance, delivery, settled: delivery === undefined };
    const { document } = render(
      [
        first,
        { id: 'before', turnId: 'run', role: 'assistant', text: 'before', settled: true },
        candidate,
        { id: 'after', turnId: 'run', role: 'assistant', text: 'after', settled: false },
      ],
      false,
      true,
    );
    expect(document.querySelector('[data-message-id="first"]')!.closest('.agent-turn')).toBeNull();
    const steer = document.querySelector('[data-message-id="steer"]')!;
    if (delivery === 'failed' || delivery === 'unknown') {
      expect(steer.closest('.agent-turn')).toBeNull();
      expect(steer.querySelector('[role="alert"]')!.textContent).toContain(
        delivery === 'failed' ? '发送失败' : '发送结果待确认',
      );
      expect(steer.textContent).toContain('真实引导');
    } else {
      expect(steer.closest('.agent-turn-process-messages')).not.toBeNull();
      expect(document.querySelectorAll('.agent-turn')).toHaveLength(1);
    }
  }
  const unscoped = render([{ ...guidance, turnId: undefined }]);
  expect(unscoped.document.querySelector('.agent-turn')).toBeNull();
  expect(unscoped.document.querySelector('[data-message-id="steer"]')!.textContent).toContain(
    '真实引导',
  );
  // A follow-up owns a new Run and has no host-confirmed steer classification.
  // Even exact Turn ownership alone cannot absorb either ordinary user input.
  const ordinaryInputs = render([
    { ...user('unclassified'), turnId: 'run' },
    { ...user('follow-up'), turnId: 'next-run' },
    { id: 'next-reply', turnId: 'next-run', role: 'assistant', text: 'next reply', settled: false },
  ]);
  for (const id of ['unclassified', 'follow-up'])
    expect(
      ordinaryInputs.document.querySelector(`[data-message-id="${id}"]`)!.closest('.agent-turn'),
    ).toBeNull();
  const onlyGuidance = render([guidance, thinking('run'), terminal('run', 'completed')]);
  expect(onlyGuidance.document.querySelectorAll('.agent-turn')).toHaveLength(1);
  expect(onlyGuidance.document.querySelectorAll('.agent-turn-process')).toHaveLength(1);
  expect(onlyGuidance.document.querySelectorAll('.agent-turn-status-label')).toHaveLength(1);
  expect(onlyGuidance.document.querySelector('.message.user:not([data-input-kind])')).toBeNull();
});

test('interleaved steers and child mail share input bubbles in one process through persistence, completion and cold expansion with exact copy boundaries', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const originals = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const copied: string[] = [];
  const firstBody = '**引导一完整正文**\n\n雪🙂\n最后一行 ONE';
  const secondBody = '引导二完整正文\n\n末尾 TWO';
  const finalBody = '父轮唯一最终回复';
  const first: Message = { ...user('first'), turnId: 'run', text: '本轮首条用户输入' };
  const guide = (id: string, text: string): Message => ({
    id,
    turnId: 'run',
    inputKind: 'input.steer',
    role: 'user',
    text,
    settled: true,
  });
  const tool = (id: string, title: string): Message => ({
    id,
    turnId: 'run',
    role: 'tool',
    toolName: 'fixture.query',
    title,
    text: '读取成功',
    settled: true,
    status: 'completed',
  });
  const draw = (phase: 'sending' | 'accepted' | 'saved' | 'completed', key = 'hot') => {
    const finished = phase === 'completed';
    const steerOne: Message = {
      ...guide(phase === 'saved' || finished ? 'saved-steer-one' : 'local-steer-one', firstBody),
      ...(phase === 'sending' ? { delivery: 'sending', settled: false } : {}),
    };
    const messages: Message[] = [
      first,
      { id: 'before', turnId: 'run', role: 'assistant', text: '模型前段', settled: true },
      steerOne,
      tool('tool-a', '工具A'),
      {
        id: 'saved-agent-mail',
        turnId: 'run',
        role: 'system',
        systemKind: 'agent_message',
        text: '**子消息完整正文**\n\n邮件末行 CHILD',
        settled: true,
        agentMessage: {
          messageId: 'original-agent-mail',
          sourceSessionId: 'child-session',
          sourceExecutionId: 'mail-tool',
          name: '线索检索',
          contentComplete: true,
        },
      },
      { id: 'middle', turnId: 'run', role: 'assistant', text: '模型中段', settled: true },
      guide('saved-steer-two', secondBody),
      tool('tool-b', '工具B'),
      {
        id: 'last',
        turnId: 'run',
        role: 'assistant',
        text: finished ? finalBody : '模型后段',
        settled: finished,
        ...(finished ? { finalReply: true, copyText: finalBody } : {}),
      },
      {
        id: 'timing',
        turnId: 'run',
        role: 'system',
        systemKind: 'turn_timing',
        text: '',
        settled: finished,
        turnStartedAtMs: 1000,
        ...(finished ? { turnFinishedAtMs: 4000 } : {}),
      },
      ...(finished ? [terminal('run', 'completed')] : []),
    ];
    root.render(
      <Conversation
        key={key}
        messages={messages}
        turnActivity={{ turnId: 'run', status: finished ? 'completed' : 'running' }}
        loading={false}
        selected
        connected
        saveReading={() => {}}
        writeClipboardText={async (text) => {
          copied.push(text);
        }}
        renderMessageContent={(message) => <MessageContent text={message.text} />}
      />,
    );
  };
  const verify = (finished = false) => {
    expect(host.querySelectorAll('.agent-turn')).toHaveLength(1);
    expect(host.querySelectorAll('.agent-turn-process')).toHaveLength(1);
    expect(host.querySelector('[data-message-id="first"]')!.closest('.agent-turn')).toBeNull();
    const steers = [...host.querySelectorAll('[data-input-kind="input.steer"]')];
    expect(steers).toHaveLength(2);
    for (const steer of steers)
      expect(steer.closest('.agent-turn-process-messages')).not.toBeNull();
    expect(steers[0]!.querySelector('.typeset-chat strong')!.textContent).toBe('引导一完整正文');
    expect(steers[0]!.textContent).toContain('最后一行 ONE');
    expect(steers[1]!.textContent).toContain('末尾 TWO');
    const mail = host.querySelector('[data-agent-message-id="original-agent-mail"]')!;
    expect(mail.closest('.agent-turn-process-messages')).not.toBeNull();
    expect(mail.classList.contains('user')).toBe(false);
    expect(mail.classList.contains('agent-result')).toBe(false);
    expect(mail.querySelectorAll('.user-message-body')).toHaveLength(1);
    expect(mail.querySelector('.user-message-body > .message-label')!.textContent).toBe(
      '线索检索 Agent 发送',
    );
    expect(mail.querySelector('.typeset-chat strong')!.textContent).toBe('子消息完整正文');
    expect(mail.textContent).toContain('邮件末行 CHILD');
    expect(host.querySelectorAll('[data-agent-message-id="original-agent-mail"]')).toHaveLength(1);
    expect(mail.querySelectorAll('.message-meta,.message-copy,button,input')).toHaveLength(0);
    for (const input of [host.querySelector('[data-message-id="first"]')!, ...steers])
      expect(input.querySelectorAll('.user-message-body')).toHaveLength(1);
    const process = host.querySelector('.agent-turn-process-messages')!;
    expect(process.querySelectorAll('.message.assistant .message-meta')).toHaveLength(0);
    expect(host.querySelector('[data-message-id="first"] .message-meta')).not.toBeNull();
    expect(steers[1]!.querySelector('.message-meta')).not.toBeNull();
    if (finished) expect(host.querySelector('.agent-turn-final .message-meta')).not.toBeNull();
    const expected = [
      '模型前段',
      '引导一完整正文',
      '工具A',
      '子消息完整正文',
      '模型中段',
      '引导二完整正文',
      '工具B',
    ];
    const positions = expected.map((text) => process.textContent!.indexOf(text));
    expect(positions.every((value) => value >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(host.querySelectorAll('.agent-turn-status-label')).toHaveLength(1);
    expect(host.querySelectorAll('[aria-label="复制本轮Agent回复"]')).toHaveLength(
      finished ? 1 : 0,
    );
  };
  try {
    await act(async () => draw('sending'));
    verify();
    const process = host.querySelector('.agent-turn-process');
    await act(async () => draw('accepted'));
    verify();
    expect(host.querySelector('.agent-turn-process')).toBe(process);
    await act(async () => draw('saved'));
    verify();
    expect(host.querySelector('.agent-turn-process')).toBe(process);
    expect(host.querySelector('[data-message-id="local-steer-one"]')).toBeNull();
    expect(host.querySelector('[data-message-id="saved-steer-one"]')).not.toBeNull();
    await act(async () => draw('completed'));
    expect(host.querySelectorAll('.agent-turn')).toHaveLength(1);
    expect(host.querySelector('.agent-turn-summary')!.getAttribute('aria-expanded')).toBe('false');
    await act(async () => (host.querySelector('.agent-turn-summary') as HTMLButtonElement).click());
    verify(true);
    expect(host.querySelector('.agent-turn-status-label')!.textContent).toBe('用时 3 秒');
    await act(async () =>
      (host.querySelector('[aria-label="复制本轮Agent回复"]') as HTMLButtonElement).click(),
    );
    expect(copied).toEqual([finalBody]);
    const steerCopy = host.querySelector(
      '[data-message-id="saved-steer-one"] [aria-label="复制本轮用户消息"]',
    ) as HTMLButtonElement;
    await act(async () => steerCopy.click());
    expect(copied).toEqual([finalBody, firstBody]);
    await act(async () => draw('completed', 'cold'));
    expect(host.querySelectorAll('.agent-turn')).toHaveLength(1);
    expect(host.querySelector('.agent-turn-summary')!.getAttribute('aria-expanded')).toBe('false');
    await act(async () => (host.querySelector('.agent-turn-summary') as HTMLButtonElement).click());
    verify(true);
    expect(host.querySelector('.agent-turn-status-label')!.textContent).toBe('用时 3 秒');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('separate traces retain their own result or thinking while the Turn shows its own status', () => {
  const old: Message = {
    ...thinking('run'),
    id: 'old-thought',
    reasoningSource: 'old-model',
    settled: true,
  };
  const done: Message = {
    id: 'read',
    turnId: 'run',
    role: 'tool',
    toolName: 'read_file',
    text: '',
    status: 'completed',
    settled: true,
  };
  const next: Message = { ...thinking('run'), id: 'next-thought', reasoningSource: 'next-model' };
  const boundaries: Message[] = [
    { id: 'prose', turnId: 'run', role: 'assistant', text: 'Real stage prose', settled: true },
    {
      id: 'steer',
      turnId: 'run',
      inputKind: 'input.steer',
      role: 'user',
      text: 'Original guidance',
      settled: true,
    },
    {
      id: 'mail',
      turnId: 'run',
      role: 'system',
      systemKind: 'agent_message',
      text: 'Original agent mail',
      settled: true,
    },
    {
      id: 'connection',
      turnId: 'run',
      role: 'system',
      systemKind: 'model_connection',
      text: 'Reconnecting',
      status: 'running',
      settled: false,
    },
    {
      id: 'result',
      turnId: 'run',
      role: 'system',
      systemKind: 'agent_result',
      text: 'Original child result',
      settled: true,
    },
  ];
  for (const boundary of boundaries) {
    for (const [status, executionUnconfirmed, notice] of [
      ['running', false, undefined],
      ['running', true, undefined],
      ['waiting', false, '正在等待'],
      ['cancelling', false, '正在停止'],
      ['recovery_required', false, '需要恢复'],
      ['completed', false, undefined],
      ['cancelled', false, '你已停止'],
      ['failed', false, '本轮异常结束'],
    ] as const) {
      const dom = new JSDOM(
        renderToStaticMarkup(
          <Conversation
            traceTurns
            selected
            connected
            loading={false}
            saveReading={() => {}}
            messages={[old, done, boundary, next]}
            turnActivity={{ turnId: 'run', status, executionUnconfirmed }}
            initialReading={{ top: 0, follow: false, expanded: { 'turn:run:complete': true } }}
          />,
        ),
      );
      const headings = traceHeadings(dom.window.document);
      expect(headings).toHaveLength(2);
      const thinking = status === 'running' && !executionUnconfirmed;
      expect(headings.map((heading) => heading.textContent)).toEqual([
        '读取了文件',
        thinking ? '思考中' : '处理过程',
      ]);
      expect(headings[0]!.getAttribute('data-status')).not.toBe('running');
      expect(headings[1]!.getAttribute('data-status') === 'running').toBe(thinking);
      expect(
        dom.window.document.querySelector(
          status === 'waiting' || status === 'cancelling' || status === 'recovery_required'
            ? '.agent-turn-summary > [role="status"]'
            : '.agent-turn > .conversation-turn-notice',
        )?.textContent,
      ).toBe(notice);
      expect(dom.window.document.body.textContent).not.toContain('PRIVATE REASONING');
      dom.window.close();
    }
  }
});

test('a non-tail trace preserves its own active tool without lending activity to settled siblings', () => {
  const pending: Message = {
    id: 'read',
    turnId: 'run',
    role: 'tool',
    toolName: 'read_file',
    text: '',
    status: 'running',
    settled: false,
  };
  for (const splitEntry of [false, true]) {
    for (const status of ['running', 'completed', 'cancelled', 'unknown'] as const) {
      const tool = { ...pending, status, settled: status !== 'running' };
      const boundary: Message = splitEntry
        ? {
            id: 'result',
            turnId: 'run',
            role: 'system',
            systemKind: 'agent_result',
            text: 'Child result',
            settled: true,
          }
        : { id: 'stage', turnId: 'run', role: 'assistant', text: 'Stage prose', settled: true };
      for (const executionUnconfirmed of [false, true]) {
        const dom = new JSDOM(
          renderToStaticMarkup(
            <Conversation
              traceTurns
              selected
              connected
              loading={false}
              saveReading={() => {}}
              messages={[tool, boundary, { ...thinking('run'), id: 'next-thought' }]}
              turnActivity={{ turnId: 'run', status: 'running', executionUnconfirmed }}
            />,
          ),
        );
        const headings = traceHeadings(dom.window.document);
        expect(headings).toHaveLength(2);
        expect(headings[0]!.getAttribute('data-status') === 'running').toBe(
          status === 'running' && !executionUnconfirmed,
        );
        expect(headings[0]!.textContent).not.toMatch(/正在回复|正在思考/);
        if (status !== 'completed') expect(headings[0]!.textContent).not.toContain('读取了');
        dom.window.close();
      }
    }
  }
});

test('tool handoff retains the latest message until a reply or terminal ends the trace', () => {
  const done: Message = {
    id: 'read',
    turnId: 'run',
    role: 'tool',
    toolName: 'read_file',
    text: '',
    status: 'completed',
    settled: true,
  };
  const lastTool: Message = {
    ...done,
    id: 'second-shell',
    toolName: 'shell_execute',
    target: '查看第二条输出',
    shell: { operation: 'execute', jobStatus: 'succeeded', commandPreview: 'printf second' },
  };
  const pending: Message = { ...thinking('run'), text: '', tracePending: 'tool' };
  const reply: Message = {
    id: 'prose',
    turnId: 'run',
    role: 'assistant',
    text: 'Streaming reply',
    settled: false,
    streaming: true,
  };
  for (const [status, tail, expected] of [
    ['running', pending, '已运行 printf second'],
    ['waiting', pending, '已运行 printf second'],
    ['running', reply, '读取了文件运行了命令'],
    ['completed', pending, '读取了文件运行了命令'],
  ] as const) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[done, { ...done, id: 'shell', toolName: 'shell_execute' }, lastTool, tail]}
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{ turnId: 'run', status }}
          initialReading={{ top: 0, follow: false, expanded: { 'turn:run:complete': true } }}
        />,
      ),
    );
    const heading = dom.window.document.querySelector('.conversation-trace > button')!;
    expect(heading.textContent).toBe(expected);
    expect(heading.querySelector('[data-status="running"]')).toBeNull();
    dom.window.close();
  }
});

test('each live Native turn shows its process immediately and retains the reading choice through settlement', async () => {
  for (const manuallyClose of [false, true]) {
    await withConversationRoot(async (host, root) => {
      const tool: Message = {
        id: 'shell-process',
        turnId: 'run',
        role: 'tool',
        text: '',
        toolName: 'shell_execute',
        status: 'running',
        settled: false,
        shell: { operation: 'execute', command: 'pwd', jobStatus: 'running' },
      };
      const reply: Message = {
        id: 'final',
        turnId: 'run',
        role: 'assistant',
        text: 'Final reply',
        settled: true,
        finalReply: true,
      };
      const draw = (status: 'running' | 'waiting' | 'completed', next?: Message) =>
        act(async () => {
          root.render(
            <Conversation
              traceTurns
              selected
              connected
              loading={false}
              messages={[
                user('first'),
                status === 'completed'
                  ? {
                      ...tool,
                      status: 'completed',
                      settled: true,
                      shell: { ...tool.shell!, jobStatus: 'succeeded' },
                    }
                  : tool,
                ...(status === 'completed' ? [reply, terminal('run', 'completed')] : []),
                ...(next ? [user('second'), next] : []),
                ...(next?.status === 'failed' ? [terminal('next', 'failed')] : []),
              ]}
              turnActivity={{
                turnId: next?.turnId ?? 'run',
                status: next ? (next.status === 'failed' ? 'failed' : 'running') : status,
              }}
              saveReading={() => {}}
            />,
          );
        });
      await draw('running');
      const trigger = host.querySelector<HTMLButtonElement>('button.agent-turn-summary')!;
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(trigger.textContent).toContain('进行中');
      expect(trigger.closest('.agent-turn-process')?.getAttribute('data-instant-open')).toBe(
        'true',
      );
      const row = host.querySelector('.shell-activity');
      expect(row).not.toBeNull();
      if (manuallyClose) await act(async () => trigger.click());
      await draw('waiting');
      expect(host.querySelector('button.agent-turn-summary') === trigger).toBe(true);
      expect(trigger.getAttribute('aria-expanded')).toBe(String(!manuallyClose));
      await draw('completed');
      expect(host.querySelector('button.agent-turn-summary') === trigger).toBe(true);
      expect(trigger.textContent).toContain('用时');
      expect(trigger.getAttribute('aria-expanded')).toBe(String(!manuallyClose));
      if (!manuallyClose) expect(host.querySelector('.shell-activity') === row).toBe(true);
      expect(host.querySelector('.agent-turn-content')?.textContent).not.toContain('Final reply');
      expect(host.textContent).toContain('Final reply');
      const next = { ...tool, id: 'next-tool', turnId: 'next' };
      await draw('completed', next);
      const summaries = host.querySelectorAll<HTMLButtonElement>('button.agent-turn-summary');
      expect(summaries[0]?.getAttribute('aria-expanded')).toBe(String(!manuallyClose));
      const nextSummary = summaries[1]!;
      const nextProcess = nextSummary.closest('.agent-turn-process')!;
      expect(nextSummary.getAttribute('aria-expanded')).toBe('true');
      expect(nextProcess.getAttribute('data-instant-open')).toBe('true');
      expect(nextProcess.querySelectorAll('.shell-activity')).toHaveLength(1);
      if (manuallyClose) {
        await act(async () => nextSummary.click());
        expect(nextProcess.hasAttribute('data-instant-open')).toBe(false);
      }
      await draw('completed', { ...next, status: 'failed', settled: true });
      expect(nextSummary.getAttribute('aria-expanded')).toBe(String(!manuallyClose));
      expect(nextSummary.textContent).toContain('用时');
    });
  }
});

test('ordinary replies stay in order and mounted when interleaved tools are folded', async () => {
  await withConversationRoot(async (host, root) => {
    const input = user('question');
    const firstReply: Message = {
      id: 'first-reply',
      role: 'assistant',
      turnId: 'run',
      text: 'I will read the configuration.',
      settled: true,
    };
    const secondReply: Message = {
      ...firstReply,
      id: 'second-reply',
      text: 'I found the entry point.',
    };
    const read: Message = {
      id: 'tool:read',
      turnId: 'run',
      role: 'tool',
      toolName: 'shell_execute',
      text: '',
      status: 'running',
      settled: false,
      shell: { operation: 'execute', command: 'rg --files', jobStatus: 'running' },
    };
    const finish = (tool: Message): Message => ({
      ...tool,
      status: 'completed',
      settled: true,
      shell: { ...tool.shell!, jobStatus: 'succeeded' },
    });
    const check: Message = {
      ...read,
      id: 'tool:check',
      shell: { ...read.shell!, command: 'git status' },
    };
    const draw = (messages: Message[], status: 'running' | 'completed' = 'running') =>
      act(async () =>
        root.render(
          <Conversation
            traceTurns
            selected
            connected
            loading={false}
            messages={messages}
            turnActivity={messages.length ? { turnId: 'run', status } : undefined}
            saveReading={() => {}}
          />,
        ),
      );
    const replies = () => [...host.querySelectorAll('.message.assistant')];

    await draw([]);
    await draw([input, firstReply]);
    const firstNode = replies()[0];
    expect(firstNode?.textContent).toContain(firstReply.text);
    await draw([input, firstReply, read]);
    const summary = host.querySelector<HTMLButtonElement>('button.agent-turn-summary')!;
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(replies()[0]).toBe(firstNode);
    expect(host.querySelector('.shell-activity')).not.toBeNull();
    await act(async () => summary.click());
    expect(summary.getAttribute('aria-expanded')).toBe('false');

    await draw([input, firstReply, finish(read), secondReply]);
    const secondNode = replies()[1];
    expect(secondNode?.textContent).toContain(secondReply.text);
    await draw([input, firstReply, finish(read), secondReply, check]);
    expect(replies()[1]).toBe(secondNode);
    await act(async () => summary.click());
    const rowText = [...host.querySelectorAll('.message.assistant, .tool-command')].map(
      (row) => row.textContent,
    );
    expect(rowText).toEqual([
      expect.stringContaining(firstReply.text),
      'rg --files',
      expect.stringContaining(secondReply.text),
      'git status',
    ]);
    const panels = summary
      .getAttribute('aria-controls')!
      .split(' ')
      .map((id) => document.getElementById(id));
    expect(panels).toHaveLength(2);
    expect(panels.every((node) => node?.getAttribute('data-state') === 'open')).toBe(true);

    const final = { ...firstReply, id: 'final', text: 'The check is complete.', finalReply: true };
    await draw(
      [
        input,
        firstReply,
        finish(read),
        secondReply,
        finish(check),
        final,
        terminal('run', 'completed'),
      ],
      'completed',
    );
    expect(summary.textContent).toContain('用时');
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    await act(async () => summary.click());
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(replies()).toHaveLength(3);
    expect(replies()[0]).toBe(firstNode);
    expect(replies()[1]).toBe(secondNode);
    expect(replies()[2]?.textContent).toContain(final.text);
    expect(replies().every((node) => node.closest('.agent-turn-content') === null)).toBe(true);
  });
});

test('reasoning keeps its own disclosure through streaming, tool updates, reconnect and completion', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const originals = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  let thought = {
    ...thinking('run'),
    presentationKey: 'stable-thought',
    reasoningSource: 'source',
    settled: true,
  };
  let status: 'running' | 'completed' = 'running';
  let executionUnconfirmed = false;
  let bodyText = 'Existing reasoning';
  let layout = 'grouped';
  const tool: Message = {
    id: 'shell',
    turnId: 'run',
    role: 'tool',
    toolName: 'shell_execute',
    text: '',
    settled: false,
    status: 'running',
  };
  const reading: import('../src/desktop/Conversation').ReadingState[] = [];
  const draw = (tools: Message[]) =>
    root.render(
      <Conversation
        key={layout}
        traceTurns
        messages={[thought, ...tools]}
        selected
        connected
        loading={false}
        saveReading={(value) => reading.push(value)}
        turnActivity={{ turnId: 'run', status, executionUnconfirmed }}
        renderReasoning={(message, open) => (
          <p data-thought-body={message.reasoningSource} data-reader-active={open}>
            {bodyText}
          </p>
        )}
      />,
    );
  try {
    await act(async () => draw([tool]));
    const groupedTrace = host.querySelector<HTMLButtonElement>('.conversation-trace > button')!;
    expect(groupedTrace.getAttribute('aria-expanded')).toBe('false');
    await act(async () => groupedTrace.click());
    expect(groupedTrace.getAttribute('aria-expanded')).toBe('true');
    const groupedThought = host.querySelector<HTMLButtonElement>(
      '.conversation-reasoning > button',
    )!;
    expect(groupedThought.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-thought-body]')).toBeNull();
    await act(async () => groupedThought.click());
    expect(groupedThought.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-thought-body]')?.textContent).toBe(bodyText);

    layout = 'single';
    thought = { ...thought, settled: false };
    await act(async () => draw([]));
    const singleTrace = host.querySelector<HTMLButtonElement>('.conversation-trace button')!;
    expect(singleTrace.textContent).toBe('思考中');
    expect(host.querySelectorAll('.conversation-trace button')).toHaveLength(1);
    await act(async () => singleTrace.click());
    const body = host.querySelector('[data-thought-body]');
    expect(body).not.toBeNull();
    const reasoning = host.querySelector('.conversation-reasoning')!;
    const button = reasoning.querySelector('button')!;
    const panel = reasoning.querySelector('.conversation-reasoning-body')!;
    expect(button === singleTrace).toBe(true);
    expect(button.textContent).toBe('思考中');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.contains(body)).toBe(true);
    expect(host.querySelectorAll('.conversation-trace [data-trace-line]')).toHaveLength(1);
    expect(host.querySelectorAll('.message.assistant')).toHaveLength(0);
    bodyText += ' streamed';
    await act(async () => draw([]));
    expect(host.querySelector('[data-thought-body]')).toBe(body);
    expect(body!.textContent).toBe('Existing reasoning streamed');
    thought = { ...thought, settled: true };
    await act(async () => draw([tool]));
    expect(host.querySelector('[data-thought-body]')).toBe(body);
    expect(host.querySelector('.conversation-reasoning')!.getAttribute('data-state')).toBe('open');
    expect(
      host.querySelector('.conversation-reasoning .conversation-trace-line')?.textContent,
    ).toBe('已思考');
    expect(host.querySelector('.conversation-reasoning')).toBe(reasoning);
    expect(host.querySelector('.conversation-reasoning > button')).toBe(button);
    expect(host.querySelector('.conversation-trace-steps')?.getAttribute('data-grouped')).toBe(
      'true',
    );
    const done: Message = {
      ...tool,
      status: 'completed',
      settled: true,
      shell: { operation: 'execute', jobStatus: 'succeeded' },
    };
    await act(async () => draw([done]));
    expect(host.querySelector('[data-thought-body]')).toBe(body);
    const summary = host.querySelector<HTMLButtonElement>('.conversation-trace > button')!;
    expect(summary.textContent).toBe('已运行');
    const second: Message = {
      ...thinking('run'),
      id: 'second-thought',
      reasoningSource: 'second-source',
    };
    await act(async () => draw([done, second]));
    expect(summary.textContent).toBe('思考中');
    expect(host.querySelectorAll('.conversation-reasoning')).toHaveLength(2);
    const secondButton = host.querySelectorAll<HTMLButtonElement>(
      '.conversation-reasoning > button',
    )[1]!;
    expect(secondButton.getAttribute('aria-expanded')).toBe('false');
    await act(async () => secondButton.click());
    expect(secondButton.getAttribute('aria-expanded')).toBe('true');
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => summary.click());
    await act(async () => summary.click());
    expect(
      host.querySelector('.conversation-reasoning > button')?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(
      host.querySelectorAll('.conversation-reasoning > button')[1]?.getAttribute('aria-expanded'),
    ).toBe('true');

    // A refreshed message ID must keep the original model presentation identity.
    thought = { ...thought, id: 'saved-thought' };
    executionUnconfirmed = true;
    await act(async () => draw([done, second]));
    expect(summary.textContent).toBe('已运行');
    expect(
      host.querySelector('.conversation-reasoning > button')?.getAttribute('aria-expanded'),
    ).toBe('false');
    executionUnconfirmed = false;
    const finishedSecond = { ...second, settled: true };
    await act(async () => draw([done, finishedSecond]));
    expect(summary.textContent).toBe('已运行');
    status = 'completed';
    await act(async () => draw([done, finishedSecond]));
    const completed = host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    expect(completed.textContent).toBe('用时未知');
    expect(completed.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.conversation-trace > button')?.textContent).toBe('运行了命令');
    const reasoningButtons = host.querySelectorAll('.conversation-reasoning > button');
    expect([...reasoningButtons].map((item) => item.textContent)).toEqual(['已思考', '已思考']);
    expect([...reasoningButtons].map((item) => item.getAttribute('aria-expanded'))).toEqual([
      'false',
      'true',
    ]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
  expect(reading.at(-1)?.expanded['stable-thought']).toBe(false);
});

test('running trace reports progress before the first model body arrives', () => {
  for (const [status, label] of [
    ['creating_session', '正在创建会话…'],
    ['preparing', '正在准备回复…'],
    ['running', '进行中'],
  ] as const) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[]}
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{ turnId: 'run', status }}
        />,
      ),
    );
    expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe(label);
    dom.window.close();
  }
  for (const unavailable of [true, false]) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[]}
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{
            turnId: 'run',
            status: 'running',
            unavailable,
            executionUnconfirmed: !unavailable,
          }}
        />,
      ),
    );
    expect(dom.window.document.querySelector('[role="status"]')).toBeNull();
    dom.window.close();
  }
});

test('temporary read failure retains the permitted Run timer and an ownership loss hides it', () => {
  const timing: Message = {
    id: 'timing',
    turnId: 'run',
    role: 'system',
    systemKind: 'turn_timing',
    text: '',
    turnStartedAtMs: Date.now() + 60_000,
    settled: false,
  };
  for (const executionUnconfirmed of [false, true]) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[timing]}
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{
            turnId: 'run',
            status: 'running',
            unavailable: true,
            executionUnconfirmed,
          }}
        />,
      ),
    );
    expect(dom.window.document.querySelector('.agent-turn-running')?.textContent).toBe(
      executionUnconfirmed ? undefined : '进行中 1 秒',
    );
    dom.window.close();
  }
});

test('first reply preparation respects execution observation and real waiting states', () => {
  for (const [status, expected] of [
    ['preparing', '正在准备回复…'],
    ['queued', '等待处理'],
    ['waiting', '正在等待'],
    ['recovery_required', '需要恢复'],
    ['cancelling', '正在停止'],
    ['cancelled', '你已停止'],
    ['completed', undefined],
  ] as const) {
    for (const responsePhase of [undefined, 'preparing'] as const) {
      const dom = new JSDOM(
        renderToStaticMarkup(
          <Conversation
            traceTurns
            messages={[]}
            selected
            connected
            loading={false}
            saveReading={() => {}}
            turnActivity={{ turnId: 'first-submission', status, responsePhase }}
          />,
        ),
      );
      expect(dom.window.document.querySelector('.conversation-turn-notice')?.textContent).toBe(
        expected,
      );
      expect(dom.window.document.querySelector('.response-status')).toBeNull();
      expect(dom.window.document.querySelector('.agent-turn-running')).toBeNull();
      dom.window.close();
    }
  }
  for (const status of ['preparing', 'running'] as const) {
    for (const unavailable of [false, true]) {
      const dom = new JSDOM(
        renderToStaticMarkup(
          <Conversation
            traceTurns
            messages={[]}
            selected
            connected
            loading={false}
            saveReading={() => {}}
            turnActivity={{
              turnId: 'first-submission',
              status,
              responsePhase: 'preparing',
              unavailable,
              executionUnconfirmed: !unavailable,
            }}
          />,
        ),
      );
      expect(dom.window.document.querySelector('.conversation-turn-notice')).toBeNull();
      expect(dom.window.document.querySelector('.response-status')).toBeNull();
      dom.window.close();
    }
  }
});

test('a connection notice separates a tool result from later reasoning', () => {
  const tool: Message = {
    id: 'shell',
    turnId: 'run',
    role: 'tool',
    toolName: 'shell_execute',
    shell: { operation: 'execute', jobStatus: 'succeeded' },
    text: '',
    settled: true,
    status: 'completed',
  };
  const messages: Message[] = [
    tool,
    {
      id: 'reconnect',
      turnId: 'run',
      role: 'system',
      systemKind: 'model_connection',
      text: '',
      status: 'running',
      settled: false,
    },
    { ...thinking('run'), id: 'next-thought' },
  ];
  for (const executionUnconfirmed of [false, true]) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={messages}
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{ turnId: 'run', status: 'running', executionUnconfirmed }}
        />,
      ),
    );
    const titles = traceHeadings(dom.window.document).map((node) => node.textContent);
    expect(titles).toEqual(['运行了命令', executionUnconfirmed ? '处理过程' : '思考中']);
    expect(dom.window.document.querySelectorAll('.model-connection')).toHaveLength(1);
    dom.window.close();
  }
});

test('Model and Tool handoff markers have no activity row of their own', () => {
  for (const tracePending of ['reasoning', 'tool'] as const) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[{ ...thinking('run'), text: '', tracePending }]}
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{ turnId: 'run', status: 'running' }}
        />,
      ),
    );
    expect(dom.window.document.querySelector('.conversation-trace')).toBeNull();
    expect(dom.window.document.querySelector('.agent-turn-running')?.textContent).toBe('进行中');
    dom.window.close();
  }
});

test('streaming native reasoning uses its source even when the body is loaded separately', () => {
  for (const [settled, executionUnconfirmed, expected] of [
    [false, false, '思考中'],
    [true, false, '处理过程'],
    [false, true, '处理过程'],
  ] as const) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[
            { ...thinking('run'), text: '', reasoningSource: 'native-model-message', settled },
          ]}
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{ turnId: 'run', status: 'running', executionUnconfirmed }}
          renderReasoning={() => <span>Model reasoning loaded from its output source</span>}
        />,
      ),
    );
    expect(traceHeadings(dom.window.document).map((line) => line.textContent)).toEqual([expected]);
    dom.window.close();
  }
  let readerCalls = 0;
  const missing = new JSDOM(
    renderToStaticMarkup(
      <Conversation
        traceTurns
        messages={[{ ...thinking('run'), settled: true }]}
        loading={false}
        selected
        connected
        turnActivity={{ turnId: 'run', status: 'running' }}
        renderReasoning={() => {
          readerCalls++;
          return <p>Unavailable detail</p>;
        }}
        saveReading={() => {}}
      />,
    ),
  );
  const trace = missing.window.document.querySelector('.conversation-trace')!;
  expect(traceHeadings(missing.window.document).map((line) => line.textContent)).toEqual([
    '处理过程',
  ]);
  expect(trace.querySelectorAll('button, [aria-expanded]')).toHaveLength(0);
  expect(trace.textContent).not.toContain('PRIVATE REASONING');
  expect(readerCalls).toBe(0);
  missing.window.close();
});

test('exact pending answers and approvals outrank parallel activity and withdraw with lost observation', () => {
  const thought: Message = {
    ...thinking('run'),
    reasoningActive: true,
    reasoningSource: 'original-thinking',
  };
  const tool: Message = {
    id: 'active',
    turnId: 'run',
    role: 'tool',
    text: '',
    toolName: 'read_file',
    status: 'running',
    settled: false,
  };
  const question: Message = {
    ...tool,
    id: 'question',
    toolName: 'ask_user',
    questionState: 'pending',
  };
  const approval: Message = {
    ...tool,
    id: 'approval',
    status: 'queued',
    toolName: 'write_file',
    dispatchCommitted: false,
    approval: { state: 'awaiting_user', source: 'user' },
  };
  for (const [steps, unconfirmed, expected] of [
    [[tool, thought], false, '读取'],
    [[thought], false, '思考中'],
    [[tool, thought, question], false, '等待回答'],
    [[tool, thought, approval], false, '等待审批'],
    [[tool, thought, question, approval], false, '等待回答 · 等待审批'],
    [[tool, { ...question, questionState: 'submitted' }, approval], false, '等待审批'],
    [[tool, { ...question, questionState: 'submitted' }], false, '已提交，待确认'],
    [[tool, thought, question, approval], true, '写入'],
    [[tool, { ...approval, approval: { state: 'checking', source: 'auto' } }], false, '读取'],
    [[{ ...approval, toolName: 'edit_file' }], false, '等待审批'],
    [[{ ...approval, toolName: 'read_file' }], false, '等待审批'],
  ] as const) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          selected
          connected
          loading={false}
          messages={[...steps]}
          turnActivity={{ turnId: 'run', status: 'running', executionUnconfirmed: unconfirmed }}
          saveReading={() => {}}
          initialReading={{ top: 0, follow: false, expanded: { 'trace-turn:turn:run': true } }}
        />,
      ),
    );
    const title = traceHeadings(dom.window.document)[0];
    expect(title?.textContent).toBe(expected);
    if (expected.startsWith('等待') || unconfirmed)
      expect(title?.getAttribute('data-status')).not.toBe('running');
    const row = dom.window.document.querySelector(
      '.conversation-reasoning [data-slot="trace-title"]',
    );
    if (steps.some((step) => step.id === thought.id))
      expect(row?.textContent).toBe(unconfirmed ? '思考' : '思考中');
    dom.window.close();
  }
});

test('Agent work creation and plan review are independent while other Agent actions remain in Trace details', () => {
  const tool = (toolName: string, title: string): Message => ({
    id: toolName,
    turnId: 'run',
    role: 'tool',
    toolName,
    title,
    text: '原结果',
    status: 'completed',
    settled: true,
  });
  const dom = new JSDOM(
    renderToStaticMarkup(
      <Conversation
        traceTurns
        selected
        connected
        loading={false}
        messages={[
          tool('spawn_agent', '创建子 Agent'),
          tool('send_agent_message', '发送 Agent 消息'),
          tool('wait_agent_events', '等待 Agent 事件'),
          tool('read_file', '读取'),
          tool('planning.review', '请求计划审阅'),
          tool('planning.update', '更新计划进度'),
        ]}
        initialReading={{
          top: 0,
          follow: false,
          expanded: { 'turn:run:complete': true, 'trace-after:spawn_agent': true },
        }}
        turnActivity={{ turnId: 'run', status: 'completed' }}
        saveReading={() => {}}
      />,
    ),
  );
  const document = dom.window.document;
  const trace = document.querySelectorAll('.conversation-trace');
  expect(trace).toHaveLength(2);
  expect(trace[0]?.querySelector(':scope > button')?.textContent).toBe('读取了文件');
  expect(trace[0]?.textContent).toContain('发送 Agent 消息');
  expect(trace[0]?.textContent).toContain('等待 Agent 事件');
  for (const name of ['创建子 Agent', '请求计划审阅']) {
    const row = [...document.querySelectorAll('.tool-activity-title')].find(
      (node) => node.textContent === name,
    );
    expect(row).toBeDefined();
    expect(row?.closest('.conversation-trace')).toBeNull();
  }
  dom.window.close();
});

test('cold and completed traces restore explicit reasoning choices without reclassifying real prose', () => {
  for (const status of ['running', 'completed'] as const) {
    for (const reasoningOpen of [undefined, true, false]) {
      const thought: Message = {
        ...thinking('run'),
        presentationKey: 'reasoning-model',
        settled: status === 'completed',
        reasoningSource: 'model-output',
      };
      const prose: Message = {
        id: 'actual-prose',
        turnId: 'run',
        role: 'assistant',
        text: 'I need to make sure that the output filename is set correctly.',
        settled: status === 'completed',
        finalReply: status === 'completed',
      };
      const dom = new JSDOM(
        renderToStaticMarkup(
          <Conversation
            traceTurns
            selected
            connected
            loading={false}
            messages={[user('first'), thought, prose]}
            turnActivity={{ turnId: 'run', status }}
            saveReading={() => {}}
            initialReading={{
              top: 42,
              follow: false,
              expanded: {
                'turn:run:complete': true,
                'trace-turn:turn:run': true,
                ...(reasoningOpen === undefined ? {} : { 'reasoning-model': reasoningOpen }),
              },
            }}
            renderMessage={(message) => <p data-original-message={message.id}>{message.text}</p>}
            renderReasoning={() => <p data-public-reasoning>Reasoning from model output only</p>}
          />,
        ),
      );
      const document = dom.window.document;
      const expectedOpen = reasoningOpen !== false;
      const reasoning = document.querySelector('.conversation-reasoning')!;
      const trigger = reasoning.querySelector('button')!;
      expect(trigger.getAttribute('aria-expanded')).toBe(String(expectedOpen));
      expect(reasoning.querySelector('[data-public-reasoning]') !== null).toBe(expectedOpen);
      expect(reasoning.querySelector('[data-original-message]')).toBeNull();
      const actual = document.querySelector('[data-original-message="actual-prose"]')!;
      expect(actual.textContent).toBe(prose.text);
      expect(actual.closest('.conversation-reasoning')).toBeNull();
      expect(document.querySelectorAll('[data-original-message="actual-prose"]')).toHaveLength(1);
      expect(document.body.textContent).not.toContain('PRIVATE REASONING');
      dom.window.close();
    }
  }
});

test('single MCP and Skill traces keep their tool title until the trace ends', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const originals = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  try {
    for (const [category, title, target, expected] of [
      ['mcp', 'MCP · qa-names-7e · add', undefined, '调用了 MCP 工具'],
      ['skill', '加载技能', 'private-skill-name', '加载了技能'],
    ] as const) {
      const tool: Message = {
        id: category,
        turnId: 'run',
        role: 'tool',
        text: 'Original result',
        toolName: category === 'skill' ? 'load_skill' : undefined,
        toolSummaryCategory: category,
        title,
        target,
        status: 'running',
        settled: false,
      };
      const draw = (
        status: NonNullable<Message['status']>,
        turnStatus: 'running' | 'completed',
        cold = false,
      ) =>
        root.render(
          <Conversation
            key={`${category}:${cold}`}
            traceTurns
            selected
            connected
            loading={false}
            messages={[{ ...tool, status, settled: status !== 'running' }]}
            turnActivity={{ turnId: 'run', status: turnStatus }}
            saveReading={() => {}}
            initialReading={{ top: 0, follow: false, expanded: { 'turn:run:complete': true } }}
          />,
        );
      const heading = () => host.querySelector<HTMLElement>('.tool-activity [data-trace-line]')!;
      const expectDirect = (summary = false) => {
        const trace = host.querySelector('.conversation-trace')!;
        expect(trace.querySelectorAll(':scope > .conversation-trace-trigger')).toHaveLength(0);
        expect(trace.querySelectorAll('[data-trace-line]')).toHaveLength(1);
        if (summary) expect(heading().textContent).toBe(expected);
        else {
          expect(heading().textContent).toContain(title);
          if (target) expect(heading().textContent).toContain(target);
        }
      };
      await act(async () => draw('running', 'running'));
      expectDirect();
      const originalHeading = heading();
      await act(async () => heading().click());
      expect(heading().getAttribute('aria-expanded')).toBe('true');
      await act(async () => draw('completed', 'running'));
      expect(heading() === originalHeading).toBe(true);
      expectDirect();
      expect(heading().getAttribute('data-status')).not.toBe('running');
      expect(host.querySelector('.tool-activity-content')?.textContent).toContain(
        'Original result',
      );
      await act(async () => heading().click());
      await act(async () => draw('completed', 'completed'));
      const turn = host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
      if (turn.getAttribute('aria-expanded') === 'false') await act(async () => turn.click());
      expectDirect(true);
      expect(heading().getAttribute('aria-expanded')).toBe('false');
      await act(async () => heading().click());
      expect(heading().getAttribute('aria-expanded')).toBe('true');
      expect(host.querySelector('.tool-activity-content')?.textContent).toContain(
        'Original result',
      );
      expect(host.querySelector('.tool-activity-content')?.textContent).toContain(title);
      await act(async () => draw('completed', 'completed', true));
      expectDirect(true);
      expect(heading().getAttribute('aria-expanded')).toBe('false');
      await act(async () => heading().click());
      expect(host.querySelector('.tool-activity-content')?.textContent).toContain(
        'Original result',
      );
      for (const status of ['failed', 'cancelled', 'unknown', 'not_executed', 'queued'] as const) {
        await act(async () => draw(status, 'completed', true));
        expect(host.querySelector('.conversation-trace > button')?.textContent).toBe('工具执行');
      }
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('separate completed traces keep category order, ordinary summaries and original expanded tool identities', () => {
  const tool = (id: string, category?: 'mcp' | 'skill'): Message => ({
    id,
    turnId: 'run',
    role: 'tool',
    text: '',
    settled: true,
    status: 'completed',
    toolSummaryCategory: category,
    title: category === 'mcp' ? `MCP · provider · ${id}` : '加载技能',
  });
  const boundary: Message = {
    id: 'boundary',
    turnId: 'run',
    role: 'assistant',
    text: 'Between traces',
    settled: true,
  };
  const dom = new JSDOM(
    renderToStaticMarkup(
      <Conversation
        traceTurns
        selected
        connected
        loading={false}
        saveReading={() => {}}
        turnActivity={{ turnId: 'run', status: 'completed' }}
        initialReading={{
          top: 0,
          follow: false,
          expanded: {
            'turn:run:complete': true,
            'trace-turn:turn:run': true,
            'trace-after:boundary': true,
          },
        }}
        messages={[
          { ...thinking('run'), settled: true },
          tool('sources', 'mcp'),
          tool('connect', 'mcp'),
          tool('remote', 'mcp'),
          { ...tool('read'), title: '读取', toolName: 'read_file' },
          boundary,
          { ...thinking('run'), id: 'second-thought', settled: true },
          tool('skill-one', 'skill'),
          tool('skill-two', 'skill'),
          tool('second-remote', 'mcp'),
        ]}
      />,
    ),
  );
  const summaries = [...dom.window.document.querySelectorAll('.conversation-trace > button')];
  expect(summaries.map((node) => node.textContent)).toEqual([
    '调用了 MCP 工具读取了文件',
    '加载了技能调用了 MCP 工具',
  ]);
  expect(summaries.every((node) => !node.textContent?.includes('provider'))).toBe(true);
  const details = dom.window.document.querySelectorAll('.conversation-trace-steps');
  expect(details[0]?.textContent).toContain('MCP · provider · sources');
  expect(details[1]?.textContent).toContain('MCP · provider · second-remote');
  expect(dom.window.document.body.textContent).not.toContain('PRIVATE REASONING');
  dom.window.close();
});

test('completed Trace summaries preserve original single-step disclosure and detail data', () => {
  const completed = (id: string, toolName?: string, extra: Partial<Message> = {}): Message => ({
    id,
    turnId: 'run',
    role: 'tool',
    text: 'Original result',
    status: 'completed',
    settled: true,
    toolName,
    ...extra,
  });
  const renderSummary = (messages: Message[], open = false) =>
    new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          selected
          connected
          loading={false}
          messages={messages}
          saveReading={() => {}}
          turnActivity={{ turnId: 'run', status: 'completed' }}
          initialReading={{
            top: 0,
            follow: false,
            expanded: {
              'turn:run:complete': true,
              'trace-turn:turn:run': open,
              ...Object.fromEntries(messages.map((message) => [`activity:${message.id}`, open])),
            },
          }}
        />,
      ),
    );
  for (const [message, label] of [
    [completed('read', 'read_file', { target: '已完成.txt' }), '读取了文件'],
    [completed('write', 'write_file', { target: '已完成.txt' }), '写入了文件'],
    [completed('create', 'write_file', { fileCreated: true, target: '已完成.txt' }), '创建了文件'],
    [completed('images', 'view_images', { toolImageCount: 2 }), '查看了图片'],
    [
      completed('shell', 'shell_execute', {
        shell: { operation: 'execute', jobStatus: 'succeeded', command: 'echo 已完成' },
        target: '报告完成情况',
      }),
      '运行了命令',
    ],
    [
      completed('edit', 'edit_file', {
        title: '修改',
        target: '已完成.txt',
        changeConfirmed: true,
        toolResult: { ok: true, stdout: '+new' },
      }),
      '编辑了文件',
    ],
  ] as const) {
    for (const open of [false, true]) {
      const dom = renderSummary([message], open);
      const trace = dom.window.document.querySelector('.conversation-trace')!;
      expect(trace.querySelectorAll(':scope > .conversation-trace-trigger')).toHaveLength(0);
      expect(trace.querySelectorAll('[data-trace-line]')).toHaveLength(1);
      expect(trace.querySelector('.tool-label')?.textContent).toBe(label);
      if (message.id === 'shell') {
        expect(trace.querySelector('.tool-command')?.textContent).toBe('echo 已完成');
        expect(trace.querySelector('.tool-detail-status')).toBeNull();
        expect(trace.textContent).not.toContain(message.target!);
      } else if (message.target && (open || message.id !== 'edit'))
        expect(trace.textContent).toContain(message.target);
      if (message.id === 'edit' && open) expect(trace.textContent).toContain('+new');
      expect(trace.querySelectorAll('.conversation-trace-steps[data-grouped]')).toHaveLength(0);
      dom.window.close();
    }
  }
  const noDiffEdit = renderSummary([
    completed('edit', 'edit_file', { title: '修改', target: 'original-no-diff.ts' }),
  ]);
  expect(noDiffEdit.window.document.querySelector('.conversation-trace')?.textContent).toContain(
    'original-no-diff.ts',
  );
  expect(noDiffEdit.window.document.querySelector('.tool-diff-toggle')).toBeNull();
  noDiffEdit.window.close();
  for (const toolName of [
    undefined,
    'browser_execute',
    'git.worktree',
    'planning.write',
    'send_agent_message',
    'wait_agent_events',
    'tool_search',
    'mcp.tools.search',
    'mcp.resources.read',
  ]) {
    const dom = renderSummary([completed('omitted', toolName, { title: '原工具标题' })]);
    expect(dom.window.document.querySelector('.conversation-trace')?.textContent).toBe('工具执行');
    dom.window.close();
  }
  const wait = renderSummary(
    [completed('wait', 'wait_agent_events', { title: '等待 Agent 事件', agentWait: true })],
    true,
  );
  expect(
    wait.window.document.querySelector('.conversation-trace-steps .tool-label')?.textContent,
  ).toBe('等待 Agent 事件');
  expect(
    wait.window.document.querySelector('.conversation-trace-steps .tool-detail')?.textContent,
  ).toBe('Original result');
  wait.window.close();
  for (const message of [
    completed('resource', 'read_skill_resource', {
      title: '读取技能资料',
      target: 'private-skill · reference.md',
      text: 'ORIGINAL RESOURCE BODY',
    }),
    completed('question', 'ask_user', {
      title: '询问用户',
      ask: {
        questions: [{ id: 'q', question: 'ORIGINAL QUESTION' }],
        answers: { q: 'ORIGINAL ANSWER' },
      },
    }),
  ]) {
    const dom = renderSummary([message], true);
    const trace = dom.window.document.querySelector('.conversation-trace');
    if (message.toolName === 'read_skill_resource') {
      expect(trace?.querySelector(':scope > button')?.textContent).toBe('工具执行');
      expect(trace?.querySelector('.conversation-trace-steps')?.textContent).toContain(
        message.target!,
      );
      expect(trace?.textContent).toContain('ORIGINAL RESOURCE BODY');
    } else {
      expect(trace?.querySelector(':scope > button')).toBeNull();
      expect(trace?.querySelector('.tool-label')?.textContent).toBe('询问了用户');
      expect(trace?.querySelector('.tool-activity-content')?.textContent).toContain(
        'ORIGINAL QUESTION',
      );
      expect(trace?.textContent).toContain('ORIGINAL ANSWER');
    }
    dom.window.close();
  }
  for (const operation of ['execute', 'read'] as const) {
    const message = completed('shell-identity', `shell.${operation}`, {
      target: operation === 'read' ? 'original-shell-id' : 'original-command-description',
      shell: { operation, jobStatus: 'succeeded', command: 'printf original-command' },
    });
    const dom = renderSummary([message], true);
    const trace = dom.window.document.querySelector('.conversation-trace')!;
    if (operation === 'execute') {
      expect(trace.querySelector(':scope > button')).toBeNull();
      expect(trace.querySelector('.tool-label')?.textContent).toBe('运行了命令');
      expect(trace.querySelector('.tool-command')?.textContent).toBe('printf original-command');
      expect(trace.textContent).not.toContain(message.target!);
    } else {
      expect(trace.querySelector(':scope > button')?.textContent).toBe('工具执行');
      expect(trace.querySelector('.conversation-trace-steps')?.textContent).toContain(
        'original-shell-id',
      );
    }
    expect(trace.querySelector('.tool-activity-content')?.textContent).toContain(
      'printf original-command',
    );
    dom.window.close();
  }
  const edits = renderSummary([completed('one', 'edit_file'), completed('two', 'edit_file')]);
  expect(edits.window.document.querySelector('.conversation-trace > button')?.textContent).toBe(
    '编辑了文件',
  );
  edits.window.close();
  const mixed = renderSummary(
    [
      { ...thinking('run'), settled: true },
      completed('edit', 'edit_file', { title: '修改', changeConfirmed: true }),
      completed('read', 'read_file'),
      completed('images', 'view_images', { toolImageCount: 2 }),
    ],
    true,
  );
  expect(mixed.window.document.querySelector('.conversation-trace > button')?.textContent).toBe(
    '编辑了文件读取了文件查看了图片',
  );
  const details = mixed.window.document.querySelector('.conversation-trace-steps');
  expect(details?.textContent).toContain('已编辑');
  expect(details?.textContent).toContain('已查看 2 张图像');
  mixed.window.close();
  for (const status of ['failed', 'cancelled', 'unknown', 'not_executed'] as const) {
    const dom = renderSummary([
      { ...thinking('run'), settled: true },
      completed('unknown', undefined, { status, title: 'Original tool' }),
    ]);
    expect(dom.window.document.querySelector('.conversation-trace > button')?.textContent).toBe(
      '工具执行',
    );
    dom.window.close();
  }
});
