import { expect, test } from 'bun:test';
import type { Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import type { NativeBridge, NativeCreation, NativeDraft, NativeState } from '../src/native-bridge';

test('actual React DOM keeps the new selected view when an original creation receipt arrives late; no draft is moved', async () => {
  const dom = new JSDOM('<div id="test-root"></div>', { url: 'http://localhost' });
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
    release!: (value: NativeCreation) => void,
    posts = 0;
  const creation = new Promise<NativeCreation>((r) => {
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
      if (input.method === 'createSession') {
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
        (b) => b.textContent === name,
      )!;
      expect(button).toBeDefined();
      button.click();
    });
  try {
    await act(async () => root.render(<NativeDesktop />));
    await click('Original A');
    expect(dom.window.document.querySelector('textarea')!.value).toBe('original text');
    await click('新建会话');
    expect(posts).toBe(1);
    await click('Other B');
    expect(dom.window.document.querySelector('textarea')!.value).toBe('other text');
    await act(async () =>
      release({
        phase: 'created',
        input: {
          expectedStoreId: 'store',
          workspaceId: 'w',
          commandId: 'original',
          sessionId: 'created',
          title: 'new',
        },
      }),
    );
    expect(
      [...dom.window.document.querySelectorAll('h2')].some(
        (heading) => heading.textContent === 'Other B',
      ),
    ).toBe(true);
    expect(selected).toBe('b');
    expect(posts).toBe(1);
    expect(dom.window.document.querySelector('textarea')!.value).toBe('other text');
  } finally {
    release({
      phase: 'unknown',
      input: {
        expectedStoreId: 'store',
        workspaceId: 'w',
        commandId: 'original',
        sessionId: 'created',
        title: 'new',
      },
    });
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
