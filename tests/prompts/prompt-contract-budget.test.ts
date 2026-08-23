import { describe, expect, test } from 'bun:test';
import {
  buildCacheableRuntimeContext,
  buildStaticSystemPrompt,
  countTokens,
} from '@kite/builtin-runtime/model';
import type { AgentConfig } from '#app/config';
import { createTestAgentTools as createAgentTools } from '../helpers/runtime-model';

function measure(version: 'legacy' | 'v2') {
  const config = {
    features: { promptContract: version === 'v2' },
  } as AgentConfig;
  const tools = createAgentTools({ workspace: 'D:\\workspace', phase: 'building', config });
  const system = [
    buildStaticSystemPrompt('agent', undefined, undefined, version),
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

describe('Prompt Contract V2 token budget', () => {
  test('uses at most 70 percent of the legacy stable prompt and builtin tool surface', () => {
    const legacy = measure('legacy');
    const v2 = measure('v2');
    expect(v2.totalTokens).toBeLessThanOrEqual(Math.floor(legacy.totalTokens * 0.7));
    expect(v2.systemTokens).toBeLessThan(legacy.systemTokens);
  });

  test('keeps each V2 builtin description bounded', () => {
    const v2 = measure('v2');
    for (const tool of v2.tools) {
      expect(String(tool.description).length, `${tool.name} description`).toBeLessThan(1_200);
    }
  });

  test('removes lexical planning triggers and stale Skill tool guidance', () => {
    const prompt = buildStaticSystemPrompt('agent', undefined, undefined, 'v2');
    expect(prompt).not.toContain('Trigger: planning is REQUIRED');
    expect(prompt).not.toContain('Use the `Skill` tool');
    expect(prompt).toContain('activate_skill');
  });

  test('turns valuable bounded work into the autonomous planning task contract', () => {
    const prompt = buildStaticSystemPrompt('agent', undefined, undefined, 'v2');
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
