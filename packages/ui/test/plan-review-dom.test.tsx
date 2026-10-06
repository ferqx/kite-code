import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { InteractionCard, type PlanReviewDraft } from '../src';

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
    allowedModes: ['auto', 'accept_edits'],
  },
} satisfies Interaction;

test('actual DOM restores explicit plan mode and original feedback, locks repeated Enter, and preserves failed drafts', async () => {
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
  const mode = () =>
    host.querySelector<HTMLSelectElement>('select[aria-label="Plan review mode"]')!;
  const feedback = () =>
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Plan review feedback"]')!;
  const approve = () =>
    [...host.querySelectorAll('button')].find(
      (node) => node.textContent === 'Approve this exact plan',
    )!;
  try {
    await render('first');
    expect(host.textContent).toContain('ORIGINAL_FULL_TAIL');
    expect(mode().value).toBe('');
    expect(approve().disabled).toBe(true);
    const text = '  修改原文\n雪🙂e\u0301 / @  ';
    await act(async () => {
      mode().value = 'accept_edits';
      mode().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      feedback().value = text;
      feedback().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    expect(saved).toEqual({ mode: 'accept_edits', feedback: text });
    await render('returned');
    expect(mode().value).toBe('accept_edits');
    expect(feedback().value).toBe(text);
    await act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(answers).toEqual([
      { kind: 'plan_review', decision: 'approve', mode: 'accept_edits', feedback: text },
    ]);
    expect(approve().disabled).toBe(true);
    await act(async () => reject(new Error('original_answer_unknown')));
    expect(feedback().value).toBe(text);
    expect(saved).toEqual({ mode: 'accept_edits', feedback: text });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('original_answer_unknown');
    await render('unknown', { phase: 'unknown', commandId: 'original-answer' });
    expect(approve().disabled).toBe(true);
    expect(mode().disabled).toBe(true);
    expect(feedback().disabled).toBe(true);
    expect(answers).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
