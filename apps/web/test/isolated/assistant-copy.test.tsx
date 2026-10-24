import { expect, test } from 'bun:test';
import type { BrowserView, Message, ModelOutputSnapshot } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createTrustedAssets } from '../../src/assets';
import { installGlobals } from '../globals.fixture';

const first = 'First raw paragraph 🌿e\u0301\r\nEXACT first';
const last = 'Final raw paragraph 東京\r\nEXACT last';
async function settle(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= end) throw new Error('assistant_copy_dom_deadline');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}
function run(id: string, sessionId: string, status = 'completed') {
  return {
    id,
    sessionId,
    originCommandId: 'original-command',
    originStoreId: 'store',
    status,
    isActive: status === 'running',
    createdAt: 1,
    finishedAt: status === 'running' ? null : 2,
    reason: null,
  };
}
function view(id: string): BrowserView {
  return {
    storeId: 'store',
    snapshotCursor: '1',
    session: {
      id,
      workspaceId: 'w',
      parentSessionId: null,
      title: `Session ${id}`,
      controlRevision: '1',
      contextSelectionId: 'selection',
      nextSeq: '201',
      deletedAt: null,
    },
    runs: [],
    executions: [],
  };
}
async function fixture(bodyMode = false) {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="kite-web-identity" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"></head><body><div id="root"></div></body></html>',
    { url: 'http://127.0.0.1:31000/', pretendToBeVisual: true },
  );
  const productionAssets = await createTrustedAssets('');
  const style = dom.window.document.createElement('style');
  style.textContent = productionAssets.assets.get('/app.css')!.content;
  dom.window.document.head.append(style);
  const restoreGlobals = installGlobals({
    window: dom.window,
    document: dom.window.document,
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
  const { mountWebPage } = await import('../../src/mount');
  const state = {
    compact: false,
    copied: '',
    pages: 0,
    runReads: [] as { sessionId: string; runId: string }[],
    outputReads: [] as string[],
    status: 'completed',
    sealed: false,
    unsupported: false,
    incomplete: false,
    hold: undefined as Promise<void> | undefined,
    outputHolds: new Map<string, Promise<void>>(),
  };
  const messages = (id: string): Message[] => {
    const rows: Message[] = Array.from({ length: 201 }, (_, index) => ({
      id: `${id}-${index + 1}`,
      sessionId: id,
      runId: null,
      seq: String(index + 1),
      role: 'user',
      status: 'complete',
      content: `Other original user ${index}`,
    }));
    const common = { sessionId: id, runId: 'original-run', status: 'complete' as const };
    rows[0] = {
      ...common,
      id: `${id}-first`,
      seq: '1',
      role: 'assistant',
      content: bodyMode ? 'FIRST PREVIEW' : first,
      toolCalls: [{ id: 'call', name: 'fixture.tool', arguments: 'DO_NOT_COPY_TOOL_ARGUMENTS' }],
    };
    rows[1] = {
      ...common,
      id: `${id}-tool`,
      seq: '2',
      role: 'tool',
      content: 'DO_NOT_COPY_TOOL_OUTPUT',
    };
    rows[2] = {
      ...common,
      runId: null,
      id: `${id}-sealed`,
      seq: '3',
      role: 'assistant',
      content: 'DO_NOT_COPY_CHILD_OR_SEALED',
      originMessage: {
        storeId: 'store',
        sessionId: 'child',
        messageId: 'child-message',
        runId: 'child-run',
      },
    };
    rows[200] = {
      ...common,
      id: `${id}-last`,
      seq: '201',
      role: 'assistant',
      content: bodyMode ? 'LAST PREVIEW' : last,
    };
    if (state.sealed)
      for (const row of [rows[0]!, rows[200]!])
        row.originMessage = {
          storeId: 'store',
          sessionId: 'source',
          messageId: row.id,
          runId: 'original-run',
        };
    if (state.unsupported) rows[200]!.contentFormat = 'unsupported';
    if (bodyMode)
      for (const [row, text, index] of [
        [rows[0]!, first, 0],
        [rows[200]!, last, 1],
      ] as const)
        row.outputBody = {
          kind: 'model_output',
          executionId: `model-${index}`,
          complete: !state.incomplete,
          contentBytes: String(new TextEncoder().encode(text).length),
          reasoningBytes: String(new TextEncoder().encode('DO_NOT_COPY_REASONING').length),
          toolCallCount: index === 0 ? 1 : 0,
        };
    return state.compact ? [rows[0]!, rows[1]!, rows[200]!] : rows;
  };
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text: string) {
        state.copied = text;
      },
    },
  });
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['runs', 'model_outputs'] },
    async connect() {
      return { storeId: 'store' };
    },
    async listAllWorkspaces() {
      return [{ id: 'w', name: 'Workspace' }];
    },
    async listAllSessionDirectory() {
      return ['a', 'b'].map((id, index) => ({
        seq: String(index + 1),
        session: view(id).session,
        activity: { updatedAt: null, run: null, queued: false, pendingInteractions: 0 },
      }));
    },
    async getView(id: string) {
      return view(id);
    },
    async listMessages(id: string, input: { afterSeq?: string }) {
      state.pages++;
      const rows = messages(id);
      return input.afterSeq ? rows.slice(200) : rows.slice(0, 200);
    },
    async getRun(sessionId: string, runId: string) {
      state.runReads.push({ sessionId, runId });
      return { storeId: 'store', run: run(runId, sessionId, state.status) };
    },
    async getModelOutput(sessionId: string, executionId: string) {
      state.outputReads.push(executionId);
      if (state.hold) await state.hold;
      const held = state.outputHolds.get(executionId);
      if (held) await held;
      const index = executionId === 'model-0' ? 0 : 1,
        content = index === 0 ? first : last;
      return {
        storeId: 'store',
        sessionId,
        rootSessionId: sessionId,
        runId: 'original-run',
        executionId,
        originCommandId: 'original-command',
        rootWorkCommandId: 'original-command',
        rootWorkSeq: '1',
        attempt: 1,
        status: 'succeeded',
        bodyHash: 'a'.repeat(64),
        bodyBytes: '1',
        contentBytes: String(new TextEncoder().encode(content).length),
        reasoningBytes: String(new TextEncoder().encode('DO_NOT_COPY_REASONING').length),
        snapshotCursor: '1',
        output: {
          content,
          reasoning: 'DO_NOT_COPY_REASONING',
          complete: !state.incomplete,
          toolCalls:
            index === 0 && !state.incomplete
              ? [{ id: 'call', name: 'fixture.tool', arguments: 'DO_NOT_COPY_TOOL_ARGUMENTS' }]
              : [],
        },
      } as ModelOutputSnapshot;
    },
    async closeBrowserSession() {},
  } as unknown as BrowserClient;
  let handle!: Awaited<ReturnType<typeof mountWebPage>>;
  await act(async () => {
    handle = await mountWebPage({
      window: dom.window as unknown as Window,
      element: dom.window.document.getElementById('root')!,
      client,
      pollIntervalMs: 60000,
    });
  });
  function button(text: string) {
    return [...dom.window.document.querySelectorAll('button')].find(
      (element) => element.textContent === text,
    )!;
  }
  async function click(element: Element) {
    await act(async () =>
      element.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      ),
    );
  }
  async function choose(id: string) {
    await click(dom.window.document.querySelector(`a[href="/sessions/${id}"]`)!);
  }
  return {
    dom,
    state,
    button,
    click,
    choose,
    async close() {
      await act(async () => handle.dispose());
      dom.window.close();
      restoreGlobals();
    },
  };
}

