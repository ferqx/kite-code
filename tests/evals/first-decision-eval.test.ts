import { expect, test } from 'bun:test';
import { FIRST_DECISION_CASES, runFirstDecisionEval } from '@/../scripts/evals/first-decision-eval';

test('the former Prompt A/B is named and reported only as first-decision eval', async () => {
  const report = await runFirstDecisionEval({ live: false });
  expect(FIRST_DECISION_CASES).toHaveLength(7);
  expect(report).toMatchObject({
    schema: 'FirstDecisionEvalV1',
    evaluationScope: 'first_decision_only',
    status: 'live_eval_skipped',
    contentLogged: false,
  });
  expect(JSON.stringify(report)).not.toContain('whole_turn');
  expect(JSON.stringify(report)).not.toContain('runtime_journey');
});
