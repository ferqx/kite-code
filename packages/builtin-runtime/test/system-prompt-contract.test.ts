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

  test('does not request extra confirmation for assigned workspace work', () => {
    const prompt = buildStaticSystemPrompt('agent');

    expect(prompt).toContain(
      'In-scope workspace edits and proportionate verification need no extra confirmation',
    );
    expect(prompt).toContain('destructive, external, costly, or scope-expanding actions');
  });
});
