import { expect, test } from 'bun:test';
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation } from '../../../../packages/ui/src/desktop/Conversation';
import { ConversationCache } from '../../../../packages/ui/src/desktop/ConversationCache';
import { MessageContent } from '../../../../packages/ui/src/desktop/MessageContent';
import { NativeModelOutputMessage } from '../../src/native-model-output-message';

test('Native retains verified reply copy DOM through paused calibration and revokes display on close and cache disposal', async () => {
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
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const content = '完整已核验回复🙂',
    contentBytes = String(new TextEncoder().encode(content).length);
  const message: Message = {
    id: 'model',
    sessionId: 'a',
    runId: 'run',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    content: 'PREVIEW',
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
  const render = (identity = 'a', readable = true, scope = 'store') =>
    act(async () =>
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
  try {
    await render();
    const button = host.querySelector<HTMLButtonElement>('.message-copy')!;
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
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false });
    await render('b');
    expect(published.at(-1)).toBe(content);
    await render('a', false);
    expect(host.querySelector('.message-copy') === button).toBe(true);
    expect(host.querySelector('.message-markdown p') === body).toBe(true);
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    await act(async () => button.click());
    expect(writes).toEqual([content]);
    await render();
    expect(host.querySelector('.message-copy') === button).toBe(true);
    const close = [...host.querySelectorAll('button')].find(
      (node) => node.textContent === 'Close full Model output',
    )!;
    await act(async () => close.click());
    expect(published.at(-1)).toBeUndefined();
    expect(host.querySelector('.message-copy') === null).toBe(true);
    const open = [...host.querySelectorAll('button')].find(
      (node) => node.textContent === 'Read complete recorded Model output',
    )!;
    await act(async () => open.click());
    expect(published.at(-1)).toBe(content);
    await render('b');
    await render('b', true, 'other-store');
    expect(published.at(-1)).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
