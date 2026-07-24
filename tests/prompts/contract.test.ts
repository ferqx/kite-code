import { expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@/core/model/context';
import { createFullModePolicy } from '@/core/policies/mode-policy';

test('full-mode contract is backed by policy rather than prompt text alone', () => {
  expect(
    createFullModePolicy(true).shouldAskUser({
      interactionMode: 'full',
      phase: 'building',
      planKind: 'building_without_plan',
    }),
  ).toMatchObject({ kind: 'deny' });
});

test('the runtime injects the plan lifecycle contract into every model prompt', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('read-only exploration first');
  expect(prompt).toContain('Do NOT re-output the plan as a text\nsummary');
});

test('the runtime injects the ask-user option contract into every model prompt', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Every question MUST include 2-3 concrete options');
  expect(prompt).toContain('mark exactly ONE option as `recommended`');
});
