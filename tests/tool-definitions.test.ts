import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillManifest } from '../src/core/skills/types';
import {
  clearToolCache,
  createAgentTools,
  isReadOnlyShellCommand,
} from '../src/core/tools/definitions';
import { TOOL_CONTRACTS } from '../src/core/tools/tool-contracts';

// Helper: AI SDK tools are in a ToolSet (Record<string, Tool>), not an array.
// Tool names are the Record keys; tool lookup is `tools[name]`.
// tool.execute() replaces the old tool.invoke().

function toolNames(tools: Record<string, unknown>): string[] {
  return Object.keys(tools);
}

// Code Agent 工具定义与只读约束单元测试 / Code agent tool definitions & read-only constraint unit tests
describe('code agent tool definitions', () => {
  // 验证 agent 暴露稳定工具 schema / Agent exposes the stable tool schema
  test('exposes cache-stable agent tools plus planning tools', () => {
    const tools = createAgentTools({
      workspace: 'D:\\workspace',
      shellExecutor: async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      }),
    });

    const names = toolNames(tools);
    expect(names).toContain('read_file');
    expect(names).toContain('write_plan');
    expect(names).toContain('update_plan');
    expect(names).toContain('ask_user');
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(tools['read_file']).toBeDefined();
  });

  // ask_user 描述包含 "Ask the user"
  test('ask_user has expected description', () => {
    const tools = createAgentTools({
      workspace: 'D:\\workspace',
    });
    const askUserTool = tools['ask_user']!;

    expect(askUserTool).toBeDefined();
    expect(String(askUserTool.description)).toContain('Ask the user');
  });

  // ── write_plan / update_plan tests ──

  test('write_plan and update_plan are present', () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    expect(tools['write_plan']).toBeDefined();
    expect(tools['update_plan']).toBeDefined();
    expect(String(tools['write_plan']!.description)).toContain('Save');
    expect(String(tools['update_plan']!.description)).toContain('progress');
  });

  test('invokes write_plan and returns plan JSON', async () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    const wp = tools['write_plan']!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- execute() return type
    const raw = (await (wp as any).execute({
      title: 'Refactor',
      body_markdown: 'Split large module into smaller pieces for maintainability.',
      steps: [
        { id: 'extract-helpers', title: 'Extract helpers' },
        { id: 'update-imports', title: 'Update imports' },
        { id: 'remove-old', title: 'Remove old code' },
      ],
    })) as string;
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result._params.title).toBe('Refactor');
    expect(result._params.steps).toHaveLength(3);
    expect(result._params.action).toBe('save');
  });

  test('write_plan schema requires a complete save document', async () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    const schema = (tools['write_plan'] as any).inputSchema;
    const jsonSchema = await schema.jsonSchema;

    // OpenAI-compatible function tools require an object at the schema root;
    // a root-level anyOf is serialized as type=null by some providers.
    expect(jsonSchema.type).toBe('object');

    expect((await schema.validate({ action: 'save' })).success).toBe(false);
    expect(
      (
        await schema.validate({
          action: 'save',
          title: 'Login page',
          body_markdown: 'Implement the login flow and authentication boundary.',
          steps: [{ id: 'build-login', title: 'Build the login interface' }],
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await schema.validate({
          action: 'submit',
          plan_id: 'plan-1',
          version: 1,
          structural_digest: 'digest-1',
        })
      ).success,
    ).toBe(true);
  });

  test('ask_user accepts batch questions without a duplicate top-level question', async () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    const schema = (tools['ask_user'] as any).inputSchema;

    expect(
      (
        await schema.validate({
          questions: [{ id: 'scope', question: 'What scope should be covered?' }],
        })
      ).success,
    ).toBe(true);
    expect((await schema.validate({})).success).toBe(false);
  });

  test('exposes one cache-stable tool set', () => {
    const tools = createAgentTools({
      workspace: 'D:\\workspace',
    });

    const names = toolNames(tools);
    expect(names).toContain('read_file');
    expect(names).toContain('write_plan');
    expect(names).toContain('update_plan');
    expect(names).toContain('ask_user');
    expect(String(tools['write_plan']?.description)).toContain('Save');
    expect(String(tools['update_plan']?.description)).toContain('progress');
    expect(String(tools['ask_user']?.description)).toContain('uncertainty');
  });

  // 验证 search 工具可以不依赖 shell 独立执行 / Search tools execute without shell access
  test('search tools execute without shell access', async () => {
    const workspace = join(tmpdir(), 'kite-code-agent-tools-native-search');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{}\n');
    writeFileSync(join(workspace, 'src', 'alpha.ts'), 'const marker = "needle";\n');

    const tools = createAgentTools({
      workspace,
      shellExecutor: async () => {
        throw new Error('search tools must not invoke shell');
      },
    });
    const searchFiles = tools['search_files']!;
    const searchContent = tools['search_content']!;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- execute() return type
    const filesResult = JSON.parse(
      (await (searchFiles as any).execute({ pattern: 'package.json' })) as string,
    );
    const contentResult = JSON.parse(
      (await (searchContent as any).execute({ pattern: 'needle' })) as string,
    );

    expect(filesResult.ok).toBe(true);
    expect(filesResult.stdout).toContain('package.json');
    expect(contentResult.ok).toBe(true);
    expect(contentResult.stdout).toContain('src/alpha.ts:1:const marker = "needle";');
  });

  // 验证常见只读 shell 命令（ls, cat, rg, git status 等）被正确分类为只读 / Common read-only shell commands (ls, cat, rg, git status, etc.) are correctly classified as read-only
  test('classifies conservative shell_execute inspect commands as read-only', () => {
    expect(isReadOnlyShellCommand('pwd')).toBe(true);
    expect(isReadOnlyShellCommand('ls src')).toBe(true);
    expect(isReadOnlyShellCommand('rg -n "Plan" src tests')).toBe(true);
    expect(isReadOnlyShellCommand('cat package.json | head -n 20')).toBe(true);
    expect(isReadOnlyShellCommand('git status --short')).toBe(true);
    expect(isReadOnlyShellCommand('git diff -- src/app/runner.ts')).toBe(true);
    // /dev/null 重定向用于抑制输出，应视为只读安全 / /dev/null redirects for output suppression are read-only safe
    expect(isReadOnlyShellCommand('ls -la src tests 2>/dev/null')).toBe(true);
    expect(isReadOnlyShellCommand("find . -name '*.ts' >/dev/null 2>&1")).toBe(true);
    // 管道中的只读命令 / Read-only commands in pipelines
    expect(
      isReadOnlyShellCommand("find src -type f | sed 's/.*\\.//' | sort | uniq -c | sort -rn"),
    ).toBe(true);
    expect(isReadOnlyShellCommand('cut -d: -f1 /etc/passwd')).toBe(true);
    expect(isReadOnlyShellCommand("tr 'a-z' 'A-Z' < input.txt")).toBe(true);
  });

  // 验证可能写入、删除或执行项目代码的 shell 命令不会被分类为只读（sed -i, rm -rf, git add, mkdir 等） / Shell commands that can write, delete, or execute project code (sed -i, rm -rf, git add, mkdir, etc.) are not classified as read-only
  test('does not classify mutating shell_execute commands as read-only', () => {
    expect(isReadOnlyShellCommand('echo hi > hello.txt')).toBe(false);
    expect(isReadOnlyShellCommand("sed -i 's/a/b/' src/a.ts")).toBe(false);
    expect(isReadOnlyShellCommand('rm -rf src')).toBe(false);
    expect(isReadOnlyShellCommand('bun test')).toBe(false);
    expect(isReadOnlyShellCommand('git add -A')).toBe(false);
    expect(isReadOnlyShellCommand('mkdir -p tmp')).toBe(false);
    expect(isReadOnlyShellCommand('find . -exec rm {} ;')).toBe(false);
    expect(isReadOnlyShellCommand('awk \'BEGIN { system("rm hello.txt") }\'')).toBe(false);
    // 裸 & 命令分隔符注入
    expect(isReadOnlyShellCommand('echo hello & rm -rf src')).toBe(false);
    // && 和 2>&1 仍然允许
    expect(isReadOnlyShellCommand('rg pattern file 2>&1')).toBe(true);
    expect(isReadOnlyShellCommand('cat a.txt && cat b.txt')).toBe(true);
  });

  // ── Prompt cache: MCP tool ordering / MCP 工具顺序不破坏前缀缓存 ──
  // Note: MCP tools temporarily disabled during migration; these tests verify cache behavior only

  test('standalone mode preserves cache-stable tool set', () => {
    // 独立工具模式（无 MCP）应始终返回相同顺序的工具
    const tools1 = createAgentTools({ workspace: '/tmp' });
    const tools2 = createAgentTools({ workspace: '/tmp' });
    expect(toolNames(tools1)).toEqual(toolNames(tools2));
  });

  test('invalidates tool cache when runtime policy state changes', () => {
    const planningTools = createAgentTools({
      workspace: '/tmp',
      phase: 'planning',
      authorization: { mode: 'default', commandGrants: {} },
      workspaceAccess: 'write',
    });
    const buildingTools = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'full_access', commandGrants: {} },
      workspaceAccess: 'write',
    });

    expect(buildingTools).not.toBe(planningTools);
    expect(toolNames(buildingTools)).toEqual(toolNames(planningTools));
  });

  test('invalidates tool cache when same-sized command grants change', () => {
    const grantA = {
      'grant-a': {
        workspace: '/tmp',
        threadId: 'thread-1',
        command: 'bun test a',
        source: 'test' as const,
        grantedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const grantB = {
      'grant-b': {
        workspace: '/tmp',
        threadId: 'thread-1',
        command: 'bun test b',
        source: 'test' as const,
        grantedAt: '2026-01-01T00:00:00.000Z',
      },
    };

    const toolsA = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: grantA },
      workspaceAccess: 'write',
    });
    const toolsB = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: grantB },
      workspaceAccess: 'write',
    });

    expect(toolsB).not.toBe(toolsA);
    expect(toolNames(toolsB)).toEqual(toolNames(toolsA));
  });

  // ── Prompt cache: Skill tool placement / Skill 工具插入不影响其他工具 ──

  test('Skill tool present in tool set when skills provided', () => {
    const skills: SkillManifest[] = [
      {
        name: 'tdd',
        description: 'Test-driven development',
        source: 'project',
        origin: '.kite-code',
      },
    ];

    const tools = createAgentTools({
      workspace: '/tmp',
      skills,
      skillOptions: {
        projectKiteCodeSkillsDir: '/tmp/.kite-code/skills',
        projectAgentsSkillsDir: '/tmp/.agents/skills',
        userKiteCodeSkillsDir: '/tmp/user-skills',
        userAgentsSkillsDir: '/tmp/user-agents-skills',
      },
    });

    const names = toolNames(tools);

    // Skill 在工具集中
    expect(names).toContain('Skill');
    expect(tools['Skill']).toBeDefined();
  });

  test('builtin tools unchanged when Skill is present', () => {
    const baseNames = toolNames(createAgentTools({ workspace: '/tmp' }));

    const skills: SkillManifest[] = [
      { name: 'tdd', description: 'TDD workflow', source: 'project', origin: '.kite-code' },
    ];

    const withSkill = createAgentTools({
      workspace: '/tmp',
      skills,
      skillOptions: {
        projectKiteCodeSkillsDir: '/tmp/.kite-code/skills',
        projectAgentsSkillsDir: '/tmp/.agents/skills',
        userKiteCodeSkillsDir: '/tmp/user-skills',
        userAgentsSkillsDir: '/tmp/user-agents-skills',
      },
    });

    const skillNames = toolNames(withSkill);

    // 去掉 Skill 后，其余内置工具与 base 完全相同
    const withoutSkill = skillNames.filter((n) => n !== 'Skill');
    expect(withoutSkill).toEqual(baseNames);
  });
});

