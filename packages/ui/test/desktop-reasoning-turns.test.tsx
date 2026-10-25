import { expect, test } from 'bun:test';
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

test('reasoning-only terminal turns retain their status between the original user messages', () => {
  for (const [status, label] of [
    ['completed', '已完成'],
    ['cancelled', '已停止'],
    ['aborted', '已中断'],
  ] as const) {
    const { document, html } = render([
      user('first'),
      thinking('run'),
      terminal('run', status),
      user('second'),
    ]);
    const turn = document.querySelector('.agent-turn');
    expect(turn?.getAttribute('data-turn-status')).toBe(status);
    expect(turn?.textContent).toContain(label);
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

test('hidden reasoning does not split adjacent exploration calls and failure receipts remain visible', () => {
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
  expect(new JSDOM(html).window.document.querySelector('.agent-turn button')).not.toBeNull();
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
  expect(failed.html).toContain('Actual failure');
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
        initialReading={restored ? { top: 42, follow: false, expanded: {} } : undefined}
        saveReading={() => {}}
      />,
    );
    const dom = new JSDOM(html);
    try {
      expect(
        dom.window.document.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded'),
      ).toBe('true');
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

test('two interleaved steers stay in one process from local sending through persistence, completion and cold expansion with exact copy bodies', async () => {
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
    const process = host.querySelector('.agent-turn-process-messages')!;
    expect(process.querySelectorAll('.message.assistant .message-meta')).toHaveLength(0);
    expect(host.querySelector('[data-message-id="first"] .message-meta')).not.toBeNull();
    expect(steers[1]!.querySelector('.message-meta')).not.toBeNull();
    if (finished) expect(host.querySelector('.agent-turn-final .message-meta')).not.toBeNull();
    const expected = ['模型前段', '引导一完整正文', '工具A', '模型中段', '引导二完整正文', '工具B'];
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
