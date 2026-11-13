import type { Interaction } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { expect, test } from '#kite-test';
import { ComposerBuffer } from '../../src/tui/composer';
import { TuiPlanReviewPanel } from '../../src/tui/plan-review-panel';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const card = {
  kind: 'plan_review',
  state: 'pending',
  request: { planId: 'p', version: '1', digest: 'digest', content: 'Exact plan' },
} as unknown as Interaction;
test('plan review offers business decisions, requires selection and keeps literal multiline feedback across Esc', async () => {
  const feedback = new ComposerBuffer(),
    answers: string[] = [];
  const ui = render(
    <TuiPlanReviewPanel card={card} feedback={feedback} onAnswer={(text) => answers.push(text)} />,
  );
  try {
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(answers).toEqual([]);
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(answers).toEqual(['approve']);
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(answers).toHaveLength(1);
    feedback.sync('  literal\n反馈🙂  ');
    ui.stdin.write('\u001b');
    await tick();
    expect(feedback.text).toBe('  literal\n反馈🙂  ');
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(answers[1]).toBe('revise   literal\n反馈🙂  ');
  } finally {
    ui.unmount();
  }
});
test('pending or unknown original outcome blocks all new decisions and edits', async () => {
  const feedback = new ComposerBuffer(),
    answers: string[] = [];
  const ui = render(
    <TuiPlanReviewPanel
      card={card}
      feedback={feedback}
      busy
      onAnswer={(text) => answers.push(text)}
    />,
  );
  try {
    await tick();
    ui.stdin.write('\u001b[B\r');
    await tick();
    ui.stdin.write('\u001b');
    await tick();
    expect(answers).toEqual([]);
    expect(feedback.text).toBe('');
  } finally {
    ui.unmount();
  }
});

test('actual input batch confirms the last explicit choice, never the listener initial selection', async () => {
  const answers: string[] = [];
  const ui = render(
    <TuiPlanReviewPanel
      card={card}
      feedback={new ComposerBuffer()}
      onAnswer={(answer) => answers.push(answer)}
    />,
  );
  try {
    await tick();
    ui.stdin.write('\u001b[B\u001b[B\u001b[A\r');
    await tick();
    expect(answers).toEqual(['approve']);
  } finally {
    ui.unmount();
  }
});

test('a replacement card does not inherit the original explicit approval selection', async () => {
  const answers: string[] = [],
    feedback = new ComposerBuffer();
  const ui = render(
    <TuiPlanReviewPanel
      key="original"
      card={card}
      feedback={feedback}
      onAnswer={(answer) => answers.push(answer)}
    />,
  );
  try {
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    ui.rerender(
      <TuiPlanReviewPanel
        key="replacement"
        card={{ ...card, revision: '2' }}
        feedback={feedback}
        onAnswer={(answer) => answers.push(answer)}
      />,
    );
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(answers).toEqual([]);
    expect(ui.lastFrame()).toContain('none (Enter has no answer)');
  } finally {
    ui.unmount();
  }
});
