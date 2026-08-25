import { expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@kite-ai/builtin-runtime/model';

test('system prompt limits questions to material choices', () => {
  const prompt = buildStaticSystemPrompt('agent');
  expect(prompt).toContain('Ask only when a material product choice cannot be discovered safely');
});
