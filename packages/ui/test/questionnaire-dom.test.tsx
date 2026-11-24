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
      [...host.querySelectorAll('button')].find(
        (node) => (node.getAttribute('aria-label') ?? node.textContent) === name,
      )!;
    const counter = () =>
      host.querySelector('nav[aria-label="题目导航"] [role="status"]')?.textContent;
    const choose = async (name: string) =>
      act(async () => host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!.click());
    const click = async (name: string) => act(async () => button(name).click());
    const questions = host.querySelector('fieldset')!;
    const heading = host.querySelector('.questionnaire-header h3')!;
    expect(questions.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(host.querySelector('input:checked')).toBeNull();
    expect(
      [...host.querySelectorAll('input[type="radio"]')].at(-1)?.getAttribute('aria-label'),
    ).toBe('自定义输入');
    expect(button('上一题').disabled).toBe(true);
    expect(button('查看下一题').disabled).toBe(false);
    expect(button('提交回答')).toBeUndefined();
    const firstChoice = host.querySelector('input[aria-label="Alpha 推荐"]')!;
    expect(
      host.ownerDocument.getElementById(firstChoice.getAttribute('aria-describedby')!)!.textContent,
    ).toBe('Full original description\nwith Unicode 尾部');
    expect(counter()).toBe('1/3');
    await click('下一题');
    expect(counter()).toBe('2/3');
    await click('查看下一题');
    expect(counter()).toBe('3/3');
    expect(button('查看下一题').disabled).toBe(true);
    expect(host.ownerDocument.activeElement?.textContent).toBe('q3 original question');
    expect(host.querySelector('.questionnaire-incomplete')?.textContent).toBe('还有 3 题待答');
    expect(button('提交回答').disabled).toBe(true);
    await choose('自定义输入');
    const customRow = host.querySelector('.questionnaire-custom-choice[data-selected="true"]')!;
    expect(customRow.querySelector('input[aria-label="自定义输入"]')).not.toBeNull();
    expect(customRow.querySelector('textarea[aria-label="自定义输入"]')).not.toBeNull();
    const text = '  q3-o1🙂é\n保持 空格  ';
    await act(async () => {
      const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="自定义输入"]')!;
      input.value = text;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click('上一题');
    await choose('q1-o1');
    await click('上一题');
    await choose('Alpha 推荐');
    await click('查看下一题');
    await click('查看下一题');
    expect(host.querySelector('textarea')!.value).toBe(text);
    expect(button('提交回答').disabled).toBe(false);
    expect(host.querySelector('.questionnaire-incomplete')).toBeNull();
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
    expect(host.querySelector('.question-submission')?.textContent).toBe('回答提交结果尚未确认。');
  });
});

test('multi-select keeps checked choices alongside inline custom text and preserves the radio step', async () => {
  await domFixture(async (host, dom, root) => {
    const values: NonNullable<Interaction['answer']>[] = [];
    const route = {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: {
        type: 'string',
        oneOf: [
          { const: 'a', title: 'First route' },
          { const: 'b', title: 'Second route' },
          { const: 'c', title: 'Third route' },
        ],
      },
    };
    const interaction: Interaction = {
      ...original,
      request: {
        schema: {
          type: 'object',
          required: ['routes', 'mode'],
          additionalProperties: false,
          properties: {
            routes: {
              title: '选择路线（可多选）：',
              anyOf: [
                route,
                {
                  type: 'object',
                  required: ['text'],
                  additionalProperties: false,
                  properties: { choices: route, text: { type: 'string', pattern: '\\S' } },
                },
              ],
            },
            mode: { type: 'string', enum: ['manual', 'automatic'] },
          },
        },
      },
    };
    await act(async () =>
      root.render(
        <InteractionCard
          interaction={interaction}
          onAnswer={(_card, answer) => {
            values.push(answer);
          }}
        />,
      ),
    );
    const click = async (selector: string) =>
      act(async () => host.querySelector<HTMLElement>(selector)!.click());
    const custom = 'input[type="checkbox"][aria-label="自定义输入"]';
    const customLabel = () => host.querySelector('.questionnaire-custom-label');
    const editor = () =>
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="自定义输入"]');
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
    expect(host.querySelector('.questionnaire-header h3')?.textContent).toBe('选择路线');
    expect(host.textContent).not.toContain('可多选');
    expect(host.querySelectorAll('input:checked')).toHaveLength(0);
    expect(customLabel()?.textContent).toBe('自定义输入');
    await click('input[aria-label="Third route"]');
    await click(custom);
    expect(editor()?.closest('.questionnaire-choice')).toBe(
      host.querySelector(custom)?.closest('.questionnaire-choice'),
    );
    expect(customLabel()?.textContent).toBe('');
    expect(editor()?.placeholder).toBe('自定义输入');
    expect(host.querySelectorAll('input:checked')).toHaveLength(2);
    const text = '  原文🪁\n第二行  ';
    await act(async () => {
      editor()!.value = text;
      editor()!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click('input[aria-label="First route"]');
    expect(editor()?.value).toBe(text);
    expect(host.querySelectorAll('input:checked')).toHaveLength(3);
    await click(custom);
    expect(editor()).toBeNull();
    expect(customLabel()?.textContent).toBe('自定义输入');
    expect(host.querySelectorAll('input:checked')).toHaveLength(2);
    await click(custom);
    expect(editor()?.value).toBe(text);
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === '下一题')!
        .click(),
    );
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    await click('input[type="radio"][aria-label="manual"]');
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(values).toEqual([
      { kind: 'question', answers: { routes: { choices: ['a', 'c'], text }, mode: 'manual' } },
    ]);
  });
});

test('only the explicitly recommended option gets a badge and no answer is preselected', async () => {
  await domFixture(async (host, _dom, root) => {
    const schema = {
      type: 'object',
      required: ['q1'],
      additionalProperties: false,
      properties: {
        q1: {
          title: 'Choose a route',
          anyOf: [
            { const: 'q1-o1', title: 'First (Recommended)' },
            { const: 'q1-o2', title: 'Second' },
          ],
        },
      },
    };
    const render = async (request: Json) =>
      act(async () =>
        root.render(
          <InteractionCard
            interaction={{ ...original, request }}
            onAnswer={() => {
              throw Error('No explicit answer was submitted');
            }}
          />,
        ),
      );
    const labels = () =>
      [...host.querySelectorAll('input[type="radio"]')].map((input) =>
        input.getAttribute('aria-label'),
      );
    const badges = () => [...host.querySelectorAll('.questionnaire-recommended')];

    await render({ schema });
    expect(labels()).toEqual(['First', 'Second']);
    expect(badges()).toHaveLength(0);

    await render({ schema, recommendedOptions: {} });
    expect(labels()).toEqual(['First (Recommended)', 'Second']);
    expect(badges()).toHaveLength(0);

    await render({ schema, recommendedOptions: { q1: 'q1-o2' } });
    expect(labels()).toEqual(['First (Recommended)', 'Second']);
    expect(badges()).toHaveLength(1);
    expect(badges()[0]?.closest('label')?.querySelector('input')?.getAttribute('aria-label')).toBe(
      'Second',
    );
    expect(host.querySelector('input:checked')).toBeNull();
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
      [...host.querySelectorAll('button')].find((button) => button.textContent === '取消回答')!;
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
