/**
 * 验证 buildRunAgentParams / buildRevertParams / buildForkParams
 * 不会遗漏 mcpManager / skills / skillOptions 等关键参数。
 */
import { describe, expect, test } from 'bun:test';
import type { BaseTuiParams } from '../src/app/tui/run-agent';
import { buildForkParams, buildRevertParams, buildRunAgentParams } from '../src/app/tui/run-agent';
import type { McpManager } from '../src/core/mcp';

function baseParams(overrides?: Partial<BaseTuiParams>): BaseTuiParams {
  return {
    threadId: 'tui-test-1',
    workspace: '/tmp/test-workspace',
    config: { providerName: 'deepseek', modelName: 'deepseek-v4' } as any,
    shellExecutor: async (i: any) => ({
      ok: true,
      command: i.command,
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    signal: new AbortController().signal,
    thinkingLevel: 'max',
    skills: [
      {
        name: 'tdd',
        description: 'TDD workflow',
        source: 'project' as const,
        origin: '.openpx' as const,
      },
    ],
    skillOptions: {
      projectOpenpxSkillsDir: '/tmp/.openpx/skills',
      projectAgentsSkillsDir: '/tmp/.agents/skills',
      userOpenpxSkillsDir: '/home/user/.openpx/skills',
      userAgentsSkillsDir: '/home/user/.agents/skills',
    },
    mcpManager: null,
    ...overrides,
  };
}

function mockMcpManager(): McpManager {
  return {
    getAllTools: () => [],
    callTool: async () => 'ok',
    connectAll: async () => {},
    connect: async () => {},
    disconnectAll: async () => {},
    getResources: () => [],
    readResource: async () => '',
    getPromptRegistry: () => new Map(),
    getServerStates: () => new Map(),
  } as any;
}

describe('buildRunAgentParams', () => {
  test('includes mcpManager when provided', () => {
    const mcp = mockMcpManager();
    const params = buildRunAgentParams({
      ...baseParams(),
      mcpManager: mcp as any,
      task: 'hello',
      pendingSkillsContent: '',
      shellContext: '',
    });
    expect(params.mcpManager).toBe(mcp);
  });

  test('mcpManager is undefined when null', () => {
    const params = buildRunAgentParams({
      ...baseParams(),
      mcpManager: null,
      task: 'hello',
      pendingSkillsContent: '',
      shellContext: '',
    });
    expect(params.mcpManager).toBeUndefined();
  });

  test('includes skills and skillOptions', () => {
    const skills = [
      { name: 'tdd', description: 'TDD', source: 'project' as const, origin: '.openpx' as const },
    ];
    const skillOptions = {
      projectOpenpxSkillsDir: '/p',
      projectAgentsSkillsDir: '/a',
      userOpenpxSkillsDir: '/u',
      userAgentsSkillsDir: '/g',
    };
    const params = buildRunAgentParams({
      ...baseParams({ skills, skillOptions }),
      task: 'test',
      pendingSkillsContent: '',
      shellContext: '',
    });
    expect(params.skills).toBe(skills);
    expect(params.skillOptions).toBe(skillOptions);
  });

  test('prepends pendingSkillsContent before task', () => {
    const params = buildRunAgentParams({
      ...baseParams(),
      task: 'do something',
      pendingSkillsContent: '[SKILL: tdd]\n\nWrite tests first.\n\n---\n\n',
      shellContext: '',
    });
    expect(params.task.startsWith('[SKILL: tdd]')).toBe(true);
    expect(params.task.endsWith('do something')).toBe(true);
  });

  test('appends shellContext after task', () => {
    const params = buildRunAgentParams({
      ...baseParams(),
      task: 'do something',
      pendingSkillsContent: '',
      shellContext: '\n> ls output here',
    });
    expect(params.task).toContain('do something\n> ls output here');
  });

  test('skillOptions is undefined when null', () => {
    const params = buildRunAgentParams({
      ...baseParams({ skillOptions: null }),
      task: 'hello',
      pendingSkillsContent: '',
      shellContext: '',
    });
    expect(params.skillOptions).toBeUndefined();
  });
});

describe('buildRevertParams', () => {
  test('includes mcpManager when provided', () => {
    const mcp = mockMcpManager();
    const params = buildRevertParams({
      ...baseParams({ mcpManager: mcp as any }),
      checkpointId: 'cp-1',
    });
    expect(params.mcpManager).toBe(mcp);
  });

  test('contains threadId and checkpointId', () => {
    const params = buildRevertParams({
      ...baseParams(),
      checkpointId: 'cp-abc',
    });
    expect(params.threadId).toBe('tui-test-1');
    expect(params.checkpointId).toBe('cp-abc');
  });
});

describe('buildForkParams', () => {
  test('includes mcpManager when provided', () => {
    const mcp = mockMcpManager();
    const params = buildForkParams({
      ...baseParams({ mcpManager: mcp as any }),
      oldThreadId: 'old-1',
      checkpointId: 'cp-1',
      newThreadId: 'new-2',
    });
    expect(params.mcpManager).toBe(mcp);
  });

  test('contains oldThreadId, checkpointId, and newThreadId', () => {
    const params = buildForkParams({
      ...baseParams(),
      oldThreadId: 'old-1',
      checkpointId: 'cp-1',
      newThreadId: 'new-2',
    });
    expect(params.oldThreadId).toBe('old-1');
    expect(params.checkpointId).toBe('cp-1');
    expect(params.newThreadId).toBe('new-2');
  });
});
