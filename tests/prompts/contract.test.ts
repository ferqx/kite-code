import { expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@kite/builtin-runtime/model';
import { testBuiltinToolCatalogV1 } from '../helpers/runtime-model';

test('full-mode contract allows ask_user for plan clarification', () => {
  const entry = testBuiltinToolCatalogV1().entries.find(
    (candidate) => candidate.visibility === 'model' && candidate.name === 'ask_user',
  );
  if (entry?.visibility !== 'model') throw new Error('ask_user Builtin entry missing');
  expect(
    entry.compilePolicy(
      {
        questions: [
          {
            question: 'Continue?',
            options: [
              { label: 'Yes', description: 'Continue.', recommended: true },
              { label: 'No', description: 'Stop.', recommended: false },
            ],
          },
        ],
      },
      { workspace: '/tmp/prompt-contract', phase: 'building' },
    ),
  ).toMatchObject({ decision: 'allow', allowed: true, requiresApproval: false });
});

test('the runtime injects the plan lifecycle contract into every model prompt', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('read-only exploration first');
  expect(prompt).toContain('Do NOT re-output the plan as a text\nsummary');
});

test('the runtime injects the ask-user option contract into every model prompt', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Every question MUST include 2-3 concrete options');
  expect(prompt).toContain('Every option MUST include a clear `label`,');
  expect(prompt).toContain('and `recommended: false` on all other options');
  expect(prompt).toContain('Do not use top-level `question`');
});
