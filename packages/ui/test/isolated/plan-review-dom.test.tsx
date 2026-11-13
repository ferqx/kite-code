import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from '#kite-test';
import type { PlanReviewDraft } from '../../src';

const original = {
  id: 'original-review',
  originStoreId: 'original-store',
  sessionId: 'original-source',
  presentationSessionId: 'original-root',
  ancestry: ['original-root', 'original-source'],
  runId: 'original-run',
  executionId: 'original-execution',
  attempt: 1,
  kind: 'plan_review',
  definitionId: 'planning.review',
  definitionVersion: '1',
  inputDigest: 'original-input',
  policyRevision: 'original-policy',
  requiredRefs: [],
  answer: null,
  revision: '7',
  acceptedDecisionRevision: null,
  state: 'pending',
  request: {
    planId: 'exact-plan',
    version: '2',
    digest: 'original-digest',
    content: 'Full plan\n1. inspect\n2. verify\nORIGINAL_FULL_TAIL',
  },
} satisfies Interaction;

test('actual DOM preserves original feedback without selecting permissions, locks repeated Enter, and preserves failed drafts', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    Event: globalThis.Event,
    MutationObserver: globalThis.MutationObserver,
    DocumentFragment: globalThis.DocumentFragment,
    Node: globalThis.Node,
    NodeFilter: globalThis.NodeFilter,
    Element: globalThis.Element,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    CustomEvent: globalThis.CustomEvent,
    getComputedStyle: globalThis.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    DocumentFragment: dom.window.DocumentFragment,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { InteractionCard } = await import('../../src');
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const answers: NonNullable<Interaction['answer']>[] = [];
  let saved: PlanReviewDraft | undefined, reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const render = async (mount: string, submission?: { phase: 'unknown'; commandId: string }) =>
    act(async () =>
      root.render(
        <InteractionCard
          key={mount}
          interaction={original}
          initialPlanDraft={saved}
          onPlanDraftChange={(draft) => {
            saved = draft;
          }}
          submission={submission}
          onAnswer={async (card, answer) => {
            expect(card).toBe(original);
            answers.push(answer);
            await pending;
          }}
        />,
      ),
    );
  const feedback = () =>
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Plan review feedback"]')!;
  const approve = () =>
    [...host.querySelectorAll('button')].find(
      (node) => node.textContent === 'Approve this exact plan',
    )!;
  try {
    await render('first');
    expect(host.textContent).toContain('ORIGINAL_FULL_TAIL');
    expect(host.querySelector('[aria-label="Plan review mode"]')).toBeNull();
    expect(approve().disabled).toBe(false);
    await act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(answers).toEqual([]);
    const text = '  modified original\nfeedback🙂  ';
    await act(async () => {
      feedback().value = text;
      feedback().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    expect(saved).toEqual({ feedback: text });
    await render('returned');
    expect(feedback().value).toBe(text);
    await act(async () => {
      approve().click();
      approve().click();
    });
    expect(answers).toEqual([{ kind: 'plan_review', decision: 'approve', feedback: text }]);
    expect(approve().disabled).toBe(true);
    await act(async () => reject(new Error('original_answer_unknown')));
    expect(feedback().value).toBe(text);
    expect(saved).toEqual({ feedback: text });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('original_answer_unknown');
    await render('unknown', { phase: 'unknown', commandId: 'original-answer' });
    expect(approve().disabled).toBe(true);
    expect(feedback().disabled).toBe(true);
    expect(answers).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
