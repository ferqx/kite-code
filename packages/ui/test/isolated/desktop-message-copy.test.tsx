import { expect, spyOn, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation } from '../../src/desktop/Conversation';
import { ConversationCache } from '../../src/desktop/ConversationCache';
import { MessageCopyButton } from '../../src/desktop/MessageCopyButton';
import type { Message } from '../../src/desktop/types';

test('select all belongs to one visible conversation and preserves editor shortcuts', async () => {
  const dom = new JSDOM('<div id="root"></div><input /><div contenteditable>Editor text</div>', {
    pretendToBeVisual: true,
  });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const view = (name: string) => (
    <Conversation
      messages={[{ id: name, role: 'assistant', text: `${name} text`, settled: true }]}
      loading={false}
      selected
      connected
      saveReading={() => {}}
    />
  );
  const shortcut = (target: EventTarget, metaKey = false) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: !metaKey,
      metaKey,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const selection = dom.window.document.getSelection()!;
  try {
    await act(async () =>
      root.render(
        <>
          <section hidden>{view('hidden')}</section>
          {view('parent')}
          {view('child')}
        </>,
      ),
    );
    const [hidden, parent, child] = [
      ...dom.window.document.querySelectorAll<HTMLElement>('.conversation-viewport'),
    ];
    expect(shortcut(dom.window.document)).toBe(true);
    expect(selection.toString()).toBe('parent text');
    expect(shortcut(child!.querySelector('.message p')!, true)).toBe(true);
    expect(selection.toString()).toBe('child text');
    expect(shortcut(dom.window.document)).toBe(true);
    expect(selection.toString()).toBe('child text');
    parent!.tabIndex = 0;
    parent!.focus();
    expect(shortcut(dom.window.document)).toBe(true);
    expect(selection.toString()).toBe('parent text');
    // An event inside the child wins over focus retained in the parent.
    expect(shortcut(child!.querySelector('.message p')!)).toBe(true);
    expect(selection.toString()).toBe('child text');
    for (const editor of dom.window.document.querySelectorAll('input, [contenteditable]')) {
      expect(shortcut(editor)).toBe(false);
      expect(selection.toString()).toBe('child text');
    }
    // A hidden retained conversation cannot claim ownership through an old selection.
    selection.selectAllChildren(hidden!.querySelector('.message p')!);
    parent!.blur();
    expect(shortcut(dom.window.document)).toBe(true);
    expect(selection.toString()).toBe('parent text');
    await act(async () => root.render(view('only')));
    selection.removeAllRanges();
    expect(shortcut(dom.window.document, true)).toBe(true);
    expect(selection.toString()).toBe('only text');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('actual Conversation copies only original settled user and host-confirmed final turn text, with explicit failure retry', async () => {
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
  const user = '完整用户消息 中文🙂\n原始第二行';
  const final = '第一段 **原始 Markdown**\n\n第二段最终回答🙂';
  const messages: Message[] = [
    { id: 'u', turnId: 'run', role: 'user', settled: true, text: user },
    { id: 'reasoning', turnId: 'run', role: 'thinking', settled: true, text: 'private reasoning' },
    { id: 'a1', turnId: 'run', role: 'assistant', settled: true, text: '第一段 **原始 Markdown**' },
    {
      id: 'tool:t',
      turnId: 'run',
      role: 'tool',
      settled: true,
      text: 'tool output',
      toolName: 'shell',
    },
    { id: 'subagent:child', turnId: 'run', role: 'subagent', settled: true, text: 'child output' },
    {
      id: 'a2',
      turnId: 'run',
      role: 'assistant',
      settled: true,
      finalReply: true,
      text: '第二段最终回答🙂',
      copyText: final,
    },
    {
      id: 'stream',
      turnId: 'stream-run',
      role: 'assistant',
      settled: false,
      finalReply: true,
      text: 'streaming body',
    },
    {
      id: 'preview',
      turnId: 'preview-run',
      role: 'assistant',
      settled: true,
      finalReply: true,
      text: 'preview body',
      copyText: null,
    },
  ];
  const writes: string[] = [];
  let fail = false;
  let release: (() => void) | undefined;
  const write = async (text: string) => {
    writes.push(text);
    if (fail) throw Error('clipboard unavailable');
    if (release !== undefined)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  const render = (value: Message[]) =>
    act(async () =>
      root.render(
        <Conversation
          messages={value}
          loading={false}
          selected
          connected
          saveReading={() => {}}
          writeClipboardText={write}
        />,
      ),
    );
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button.message-copy')];
  const click = async (button: HTMLButtonElement) =>
    act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  try {
    await render(messages);
    expect(buttons()).toHaveLength(2);
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual([
      '复制本轮用户消息',
      '复制本轮Agent回复',
    ]);
    await click(buttons()[0]!);
    expect(writes).toEqual([user]);
    expect(buttons()[0]!.getAttribute('data-copy-state')).toBe('copied');
    fail = true;
    await click(buttons()[1]!);
    expect(writes).toEqual([user, final]);
    expect(buttons()[1]!.getAttribute('aria-label')).toBe('复制失败，请重试');
    fail = false;
    await click(buttons()[1]!);
    expect(writes).toEqual([user, final, final]);
    expect(buttons()[1]!.getAttribute('aria-label')).toBe('已复制消息');
    expect(writes.join('\n')).not.toContain('private reasoning');
    expect(writes.join('\n')).not.toContain('tool output');
    expect(writes.join('\n')).not.toContain('child output');
    expect(writes.join('\n')).not.toContain('streaming body');
    expect(writes.join('\n')).not.toContain('preview body');
    release = () => {};
    await click(buttons()[1]!);
    const finish = release;
    await render([
      {
        id: 'replacement',
        turnId: 'other-run',
        role: 'user',
        settled: true,
        text: 'replacement scope',
      },
    ]);
    await act(async () => finish?.());
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]!.getAttribute('aria-label')).toBe('复制本轮用户消息');
    expect(buttons()[0]!.getAttribute('data-copy-state')).toBe('idle');
    expect(writes).toEqual([user, final, final, final]);
    // A verified body can change while the same public message remains mounted.
    // Its old clipboard completion must not report the replacement body copied.
    await click(buttons()[0]!);
    const oldBodyFinished = release;
    const existingButton = buttons()[0]!;
    await render([
      {
        id: 'replacement',
        turnId: 'other-run',
        role: 'user',
        settled: true,
        text: 'replacement complete body 中文🙂',
      },
    ]);
    expect(buttons()[0]).toBe(existingButton);
    await act(async () => oldBodyFinished?.());
    expect(buttons()[0]!.getAttribute('data-copy-state')).toBe('idle');
    expect(buttons()[0]!.getAttribute('aria-label')).toBe('复制本轮用户消息');
    release = undefined;
    await click(buttons()[0]!);
    expect(writes).toEqual([
      user,
      final,
      final,
      final,
      'replacement scope',
      'replacement complete body 中文🙂',
    ]);
    expect(buttons()[0]!.getAttribute('data-copy-state')).toBe('copied');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('cached copy feedback survives effect reactivation, expires at its original deadline and rejects paused or late copies', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  let now = 100000,
    release: (() => void) | undefined;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const writes: string[] = [];
  const write = async (text: string) => {
    writes.push(text);
    if (release)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  const render = (id: string, readable = true) =>
    act(async () =>
      root.render(
        <ConversationCache
          identity={id}
          loading={!readable}
          visible
          cache={{ scope: 'window', revision: '0', readActive: readable }}
        >
          <div>
            <MessageCopyButton text={id} writeClipboardText={write} />
          </div>
        </ConversationCache>,
      ),
    );
  try {
    await render('a');
    const button = dom.window.document.querySelector<HTMLButtonElement>('button')!;
    await act(async () => button.click());
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    await render('b');
    now += 500;
    await render('a', false);
    expect(dom.window.document.querySelector('button') === button).toBe(true);
    expect(button.matches(':disabled')).toBe(false);
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    await act(async () => button.click());
    expect(writes).toEqual(['a']);
    await render('a');
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    await render('b');
    now += 2000;
    await render('a', false);
    expect(button.getAttribute('data-copy-state')).toBe('idle');
    await render('a');
    release = () => {};
    await act(async () => button.click());
    await render('b');
    await act(async () => {
      release?.();
    });
    await render('a');
    expect(button.getAttribute('data-copy-state')).toBe('idle');
  } finally {
    await act(async () => root.unmount());
    clock.mockRestore();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
