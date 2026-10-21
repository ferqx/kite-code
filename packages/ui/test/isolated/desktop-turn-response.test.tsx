import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../../src/desktop/Conversation';
import type { Message, TurnActivity } from '../../src/desktop/types';

const activeStatuses = ['queued', 'running', 'waiting', 'cancelling', 'recovery_required'] as const;
const assistant = (id: string, settled = false): Message => ({
  id,
  turnId: 'run',
  role: 'assistant',
  text: `${id} content`,
  settled,
});
const tool: Message = {
  id: 'tool',
  turnId: 'run',
  role: 'tool',
  text: 'read complete',
  settled: true,
  toolName: 'read_file',
  status: 'completed',
};
const terminal = (status: NonNullable<Message['turnTerminalStatus']>): Message => ({
  id: 'terminal',
  turnId: 'run',
  role: 'system',
  text: '',
  settled: true,
  systemKind: 'turn_terminal',
  turnTerminalStatus: status,
});
const user: Message = { id: 'user', role: 'user', text: 'original input', settled: true };
const props = { loading: false, selected: true, connected: true, saveReading: () => {} };

function inspect(
  messages: Message[],
  turnActivity: TurnActivity | undefined,
  run: (document: Document) => void,
) {
  const dom = new JSDOM(
    renderToStaticMarkup(
      <Conversation {...props} messages={messages} turnActivity={turnActivity} />,
    ),
  );
  try {
    run(dom.window.document);
  } finally {
    dom.window.close();
  }
}

function expectBottomResponse(document: Document, label = '正在回复…') {
  const responses = document.querySelectorAll('.response-status');
  expect(responses).toHaveLength(1);
  const response = responses[0]!;
  expect(response.textContent).toBe(label);
  const turn = response.closest('.agent-turn');
  expect(turn).not.toBeNull();
  expect(turn!.lastElementChild).toBe(response);
  expect(response.closest('.agent-turn-process')).toBeNull();
  expect(response.closest('.message')).toBeNull();
}

for (const status of activeStatuses)
  for (const unavailable of [false, true])
    test(`exact ${status} activity keeps one bottom response without assistant content, unavailable=${unavailable}`, () => {
      for (const messages of [[], [user], [user, tool], [assistant('model', true), tool]])
        inspect(messages, { turnId: 'run', status, unavailable }, (document) => {
          expectBottomResponse(document);
          if (unavailable) expect(document.body.textContent).toContain('上次确认状态');
        });
    });

test('thinking-only and multiple model fragments keep one Turn response outside hidden reasoning', () => {
  const thinking: Message = {
    id: 'thinking',
    turnId: 'run',
    role: 'thinking',
    text: 'PRIVATE_REASONING',
    settled: false,
  };
  for (const [messages, label] of [
    [[user, thinking], '正在思考…'],
    [[user, thinking, assistant('first', true), assistant('second'), tool], '正在回复…'],
  ] as const)
    inspect([...messages], { turnId: 'run', status: 'running' }, (document) => {
      expectBottomResponse(document, label);
      expect(document.body.textContent).not.toContain('PRIVATE_REASONING');
      if (label === '正在思考…') expect(document.querySelector('.agent-turn-summary')).toBeNull();
      else expect(document.querySelector('.agent-turn-status-label')?.textContent).toBe('处理过程');
    });
});

test('the same Turn split across entries owns its response only in the last entry', () => {
  inspect(
    [assistant('first'), { ...user, id: 'interleaved' }, assistant('second')],
    { turnId: 'run', status: 'running' },
    (document) => {
      const turns = [...document.querySelectorAll('.agent-turn')];
      expect(turns).toHaveLength(2);
      expectBottomResponse(document);
      expect(turns[0]!.querySelector('.response-status')).toBeNull();
      expect(turns[1]!.querySelector('.response-status')).not.toBeNull();
    },
  );
});

for (const status of ['completed', 'failed', 'cancelled', 'aborted'] as const)
  test(`exact terminal ${status} suppresses stale unfinished text even with a stale active activity`, () => {
    for (const activity of [
      undefined,
      { turnId: 'run', status: 'running' as const },
      { turnId: 'run', status: 'waiting' as const, unavailable: true },
    ])
      inspect([assistant('unfinished'), terminal(status)], activity, (document) => {
        expect(document.querySelector('.response-status')).toBeNull();
      });
  });

for (const status of ['completed', 'failed', 'cancelled'] as const)
  test(`terminal activity ${status} suppresses unfinished model fallback`, () => {
    inspect([assistant('unfinished')], { turnId: 'run', status }, (document) => {
      expect(document.querySelector('.response-status')).toBeNull();
    });
  });

test('unscoped legacy streaming keeps its original message response fallback', () => {
  inspect([{ ...assistant('legacy'), turnId: undefined }], undefined, (document) => {
    expect(document.querySelectorAll('.response-status')).toHaveLength(1);
    expect(document.querySelector('.message.assistant .response-status')?.textContent).toBe(
      '正在回复…',
    );
  });
});

test('manual process collapse, model completion, tools, approval wait and later model retain the same bottom response until actual termination', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const render = (messages: Message[], status: TurnActivity['status'] = 'running') =>
    act(async () =>
      root.render(
        <Conversation {...props} messages={messages} turnActivity={{ turnId: 'run', status }} />,
      ),
    );
  try {
    const thinking: Message = {
      id: 'thinking',
      turnId: 'run',
      role: 'thinking',
      text: 'PRIVATE_REASONING',
      settled: false,
    };
    await render([user, thinking]);
    const response = host.querySelector('.response-status')!;
    expect(response).not.toBeNull();
    expect(response.textContent).toBe('正在思考…');
    expect(response.closest('.agent-turn')?.firstElementChild).toBe(response);
    expect(host.querySelector('.agent-turn-summary')).toBeNull();
    await render([user, assistant('first')]);
    expect(host.querySelector('.response-status')).toBe(response);
    expect(response.textContent).toBe('正在回复…');
    expect(host.querySelector('.agent-turn-status-label')?.textContent).toBe('处理过程');
    const toggle = host.querySelector<HTMLButtonElement>('.agent-turn-summary[aria-expanded]')!;
    expect(toggle).not.toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await render([user, assistant('first', true), thinking]);
    expect(host.querySelector('.response-status')).toBe(response);
    expect(response.textContent).toBe('正在思考…');
    expect(host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('PRIVATE_REASONING');
    await render([
      user,
      assistant('first', true),
      thinking,
      { ...tool, settled: false, status: 'running' },
    ]);
    expect(host.querySelector('.response-status')).toBe(response);
    expect(response.textContent).toBe('正在回复…');
    for (const [messages, status] of [
      [[user, { ...assistant('first'), text: 'more streaming text' }], 'running'],
      [[user, assistant('first', true)], 'running'],
      [[user, assistant('first', true), tool], 'waiting'],
      [
        [
          user,
          assistant('first', true),
          { ...tool, approval: { source: 'user', state: 'awaiting_user' } },
        ],
        'waiting',
      ],
      [[user, assistant('first', true), tool, assistant('later')], 'running'],
    ] as [Message[], TurnActivity['status']][]) {
      await render(messages, status);
      expect(host.querySelectorAll('.response-status')).toHaveLength(1);
      expect(host.querySelector('.response-status')).toBe(response);
      expect(response.closest('.agent-turn')!.lastElementChild).toBe(response);
      expect(host.querySelector('.agent-turn-summary')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
    }
    await render([user, assistant('first', true), tool, assistant('later'), terminal('aborted')]);
    expect(host.querySelector('.response-status')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
