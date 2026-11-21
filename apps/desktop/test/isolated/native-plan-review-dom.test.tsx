import { expect, test } from 'bun:test';
import type { Command, Interaction, Session } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeDraft, NativeEvent, NativeState } from '../../src/native-bridge';
import {
  nextDesktopPresentation,
  prepareDesktopDom,
  promptValue,
  setPromptText,
} from '../native-page-dom.fixture';

test('Native puts plan decisions in the composer slot and restores the original queue and draft', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
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
  const { NativeDesktop } = await import('../../src/native');
  const { verifyInteractionAnswerReceipt } = await import('../../src/controller');
  const sessions = ['a', 'b'].map((id) => ({
    id,
    workspaceId: 'w',
    rootSessionId: id,
    parentSessionId: null,
    title: `Plan ${id.toUpperCase()}`,
    nextSeq: '0',
    deletedAt: null,
  })) as Session[];
  const cards: Record<string, Interaction> = Object.fromEntries(
    sessions.map((session) => [
      session.id,
      {
        id: `plan-${session.id}`,
        originStoreId: 'store',
        sessionId: session.id,
        presentationSessionId: session.id,
        ancestry: [session.id],
        runId: `run-${session.id}`,
        executionId: `execution-${session.id}`,
        attempt: 1,
        kind: 'plan_review',
        definitionId: 'planning.review',
        definitionVersion: '1',
        inputDigest: `input-${session.id}`,
        policyRevision: 'information-1',
        requiredRefs: [],
        answer: null,
        revision: '1',
        acceptedDecisionRevision: null,
        state: 'pending',
        request: {
          planId: `plan-${session.id}`,
          version: '1',
          digest: `plan-digest-${session.id}`,
          content: JSON.stringify({
            kind: 'plan_document',
            planId: `plan-${session.id}`,
            version: 1,
            digest: `plan-digest-${session.id}`,
            title: '核对原计划',
            body: '保留正文预览。',
            steps: [{ id: 'verify', title: '核对方案' }],
          }),
        },
      } satisfies Interaction,
    ]),
  );
  let selected = 'a',
    omitted = false,
    unavailable = false,
    permissionUnavailable = false,
    ordinarySends = 0,
    posts = 0;
  let watcher: ((event: NativeEvent) => void) | undefined;
  let submissions: NativeState['interactionSubmissions'] = [];
  const waitingPlans = new Set<string>();
  const state = (): NativeState => ({
    generation: 1,
    creationSubmissions: [],
    inputSubmissions: [],
    permissionSubmissions: [],
    interactionSubmissions: submissions,
    selection: {
      viewGeneration: 1,
      canReadInputQueue: selected === 'a',
      canReadModelOutput: false,
      permissionUnavailable,
      storeId: 'store',
      session: sessions.find((session) => session.id === selected)!,
      runs: [
        {
          id: `run-${selected}`,
          sessionId: selected,
          originCommandId: `work-${selected}`,
          originStoreId: 'store',
          status: waitingPlans.has(selected) ? 'waiting_interaction' : 'running',
          isActive: true,
          createdAt: 1,
          finishedAt: null,
          reason: null,
        },
      ],
      executions: [
        {
          id: `execution-${selected}`,
          sessionId: selected,
          runId: `run-${selected}`,
          originStoreId: 'store',
          kind: 'tool',
          definitionId: 'planning.review',
          definitionVersion: '1',
          status: 'dispatching',
          result: null,
          resultRevision: '0',
          cancelRequestedAt: null,
        },
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
      interactions:
        omitted || (!waitingPlans.has(selected) && cards[selected]!.kind === 'plan_review')
          ? []
          : [cards[selected]!],
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
          workspaces: [{ id: 'w', name: 'Plans', rootUri: 'file:///workspace' }],
          sessions,
        };
      if (input.method === 'select') {
        selected = input.sessionId;
        return state();
      }
      if (input.method === 'messages')
        return { messages: [], nextAfterSeq: null, highWaterSeq: '0' };
      if (input.method === 'input.queue.read')
        return {
          kind: 'input.queue.observation',
          scope: {
            generation: input.generation,
            viewSelection: input.viewSelection,
            historyEpoch: input.historyEpoch,
            storeId: 'store',
            sessionId: selected,
            workspaceId: 'w',
          },
          readId: input.readId,
          observationId: 7,
          revision: 'a'.repeat(64),
          entries: [
            { id: 'queued-follow-up', text: '核对后续事项', editable: true, steerable: true },
          ],
          submissions: [],
        };
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
      if (input.method === 'caller.prepare') ordinarySends++;
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
      if (button.classList.contains('session-row')) await nextDesktopPresentation(dom);
    });
  const mainInput = () =>
    host.querySelector<HTMLTextAreaElement>('[role="textbox"][aria-label="当前会话私有草稿"]');
  const replyInput = () => host.querySelector<HTMLTextAreaElement>('[aria-label="审阅意见"]');
  const review = () => host.querySelector('.bottom-controls .plan-review-composer');
  const actions = () => [...(review()?.querySelectorAll('button') ?? [])];
  const refresh = async () => act(async () => watcher?.({ generation: 1, kind: 'changed' }));
  try {
    await act(async () => root.render(<NativeDesktop testDiagnostics />));
    await click('Plan A');
    await click('会话工具');
    const firstInput = mainInput()!;
    expect(promptValue(firstInput)).toBe('  main a\n雪🙂  ');
    const originalForm = firstInput.closest('form')!;
    expect(host.querySelector('.composer-queue')?.textContent).toContain('核对后续事项');
    await click('已排队 1 条');
    waitingPlans.add('a');
    await refresh();
    expect(mainInput()).toBeNull();
    expect(host.querySelector('.bottom-controls .composer')).toBeNull();
    expect(host.querySelector('.composer-queue')).toBeNull();
    expect(host.querySelector('[data-permission-trigger]')).toBeNull();
    const planSource = host.querySelector(
      '.native-plan-review-message .plan-review-document-heading',
    )!;
    expect(planSource.closest('.native-plan-review-message')).toBeTruthy();
    expect(planSource.closest('.interaction-area')).toBeNull();
    const planCard = planSource.closest<HTMLElement>('.plan-review-document-card')!;
    const planActions = review()!;
    expect(planActions.closest('.conversation-footer')).toBeTruthy();
    expect(planCard.querySelector('.plan-review-composer')).toBeNull();
    expect(planCard.querySelector('.plan-review-excerpt')).not.toBeNull();
    const toggle = planSource.querySelector('button')!;
    await act(async () => toggle.click());
    expect(toggle.textContent).toBe('收起完整计划');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const fullPlan = host.querySelector('[aria-label="完整计划正文"]')!;
    expect(toggle.getAttribute('aria-controls')).toBe(fullPlan.id);
    expect(fullPlan.closest('.plan-review-document-card')).toBe(planCard);
    expect(review()).toBe(planActions);
    await act(async () => toggle.click());
    expect(toggle.textContent).toBe('展开完整计划');
    expect(host.querySelector('[aria-label="完整计划正文"]')).toBeNull();
    expect(mainInput()).toBeNull();
    expect(replyInput()?.closest('.plan-review-composer')).toBe(planActions);
    expect(planActions.querySelector('h3')?.textContent).toBe('计划审阅');
    const decisions = planActions.querySelector('.plan-review-composer-decisions');
    const reply = planActions.querySelector('.plan-review-composer-reply');
    expect([...decisions!.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      '跳过',
      '实施此计划',
    ]);
    expect(
      [...reply!.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
    ).toEqual(['发送审阅意见']);
    expect(promptValue(replyInput())).toBe('');
    expect(actions().find((button) => button.type === 'submit')?.disabled).toBe(true);
    expect(host.querySelectorAll('.composer-actions button')).toHaveLength(0);
    const reviewDraft = '  增加验收步骤\n雪🙂  ';
    await act(async () => setPromptText(replyInput()!, reviewDraft));
    expect(promptValue(replyInput())).toBe(reviewDraft);
    permissionUnavailable = true;
    await refresh();
    expect(actions().every((button) => button.disabled)).toBe(true);
    expect(mainInput()).toBeNull();
    expect(promptValue(replyInput())).toBe(reviewDraft);
    expect(posts).toBe(0);
    permissionUnavailable = false;
    await refresh();
    expect(actions().every((button) => !button.disabled)).toBe(true);
    // Plan denial and the explicit original-work cancellation are separate choices.
    expect(
      [...host.querySelectorAll('button')].some((button) =>
        button.textContent?.startsWith('停止原 Job'),
      ),
    ).toBe(true);
    await click('Plan B');
    expect(promptValue(mainInput())).toBe('  main b\n雪🙂  ');
    await act(async () => setPromptText(mainInput()!, 'other B'));
    await click('Plan A');
    await act(async () => nextDesktopPresentation(dom));
    expect(mainInput()).toBeNull();
    expect(review()).not.toBeNull();
    expect(promptValue(replyInput())).toBe(reviewDraft);
    omitted = true;
    await refresh();
    expect(review()).toBeNull();
    expect(host.querySelector('.bottom-controls > .interaction-area')).toBeNull();
    expect(mainInput()).toBeNull();
    expect(host.querySelector('.composer-queue')).toBeNull();
    await act(async () => {
      originalForm.dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(ordinarySends).toBe(0);
    unavailable = true;
    await refresh();
    omitted = unavailable = false;
    await refresh();
    expect(mainInput()).toBeNull();
    expect(promptValue(replyInput())).toBe(reviewDraft);
    await act(async () => {
      const input = replyInput()!;
      input.focus();
      input.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
      );
      input.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
      );
    });
    expect(posts).toBe(0);
    await act(async () => {
      const input = replyInput()!;
      for (let index = 0; index < 2; index++)
        input.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
    });
    expect(posts).toBe(1);
    expect(mainInput()).toBeNull();
    expect(ordinarySends).toBe(0);
    expect(submissions[0]!.intent.answer).toEqual({
      kind: 'plan_review',
      decision: 'revise',
      feedback: reviewDraft,
      asUserMessage: true,
    });
    omitted = true;
    waitingPlans.delete('a');
    await refresh();
    expect(promptValue(mainInput())).toBe('  main a\n雪🙂  ');
    expect(host.querySelector('.composer-queue-heading')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    await click('已排队 1 条');
    expect(host.querySelector('.composer-queue')?.textContent).toContain('核对后续事项');
    expect(ordinarySends).toBe(0);
    omitted = false;
    const laterDraft = '  主输入的新草稿\n后续  ';
    await act(async () => setPromptText(mainInput()!, laterDraft));
    waitingPlans.add('a');
    await refresh();
    await click('Plan B');
    expect(promptValue(mainInput())).toBe('other B');
    await click('Plan A');
    expect(actions().every((button) => button.disabled)).toBe(true);
    expect(mainInput()).toBeNull();
    expect(promptValue(replyInput())).toBe(reviewDraft);
    expect(posts).toBe(1);
    await click('Plan B');
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
    expect(promptValue(mainInput())).toBe('other B');
    await click('Plan A');
    expect(mainInput()).toBeNull();
    expect(posts).toBe(1);
    cards.a = {
      ...cards.a!,
      state: 'answered',
      revision: '2',
      acceptedDecisionRevision: '2',
      answer: original.intent.answer,
    };
    waitingPlans.delete('a');
    await refresh();
    expect(promptValue(mainInput())).toBe(laterDraft);
    expect(posts).toBe(1);
    cards.a = {
      ...cards.a!,
      kind: 'approval',
      state: 'pending',
      revision: '3',
      acceptedDecisionRevision: null,
      answer: null,
      request: {
        options: [
          { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
        ],
      },
    };
    await refresh();
    expect(promptValue(mainInput())).toBe(laterDraft);
    expect(posts).toBe(1);
    await click('Plan B');
    waitingPlans.add('b');
    await refresh();
    expect(promptValue(replyInput())).toBe('');
    await click('实施此计划');
    expect(submissions[0]!.intent.answer).toEqual({
      kind: 'plan_review',
      decision: 'approve',
      feedback: '开始实施此计划',
      asUserMessage: true,
    });
    expect(mainInput()).toBeNull();
    cards.b = { ...cards.b!, revision: '2', inputDigest: 'replacement-input' };
    await refresh();
    await click('跳过');
    expect(submissions[0]!.intent.answer).toEqual({ kind: 'plan_review', decision: 'deny' });
    waitingPlans.delete('b');
    await refresh();
    expect(promptValue(mainInput())).toBe('other B');
    expect(posts).toBe(3);
  } finally {
    await act(async () => root.unmount());
    restoreLayoutGlobals();
    dom.window.close();
    Object.assign(globalThis, prior);
  }
});
