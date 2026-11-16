import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BookOpen01Icon, BulbIcon, TerminalIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/desktop/Conversation';
import { MessageContent } from '../src/desktop/MessageContent';
import type { Message } from '../src/desktop/types';

const user = (id: string): Message => ({ id, role: 'user', text: id, settled: true });
const thinking = (turnId: string): Message => ({
  id: `thinking:${turnId}`,
  turnId,
  role: 'thinking',
  text: 'PRIVATE REASONING',
  settled: false,
});
const terminal = (turnId: string, status: 'completed' | 'cancelled' | 'aborted'): Message => ({
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
        tool('shell', 'shell_execute'),
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
  const summaries = [...document.querySelectorAll('.conversation-trace-trigger')];
  expect(summaries).toHaveLength(2);
  expect(summaries.every((node) => !node.textContent?.includes('创建子 Agent'))).toBe(true);
});

test('a single Agent wait shows one tool heading and opens directly to its result', () => {
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

  expectIcon(renderTrace([thought]).querySelector(summary)!, BulbIcon);
  const completedThought = renderTrace([complete(thought)]).querySelector(summary)!;
  expect(completedThought.textContent).toBe('已思考');
  expectIcon(completedThought, BulbIcon);
  expectIcon(renderTrace([complete(read)]).querySelector(summary)!, BookOpen01Icon);
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
  const pending = renderTrace([{ ...thought, tracePending: 'tool' }]).querySelector(summary)!;
  expectIcon(pending, Wrench01Icon);

  const css = readFileSync(new URL('../src/desktop/style.css', import.meta.url), 'utf8');
  const guideSelector = css.match(/([^{}]+)\{\s*--trace-guide-width:/)?.[1];
  expect(guideSelector).toBeDefined();
  const guides = (document: Document) => {
    document.body.classList.add('kite-client');
    return document.querySelectorAll(guideSelector!.replaceAll('::before', ''));
  };
  expect(guides(renderTrace([complete(thought)]))).toHaveLength(0);
  expect(guides(renderTrace([complete(thought)], true))).toHaveLength(2);
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
  expect(document.querySelectorAll('.response-status')).toHaveLength(1);
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

test('an active trace never falls back to completed statistics between model and tool events', () => {
  const done: Message = {
    id: 'read',
    turnId: 'run',
    role: 'tool',
    toolName: 'read_file',
    text: '',
    status: 'completed',
    settled: true,
  };
  for (const status of ['running', 'waiting', 'completed'] as const) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <Conversation
          traceTurns
          messages={[done]}
          selected
          connected
          loading={false}
          saveReading={() => {}}
          turnActivity={{ turnId: 'run', status }}
          initialReading={{ top: 0, follow: false, expanded: { 'turn:run:complete': true } }}
        />,
      ),
    );
    const title = dom.window.document.querySelector('.conversation-trace > button')!.textContent;
    expect(title).toBe(
      status === 'running' ? '正在回复…' : status === 'waiting' ? '正在等待' : '已读取',
    );
    dom.window.close();
  }
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
  };
  let status: 'running' | 'completed' = 'running';
  let executionUnconfirmed = false;
  let bodyText = 'Existing reasoning';
  const reading: import('../src/desktop/Conversation').ReadingState[] = [];
  const draw = (tools: Message[]) =>
    root.render(
      <Conversation
        traceTurns
        messages={[thought, ...tools]}
        selected
        connected
        loading={false}
        saveReading={(value) => reading.push(value)}
        turnActivity={{ turnId: 'run', status, executionUnconfirmed }}
        initialReading={{ top: 0, follow: false, expanded: { 'trace-turn:turn:run': true } }}
        renderReasoning={(message, open) => (
          <p data-thought-body={message.reasoningSource} data-reader-active={open}>
            {bodyText}
          </p>
        )}
      />,
    );
  try {
    await act(async () => draw([]));
    const body = host.querySelector('[data-thought-body]');
    expect(body).not.toBeNull();
    const reasoning = host.querySelector('.conversation-reasoning')!;
    const button = reasoning.querySelector('button')!;
    const panel = reasoning.querySelector('.conversation-reasoning-body')!;
    const group = host.querySelector('.conversation-trace-steps')!;
    expect(button.textContent).toBe('思考');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.contains(body)).toBe(true);
    expect(group.getAttribute('data-grouped')).toBe('true');
    expect(reasoning.hasAttribute('data-direct-reasoning')).toBe(false);
    expect(host.querySelectorAll('.message.assistant')).toHaveLength(0);
    bodyText += ' streamed';
    await act(async () => draw([]));
    expect(host.querySelector('[data-thought-body]')).toBe(body);
    expect(body!.textContent).toBe('Existing reasoning streamed');
    thought = { ...thought, settled: true };
    const tool: Message = {
      id: 'shell',
      turnId: 'run',
      role: 'tool',
      toolName: 'shell_execute',
      text: '',
      settled: false,
      status: 'running',
    };
    await act(async () => draw([tool]));
    expect(host.querySelector('[data-thought-body]')).toBe(body);
    expect(host.querySelector('.conversation-reasoning')!.getAttribute('data-state')).toBe('open');
    expect(
      host.querySelector('.conversation-reasoning .conversation-trace-line')?.textContent,
    ).toBe('已思考');
    expect(host.querySelector('.conversation-reasoning')).toBe(reasoning);
    expect(host.querySelector('.conversation-reasoning > button')).toBe(button);
    expect(group.getAttribute('data-grouped')).toBe('true');
    const done = { ...tool, status: 'completed', settled: true } as const;
    await act(async () => draw([done]));
    expect(host.querySelector('[data-thought-body]')).toBe(body);
    const summary = host.querySelector<HTMLButtonElement>('.conversation-trace > button')!;
    expect(summary.textContent).toBe('正在回复…');
    const second: Message = {
      ...thinking('run'),
      id: 'second-thought',
      reasoningSource: 'second-source',
    };
    await act(async () => draw([done, second]));
    expect(summary.textContent).toBe('正在思考…');
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
    expect(summary.textContent).toBe('执行状态待确认');
    expect(
      host.querySelector('.conversation-reasoning > button')?.getAttribute('aria-expanded'),
    ).toBe('false');
    executionUnconfirmed = false;
    const finishedSecond = { ...second, settled: true };
    await act(async () => draw([done, finishedSecond]));
    expect(summary.textContent).toBe('正在回复…');
    status = 'completed';
    await act(async () => draw([done, finishedSecond]));
    const completed = host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    expect(completed.textContent).toBe('用时未知');
    expect(completed.getAttribute('aria-expanded')).toBe('false');
    await act(async () => completed.click());
    expect(host.querySelector('.conversation-trace > button')?.textContent).not.toMatch(/正在/);
    const reasoningButtons = host.querySelectorAll('.conversation-reasoning > button');
    expect([...reasoningButtons].map((item) => item.textContent)).toEqual(['已思考', '已思考']);
    expect([...reasoningButtons].map((item) => item.getAttribute('aria-expanded'))).toEqual([
      'false',
      'true',
    ]);
  } finally {
    await act(async () => root.unmount());
    expect(reading.at(-1)?.expanded['stable-thought']).toBe(false);
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('running trace reports progress before the first model body arrives', () => {
  for (const [phase, expected] of [
    [undefined, '正在回复…'],
    ['preparing', '正在准备回复…'],
    ['thinking', '正在回复…'],
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
          turnActivity={{ turnId: 'run', status: 'running', responsePhase: phase }}
        />,
      ),
    );
    expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe(expected);
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

test('connection notices and subsequent reasoning do not finalize an unfinished trace', () => {
  const tool: Message = {
    id: 'shell',
    turnId: 'run',
    role: 'tool',
    toolName: 'shell_execute',
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
    const titles = [...dom.window.document.querySelectorAll('.conversation-trace > button')].map(
      (node) => node.textContent,
    );
    expect(titles.length).toBeGreaterThan(0);
    expect(
      titles.every((title) => title === (executionUnconfirmed ? '执行状态待确认' : '正在思考…')),
    ).toBe(true);
    dom.window.close();
  }
});

test('an empty reasoning placeholder cannot claim visible thinking', () => {
  const html = renderToStaticMarkup(
    <Conversation
      traceTurns
      messages={[{ ...thinking('run'), text: '' }]}
      selected
      connected
      loading={false}
      saveReading={() => {}}
      turnActivity={{ turnId: 'run', status: 'running', responsePhase: 'thinking' }}
    />,
  );
  expect(html).not.toContain('正在思考');
  expect(html).toContain('正在回复');
});

test('streaming native reasoning uses its source even when the body is loaded separately', () => {
  for (const [settled, executionUnconfirmed, expected] of [
    [false, false, '正在思考…'],
    [true, false, '正在回复…'],
    [false, true, '执行状态待确认'],
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
    expect(dom.window.document.querySelector('.conversation-trace > button')?.textContent).toBe(
      expected,
    );
    dom.window.close();
  }
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
