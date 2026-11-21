import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
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

test('inline review renders the original plan as a document and uses the accepted revision for its decision', async () => {
  const { InteractionCard } = await import('../../src');
  const content = JSON.stringify({
    kind: 'plan_document',
    planId: original.request.planId,
    version: Number(original.request.version),
    digest: original.request.digest,
    title: '原计划标题',
    body: '## 验收\n\n检查**原文**。\n\n| 项目 | 结果 |\n| --- | --- |\n| 文件 | `plan.md` |\n\n![示意](https://example.invalid/remote.png)',
    steps: [{ id: 'internal-step-id', title: '核对保存结果' }],
  });
  const review = { ...original, request: { ...original.request, content } };
  const answered: Interaction = {
    ...review,
    state: 'answered',
    answer: { kind: 'plan_review', decision: 'approve', feedback: '原审阅反馈' },
  };
  const render = (interaction: Interaction, inlinePlanReview = true) =>
    JSDOM.fragment(
      renderToStaticMarkup(
        <InteractionCard interaction={interaction} inlinePlanReview={inlinePlanReview} />,
      ),
    );
  const pending = render(review);
  const heading = pending.querySelector('.plan-review-document-heading');
  expect(heading?.querySelector('.plan-review-document-meta')?.textContent).toBe('第 2 版');
  expect(heading?.querySelector('h4')?.textContent).toBe('原计划标题');
  const toggle = heading?.querySelector('button');
  expect(toggle?.textContent).toBe('展开完整计划');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(pending.querySelector('.plan-review-excerpt strong')?.textContent).toBe('原文');
  expect(pending.querySelector('[aria-label="完整计划正文"]')).toBeNull();
  const body = render(review, false).querySelector('[aria-label="完整计划正文"]')!;
  expect(body.querySelector('h2')?.textContent).toBe('验收');
  expect(body.querySelector('strong')?.textContent).toBe('原文');
  expect(body.querySelector('.markdown-table-scroll table td code')?.textContent).toBe('plan.md');
  expect(body.querySelector('img')).toBeNull();
  expect(body.querySelector('ol[aria-label="计划步骤"] li')?.textContent).toBe('核对保存结果');
  expect(pending.textContent).not.toContain('internal-step-id');
  const saved = render(answered);
  expect(saved.querySelector('[role="status"]')?.textContent).toBe('答复已保存，待确认');
  expect(saved.querySelector('.plan-review-feedback p')?.textContent).toBe('原审阅反馈');
  expect(saved.querySelector('form')).toBeNull();
  expect(
    render({ ...answered, acceptedDecisionRevision: answered.revision }).querySelector(
      '.plan-review-document-heading [role="status"]',
    )?.textContent,
  ).toBe('已批准');
  expect(
    render({ ...review, state: 'cancelled' }).querySelector('[role="status"]')?.textContent,
  ).toBe('已取消');
  const mismatched = render({ ...review, request: { ...review.request, version: '3' } }, false);
  expect(mismatched.querySelector('[aria-label="计划原文"]')?.textContent).toBe(content);
});

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
  const feedback = () => host.querySelector<HTMLTextAreaElement>('.plan-review textarea')!;
  const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const approve = () => host.querySelector<HTMLInputElement>('[aria-label="批准此版本"]')!;
  try {
    await render('first');
    expect(host.textContent).toContain('ORIGINAL_FULL_TAIL');
    expect(feedback().labels?.[0]?.textContent).toBe('审阅意见（选填）');
    expect(host.querySelector('[aria-label="Plan review mode"]')).toBeNull();
    expect(submit().disabled).toBe(true);
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
    await act(async () => approve().click());
    expect(answers).toEqual([]);
    expect(saved).toEqual({ feedback: text, decision: 'approve' });
    await render('returned');
    expect(feedback().value).toBe(text);
    expect(approve().checked).toBe(true);
    await act(async () => {
      submit().click();
      submit().click();
    });
    expect(answers).toEqual([{ kind: 'plan_review', decision: 'approve', feedback: text }]);
    expect(submit().disabled).toBe(true);
    await act(async () => reject(new Error('original_answer_unknown')));
    expect(feedback().value).toBe(text);
    expect(saved).toEqual({ feedback: text, decision: 'approve' });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('审阅答复提交失败，请重试。');
    await render('unknown', { phase: 'unknown', commandId: 'original-answer' });
    expect(submit().disabled).toBe(true);
    expect(feedback().disabled).toBe(true);
    expect(answers).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
