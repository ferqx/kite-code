import { expect, test } from 'bun:test';
import type { Interaction, Json } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { InteractionCard, type QuestionAnswerDraft } from '../src';

const original: Interaction = {
  id: 'original-question',
  originStoreId: 'original-store',
  sessionId: 'original-source',
  presentationSessionId: 'original-root',
  ancestry: ['original-root', 'original-source'],
  runId: 'original-run',
  executionId: 'original-execution',
  attempt: 1,
  kind: 'question',
  definitionId: 'ask_user',
  definitionVersion: '1',
  inputDigest: 'original-input',
  policyRevision: 'original-policy',
  requiredRefs: [],
  answer: null,
  revision: '7',
  acceptedDecisionRevision: null,
  state: 'pending',
  request: {
    schema: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['q1', 'q2', 'q3'],
          properties: Object.fromEntries(
            ['q1', 'q2', 'q3'].map((id): [string, Json] => [
              id,
              {
                title: `${id} original question`,
                anyOf: [
                  {
                    const: `${id}-o1`,
                    title: id === 'q1' ? 'Alpha 推荐' : id === 'q2' ? 'q1-o1' : 'Third choice',
                    description: 'Full original description\nwith Unicode 尾部',
                  },
                  { const: `${id}-o2`, title: 'Other choice' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['text'],
                    properties: { text: { type: 'string', pattern: '\\S', maxLength: 64 } },
                  },
                ],
              },
            ]),
          ),
        },
        {
          const: null,
          title: 'Cancel answering',
          description: 'Leave the original questions unanswered.',
        },
      ],
    },
  },
};

async function domFixture(
  run: (host: HTMLElement, dom: JSDOM, root: ReturnType<typeof createRoot>) => Promise<void>,
) {
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
  try {
    await run(host, dom, root);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, prior);
  }
}

test('actual DOM browses unanswered original questions and submits all exact values once, preserving descriptions and text', async () => {
  await domFixture(async (host, dom, root) => {
    const answers: { card: Interaction; answer: NonNullable<Interaction['answer']> }[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () =>
      root.render(
        <InteractionCard
          interaction={original}
          onAnswer={async (card, answer) => {
            answers.push({ card, answer });
            await pending;
          }}
        />,
      ),
    );
    const button = (name: string) =>
      [...host.querySelectorAll('button')].find((node) => node.textContent === name)!;
    const choose = async (name: string) =>
      act(async () => host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!.click());
    const click = async (name: string) => act(async () => button(name).click());
    expect(host.querySelector('fieldset')).not.toBeNull();
    expect(host.querySelector('input:checked')).toBeNull();
    expect(button('上一题')).toBeUndefined();
    expect(button('提交回答')).toBeUndefined();
    expect(host.querySelector('form')!.textContent).not.toContain('Full original description');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Alpha 推荐的说明"]')!.focus(),
    );
    expect(host.querySelector('[role="tooltip"]')!.textContent).toContain(
      'Full original description\nwith Unicode 尾部',
    );
    await click('下一题');
    await click('下一题');
    expect(button('提交回答').disabled).toBe(true);
    await choose('自由回答');
    const text = '  q3-o1🙂é\n保持 空格  ';
    await act(async () => {
      const input = host.querySelector('textarea')!;
      input.value = text;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click('上一题');
    await choose('q1-o1');
    await click('上一题');
    await choose('Alpha 推荐');
    await click('下一题');
    await click('下一题');
    expect(host.querySelector('textarea')!.value).toBe(text);
    expect(button('提交回答').disabled).toBe(false);
    expect(answers).toHaveLength(0);
    await act(async () => {
      const input = host.querySelector('textarea')!;
      input.value = '  \n  ';
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    expect(button('提交回答').disabled).toBe(true);
    await act(async () => {
      const input = host.querySelector('textarea')!;
      input.value = text;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(answers).toEqual([
      {
        card: original,
        answer: { kind: 'question', answers: { q1: 'q1-o1', q2: 'q2-o1', q3: { text } } },
      },
    ]);
    await act(async () => release());
    await act(async () =>
      root.render(
        <InteractionCard
          interaction={original}
          submission={{ phase: 'unknown', commandId: 'original-answer' }}
          onAnswer={() => {
            throw Error('must not repeat');
          }}
        />,
      ),
    );
    expect(host.querySelector('textarea')!.value).toBe(text);
    expect(button('提交回答').disabled).toBe(true);
  });
});

test('raw JSON fallback keeps its own page draft across unmount and a replaced identity starts empty', async () => {
  await domFixture(async (host, dom, root) => {
    const card = { ...original, request: { schema: { type: 'array', items: { type: 'string' } } } };
    let draft: QuestionAnswerDraft | undefined;
    const render = (interaction = card) =>
      root.render(
        <InteractionCard
          interaction={interaction}
          initialQuestionDraft={draft}
          onQuestionDraftChange={(next) => {
            draft = next;
          }}
          onAnswer={() => {
            throw Error('owned failure');
          }}
        />,
      );
    await act(async () => render());
    const raw = '["原文\\n尾部"]';
    await act(async () => {
      host.querySelector('textarea')!.value = raw;
      host
        .querySelector('textarea')!
        .dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => root.render(null));
    await act(async () => render());
    expect(host.querySelector('textarea')!.value).toBe(raw);
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('owned failure');
    expect(host.querySelector('textarea')!.value).toBe(raw);
    draft = undefined;
    await act(async () => render({ ...card, inputDigest: 'replaced-input' }));
    expect(host.querySelector('textarea')!.value).toBe('{}');
  });
});

test('the explicit original null alternative answers once without completing required fields', async () => {
  await domFixture(async (host, _dom, root) => {
    const values: NonNullable<Interaction['answer']>[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () =>
      root.render(
        <InteractionCard
          interaction={original}
          onAnswer={async (_card, answer) => {
            values.push(answer);
            await pending;
          }}
        />,
      ),
    );
    const cancel = () =>
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Cancel answering',
      )!;
    await act(async () => {
      cancel().click();
      cancel().click();
    });
    expect(values).toEqual([{ kind: 'question', answers: null }]);
    expect(host.querySelector('input:checked')).toBeNull();
    await act(async () => release());
    await act(async () =>
      root.render(
        <InteractionCard
          interaction={original}
          submission={{ phase: 'unknown', commandId: 'original-null-answer' }}
          onAnswer={() => {
            throw Error('no repeat');
          }}
        />,
      ),
    );
    expect(cancel().disabled).toBe(true);
  });
});