async function open(f: Awaited<ReturnType<typeof fixture>>) {
  await f.click(f.button('Workspace'));
  await settle(() => !!f.dom.window.document.querySelector('a[href="/sessions/a"]'));
  await f.choose('a');
  await settle(() => f.dom.window.document.querySelectorAll('[data-message-id]').length === 201);
}
const assistantButtons = (f: Awaited<ReturnType<typeof fixture>>) =>
  [...f.dom.window.document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.getAttribute('aria-label') === '复制本轮Agent回复',
  );

test('Web copies the exact completed historical Run across all message pages including intermediate tool-call prose', async () => {
  const f = await fixture();
  try {
    await open(f);
    await act(async () => {
      await Bun.sleep(10);
    });
    expect(assistantButtons(f)).toHaveLength(1);
    expect(
      assistantButtons(f)[0]!.closest('[data-message-id]')?.getAttribute('data-message-id'),
    ).toBe('a-last');
    const finalArticle = assistantButtons(f)[0]!.closest('article')!;
    expect(finalArticle.getAttribute('data-final-reply')).toBe('true');
    expect(f.dom.window.getComputedStyle(finalArticle).position).toBe('relative');
    expect(f.dom.window.getComputedStyle(finalArticle).paddingBottom).toBe('32px');
    const intermediate = f.dom.window.document.querySelector('[data-message-id="a-first"]')!;
    expect(f.dom.window.getComputedStyle(intermediate).paddingBottom).toBe('8px');
    expect(f.state.pages).toBe(2);
    expect(f.state.runReads).toContainEqual({ sessionId: 'a', runId: 'original-run' });
    expect(f.state.outputReads).toHaveLength(0);
    await f.click(assistantButtons(f)[0]!);
    expect(f.state.copied).toBe(`${first}\n\n${last}`);
    expect(f.state.copied).not.toContain('DO_NOT_COPY');
    expect(f.state.copied).not.toContain('Other original user');
    expect(
      f.dom.window.document.querySelector('[data-message-id="a-first"] .message-copy'),
    ).toBeNull();
    expect(
      f.dom.window.document.querySelector('[data-message-id="a-tool"] .message-copy'),
    ).toBeNull();
    await f.choose('b');
    await settle(() => !!f.dom.window.document.querySelector('[data-message-id="b-last"]'));
    expect(f.dom.window.document.querySelector('[data-copy-state="copied"]')).toBeNull();
  } finally {
    await f.close();
  }
}, 10000);

