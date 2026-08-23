import { describe, expect, test } from 'bun:test';
import {
  buildCacheableRuntimeContext,
  buildStaticSystemPrompt,
  countTokens,
} from '@kite/builtin-runtime/model';
import { createTestAgentTools as createAgentTools } from '../helpers/runtime-model';

function measure() {
  const tools = createAgentTools({ workspace: 'D:\\workspace', phase: 'building' });
  const system = [
    buildStaticSystemPrompt('agent'),
    buildCacheableRuntimeContext({ workspace: 'D:\\workspace' }),
  ].join('\n\n');
  const toolEntries = Object.entries(tools).map(([name, value]) => {
    const tool = value as unknown as Record<string, unknown>;
    return {
      name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? tool.parameters,
    };
  });
  const systemTokens = countTokens(system);
  const toolTokens = countTokens(JSON.stringify(toolEntries));
  return { systemTokens, toolTokens, totalTokens: systemTokens + toolTokens, tools: toolEntries };
}

describe('Prompt contract token budget', () => {
  test('keeps the current prompt and builtin tool surface within the fixed budget', () => {
    const current = measure();
    expect(current.totalTokens).toBeLessThan(18_000);
    expect(current.systemTokens).toBeGreaterThan(0);
  });

  test('keeps each current builtin description bounded', () => {
    const current = measure();
    for (const tool of current.tools) {
      expect(String(tool.description).length, `${tool.name} description`).toBeLessThan(1_200);
    }
  });

  test('removes lexical planning triggers and stale Skill tool guidance', () => {
    const prompt = buildStaticSystemPrompt('agent');
    expect(prompt).not.toContain('Trigger: planning is REQUIRED');
    expect(prompt).not.toContain('Use the `Skill` tool');
    expect(prompt).toContain('activate_skill');
  });

  test('turns valuable bounded work into the autonomous planning task contract', () => {
    const prompt = buildStaticSystemPrompt('agent');
    expect(prompt).toContain('Use subagents autonomously');
    expect(prompt).toContain('independent enough to justify an isolated model call');
    expect(prompt).toContain('`subagent_type` and a concrete self-contained `task`');
    expect(prompt).toContain('`plan` for architecture/design planning');
    expect(prompt).toContain("`code` only when the user's task calls for implementation");
    expect(prompt).toContain('issue their task calls together in one response');
    expect(prompt).toContain('execute them concurrently within its shared budget');
    expect(prompt).toContain('Serialize dependent tasks');
    expect(prompt).toContain('Obey an explicit user instruction not to delegate');
    expect(prompt).toContain('do not duplicate the assigned investigation');
  });
});
