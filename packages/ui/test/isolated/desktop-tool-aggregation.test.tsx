import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation } from '../../src/desktop/Conversation';
import { ToolActivity } from '../../src/desktop/ToolActivity';
import type { Message } from '../../src/desktop/types';

const tool = (id: string, status: NonNullable<Message['status']> = 'queued'): Message => ({
  id: `tool:${id}`,
  turnId: 'run',
  role: 'tool',
  toolName: 'read_file',
  target: `${id}.ts`,
  presentation: 'exploration',
  presentationGroupId: `batch:${id}`,
  text: '',
  status,
  settled: ['completed', 'failed'].includes(status),
});

async function withConversation(
  inspect: (fixture: {
    host: HTMLElement;
    render: (messages: Message[]) => Promise<void>;
    click: (element: Element) => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
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
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  }))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await inspect({
      host,
      render: (messages) =>
        act(async () => {
          root.render(
            <Conversation
              messages={messages}
              loading={false}
              selected
              connected
              turnActivity={{ turnId: 'run', status: 'running' }}
              saveReading={() => {}}
              renderToolActivity={(group, state) => (
                <ToolActivity
                  messages={group}
                  {...state}
                  renderChildren={(_, open) =>
                    group.length === 1 && !group[0]!.toolName && open ? (
                      <pre key={group[0]!.id}>ORIGINAL_TOOL_RECORD</pre>
                    ) : null
                  }
                />
              )}
            />,
          );
        }),
      click: (element) =>
        act(async () => {
          element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
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

function summary(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>('.tool-activity-summary[aria-expanded]');
  expect(button).not.toBeNull();
  return button!;
}

for (const initial of ['queued', 'running'] as const)
  test(`a ${initial} exploration group remains closed as tools progress, arrive and finish`, async () => {
    await withConversation(async ({ host, render }) => {
      const states = [
        [tool('a', initial), tool('b', initial)],
        [tool('a', 'running'), tool('b', 'queued')],
        [tool('a', 'running'), tool('b', 'running'), tool('c')],
        [tool('a', 'completed'), tool('b', 'running'), tool('c', 'running')],
        [tool('a', 'completed'), tool('b', 'completed'), tool('c', 'completed')],
      ];
      for (const messages of states) {
        await render(messages);
        expect(summary(host).getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector('.tool-activity-steps')).toBeNull();
      }
    });
  });

test('an exploration group keeps the reader choice when tools arrive or finish', async () => {
  await withConversation(async ({ host, render, click }) => {
    await render([tool('a', 'running'), tool('b')]);
    await click(summary(host));
    expect(summary(host).getAttribute('aria-expanded')).toBe('true');
    await render([tool('a', 'completed'), tool('b', 'running'), tool('c')]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.tool-activity-step')).toHaveLength(3);
    await click(summary(host));
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    await render([tool('a', 'completed'), tool('b', 'completed'), tool('c', 'running'), tool('d')]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tool-activity-steps')).toBeNull();
  });
});

test('opening an unverified single record does not open the exploration group it later joins', async () => {
  await withConversation(async ({ host, render, click }) => {
    const unverified: Message = {
      id: 'tool:a',
      turnId: 'run',
      role: 'tool',
      text: '',
      settled: true,
    };
    await render([unverified]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    await click(summary(host));
    expect(summary(host).getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('ORIGINAL_TOOL_RECORD');

    // Verified metadata changes the same first receipt into a lightweight
    // exploration item while another adjacent result joins its aggregation.
    await render([tool('a', 'completed'), tool('b', 'running')]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tool-activity-steps')).toBeNull();
    expect(host.textContent).not.toContain('ORIGINAL_TOOL_RECORD');

    await click(summary(host));
    await render([tool('a', 'completed'), tool('b', 'completed'), tool('c', 'running')]);
    expect(summary(host).getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.tool-activity-step')).toHaveLength(3);
  });
});

test('Trace aggregation preserves Shell disclosure, output following and real stopped status', async () => {
  await withConversation(async ({ host, render, click }) => {
    const shell = (stdout: string, status: Message['status'] = 'running'): Message => ({
      ...tool('shell', status),
      toolName: 'shell_execute',
      target: 'bun test',
      toolProgress: { stdout, stderr: '' },
      settled: status === 'cancelled',
    });
    const messages = (stdout: string, status: Message['status'] = 'running') => [
      tool('read', 'completed'),
      shell(stdout, status),
    ];
    await render(messages('first line'));
    await click(summary(host));
    expect(host.querySelector('.tool-activity-steps')?.getAttribute('data-slot')).toBe('trace');
    const shellSummary = () => host.querySelector('.shell-activity .tool-activity-summary')!;
    expect(shellSummary().getAttribute('data-slot')).toBe('trace-collapsible-trigger');
    expect(shellSummary().querySelector('[data-slot="trace-title"]')).not.toBeNull();
    await click(shellSummary());
    const output = () => host.querySelector<HTMLElement>('[aria-label="Shell 执行输出"]')!;
    expect(output().tagName).toBe('PRE');
    expect(output().getAttribute('role')).toBe('region');
    expect(output().getAttribute('tabindex')).toBe('0');
    expect(output().getAttribute('data-slot')).toBe('code-block-content');
    expect(output().textContent).toBe('first line');
    Object.defineProperties(output(), {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    output().scrollTop = 500;
    await act(async () => {
      const scroll = output().ownerDocument.createEvent('Event');
      scroll.initEvent('scroll', true, false);
      output().dispatchEvent(scroll);
    });
    await render(messages('first line\nsecond line'));
    expect(output().scrollTop).toBe(500);
    expect(host.querySelector('.shell-latest')?.textContent).toBe('回到最新输出');
    await click(host.querySelector('.shell-latest')!);
    expect(output().scrollTop).toBe(1000);
    expect(host.querySelector('.shell-latest')).toBeNull();

    // Less than 24 px from the end resumes following; exactly 24 px pauses it.
    for (const [top, paused] of [
      [876, true],
      [877, false],
    ] as const) {
      output().scrollTop = top;
      await act(async () => {
        const scroll = output().ownerDocument.createEvent('Event');
        scroll.initEvent('scroll', true, false);
        output().dispatchEvent(scroll);
      });
      expect(Boolean(host.querySelector('.shell-latest'))).toBe(paused);
    }
    await click(summary(host));
    await click(summary(host));
    expect(shellSummary().getAttribute('aria-expanded')).toBe('true');
    expect(output().textContent).toContain('second line');
    await render(messages('first line\nsecond line', 'cancelled'));
    expect(output().textContent).toContain('second line');
    expect(host.querySelector('.shell-result')?.textContent).toContain('已停止');
    expect(host.querySelector('.shell-activity [data-status="error"]')).toBeNull();
    expect(host.querySelector('button button')).toBeNull();
  });
});