test('Web requires every exact original Model body and retires a late read when its Session closes', async () => {
  const f = await fixture(true);
  let releaseFirst!: () => void,
    releaseLast!: () => void,
    releaseB!: () => void,
    releaseA!: () => void;
  f.state.outputHolds.set(
    'model-0',
    new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }),
  );
  f.state.outputHolds.set(
    'model-1',
    new Promise<void>((resolve) => {
      releaseLast = resolve;
    }),
  );
  try {
    await open(f);
    expect(assistantButtons(f)).toHaveLength(0);
    await settle(() => f.state.outputReads.length === 2);
    expect(f.dom.window.document.querySelector('.model-output-message > button')).toBeNull();
    const finalArticle = () => f.dom.window.document.querySelector('[data-message-id="a-last"]')!;
    await settle(() => finalArticle().getAttribute('data-final-reply') === 'true');
    expect(f.dom.window.getComputedStyle(finalArticle()).paddingBottom).toBe('32px');
    await act(async () => releaseFirst());
    expect(assistantButtons(f)).toHaveLength(0);
    await act(async () => releaseLast());
    await settle(() => assistantButtons(f).length === 1);
    expect(f.state.outputReads).toEqual(['model-0', 'model-1']);
    await f.click(assistantButtons(f)[0]!);
    expect(f.state.copied).toBe(`${first}\n\n${last}`);
    expect(f.state.copied).not.toContain('DO_NOT_COPY_REASONING');
    expect(finalArticle().getAttribute('data-final-reply')).toBe('true');
    expect(finalArticle().getAttribute('data-final-reply')).toBe('true');
    expect(f.dom.window.getComputedStyle(finalArticle()).paddingBottom).toBe('32px');
    f.state.hold = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    await f.choose('b');
    await settle(() => !!f.dom.window.document.querySelector('[data-message-id="b-last"]'));
    await settle(() => f.state.outputReads.length === 4);
    expect(assistantButtons(f)).toHaveLength(0);
    f.state.hold = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    await f.choose('a');
    await settle(() => !!f.dom.window.document.querySelector('[data-message-id="a-last"]'));
    await settle(() => f.state.outputReads.length === 6);
    await act(async () => releaseB());
    expect(assistantButtons(f)).toHaveLength(0);
    expect(f.dom.window.document.querySelector('[data-message-id="b-last"]')).toBeNull();
    await act(async () => releaseA());
    await settle(() => assistantButtons(f).length === 1);
    await f.click(assistantButtons(f)[0]!);
    expect(f.state.copied).toBe(`${first}\n\n${last}`);
  } finally {
    releaseFirst?.();
    releaseLast?.();
    releaseB?.();
    releaseA?.();
    await f.close();
  }
}, 10000);

