import { describe, expect, test } from 'bun:test';
import { buildStaticSystemPrompt } from '@kite-ai/builtin-runtime/model';

describe('current primary-agent system prompt', () => {
  test('keeps routine workspace inspection in simple provable tool shapes', () => {
    const prompt = buildStaticSystemPrompt('agent');

    expect(prompt).toContain('`shell_execute` already runs in that workspace');
    expect(prompt).toContain('do not add `cd` or `git -C <workspace>`');
    expect(prompt).toContain('Prefer one simple read-only Git command per call');
    expect(prompt).toContain('avoid `&&`, pipelines, loops');
  });
});
