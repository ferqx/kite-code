import { expect, test } from 'bun:test';
import type { Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeConversationResult,
  NativeDraft,
  NativeRequest,
  NativeState,
} from '../../src/native-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const previous = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { NativeDesktop } = await import('../../src/native');
Object.assign(globalThis, previous);
bootstrap.window.close();

test('actual React DOM keeps the new selected view when an original creation receipt arrives late; no draft is moved', async () => {
  const dom = new JSDOM('<div id="test-root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayoutGlobals = prepareDesktopDom(dom);
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let selected = 'a',
    release!: (value: NativeConversationResult) => void,
    posts = 0,
    submitted: Extract<NativeRequest, { method: 'conversation.send' }> | undefined;
  const creation = new Promise<NativeConversationResult>((r) => {
    release = r;
  });
  const sessions = ['a', 'b'].map((id) => ({
    id,
    workspaceId: 'w',
    rootSessionId: id,
    parentSessionId: null,
    title: id === 'a' ? 'Original A' : 'Other B',
    nextSeq: '0',
    deletedAt: null,
  })) as Session[];
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: [],
    selection: {
      viewGeneration: 1,
      canReadModelOutput: false,
      storeId: 'store',
      session: sessions.find((s) => s.id === selected)!,
      runs: [],
      executions: [],
      interactions: [],
      interactionsAfterId: null,
    },
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      if (input.method === 'attach' || input.method === 'state') return state();
      if (input.method === 'directory')
        return {
          storeId: 'store',
          workspaces: [
            { id: 'w', name: 'Workspace', rootUri: 'file:///workspace' },
          ] as import('@kite-ai/client').Workspace[],
          sessions,
        };
      if (input.method === 'select') {
        selected = input.sessionId;
        return state();
      }
      if (input.method === 'messages')
        return { messages: [], nextAfterSeq: null, highWaterSeq: '0' };
      if (input.method === 'draft.read')
        return {
          id: input.sessionId,
          storeId: 'store',
          workspaceId: 'w',
          rootSessionId: input.sessionId,
          revision: 1,
          content: input.sessionId === 'a' ? 'original text' : 'other text',
        } as NativeDraft;
      if (input.method === 'conversation.branch')
        return {
          kind: 'conversation.branch',
          storeId: 'store',
          workspaceId: 'w',
          repository: false,
          branches: [],
          label: '本地目录',
        };
      if (input.method === 'conversation.models.read')
        return {
          kind: 'settings.models',
          storeId: 'store',
          scope: 'user',
          observationId: 1,
          canWrite: false,
          errors: [],
          defaultModelId: 'model',
          models: [{ id: 'model', enabled: true, configured: true, diagnostics: [] }],
        };
      if (input.method === 'conversation.send') {
        submitted = input;
        posts++;
        return creation;
      }
      return null;
    },
  };
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge });
  const root = createRoot(dom.window.document.getElementById('test-root')!);
  const click = async (name: string) =>
    act(async () => {
      const button = [...dom.window.document.querySelectorAll('button')].find(
        (b) => b.textContent === name || b.getAttribute('aria-label') === name,
      )!;
      expect(button).toBeDefined();
      button.click();
    });
  try {
    await act(async () => root.render(<NativeDesktop />));
    await click('Original A');
    expect(dom.window.document.querySelector('textarea')!.value).toBe('original text');
    await click('在 Workspace 中新建对话');
    expect(posts).toBe(0);
    await click('研究与理解资料');
    await click('发送首条消息');
    expect(posts).toBe(1);
    await click('Other B');
    expect(dom.window.document.querySelector('textarea')!.value).toBe('other text');
    await act(async () =>
      release({
        kind: 'conversation',
        commandId: submitted!.intent.commandId,
        phase: 'accepted',
        stage: 'input',
        creation: { phase: 'created', input: submitted!.creation },
      }),
    );
    expect(
      [...dom.window.document.querySelectorAll('.session-header strong')].some(
        (heading) => heading.textContent === 'Other B',
      ),
    ).toBe(true);
    expect(selected).toBe('b');
    expect(posts).toBe(1);
    expect(dom.window.document.querySelector('textarea')!.value).toBe('other text');
    const composer = dom.window.document.querySelector('textarea'),
      conversation = dom.window.document.querySelector('[aria-label="会话消息"]');
    expect(composer).not.toBeNull();
    expect(conversation).not.toBeNull();
    await click('会话工具');
    expect(dom.window.document.querySelector('#native-session-tools')).not.toBeNull();
    expect(dom.window.document.querySelector('[aria-label="会话消息"]')).toBe(conversation);
    await act(async () =>
      (dom.window.document.querySelector('.right-sidebar-close') as HTMLButtonElement).click(),
    );
    expect(dom.window.document.querySelector('#native-session-tools')).toBeNull();
    expect(dom.window.document.querySelector('[aria-label="会话消息"]')).toBe(conversation);
    expect(dom.window.document.querySelector('textarea')).toBe(composer);
    expect(dom.window.document.querySelector('textarea')!.value).toBe('other text');
    expect(posts).toBe(1);
  } finally {
    if (submitted)
      release({
        kind: 'conversation',
        commandId: submitted.intent.commandId,
        phase: 'unknown',
        stage: 'create',
      });
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    restoreLayoutGlobals();
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
