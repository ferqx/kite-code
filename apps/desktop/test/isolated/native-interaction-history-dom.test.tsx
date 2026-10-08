import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeInteractionHistoryPage,
  NativeSelection,
} from '../../src/native-bridge';
import { NativeInteractionHistory } from '../../src/native-interaction-history';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('original readonly cards keep saved generic answers, cancellation and exact feedback; partial and late history never replace a complete scope', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom);
  const descriptors = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById('root')!,
    root = createRoot(container);
  const base: Interaction = {
    id: 'a',
    originStoreId: 'store',
    sessionId: 'session',
    presentationSessionId: 'session',
    ancestry: ['session'],
    runId: 'run',
    executionId: 'execution',
    attempt: 1,
    kind: 'question',
    definitionId: 'custom.question',
    definitionVersion: '4',
    inputDigest: 'digest',
    policyRevision: 'original',
    requiredRefs: [],
    answer: { kind: 'question', answers: { reply: '原问题回答 雪🙂' } },
    revision: '2',
    acceptedDecisionRevision: null,
    state: 'answered',
    request: {
      schema: {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
        additionalProperties: false,
      },
    },
  };
  const cards: Interaction[] = [
    base,
    { ...base, id: 'b', state: 'cancelled' },
    {
      ...base,
      id: 'c',
      kind: 'plan_review',
      acceptedDecisionRevision: '2',
      answer: { kind: 'plan_review', decision: 'revise', feedback: '  原反馈\r\n雪🙂  ' },
      request: {
        planId: 'plan',
        version: '1',
        digest: 'digest',
        content: '原计划',
        allowedModes: ['auto'],
      },
    },
    {
      ...base,
      id: 'd',
      kind: 'approval',
      answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
    },
  ];
  let release!: (page: NativeInteractionHistoryPage) => void;
  let firstRead = true;
  const calls: string[] = [];
  let nextPage!: NativeInteractionHistoryPage;
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (input) => {
      calls.push(input.method);
      if (input.method === 'interactionHistory.close') return null;
      if (input.method === 'interactionHistory.open') {
        const scope = {
          generation: 1,
          viewSelection: input.viewSelection,
          historyEpoch: input.historyEpoch,
          storeId: 'store',
          sessionId: input.viewSelection === 1 ? 'session' : 'other',
          workspaceId: 'w',
        };
        if (!firstRead)
          return {
            kind: 'interactionHistory.page',
            readId: input.readId,
            scope,
            page: { interactions: [], nextAfterId: null, snapshotCursor: '11' },
          };
        nextPage = {
          kind: 'interactionHistory.page',
          readId: input.readId,
          scope,
          page: { interactions: cards.slice(1), nextAfterId: null, snapshotCursor: '10' },
        };
        return {
          ...nextPage,
          page: { interactions: cards.slice(0, 1), nextAfterId: 'a', snapshotCursor: '10' },
        };
      }
      if (input.method === 'interactionHistory.next')
        return new Promise((done) => {
          release = done;
        });
      throw Error('readonly view must not submit answers');
    },
  };
  const selection = (id: string, viewSelection: number): NativeSelection => ({
    storeId: 'store',
    viewSelection,
    viewGeneration: 1,
    canReadModelOutput: true,
    session: {
      id,
      workspaceId: 'w',
      parentSessionId: null,
      rootSessionId: id,
      title: id,
      nextSeq: '0',
      deletedAt: null,
      controlRevision: '0',
      contextSelectionId: 'context',
    },
    runs: [],
    executions: [],
    interactions: [],
    interactionsAfterId: null,
  });
  const render = (value = selection('session', 1)) =>
    root.render(
      <NativeInteractionHistory
        bridge={bridge}
        generation={1}
        selection={value}
        historyEpoch={0}
      />,
    );
  try {
    await act(async () => {
      render();
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(container.textContent).not.toContain('原问题回答');
    expect(container.textContent).not.toContain('已完整读取');
    await act(async () => release(nextPage));
    expect(container.textContent).toContain('已完整读取 4 项交互记录');
    expect(container.textContent).toContain('原问题回答 雪🙂');
    expect(container.textContent).toContain('问题 · 已取消');
    expect(container.textContent).toContain('本次执行已接收该回答');
    expect(
      container.querySelector('[data-interaction-id="c"] pre[data-saved-answer]')?.textContent,
    ).toBe('  原反馈\r\n雪🙂  ');
    const answerButtons = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-interaction-id] button'),
    ].filter((button) => button.textContent !== 'Load complete attachment');
    expect(answerButtons.length).toBeGreaterThan(0);
    expect(answerButtons.every((button) => button.disabled)).toBe(true);
    await act(async () => {
      for (const button of answerButtons) button.click();
    });
    expect(calls.every((method) => method.startsWith('interactionHistory.'))).toBe(true);
    // A new pending read is still owned by the old selection when the user moves.
    await act(async () => container.querySelector<HTMLButtonElement>('section > button')!.click());
    const oldRelease = release,
      oldPage = nextPage;
    firstRead = false;
    await act(async () => {
      render(selection('other', 2));
      await new Promise((done) => setTimeout(done, 0));
    });
    await act(async () => oldRelease(oldPage));
    expect(container.textContent).toContain('已完整读取 0 项交互记录');
    expect(container.textContent).not.toContain('原问题回答');
    expect(calls.filter((method) => method === 'interactionHistory.close').length).toBeGreaterThan(
      0,
    );
  } finally {
    await act(async () => root.unmount());
    restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
