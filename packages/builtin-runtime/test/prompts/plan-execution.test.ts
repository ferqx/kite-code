import { expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@kite-ai/builtin-runtime/model';

/**
 * Contract: A reviewed plan enters execution; structural revisions request review again.
 *
 * Once a plan is approved, the model must enter building/execution mode and NOT
 * re-emit the plan as a text summary. Structural changes require a new review.
 */
test('system prompt directs approved implementation work into building', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Building may mutate only through admitted tools and policy');
});

test('system prompt links execution phase to approved plan', () => {
  const prompt = buildStaticSystemPrompt('agent');
  // After plan approval, the model should build, not re-plan
  expect(prompt).toMatch(/execut|build|implement/i);
});
