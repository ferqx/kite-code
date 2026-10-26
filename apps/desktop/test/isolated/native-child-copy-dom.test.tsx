import { expect, test } from 'bun:test';
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBackgroundChild } from '../../src/background-bridge';
import { NativeChildDetail } from '../../src/native-child-detail';
import { backgroundItem } from '../background-item.fixture';

const code = 'const complete = true;\nconst second = "雪🙂";\n';
const content = `\`\`\`ts\n${code}\`\`\``;
const preview = '```ts\nconst complete = tr';
function childFacts(
  sessionId = 'child',
  storeId = 'store',
  fullContent = content,
): NativeBackgroundChild {
  const original = backgroundItem(1, true);
  const session = { ...original.childSession!, id: sessionId };
  const item = {
    ...original,
    childSession: session,
    execution: { ...original.execution, childSessionId: sessionId, originStoreId: storeId },
  };
  const snapshot: ModelOutputSnapshot = {
    storeId,
    sessionId,
    rootSessionId: 'root',
    runId: 'run',
    executionId: 'model-execution',
    originCommandId: 'command',
    rootWorkCommandId: 'command',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    bodyHash: 'a'.repeat(64),
    bodyBytes: '1',
    contentBytes: String(Buffer.byteLength(fullContent)),
    reasoningBytes: '0',
    snapshotCursor: '1',
    output: { content: fullContent, reasoning: '', toolCalls: [], complete: true },
  };
  const message: Message = {
    id: 'model',
    sessionId,
    runId: 'run',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    content: preview,
    outputBody: {
      kind: 'model_output',
      executionId: snapshot.executionId,
      complete: true,
      contentBytes: snapshot.contentBytes,
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  };
  return {
    item,
    session,
    upperSeq: '1',
    messages: [message],
    modelOutputs: [{ messageId: message.id, snapshot }],
    presentation: {
      runs: [
        {
          id: 'run',
          sessionId,
          originStoreId: storeId,
          status: 'completed',
          isActive: false,
          createdAt: 1000,
          finishedAt: 2000,
          reason: null,
        },
      ],
      tools: [],
      executions: [],
    },
  };
}
async function fixture(
  run: (f: {
    host: HTMLElement;
    writes: string[];
    render: (
      facts: NativeBackgroundChild,
      options?: {
        generation?: number;
        executionId?: string;
        storeId?: string;
        readActive?: boolean;
        loading?: boolean;
      },
    ) => Promise<void>;
    click: (label: string) => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const;
  const prior = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host),
    writes: string[] = [];
  const writer = async (text: string) => {
    writes.push(text);
  };
  try {
    await run({
      host,
      writes,
      render: async (facts, options = {}) =>
        act(async () =>
          root.render(
            <NativeChildDetail
              child={{
                scope: 'fixture',
                sessionId: facts.session.id,
                executionId: options.executionId,
                loading: options.loading ?? false,
                facts,
              }}
              generation={options.generation ?? 1}
              storeId={options.storeId ?? 'store'}
              sessionId={facts.session.id}
              executionId={options.executionId}
              readActive={options.readActive ?? true}
              onTitleChange={() => {}}
              writeClipboardText={writer}
            />,
          ),
        ),
      click: async (label) =>
        act(async () => {
          const button = [...host.querySelectorAll('button')].find(
            (node) => node.textContent === label || node.getAttribute('aria-label') === label,
          );
          expect(button).toBeDefined();
          button!.click();
        }),
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('child automatically shows the verified body and rejected replacement revokes copy until a valid body returns', async () =>
  fixture(async (f) => {
    const facts = childFacts();
    await f.render(facts);
    const oldCode = f.host.querySelector<HTMLButtonElement>(
      '[data-slot="code-block-copy-button"]',
    )!;
    await f.click('复制代码');
    expect(f.writes).toEqual([code]);
    expect(f.host.querySelector('.model-output-message > button')).toBeNull();
    expect(f.host.querySelector('.model-output-message > p')).toBeNull();
    const rejected = childFacts();
    rejected.modelOutputs[0]!.snapshot.executionId = 'wrong-execution';
    await f.render(rejected);
    expect(f.host.querySelector('pre code')?.textContent).toBe('const complete = tr\n');
    expect(f.host.querySelector('[data-slot="code-block-copy-button"]') === null).toBe(true);
    expect(f.host.querySelector('.message-copy') === null).toBe(true);
    await act(async () => oldCode.click());
    expect(f.writes).toEqual([code]);
    await f.render(facts);
    await f.click('复制代码');
    await f.click('复制本轮Agent回复');
    expect(f.writes).toEqual([code, code, content]);
  }));

test('child pause preserves disabled copy feedback and code DOM, and resuming keeps automatic body copy accurate', async () =>
  fixture(async (f) => {
    const facts = childFacts();
    await f.render(facts);
    await f.click('复制代码');
    const button = f.host.querySelector<HTMLButtonElement>('[data-slot="code-block-copy-button"]')!;
    const pre = f.host.querySelector('pre');
    await f.render(facts, { loading: true });
    expect(f.host.querySelector('pre')).toBe(pre);
    expect(f.host.querySelector('[data-slot="code-block-copy-button"]') === button).toBe(true);
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => button.click());
    expect(f.writes).toEqual([code]);
    await f.render(facts);
    expect(f.host.querySelector('pre')).toBe(pre);
    expect(f.host.querySelector('[data-slot="code-block-copy-button"]') === button).toBe(true);
    expect(button.getAttribute('data-copy-state')).toBe('copied');
    await f.render(facts, { readActive: false });
    expect(f.host.querySelector('[data-slot="code-block-copy-button"]') === button).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => button.click());
    expect(f.writes).toEqual([code]);
    expect(f.host.querySelector('.model-output-message > button')).toBeNull();
    await f.render(facts);
    expect(f.host.querySelector('[data-slot="code-block-copy-button"]') === button).toBe(true);
    await act(async () => button.click());
    expect(f.writes).toEqual([code, code]);
  }));

test('child copy eligibility does not survive a rejected replacement snapshot or cross child, store and generation identity', async () =>
  fixture(async (f) => {
    for (const target of ['snapshot', 'child', 'store', 'generation'] as const) {
      await f.render(childFacts());
      expect(f.host.querySelector('[data-slot="code-block-copy-button"]')).not.toBeNull();
      const facts = childFacts(
        target === 'child' ? 'other-child' : 'child',
        target === 'store' ? 'other-store' : 'store',
      );
      // Same message ID and full text, but the reader must reject this snapshot's ownership.
      facts.modelOutputs[0]!.snapshot = {
        ...facts.modelOutputs[0]!.snapshot,
        executionId: 'wrong-execution',
      };
      await f.render(facts, {
        storeId: target === 'store' ? 'other-store' : 'store',
        generation: target === 'generation' ? 2 : 1,
      });
      expect(f.host.querySelector('pre code')?.textContent).toBe('const complete = tr\n');
      expect(f.host.querySelector('[data-slot="code-block-copy-button"]') === null).toBe(true);
      expect(f.host.querySelector('.message-copy') === null).toBe(true);
    }
    expect(f.writes).toEqual([]);
  }));

test('valid child, store, generation and execution replacements retire old controls and publish only the new body', async () =>
  fixture(async (f) => {
    for (const target of ['child', 'store', 'generation', 'execution'] as const) {
      await f.render(childFacts());
      const oldCode = f.host.querySelector<HTMLButtonElement>(
        '[data-slot="code-block-copy-button"]',
      )!;
      const replacementCode = `const replacement = "${target}";\n`;
      const replacementContent = `\`\`\`ts\n${replacementCode}\`\`\``;
      const storeId = target === 'store' ? 'other-store' : 'store';
      const facts = childFacts(
        target === 'child' ? 'other-child' : 'child',
        storeId,
        replacementContent,
      );
      if (target === 'execution') facts.item.execution.id = 'other-execution';
      await f.render(facts, {
        storeId,
        generation: target === 'generation' ? 2 : 1,
        executionId: target === 'execution' ? 'other-execution' : undefined,
      });
      const count = f.writes.length;
      await act(async () => oldCode.click());
      expect(f.writes).toHaveLength(count);
      expect(f.host.querySelector('pre code')?.textContent).toBe(replacementCode);
      await f.click('复制代码');
      expect(f.writes.at(-1)).toBe(replacementCode);
      await f.click('复制本轮Agent回复');
      expect(f.writes.at(-1)).toBe(replacementContent);
    }
  }));
