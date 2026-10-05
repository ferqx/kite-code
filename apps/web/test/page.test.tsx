import { expect, test } from 'bun:test';
import { type BrowserView, ClientError, type Message } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { mountWebPage } from '../src/mount';

function view(id: string, active = false): BrowserView {
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
    runs: [
      {
        id: `run-${id}`,
        sessionId: id,
        originCommandId: 'command',
        originStoreId: 'store',
        status: active ? 'waiting_execution' : 'cancelled',
        isActive: active,
        createdAt: 1,
        finishedAt: active ? null : 2,
        reason: null,
      },
    ],
    executions: [
      {
        id: `execution-${id}`,
        sessionId: id,
        runId: `run-${id}`,
        kind: 'tool',
        definitionId: 'fixture.read',
        definitionVersion: '1',
        status: 'outcome_unknown',
        resultRevision: '1',
        cancelRequestedAt: null,
      },
    ],
  };
}
function body(id: string, seq: number): Message {
  return {
    id: `${id}-${seq}`,
    sessionId: id,
    runId: `run-${id}`,
    seq: String(seq),
    status: 'complete',
    role: 'assistant',
    content:
      seq === 1
        ? `# ${id} body 1\n\n- List\n\n> Quote\n\n\`\`\`ts\ncode\n\`\`\`\n\n| Header |\n| --- |\n| Cell |\n\n![Alt](https://invalid.example/image.png) [File](../file.ts)\n\n<script>not executable</script>`
        : `${id} body ${seq} <script>not executable</script>`,
  };
}
async function settle(check: () => boolean) {
  const end = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > end) throw new Error('dom_deadline');
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}
async function fixture(
  options: { active?: boolean; wrongIdentity?: boolean; modelOutput?: boolean } = {},
) {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="kite-web-identity" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"></head><body><div id="root"></div></body></html>',
    { url: 'http://127.0.0.1:31000/', pretendToBeVisual: true },
  );
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const state = {
    fail: false,
    connections: 0,
    resumeIdentityFailure: false,
    resumeGate: undefined as Promise<void> | undefined,
    reads: 0,
    pages: 0,
    closed: 0,
    active: options.active ?? false,
    held: undefined as Promise<void> | undefined,
    release: undefined as (() => void) | undefined,
    tool: false,
    extra: false,
    copied: '',
    outputReads: 0,
    outputBody: 'FULL RECORDED ANSWER exact tail',
  };
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(content: string) {
        state.copied = content;
      },
    },
  });
  const client = {
    serverInfo: { storeId: 'store', capabilities: options.modelOutput ? ['model_outputs'] : [] },
    async connect() {
      state.connections++;
      if (state.connections > 1 && state.resumeGate) await state.resumeGate;
      if (state.resumeIdentityFailure) throw new ClientError('browser_identity_mismatch');
      if (options.wrongIdentity) throw new ClientError('browser_identity_mismatch');
      return { storeId: 'store' };
    },
    async listAllWorkspaces() {
      return [{ id: 'w', name: 'Workspace' }];
    },
    async listAllSessions() {
      return [view('a').session, view('b').session];
    },
    async getView(id: string) {
      state.reads++;
      if (id === 'a' && state.held) await state.held;
      if (state.fail) throw new ClientError('browser_read_unavailable');
      const result = view(id, state.active);
      if (state.extra) result.session.nextSeq = '202';
      return result;
    },
    async listMessages(id: string, input: { afterSeq?: string }) {
      state.pages++;
      return input.afterSeq
        ? [
            {
              ...body(id, 201),
              ...(options.modelOutput
                ? {
                    content: 'OUTPUT PREVIEW',
                    outputBody: {
                      kind: 'model_output' as const,
                      executionId: 'model',
                      complete: true,
                      contentBytes: String(new TextEncoder().encode(state.outputBody).length),
                      reasoningBytes: '0',
                      toolCallCount: 0,
                    },
                  }
                : {}),
              ...(state.tool
                ? { role: 'tool' as const, content: '# Tool output\n\nFull detail' }
                : {}),
            },
            ...(state.extra ? [body(id, 202)] : []),
          ]
        : Array.from({ length: 200 }, (_, i) => body(id, i + 1));
    },
    async getModelOutput(id: string, executionId: string) {
      state.outputReads++;
      return {
        storeId: 'store',
        sessionId: id,
        rootSessionId: id,
        runId: `run-${id}`,
        executionId,
        originCommandId: 'command',
        rootWorkCommandId: 'command',
        rootWorkSeq: '1',
        attempt: 1,
        status: 'succeeded',
        bodyHash: 'a'.repeat(64),
        bodyBytes: '1',
        contentBytes: String(new TextEncoder().encode(state.outputBody).length),
        reasoningBytes: '0',
        snapshotCursor: '1',
        output: { content: state.outputBody, reasoning: '', toolCalls: [], complete: true },
      };
    },
    async closeBrowserSession() {
      state.closed++;
    },
  } as unknown as BrowserClient;
  let handle!: Awaited<ReturnType<typeof mountWebPage>>;
  await act(async () => {
    handle = await mountWebPage({
      window: dom.window as unknown as Window,
      element: dom.window.document.getElementById('root')!,
      client,
      pollIntervalMs: 100,
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
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('React browser page navigates directory, renders all 201 history messages and preserves exact failure/unknown statuses without write controls', async () => {
  const f = await fixture();
  try {
    await f.click(f.button('Workspace'));
    await settle(() => !!f.dom.window.document.querySelector('a[href="/sessions/a"]'));
    await f.choose('a');
    await settle(() => f.dom.window.document.querySelectorAll('[data-message-id]').length === 201);
    expect(f.dom.window.location.pathname).toBe('/sessions/a');
    expect(f.dom.window.document.querySelector('h1')?.textContent).toBe('Session a');
    expect(f.dom.window.document.querySelector('[aria-label="History"]')?.textContent).toContain(
      'a body 201',
    );
    expect(f.dom.window.document.querySelector('[aria-label="Run status"]')?.textContent).toContain(
      'cancelled',
    );
    expect(
      f.dom.window.document.querySelector('[aria-label="Execution status"]')?.textContent,
    ).toContain('outcome_unknown');
    expect(f.dom.window.document.querySelectorAll('input,textarea,form,script,img')).toHaveLength(
      0,
    );
    const firstBody = f.dom.window.document.querySelector('[data-message-id="a-1"]')!;
    expect(firstBody.querySelector('h1')?.textContent).toBe('a body 1');
    expect(firstBody.querySelectorAll('ul,blockquote,pre,table')).toHaveLength(4);
    expect(firstBody.textContent).toContain('<script>not executable</script>');
    expect(firstBody.querySelector('a[href="../file.ts"]')).toBeNull();
    expect(
      [...f.dom.window.document.querySelectorAll('button')].some((button) =>
        /^(Send|Cancel|Approve|Run)$/.test(button.textContent ?? ''),
      ),
    ).toBe(false);
    f.state.fail = true;
    await f.click(f.button('Refresh history'));
    await settle(() => f.dom.window.document.body.textContent!.includes('Stale'));
    expect(f.dom.window.document.querySelectorAll('[data-message-id]')).toHaveLength(201);
    expect(f.dom.window.document.body.textContent).toContain('Last known history');
    f.state.fail = false;
    await f.click(f.button('Refresh history'));
    await settle(() => f.dom.window.document.body.textContent!.includes('History synchronized'));
    await f.choose('b');
    await settle(() => f.dom.window.document.querySelector('h1')?.textContent === 'Session b');
    f.dom.window.history.pushState(null, '', '/sessions/a');
    await act(async () => f.dom.window.dispatchEvent(new f.dom.window.PopStateEvent('popstate')));
    await settle(() => f.dom.window.document.querySelector('h1')?.textContent === 'Session a');
    expect(f.state.closed).toBe(0);
  } finally {
    await f.close();
  }
});

test('DOM visibility controls actual activity polling, navigation blocks late A responses and root navigation stops selection', async () => {
  const f = await fixture({ active: true });
  try {
    await f.click(f.button('Workspace'));
    await settle(() => !!f.dom.window.document.querySelector('a[href="/sessions/a"]'));
    f.state.held = new Promise<void>((resolve) => {
      f.state.release = resolve;
    });
    await f.choose('a');
    await settle(() => f.state.reads > 0);
    await f.choose('b');
    await settle(() => f.dom.window.document.querySelector('h1')?.textContent === 'Session b');
    f.state.release!();
    f.state.held = undefined;
    await act(async () => {
      await Bun.sleep(20);
    });
    expect(f.dom.window.document.querySelector('h1')?.textContent).toBe('Session b');
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange')),
    );
    const hidden = f.state.reads;
    await act(async () => {
      await Bun.sleep(40);
    });
    expect(f.state.reads).toBe(hidden);
    Object.defineProperty(f.dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange')),
    );
    await settle(() => f.state.reads > hidden);
    await f.click(f.dom.window.document.querySelector('a[href="/"]')!);
    const unselected = f.state.reads;
    await act(async () => {
      await Bun.sleep(40);
    });
    expect(f.state.reads).toBe(unselected);
    expect(f.dom.window.document.body.textContent).toContain('Select a session');
    expect(f.state.closed).toBe(0);
  } finally {
    f.state.release?.();
    await f.close();
  }
});

test('identity refusal renders a blocking read-only error with zero directory/history reads; pagehide releases only browser session', async () => {
  const refused = await fixture({ wrongIdentity: true });
  try {
    expect(refused.dom.window.document.body.textContent).toContain('browser_identity_mismatch');
    expect(refused.state.reads).toBe(0);
    expect(refused.state.pages).toBe(0);
    expect(refused.dom.window.document.querySelector('nav')).toBeNull();
  } finally {
    await refused.close();
  }
  const active = await fixture();
  try {
    await act(async () => active.dom.window.dispatchEvent(new active.dom.window.Event('pagehide')));
    expect(active.state.closed).toBe(1);
    expect(active.dom.window.document.getElementById('root')?.textContent).toBe('');
  } finally {
    await active.close();
  }
});

test('session reading keeps original position and tool expansion; visible copy and select-all stay in history', async () => {
  const f = await fixture();
  try {
    f.state.tool = true;
    await f.click(f.button('Workspace'));
    await settle(() => !!f.dom.window.document.querySelector('a[href="/sessions/a"]'));
    await f.choose('a');
    await settle(() => f.dom.window.document.querySelectorAll('[data-message-id]').length === 201);
    const history = f.dom.window.document.querySelector('[aria-label="History"]') as HTMLElement;
    Object.defineProperties(history, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    history.scrollTop = 125;
    await act(async () =>
      history.dispatchEvent(new f.dom.window.Event('scroll', { bubbles: true })),
    );
    expect(f.button('Back to latest messages')).toBeDefined();
    f.state.extra = true;
    await f.click(f.button('Refresh history'));
    await settle(() => f.dom.window.document.querySelectorAll('[data-message-id]').length === 202);
    expect(history.scrollTop).toBe(125);
    const details = history.querySelector('details')!;
    details.open = true;
    await act(async () => details.dispatchEvent(new f.dom.window.Event('toggle')));
    await f.click(f.button('Copy conversation'));
    expect(f.state.copied).toContain('a body 1');
    expect(f.state.copied).toContain('# Tool output');
    expect(f.state.copied).not.toContain('Workspace');
    expect(f.state.copied).not.toContain('run-a');
    const select = new f.dom.window.KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    f.dom.window.document.body.dispatchEvent(select);
    expect(select.defaultPrevented).toBe(true);
    expect(f.dom.window.getSelection()!.getRangeAt(0).commonAncestorContainer).toBe(history);
    const input = f.dom.window.document.createElement('textarea');
    f.dom.window.document.body.append(input);
    const editable = new f.dom.window.KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(editable);
    expect(editable.defaultPrevented).toBe(false);
    input.remove();
    await f.choose('b');
    await settle(() => f.dom.window.document.querySelector('h1')?.textContent === 'Session b');
    await f.choose('a');
    await settle(() => f.dom.window.document.querySelector('h1')?.textContent === 'Session a');
    const restoredHistory = f.dom.window.document.querySelector(
      '[aria-label="History"]',
    ) as HTMLElement;
    expect(restoredHistory.scrollTop).toBe(125);
    expect(restoredHistory.querySelector('details')!.open).toBe(true);
    Object.defineProperties(restoredHistory, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    await f.click(f.button('Back to latest messages'));
    expect(restoredHistory.scrollTop).toBe(1000);
    restoredHistory.querySelector('details')!.open = false;
    await act(async () =>
      restoredHistory.querySelector('details')!.dispatchEvent(new f.dom.window.Event('toggle')),
    );
    await f.click(f.button('Copy conversation'));
    expect(f.state.copied).not.toContain('Full detail');
  } finally {
    await f.close();
  }
});

test('persisted pagehide retains document/reading state, pauses reads, and pageshow verifies original identity before resuming', async () => {
  const f = await fixture({ active: true });
  let resume!: () => void;
  try {
    await f.click(f.button('Workspace'));
    await settle(() => !!f.dom.window.document.querySelector('a[href="/sessions/a"]'));
    await f.choose('a');
    await settle(() => f.dom.window.document.querySelectorAll('[data-message-id]').length === 201);
    const history = f.dom.window.document.querySelector('[aria-label="History"]') as HTMLElement;
    Object.defineProperties(history, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    history.scrollTop = 123;
    await act(async () =>
      history.dispatchEvent(new f.dom.window.Event('scroll', { bubbles: true })),
    );
    await act(async () =>
      f.dom.window.dispatchEvent(
        new f.dom.window.PageTransitionEvent('pagehide', { persisted: true }),
      ),
    );
    const pausedReads = f.state.reads;
    expect(f.state.closed).toBe(0);
    expect(f.dom.window.document.querySelector('[aria-label="History"]')).toBe(history);
    expect(f.dom.window.document.querySelector('.web-page')?.hasAttribute('inert')).toBe(true);
    await act(async () =>
      f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange')),
    );
    await act(async () => {
      await Bun.sleep(120);
    });
    expect(f.state.reads).toBe(pausedReads);
    f.state.resumeGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    await act(async () =>
      f.dom.window.dispatchEvent(
        new f.dom.window.PageTransitionEvent('pageshow', { persisted: true }),
      ),
    );
    expect(f.state.connections).toBe(2);
    expect(f.state.reads).toBe(pausedReads);
    await act(async () => resume());
    await settle(() => f.state.reads > pausedReads);
    expect(f.dom.window.document.querySelector('[aria-label="History"]')).toBe(history);
    expect(history.scrollTop).toBe(123);
    expect(f.dom.window.document.querySelector('.web-page')?.hasAttribute('inert')).toBe(false);
    expect(f.state.closed).toBe(0);
  } finally {
    resume?.();
    await f.close();
  }
});

test('bfcache restore identity failure preserves original document paused, issues no business read and never closes Runtime', async () => {
  const f = await fixture();
  try {
    await f.click(f.button('Workspace'));
    await settle(() => !!f.dom.window.document.querySelector('a[href="/sessions/a"]'));
    await f.choose('a');
    await settle(() => f.dom.window.document.querySelectorAll('[data-message-id]').length === 201);
    await act(async () =>
      f.dom.window.dispatchEvent(
        new f.dom.window.PageTransitionEvent('pagehide', { persisted: true }),
      ),
    );
    const reads = f.state.reads,
      pages = f.state.pages;
    f.state.resumeIdentityFailure = true;
    await act(async () =>
      f.dom.window.dispatchEvent(
        new f.dom.window.PageTransitionEvent('pageshow', { persisted: true }),
      ),
    );
    expect(f.dom.window.document.body.textContent).toContain('browser_identity_mismatch');
    expect(f.dom.window.document.querySelectorAll('[data-message-id]')).toHaveLength(201);
    expect(f.dom.window.document.querySelector('.web-page')?.hasAttribute('inert')).toBe(true);
    expect(f.state.reads).toBe(reads);
    expect(f.state.pages).toBe(pages);
    expect(f.state.closed).toBe(0);
    await act(async () =>
      f.dom.window.dispatchEvent(
        new f.dom.window.PageTransitionEvent('pagehide', { persisted: false }),
      ),
    );
    expect(f.state.closed).toBe(1);
    expect(f.dom.window.document.getElementById('root')?.textContent).toBe('');
  } finally {
    await f.close();
  }
});

test('Web copies loaded full Model output only while visible, closes to preview and does not retain body across session selection', async () => {
  const f = await fixture({ modelOutput: true });
  try {
    await f.click(f.button('Workspace'));
    await settle(() => !!f.dom.window.document.querySelector('a[href="/sessions/a"]'));
    await f.choose('a');
    await settle(() => f.dom.window.document.querySelectorAll('[data-message-id]').length === 201);
    expect(f.state.outputReads).toBe(0);
    await f.click(f.button('Read complete recorded Model output'));
    await settle(() => f.dom.window.document.body.textContent!.includes(f.state.outputBody));
    await f.click(f.button('Copy conversation'));
    expect(f.state.copied).toContain(f.state.outputBody);
    expect(f.state.copied).not.toContain('OUTPUT PREVIEW');
    await f.click(f.button('Close full Model output'));
    await f.click(f.button('Copy conversation'));
    expect(f.state.copied).toContain('OUTPUT PREVIEW');
    expect(f.state.copied).not.toContain(f.state.outputBody);
    await f.click(f.button('Read complete recorded Model output'));
    await f.choose('b');
    await settle(() => f.dom.window.document.querySelector('h1')?.textContent === 'Session b');
    await f.choose('a');
    await settle(() => f.dom.window.document.querySelector('h1')?.textContent === 'Session a');
    expect(f.dom.window.document.body.textContent).not.toContain(f.state.outputBody);
    expect(f.state.closed).toBe(0);
  } finally {
    await f.close();
  }
});
