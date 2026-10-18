import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/desktop/Conversation';
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
        : element.textContent?.trim(),
    ),
  ).toEqual(['first-user', 'cancelled', 'second-user', 'completed']);
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
