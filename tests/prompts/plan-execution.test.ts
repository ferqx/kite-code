import { expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@/core/model/context';

/**
 * Contract: A reviewed plan enters execution; structural revisions request review again.
 *
 * Once a plan is approved, the model must enter building/execution mode and NOT
 * re-emit the plan as a text summary. Structural changes require a new review.
 */
test('system prompt forbids re-outputting the plan summary after approval', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Do NOT re-output the plan as a text');
});

test('system prompt links execution phase to approved plan', () => {
  const prompt = buildStaticSystemPrompt('agent');
  // After plan approval, the model should build, not re-plan
  expect(prompt).toMatch(/execut|build|implement/i);
});
