import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { InteractionCard } from '../src';

const original: Interaction = {
  id: 'original-card',
  originStoreId: 'original-store',
  sessionId: 'actual-child',
  presentationSessionId: 'root',
  ancestry: ['root', 'actual-child'],
  runId: 'original-run',
  executionId: 'original-execution',
  attempt: 1,
  kind: 'approval',
  definitionId: 'original.command',
  definitionVersion: '2',
  inputDigest: 'digest',
  policyRevision: 'policy',
  requiredRefs: [],
  request: { input: { command: 'exact' } },
  answer: null,
  revision: '7',
  acceptedDecisionRevision: null,
  state: 'pending',
};
test('actual DOM offers same-command only from the original approval request and sends exact grant with the unchanged card identity', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
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
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const answers: { card: Interaction; answer: NonNullable<Interaction['answer']> }[] = [];
  const onAnswer = (card: Interaction, answer: NonNullable<Interaction['answer']>) => {
    answers.push({ card, answer });
  };
  const button = (text: string) =>
    Array.from(host.querySelectorAll('button')).find((node) => node.textContent === text);
  try {
    await act(async () =>
      root.render(<InteractionCard interaction={original} onAnswer={onAnswer} />),
    );
    expect(button('本 Session 相同命令')).toBeUndefined();
    await act(async () => button('Approve once')!.click());
    expect(answers[0]).toEqual({
      card: original,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    const offered = {
      ...original,
      id: 'offered-card',
      revision: '9',
      request: { ...(original.request as object), grants: ['approve_once', 'same_command'] },
    };
    await act(async () =>
      root.render(<InteractionCard interaction={offered} onAnswer={onAnswer} />),
    );
    await act(async () =>
      button('本 Session 相同命令')!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    );
    expect(answers[1]).toEqual({
      card: offered,
      answer: { kind: 'approval', decision: 'approve', grant: 'same_command' },
    });
    expect(answers[1]!.card).toBe(offered);
    await act(async () => button('Deny')!.click());
    expect(answers[2]!.answer).toEqual({ kind: 'approval', decision: 'deny' });
    await act(async () =>
      root.render(
        <InteractionCard
          interaction={offered}
          submission={{ phase: 'unknown', commandId: 'original-answer-intent' }}
          onAnswer={onAnswer}
        />,
      ),
    );
    expect(button('本 Session 相同命令')!.disabled).toBe(true);
    expect(host.textContent).toContain('original-answer-intent');
    await act(async () => button('本 Session 相同命令')!.click());
    expect(answers).toHaveLength(3);
    for (const kind of ['question', 'plan_review'] as const) {
      await act(async () =>
        root.render(<InteractionCard interaction={{ ...offered, kind }} onAnswer={onAnswer} />),
      );
      expect(button('本 Session 相同命令')).toBeUndefined();
    }
    await act(async () => root.render(<InteractionCard interaction={offered} />));
    expect(button('本 Session 相同命令')!.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
