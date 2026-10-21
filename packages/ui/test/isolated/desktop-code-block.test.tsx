import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationActivityContext } from '../../src/conversation-activity';
import { Conversation } from '../../src/desktop/Conversation';
import { MessageContent } from '../../src/desktop/MessageContent';

test('Markdown code blocks retain language, unknown labels, indentation, exact text and inline semantics', () => {
  const html = renderToStaticMarkup(
    <MessageContent
      text={
        '`inline`\n\n```ts\nconst x = "漢字🙂";\n```\n\n```future-lang\na\n```\n\n```\nb\n```\n\n    indented\n'
      }
    />,
  );
  const dom = new JSDOM(html);
  const blocks = [...dom.window.document.querySelectorAll('[data-slot="code-block"]')];
  expect(
    blocks.map((block) => block.querySelector('[data-slot="code-block-title"]')?.textContent),
  ).toEqual(['ts', 'future-lang', '代码', '代码']);
  expect(blocks.map((block) => block.querySelector('pre > code')?.textContent)).toEqual([
    'const x = "漢字🙂";\n',
    'a\n',
    'b\n',
    'indented\n',
  ]);
  expect(blocks[0]!.querySelector('code')!.className).toBe('language-ts');
  expect(blocks[1]!.querySelector('code')!.className).toBe('language-future-lang');
  expect(dom.window.document.querySelector('p > code')?.textContent).toBe('inline');
  expect(dom.window.document.querySelector('[data-slot="code-block-line"]')).toBeNull();
  dom.window.close();
});

test('custom message code copies exact host text, retries failures and rejects paused or obsolete feedback', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
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
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const calls: string[] = [];
  let mode: 'fail' | 'success' | 'pending' = 'fail';
  let resolveCopy: (() => void) | undefined;
  const writer = async (text: string) => {
    calls.push(text);
    if (mode === 'fail') throw new Error('clipboard unavailable');
    if (mode === 'pending')
      await new Promise<void>((resolve) => {
        resolveCopy = resolve;
      });
  };
  const render = async (
    text = '漢字🙂\n',
    readActive = true,
    port: (text: string) => Promise<void> = writer,
  ) =>
    act(async () =>
      root.render(
        <ConversationActivityContext.Provider value={{ readActive, resume: 0 }}>
          <Conversation
            messages={[
              {
                id: 'message',
                turnId: 'run',
                role: 'assistant',
                text,
                settled: true,
                finalReply: true,
              },
            ]}
            loading={false}
            selected
            connected
            saveReading={() => {}}
            writeClipboardText={port}
            renderMessageContent={() => <MessageContent text={`\`\`\`txt\n${text}\`\`\``} />}
          />
        </ConversationActivityContext.Provider>,
      ),
    );
  const button = () =>
    host.querySelector<HTMLButtonElement>('[data-slot="code-block-copy-button"]')!;
  const click = async () => act(async () => button().click());
  try {
    await render();
    await click();
    expect(calls).toEqual(['漢字🙂\n']);
    expect(button().getAttribute('aria-label')).toBe('复制失败，请重试');
    mode = 'success';
    await click();
    expect(button().getAttribute('data-copy-state')).toBe('copied');
    await render('next\n');
    expect(button().getAttribute('data-copy-state')).toBe('idle');
    mode = 'pending';
    await click();
    await render('replacement\n');
    await act(async () => resolveCopy?.());
    expect(button().getAttribute('data-copy-state')).toBe('idle');
    await click();
    await render('replacement\n', false);
    const count = calls.length;
    await act(async () => resolveCopy?.());
    await click();
    expect(calls).toHaveLength(count);
    expect(button().getAttribute('aria-disabled')).toBe('true');
    const replacementCalls: string[] = [];
    const replacementWriter = async (text: string) => {
      replacementCalls.push(text);
    };
    await render('replacement\n', true);
    await click();
    await render('replacement\n', true, replacementWriter);
    await act(async () => resolveCopy?.());
    expect(button().getAttribute('data-copy-state')).toBe('idle');
    const oldCount = calls.length;
    await click();
    expect(calls).toHaveLength(oldCount);
    expect(replacementCalls).toEqual(['replacement\n']);
    expect(button().getAttribute('data-copy-state')).toBe('copied');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('actual Conversation exposes code copy only for its verified final copy and preserves code DOM through admission changes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
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
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const text = '```ts\nconst original = "漢字🙂";\n```';
  const calls: string[] = [];
  let resolveCopy: (() => void) | undefined;
  const writer = async (value: string) => {
    calls.push(value);
    await new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });
  };
  const render = async (state: 'preview' | 'streaming' | 'unverified' | 'verified') =>
    act(async () =>
      root.render(
        <Conversation
          messages={[
            {
              id: 'message',
              turnId: 'run',
              role: 'assistant',
              text,
              settled: state !== 'streaming',
              finalReply: state !== 'unverified',
              copyText: state === 'preview' ? null : undefined,
            },
          ]}
          loading={false}
          selected
          connected
          saveReading={() => {}}
          writeClipboardText={writer}
        />,
      ),
    );
  const button = () =>
    host.querySelector<HTMLButtonElement>('[data-slot="code-block-copy-button"]');
  try {
    for (const state of ['streaming', 'unverified'] as const) {
      await render(state);
      expect(button()).toBeNull();
    }
    await render('preview');
    const pre = host.querySelector('pre')!;
    expect(pre.querySelector('code')!.textContent).toBe('const original = "漢字🙂";\n');
    expect(button()).toBeNull();
    await render('verified');
    expect(host.querySelector('pre')).toBe(pre);
    const oldButton = button()!;
    expect(oldButton).not.toBeNull();
    await act(async () => oldButton.click());
    expect(calls).toEqual(['const original = "漢字🙂";\n']);
    await render('preview');
    expect(button()).toBeNull();
    expect(host.querySelector('pre')).toBe(pre);
    await act(async () => {
      oldButton.click();
      resolveCopy?.();
    });
    expect(calls).toHaveLength(1);
    await render('verified');
    expect(button()?.getAttribute('data-copy-state')).toBe('idle');
    expect(host.querySelector('pre')).toBe(pre);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
