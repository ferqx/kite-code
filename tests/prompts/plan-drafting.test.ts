import { expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@kite/builtin-runtime/model';

/**
 * Contract: Complex planning work reads/searches before proposing a structural plan.
 *
 * The system prompt must instruct the model to explore (read/search) the codebase
 * before submitting a plan. This prevents plans based on assumptions rather than
 * actual code structure.
 */
test('system prompt instructs read-only exploration before plan submission', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Planning is read-only');
  expect(prompt).toContain('Read files before editing');
});

test('system prompt requires reading existing code before proposing a plan', () => {
  const prompt = buildStaticSystemPrompt('agent');
  // The plan lifecycle contract must mention gathering context before structural changes
  expect(prompt).toMatch(/plan/i);
  expect(prompt).toMatch(/read|search|explore|gather|understand/i);
});

test('system prompt keeps executable validation in building', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain(
    'leave tests, builds, installs, formatting, generation, and mutations in the plan for Building',
  );
});

test('system prompt directs planning edits into the Plan instead of an approval request', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('do not call file-writing or side-effectful tools');
});
