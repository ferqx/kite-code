import { expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@/core/model/context';

/**
 * Contract: ask_user uses one canonical questions array.
 *
 * Every question includes 2-3 concrete options. The first option is recommended,
 * and the TUI supplies free text without a model-generated "Other" option.
 */
test('system prompt requires the canonical questions array and 2-3 options', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Always use the `questions` array');
  expect(prompt).toContain('Do not use top-level `question`');
  expect(prompt).toContain('Every question MUST include 2-3 concrete options');
});

test('system prompt makes the first option recommended', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Put the recommended option first');
});

test('system prompt reserves Other for the TUI', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain(`Do not add an "Other" option`);
  expect(prompt).toContain('provides free-text input automatically');
});
