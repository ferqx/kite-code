import { expect, test } from 'bun:test';
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act, useContext, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationActivityContext } from '../../../../packages/ui/src/conversation-activity';
import { Conversation } from '../../../../packages/ui/src/desktop/Conversation';
import { ConversationCache } from '../../../../packages/ui/src/desktop/ConversationCache';
import { MessageContent } from '../../../../packages/ui/src/desktop/MessageContent';
import { controlCacheAccounting } from '../../../../packages/ui/test/conversation-cache-accounting.fixture';
import { NativeModelOutputMessage } from '../../src/native-model-output-message';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('resume-only context updates preserve the retained body while real read gates and messages still update', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const restoreLayout = prepareDesktopDom(dom);
  const previous = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const message: Message = {
    id: 'message',
    sessionId: 'session',
    runId: null,
    seq: '1',
    role: 'assistant',
    status: 'complete',
    content: 'Retained original body',
  };
  let bodyRenders = 0;
  const renderText = (text: string) => {
    bodyRenders++;
    return <p>{text}</p>;
  };
  function Resume() {
    return <span data-resume="">{useContext(ConversationActivityContext).resume}</span>;
  }
  const render = (resume: number, readActive: boolean, current = message) =>
    act(async () =>
      root.render(
        <ConversationActivityContext value={{ resume, readActive }}>
          <Resume />
          <NativeModelOutputMessage message={current} storeId="store" renderText={renderText} />
        </ConversationActivityContext>,
      ),
    );
  try {
    await render(0, false);
    const initial = bodyRenders;
    expect(initial).toBeGreaterThan(0);
    await render(1, false);
    expect(bodyRenders).toBe(initial);
    expect(host.querySelector('[data-resume]')?.textContent).toBe('1');
    await render(2, true);
    expect(bodyRenders).toBeGreaterThan(initial);
    const readable = bodyRenders;
    await render(3, false);
    expect(bodyRenders).toBeGreaterThan(readable);
    await render(4, false, { ...message, content: 'Changed original body' });
    expect(host.textContent).toContain('Changed original body');
    expect(host.textContent).not.toContain('Retained original body');
  } finally {
    await act(async () => root.unmount());
    restoreLayout();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('Native automatically renders the verified reply and retains exact copy DOM through paused calibration until cache disposal', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const accounting = controlCacheAccounting(dom.window);
  const restoreLayout = prepareDesktopDom(dom);
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const code = 'const verified = "汉字🙂";\n';
  const content = `完整已核验回复🙂\n\n\`\`\`ts\n${code}\`\`\``,
    contentBytes = String(new TextEncoder().encode(content).length);
  const message: Message = {
    id: 'model',
    sessionId: 'a',
    runId: 'run',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    content: '```ts\nPREVIEW\n```',
    outputBody: {
      kind: 'model_output',
      executionId: 'model-execution',
      complete: true,
      contentBytes,
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  };
  const snapshot: ModelOutputSnapshot = {
    storeId: 'store',
    sessionId: 'a',
    rootSessionId: 'a',
    runId: 'run',
    executionId: 'model-execution',
    originCommandId: 'command',
    rootWorkCommandId: 'command',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    bodyHash: 'a'.repeat(64),
    bodyBytes: '1',
    contentBytes,
    reasoningBytes: '0',
    snapshotCursor: '1',
    output: { content, reasoning: '', toolCalls: [], complete: true },
  };
  const published: (string | undefined)[] = [],
    writes: string[] = [];
  function Reply() {
    const [copy, setCopy] = useState<string>();
    return (
      <Conversation
        selected
        connected
        loading={false}
        saveReading={() => {}}
        messages={[
          {
            id: 'model',
            turnId: 'run',
            role: 'assistant',
            settled: true,
            finalReply: true,
            text: 'PREVIEW',
            copyText: copy ?? null,
          },
        ]}
        writeClipboardText={async (text) => {
          writes.push(text);
        }}
        renderMessageContent={() => (
          <NativeModelOutputMessage
            message={message}
            storeId="store"
            verifiedSnapshot={snapshot}
            onContent={(text) => {
              published.push(text);
              setCopy(text);
            }}
            renderText={(text) => <MessageContent text={text} />}
          />
        )}
      />
    );
  }
  const render = async (identity = 'a', readable = true, scope = 'store') => {
    await act(async () => accounting.flush());
    await act(async () =>
      root.render(
        <ConversationCache
          identity={identity}
          loading={!readable}
          visible
          cache={{ scope, revision: '0', readActive: readable }}
        >
          {identity === 'a' ? <Reply /> : <div>Other</div>}
        </ConversationCache>,
      ),
    );
    await act(async () => accounting.flush());
  };
  try {
    await render();
    expect(host.querySelector('.model-output-message > button')).toBeNull();
    expect(host.querySelector('.model-output-message > p')).toBeNull();
    const button = host.querySelector<HTMLButtonElement>('.message-copy')!;
    const codeButton = host.querySelector<HTMLButtonElement>(
      '[data-slot="code-block-copy-button"]',
    )!;
    expect(codeButton).not.toBeNull();
    const body = host.querySelector('.message-markdown p')!;
    await act(async () => button.click());
    expect(writes).toEqual([content]);
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: true });
    await act(async () =>
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')),
    );
    expect(published.at(-1)).toBe(content);
    expect(host.querySelector('.message-copy') === button).toBe(true);
    expect(host.querySelector('[data-slot="code-block-copy-button"]') === codeButton).toBe(true);
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false });
    await render('b');
    expect(published.at(-1)).toBe(content);
    await render('a', false);
    expect(host.querySelector('.message-copy') === button).toBe(true);
    expect(host.querySelector('.message-markdown p') === body).toBe(true);
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    await act(async () => button.click());
    await act(async () => codeButton.click());
    expect(writes).toEqual([content]);
    await render();
    expect(host.querySelector('.message-copy') === button).toBe(true);
    expect(published.at(-1)).toBe(content);
    await act(async () => codeButton.click());
    expect(writes).toEqual([content, code]);
    await render('b');
    await render('b', true, 'other-store');
    expect(published.at(-1)).toBeUndefined();
    await act(async () => codeButton.click());
    expect(writes).toEqual([content, code]);
  } finally {
    await act(async () => root.unmount());
    accounting.restore();
    restoreLayout();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
