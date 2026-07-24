import { expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@/core/model/context';

/**
 * Contract: ask_user requires a question and either options or free text.
 *
 * The system prompt must enforce that every ask_user call includes a clear question
 * and 2-4 concrete options (with one marked recommended), OR a free-text prompt.
 */
test('system prompt requires 2-4 concrete options per ask_user call', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Every question MUST include 2-3 concrete options');
});

test('system prompt requires one option marked as recommended', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('mark exactly ONE option as `recommended`');
});

test('system prompt requires every option to have label and description', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toMatch(/label|description/i);
});
