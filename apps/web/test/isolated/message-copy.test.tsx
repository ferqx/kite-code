import { expect, test } from 'bun:test';
import type { BrowserView, Message } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { installGlobals } from '../globals.fixture';

async function settle(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('message_copy_dom_deadline');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}

test('formal Web mount copies each original user message with recoverable clipboard feedback and no late cross-Session feedback', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/sessions/a',
    pretendToBeVisual: true,
  });
  const restoreGlobals = installGlobals({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    CustomEvent: dom.window.CustomEvent,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const raw = [
    '第一条🌿e\u0301\r\n完整原文 <script>window.originalExecuted=true</script>\r\nUSER_ONE_END',
    'Second original 文本\r\n\r\n**literal Markdown**\r\nUSER_TWO_END',
  ];
  const fullModel = 'FULL RECORDED MODEL BODY stays visible 🌿 MODEL_COMPLETE_END';
  const message = (sessionId: string, index: number): Message => ({
    id: `${sessionId}-${index}`,
    sessionId,
    runId: null,
    seq: String(index),
    status: 'complete',
    role: index < 3 ? 'user' : 'assistant',
    content:
      index < 3
        ? sessionId === 'a'
          ? raw[index - 1]!
          : `Session B original user ${index}`
        : 'MODEL PREVIEW',
    ...(index === 3
      ? {
          outputBody: {
            kind: 'model_output' as const,
            executionId: 'model',
            complete: true,
            contentBytes: String(Buffer.byteLength(fullModel)),
            reasoningBytes: '0',
            toolCallCount: 0,
          },
        }
      : {}),
  });
  const originals = {
    a: [message('a', 1), message('a', 2), message('a', 3)],
    b: [message('b', 1), message('b', 2)],
  };
  const before = structuredClone(originals);
  const view = (sessionId: string): BrowserView => ({
    storeId: 'store',
    snapshotCursor: '3',
    session: {
      id: sessionId,
      workspaceId: 'w',
      parentSessionId: null,
      title: `Session ${sessionId}`,
      controlRevision: '1',
      contextSelectionId: 'selection',
      nextSeq: sessionId === 'a' ? '3' : '2',
      deletedAt: null,
    },
    runs: [],
    executions: [],
  });
  const reads: string[] = [],
    copied: string[] = [];
  let clipboardMode: 'ok' | 'fail' | 'hold' = 'ok';
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(content: string) {
        copied.push(content);
        if (clipboardMode === 'fail') throw Error('clipboard_refused');
        if (clipboardMode === 'hold') await held;
      },
    },
  });
  const port = {
    serverInfo: { storeId: 'store', capabilities: ['model_outputs'] },
    async connect() {
      reads.push('connect');
      return { storeId: 'store' };
    },
    async listAllWorkspaces() {
      reads.push('listAllWorkspaces');
      return [{ id: 'w', name: 'Workspace' }];
    },
    async listAllSessionDirectory() {
      reads.push('listAllSessionDirectory');
      return ['a', 'b'].map((id, index) => ({
        seq: String(index + 1),
        session: view(id).session,
        activity: { updatedAt: null, run: null, queued: false, pendingInteractions: 0 },
      }));
    },
    async getView(id: string) {
      reads.push('getView');
      return view(id);
    },
    async listMessages(id: 'a' | 'b') {
      reads.push('listMessages');
      return structuredClone(originals[id]);
    },
    async getModelOutput(sessionId: string, executionId: string) {
      reads.push('getModelOutput');
      return {
        storeId: 'store',
        sessionId,
        rootSessionId: sessionId,
        runId: null,
        executionId,
        originCommandId: 'original-command',
        rootWorkCommandId: 'original-command',
        rootWorkSeq: '1',
        attempt: 1,
        status: 'succeeded',
        bodyHash: 'a'.repeat(64),
        bodyBytes: '1',
        contentBytes: String(Buffer.byteLength(fullModel)),
        reasoningBytes: '0',
        snapshotCursor: '3',
        output: { content: fullModel, reasoning: '', toolCalls: [], complete: true },
      };
    },
    async closeBrowserSession() {
      reads.push('closeBrowserSession');
    },
  } as unknown as BrowserClient;
  let mounted: Awaited<ReturnType<typeof import('../../src/mount')['mountWebPage']>> | undefined;
  const document = dom.window.document;
  const copyButton = (id: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-message-id="${id}"] button[aria-label="复制本轮用户消息"]`,
    );
  const click = async (button: HTMLElement) => {
    await act(async () => button.click());
  };
  try {
    const { mountWebPage } = await import('../../src/mount');
    await act(async () => {
      mounted = await mountWebPage({
        window: dom.window as unknown as Window,
        element: document.getElementById('root')!,
        client: port,
      });
    });
    await settle(() => !!document.querySelector('[data-message-id="a-3"]'));
    await settle(() => document.body.textContent!.includes(fullModel));
    expect(document.querySelector('.model-output-message > button')).toBeNull();
    expect(document.querySelector('.model-output-message > p')).toBeNull();
    const first = copyButton('a-1');
    expect(first).not.toBeNull();
    expect(copyButton('a-2')).not.toBeNull();
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(
      (dom.window as unknown as { originalExecuted?: boolean }).originalExecuted,
    ).toBeUndefined();
    first!.focus();
    expect(document.activeElement).toBe(first);
    // JSDOM has no native Enter activation; deliver the browser's resulting click to its focused button.
    first!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await click(first!);
    expect(copied).toEqual([raw[0]!]);
    expect(first!.getAttribute('aria-label')).toBe('已复制消息');
    await act(async () => {
      await Bun.sleep(1500);
    });
    expect(first!.getAttribute('aria-label')).toBe('已复制消息');
    await settle(() => first!.getAttribute('aria-label') === '复制本轮用户消息');
    expect(first!.querySelector('svg')).not.toBeNull();
    clipboardMode = 'fail';
    await click(copyButton('a-2')!);
    const second = document.querySelector<HTMLButtonElement>(
      '[data-message-id="a-2"] button.message-copy',
    )!;
    expect(second.getAttribute('aria-label')).toContain('失败');
    clipboardMode = 'ok';
    await click(second);
    expect(second.getAttribute('aria-label')).toBe('已复制消息');
    expect(copied).toEqual([raw[0]!, raw[1]!, raw[1]!]);
    expect(document.body.textContent).toContain(fullModel);
    expect(originals).toEqual(before);
    await settle(() => first!.getAttribute('aria-label') === '复制本轮用户消息');
    clipboardMode = 'hold';
    await click(first!);
    expect(copied.at(-1)).toBe(raw[0]);
    dom.window.history.pushState(null, '', '/sessions/b');
    await act(async () => dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')));
    await settle(() => !!document.querySelector('[data-message-id="b-1"]'));
    await act(async () => {
      finish();
    });
    expect(copyButton('b-1')).not.toBeNull();
    expect(document.querySelector('[aria-label="已复制消息"]')).toBeNull();
    expect(document.querySelector('[aria-label*="失败"]')).toBeNull();
    expect(document.querySelector('[data-message-id="a-1"]')).toBeNull();
    expect(originals).toEqual(before);
    expect(
      reads.every((read) =>
        [
          'connect',
          'listAllWorkspaces',
          'listAllSessionDirectory',
          'getView',
          'listMessages',
          'getModelOutput',
          'closeBrowserSession',
        ].includes(read),
      ),
    ).toBe(true);
    expect(reads.filter((read) => read === 'getModelOutput')).toHaveLength(1);
  } finally {
    await act(async () => mounted?.dispose());
    dom.window.close();
    restoreGlobals();
  }
}, 15000);
