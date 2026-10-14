import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { ComposerBuffer } from '../../src/tui/composer';
import { TuiPlanReviewPanel } from '../../src/tui/plan-review-panel';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const card = {
  kind: 'plan_review',
  state: 'pending',
  request: { allowedModes: ['accept_edits'] },
} as unknown as Interaction;
test('plan review offers exact modes, requires selection and keeps literal multiline feedback across Esc', async () => {
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
    expect(answers).toEqual(['approve accept_edits']);
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