// 工具契约验证测试：确保所有工具描述作为一等 UX 契约，包含何时使用、常见误区、输出格式和失败处理 / Tool contract verification: ensure all tool descriptions are first-class UX contracts with whenToUse, commonMistakes, outputFormat, and failureHandling sections
describe('tool contracts (ACI)', () => {
  const registeredTools = [
    'read_file',
    'edit_file',
    'write_file',
    'shell_execute',
    'search_content',
    'search_files',
    'update_plan',
    'write_plan',
    'read_mcp_resource',
    'ask_user',
    'web_fetch',
  ];

  // 每个注册工具的契约必须存在 / Every registered tool must have a contract
  test('every registered tool has a contract', () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name);
      expect(contract).toBeDefined();
      expect(contract?.name).toBe(name);
    }
  });

  // 每个契约必须有非空的四个基本部分 / Every contract must have four non-empty sections
  test('every contract has four non-empty sections', () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(contract.sections.whenToUse.length).toBeGreaterThan(20);
      expect(contract.sections.commonMistakes.length).toBeGreaterThan(20);
      expect(contract.sections.outputFormat.length).toBeGreaterThan(10);
      expect(contract.sections.failureHandling.length).toBeGreaterThan(20);
    }
  });

  // 每个契约的描述必须与 sections 内容一致 / Each contract's description must be consistent with its sections
  test('contract description embeds all section content', () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(contract.description).toContain(contract.sections.whenToUse.slice(0, 30));
      expect(contract.description).toContain('Common mistakes');
      expect(contract.description).toContain('Output:');
      expect(contract.description).toContain('Failure:');
    }
  });

  // 每个注册工具的 tool() description 必须等于其契约描述 / Each registered tool() description must equal its contract description
  test('tool descriptions match contract descriptions', () => {
    const tools = createAgentTools({
      workspace: '/tmp/test-workspace',
    });
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      const toolObj = tools[name];
      expect(toolObj).toBeDefined();
      expect(toolObj?.description).toBe(contract.description);
    }
  });

  // whenToUse 必须提及至少一个不应使用该工具的替代方案 / whenToUse must mention at least one alternative tool name
  test('whenToUse mentions at least one alternative tool name', () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      const others = registeredTools.filter((n) => n !== name);
      const mentionsAlternative = others.some((otherName) =>
        contract.sections.whenToUse.includes(otherName),
      );
      expect(
        mentionsAlternative,
        `${name}: whenToUse should reference at least one other tool name (e.g. "use write_file instead")`,
      ).toBe(true);
    }
  });

  // commonMistakes 必须包含可操作的具体错误模式 / commonMistakes must contain actionable specific failure patterns
  test('commonMistakes describes actionable failure patterns', () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(
        contract.sections.commonMistakes,
        `${name}: commonMistakes should describe specific things the model does wrong`,
      ).toMatch(
        /fail|error|match|reject|denied|wrong|incorrect|forget|overusing|substitute|should not|instead|avoid|vague|without|lack|could answer|not providing/i,
      );
    }
  });

  // outputFormat 必须提及至少一个返回字段名 / outputFormat must mention at least one JSON field name
  test('outputFormat describes expected JSON fields', () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(
        contract.sections.outputFormat,
        `${name}: outputFormat should mention specific field names`,
      ).toMatch(/\bok\b/);
    }
  });

  // failureHandling 必须提供可执行的恢复步骤 / failureHandling must provide executable recovery steps
  test('failureHandling provides actionable recovery steps', () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(
        contract.sections.failureHandling,
        `${name}: failureHandling should describe recovery actions`,
      ).toMatch(
        /retry|re-read|adjust|switch|fix|check|verify|read_file|shell_execute|edit_file|write_file|update_plan|call|again|no error|recover/i,
      );
    }
  });

  // shell_execute 的特殊契约要求 / shell_execute-specific contract requirements
  test('shell_execute contract covers intent enumeration and approval rejection', () => {
    const contract = TOOL_CONTRACTS.get('shell_execute')!;
    expect(contract.sections.whenToUse).toMatch(
      /intent=inspect|intent=verify|intent=test|intent=build|intent=git/,
    );
    expect(contract.sections.commonMistakes).toMatch(/reject/);
    expect(contract.sections.failureHandling).toMatch(/rejected by policy|denied|plan mode/);
  });

  // read_mcp_resource 工具定义验证 / read_mcp_resource tool definition validation
  test('read_mcp_resource tool is defined', () => {
    const tools = createAgentTools({
      workspace: '/workspace',
    });
    const tool = tools['read_mcp_resource']!;
    expect(tool).toBeDefined();
    expect(String(tool.description)).toContain('MCP');
  });

  // apply_patch 契约标记为 @reserved，待需求确认后启用 / apply_patch contract is reserved for future enablement
  test('apply_patch contract is reserved, not wired to agent tools', () => {
    const contract = TOOL_CONTRACTS.get('apply_patch');
    expect(contract).toBeUndefined();
    const tools = createAgentTools({ workspace: '/tmp' });
    expect(tools['apply_patch']).toBeUndefined();
  });

  // ── Cache key stabilization ──

  test('returns same tool instances on cache hit (same state)', () => {
    clearToolCache();
    const a = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
      workspaceAccess: 'write',
      interactionMode: 'auto',
    });
    const b = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
      workspaceAccess: 'write',
      interactionMode: 'auto',
    });
    // Same state → cache hit → same object reference returned
    expect(a).toBe(b);
  });

  test('different phase produces different cache key (cache miss)', () => {
    clearToolCache();
    const planning = createAgentTools({
      workspace: '/tmp',
      phase: 'planning',
      authorization: { mode: 'default', commandGrants: {} },
    });
    const building = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
    });
    expect(planning).not.toBe(building);
  });

  test('different authorization mode produces different cache key (cache miss)', () => {
    clearToolCache();
    const defaultAuth = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
    });
    const fullAccess = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'full_access', commandGrants: {} },
    });
    expect(defaultAuth).not.toBe(fullAccess);
  });

  test('different commandGrants produces different cache key (cache miss)', () => {
    clearToolCache();
    const noGrants = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
    });
    const withGrants = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: {
        mode: 'default',
        commandGrants: {
          'thread-x::/tmp::bun test': {
            workspace: '/tmp',
            threadId: 'thread-x',
            command: 'bun test',
            source: 'test' as const,
            grantedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    });
    expect(noGrants).not.toBe(withGrants);
  });

  test('different interactionMode produces different cache key (cache miss)', () => {
    clearToolCache();
    const auto = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
      interactionMode: 'auto',
    });
    const ask = createAgentTools({
      workspace: '/tmp',
      phase: 'building',
      authorization: { mode: 'default', commandGrants: {} },
      interactionMode: 'accept_edits',
    });
    expect(auto).not.toBe(ask);
  });

  test('different threadId invalidates cache', () => {
    clearToolCache();
    const t1 = createAgentTools({
      workspace: '/tmp',
      threadId: 'thread-a',
    });
    const t2 = createAgentTools({
      workspace: '/tmp',
      threadId: 'thread-b',
    });
    expect(t1).not.toBe(t2);
  });
});