test('Web never labels unfinished, unsuccessful, sealed, unsupported or incomplete Run output as a complete copy', async () => {
  for (const boundary of [
    'running',
    'cancelled',
    'failed',
    'interrupted',
    'sealed',
    'unsupported',
    'incomplete',
  ]) {
    const f = await fixture(boundary === 'incomplete');
    try {
      if (boundary === 'sealed') f.state.sealed = true;
      else if (boundary === 'unsupported') f.state.unsupported = true;
      else if (boundary === 'incomplete') f.state.incomplete = true;
      else f.state.status = boundary;
      await open(f);
      await act(async () => {
        await Bun.sleep(20);
      });
      expect(assistantButtons(f)).toHaveLength(0);
      expect(f.state.outputReads).toHaveLength(boundary === 'incomplete' ? 2 : 0);
      expect(f.state.copied).toBe('');
    } finally {
      await f.close();
    }
  }
}, 10000);

test('Web production CSS keeps process, tool-to-final and turn gaps through automatic body reading and visibility pause', async () => {
  const f = await fixture(true);
  let release!: () => void;
  f.state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.state.compact = true;
    await f.click(f.button('Workspace'));
    await settle(() => !!f.dom.window.document.querySelector('a[href="/sessions/a"]'));
    await f.choose('a');
    await settle(() => f.dom.window.document.querySelectorAll('[data-message-id]').length === 3);
    const article = (part: string) =>
      f.dom.window.document.querySelector(`[data-message-id="a-${part}"]`)!;
    await settle(() => article('last').getAttribute('data-final-reply') === 'true');
    expect(f.dom.window.getComputedStyle(article('first')).paddingBottom).toBe('8px');
    expect(f.dom.window.getComputedStyle(article('tool')).paddingBottom).toBe('16px');
    expect(f.dom.window.getComputedStyle(article('last')).paddingBottom).toBe('32px');
    expect(assistantButtons(f)).toHaveLength(0);
    expect(f.dom.window.document.querySelector('.model-output-message > button')).toBeNull();
    await act(async () => release());
    await settle(() => assistantButtons(f).length === 1);
    expect(article('last').getAttribute('data-final-reply')).toBe('true');
    expect(f.dom.window.getComputedStyle(article('last')).paddingBottom).toBe('32px');
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange')),
    );
    await settle(() => assistantButtons(f).length === 0);
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange')),
    );
    await settle(() => article('last').getAttribute('data-final-reply') === 'true');
    expect(article('last').getAttribute('data-final-reply')).toBe('true');
    expect(f.dom.window.getComputedStyle(article('tool')).paddingBottom).toBe('16px');
  } finally {
    release?.();
    await f.close();
  }
}, 10000);
