import { expect, test } from 'bun:test';
import type { Command, Interaction, Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { verifyInteractionAnswerReceipt } from '../src/controller';
import { NativeDesktop } from '../src/native';
import type { NativeBridge, NativeDraft, NativeEvent, NativeState } from '../src/native-bridge';
import { prepareDesktopDom } from './native-page-dom.fixture';

test('Native page keeps original question drafts across sessions, missing pages and read failure; only the exact accepted answer clears its draft', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayoutGlobals = prepareDesktopDom(dom);
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const sessions = ['a', 'b'].map((id) => ({
    id,
    workspaceId: 'w',
    rootSessionId: id,
    parentSessionId: null,
    title: `Question ${id.toUpperCase()}`,
    nextSeq: '0',
    deletedAt: null,
  })) as Session[];
  const cards: Record<string, Interaction> = Object.fromEntries(
    sessions.map((session) => [
      session.id,
      {
        id: `question-${session.id}`,
        originStoreId: 'store',
        sessionId: session.id,
        presentationSessionId: session.id,
        ancestry: [session.id],
        runId: `run-${session.id}`,
        executionId: `execution-${session.id}`,
        attempt: 1,
        kind: 'question',
        definitionId: 'ask_user',
        definitionVersion: '1',
        inputDigest: `input-${session.id}`,
        policyRevision: 'information-1',
        requiredRefs: [],
        answer: null,
        revision: '1',
        acceptedDecisionRevision: null,
        state: 'pending',
        request: { schema: { type: 'string', minLength: 1, pattern: '\\S' } },
      } satisfies Interaction,
    ]),
  );
  let selected = 'a',
    omitted = false,
    unavailable = false,
    posts = 0;
  let watcher: ((event: NativeEvent) => void) | undefined;
  let submissions: NativeState['interactionSubmissions'] = [];
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: submissions,
    selection: {
      viewGeneration: 1,
      canReadModelOutput: false,
      storeId: 'store',
      session: sessions.find((session) => session.id === selected)!,
      runs: [],
      executions: [
        {
          id: 'parallel-job',
          sessionId: selected,
          runId: 'original-run',
          kind: 'job',
          definitionId: 'ordinary-job',
          definitionVersion: '1',
          status: 'running',
          result: null,
          resultRevision: '0',
          cancelRequestedAt: null,
        },
      ],
      interactions: omitted ? [] : [cards[selected]!],
      interactionsAfterId: null,
    },
  });
  const bridge: NativeBridge = {
    watch(callback) {
      watcher = callback;
      return () => {
        watcher = undefined;
      };
    },
    async request(input) {
      if (input.method === 'attach') return state();
      if (input.method === 'state') {
        if (unavailable) throw new Error('read_unavailable');
        return state();
      }
      if (input.method === 'directory')
        return {
          storeId: 'store',
          workspaces: [{ id: 'w', name: 'Questions', rootUri: 'file:///workspace' }],
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
          content: `  main ${input.sessionId}\n雪🙂  `,
        } satisfies NativeDraft;
      if (input.method === 'interaction.answer') {
        posts++;
        const card = cards[selected]!;
        submissions = [
          {
            interaction: card,
            intent: {
              expectedStoreId: 'store',
              commandId: 'original-answer',
              expectedRevision: card.revision,
              answer: input.answer,
            },
            phase: 'unknown',
          },
        ];
        return null;
      }
      return null;
    },
  };
  Object.defineProperty(dom.window, 'kiteNative', { value: bridge });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const host = dom.window.document;
  const click = async (name: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find(
        (value) => value.textContent === name || value.getAttribute('aria-label') === name,
      )!;
      expect(button).toBeDefined();
      button.click();
    });
  const text = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="自由回答"]')!;
  const mainInput = () =>
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="当前会话私有草稿"]');
  const edit = async (value: string) =>
    act(async () => {
      text().value = value;
      text().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  const refresh = async () => act(async () => watcher?.({ generation: 1, kind: 'changed' }));
  try {
    await act(async () => root.render(<NativeDesktop />));
    await click('Question A');
    await click('会话工具');
    expect(mainInput() === null).toBe(true);
    await edit('  original A\n雪🙂  ');
    expect(
      [...host.querySelectorAll('button')].some((button) =>
        button.textContent?.startsWith('停止原 Job'),
      ),
    ).toBe(false);
    await click('Question B');
    expect(text().value).toBe('');
    await edit('other B');
    await click('Question A');
    expect(text().value).toBe('  original A\n雪🙂  ');
    omitted = true;
    await refresh();
    expect(text()).toBeNull();
    expect(mainInput()?.value).toBe('  main a\n雪🙂  ');
    unavailable = true;
    await refresh();
    omitted = unavailable = false;
    await refresh();
    expect(text().value).toBe('  original A\n雪🙂  ');
    await click('提交回答');
    expect(posts).toBe(1);
    expect(mainInput() === null).toBe(true);
    expect(submissions[0]!.intent.answer).toEqual({
      kind: 'question',
      answers: '  original A\n雪🙂  ',
    });
    await click('Question B');
    expect(text().value).toBe('other B');
    await click('Question A');
    expect(text().value).toBe('  original A\n雪🙂  ');
    expect(
      [...host.querySelectorAll('button')].find((button) => button.textContent === '提交回答')!
        .disabled,
    ).toBe(true);
    expect(posts).toBe(1);
    await click('Question B');
    const original = submissions[0]!;
    const receipt = {
      id: original.intent.commandId,
      originStoreId: 'store',
      sessionId: 'a',
      kind: 'interaction.answer',
      status: 'applied',
      cancelRequestedAt: null,
      receipt: {
        outcome: 'answer_saved',
        interactionId: cards.a!.id,
        decisionRevision: '2',
        cancelled: false,
      },
    } as Command;
    submissions = [
      {
        ...original,
        receipt,
        phase: verifyInteractionAnswerReceipt(cards.a!, original.intent, receipt),
      },
    ];
    await refresh();
    expect(text().value).toBe('other B');
    await click('Question A');
    expect(text().value).toBe('');
    await click('Question B');
    expect(text().value).toBe('other B');
    cards.b = { ...cards.b!, revision: '2', inputDigest: 'replacement-input' };
    await refresh();
    expect(text().value).toBe('');
    expect(posts).toBe(1);
    cards.a = {
      ...cards.a!,
      state: 'answered',
      revision: '2',
      acceptedDecisionRevision: '2',
      answer: original.intent.answer,
    };
    await click('Question A');
    expect(mainInput()?.value).toBe('  main a\n雪🙂  ');
    expect(posts).toBe(1);
  } finally {
    await act(async () => root.unmount());
    restoreLayoutGlobals();
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
