import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../src/core/config';
import { exposedMcpToolName } from '../src/core/mcp';
import { isReadOnlyShellCommand } from '../src/core/policies/shell-classification';
import { clearToolCache, createAgentTools } from '../src/core/tools/definitions';
import { builtinToolRegistry } from '../src/core/tools/registry/builtins';
import { askUserSpec } from '../src/core/tools/registry/builtins/ask-user';
import { searchContentSpec } from '../src/core/tools/registry/builtins/search-content';
import { searchFilesSpec } from '../src/core/tools/registry/builtins/search-files';
import { writePlanSpec } from '../src/core/tools/registry/builtins/write-plan';
import { dispatchRegisteredTool } from '../src/core/tools/registry/dispatch';
import { TOOL_CONTRACTS } from '../src/core/tools/tool-contracts';
import type { CapabilityBinding, CapabilityDescriptor } from '../src/protocol/capabilities';

// Helper: AI SDK tools are in a ToolSet (Record<string, Tool>), not an array.
// Tool names are the Record keys; tool lookup is `tools[name]`.
// tool.execute() replaces the old tool.invoke().

// AI SDK Schema 的结构化投影。schema-only 工具的 inputSchema 在运行时是
// zodSchema() 包装后的 Schema：jsonSchema 可等待解析为 JSON Schema，
// validate 返回 { success } 校验结果。
interface ToolSchemaLike {
  jsonSchema: { type?: string } | PromiseLike<{ type?: string }>;
  validate: (value: unknown) => { success: boolean } | PromiseLike<{ success: boolean }>;
}

// ask_user 规范 questions-only JSON Schema 的窄结构投影（min/max 约束）。
interface AskUserJsonSchema {
  required?: string[];
  properties: {
    questions: {
      minItems?: number;
      maxItems?: number;
      items: {
        required?: string[];
        properties: {
          options: { minItems?: number; maxItems?: number };
        };
      };
    };
  };
}

function toolNames(tools: Record<string, unknown>): string[] {
  return Object.keys(tools);
}

// Code Agent 工具定义与只读约束单元测试 / Code agent tool definitions & read-only constraint unit tests
describe('code agent tool definitions', () => {
  test('normalizes remote MCP tool names into stable model-safe identifiers', () => {
    expect(exposedMcpToolName('docs', 'search_docs')).toBe('mcp__docs__search_docs');
    const unsafe = exposedMcpToolName(
      'provider.with.dots',
      '搜索 documentation / with spaces and a very long remote tool name'.repeat(2),
    );
    expect(unsafe).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(unsafe.length).toBeLessThanOrEqual(64);
    expect(unsafe).toBe(
      exposedMcpToolName(
        'provider.with.dots',
        '搜索 documentation / with spaces and a very long remote tool name'.repeat(2),
      ),
    );
    expect(unsafe).not.toBe(exposedMcpToolName('provider.with.dots', `${unsafe}-other`));
  });

  test('appends only Runtime-issued MCP bindings without an execute handler', () => {
    const descriptor: CapabilityDescriptor = {
      capabilityId: 'mcp:fixture/read',
      revision: 'revision-1',
      kind: 'mcp_tool',
      displayName: 'read',
      description: 'Read fixture data',
      provider: { type: 'mcp', id: 'fixture', provenance: 'remote' },
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      declaredEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
      effectiveEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
      availability: 'available',
      diagnostics: [],
    };
    const binding: CapabilityBinding = {
      bindingId: 'binding-1',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: 'mcp__fixture__read',
      schemaDigest: 'schema-1',
      issuedForTurnId: 'turn-1',
    };
    const tools = createAgentTools({
      workspace: '/workspace',
      mcpBindings: [{ binding, descriptor }],
    });
    expect(Object.keys(tools).at(-1)).toBe('mcp__fixture__read');
    expect(tools.mcp__fixture__read).toBeDefined();
    expect('execute' in tools.mcp__fixture__read!).toBe(false);
  });

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
    expect(tools.read_file).toBeDefined();
  });

  // ask_user 描述包含 "Ask the user"
  test('ask_user has expected description', () => {
    const tools = createAgentTools({
      workspace: 'D:\\workspace',
    });
    const askUserTool = tools.ask_user!;

    expect(askUserTool).toBeDefined();
    expect(String(askUserTool.description)).toContain('Ask the user');
  });

  // ── write_plan / update_plan tests ──

  test('write_plan and update_plan are present', () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    expect(tools.write_plan).toBeDefined();
    expect(tools.update_plan).toBeDefined();
    expect(String(tools.write_plan!.description)).toContain('Save');
    expect(String(tools.update_plan!.description)).toContain('progress');
  });

  test('write_plan is schema-only and Registry preserves parsed arguments', () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    const wp = tools.write_plan!;
    expect((wp as { execute?: unknown }).execute).toBeUndefined();
    const input = {
      title: 'Refactor',
      body_markdown: 'Split large module into smaller pieces for maintainability.',
      steps: [
        { id: 'extract-helpers', title: 'Extract helpers' },
        { id: 'update-imports', title: 'Update imports' },
        { id: 'remove-old', title: 'Remove old code' },
      ],
    };
    const parsed = builtinToolRegistry.parseToolCall(
      { name: 'write_plan', args: input },
      { workspace: '/tmp' },
    );
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) expect(parsed.args).toEqual(writePlanSpec.inputSchema.parse(input));
  });

  test('write_plan schema requires a complete save document', async () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    const schema = (tools.write_plan as unknown as { inputSchema: ToolSchemaLike }).inputSchema;
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

  test('ask_user exposes one canonical questions-only model schema', async () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    const schema = (tools.ask_user as unknown as { inputSchema: ToolSchemaLike }).inputSchema;
    const validQuestion = {
      question: 'What scope should be covered?',
      options: [
        { label: 'Focused', description: 'Cover only the critical path.', recommended: true },
        {
          label: 'Complete',
          description: 'Cover the full production rollout.',
          recommended: false,
        },
      ],
    };

    expect((await schema.validate({ questions: [validQuestion] })).success).toBe(true);
    expect(
      (
        await schema.validate({
          questions: [
            {
              ...validQuestion,
              options: validQuestion.options.map((option) => ({ ...option, recommended: false })),
            },
          ],
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await schema.validate({
          questions: [
            {
              ...validQuestion,
              options: validQuestion.options.map((option) => ({ ...option, recommended: true })),
            },
          ],
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await schema.validate({
          questions: [
            {
              ...validQuestion,
              options: [
                { ...validQuestion.options[0], id: 'legacy-option-id' },
                validQuestion.options[1],
              ],
            },
          ],
        })
      ).success,
    ).toBe(false);
    expect((await schema.validate({})).success).toBe(false);
    expect((await schema.validate({ question: validQuestion.question })).success).toBe(false);
    expect(
      (
        await schema.validate({
          questions: [validQuestion],
          question: validQuestion.question,
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await schema.validate({
          questions: [{ ...validQuestion, id: 'legacy-question-id' }],
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await schema.validate({
          questions: [{ ...validQuestion, options: validQuestion.options.slice(0, 1) }],
        })
      ).success,
    ).toBe(false);
    expect(
      (await schema.validate({ questions: Array.from({ length: 4 }, () => validQuestion) }))
        .success,
    ).toBe(false);

    const json = schema.jsonSchema as unknown as AskUserJsonSchema;
    expect(Object.keys(json.properties)).toEqual(['questions']);
    expect(json.required).toEqual(['questions']);
    expect(json.properties.questions.minItems).toBe(1);
    expect(json.properties.questions.maxItems).toBe(3);
    expect(json.properties.questions.items.properties.options.minItems).toBe(2);
    expect(json.properties.questions.items.properties.options.maxItems).toBe(3);
    expect(json.properties.questions.items.required).toEqual(['question', 'options']);
    const optionSchema = (
      json.properties.questions.items.properties.options as unknown as {
        items: { required?: string[] };
      }
    ).items;
    expect(optionSchema.required).toEqual(['label', 'description', 'recommended']);
  });

  test('ask_user input schema remains capability-descriptor representable', () => {
    const descriptor = builtinToolRegistry.descriptorOf(askUserSpec);
    expect(descriptor.inputSchema).toMatchObject({
      type: 'object',
      required: ['questions'],
    });
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
    expect(String(tools.write_plan?.description)).toContain('Save');
    expect(String(tools.update_plan?.description)).toContain('progress');
    expect(String(tools.ask_user?.description)).toContain('uncertainty');
  });

  // 验证 search 工具可以不依赖 shell 独立执行 / Search tools execute without shell access
  test('search tools execute without shell access', async () => {
    const workspace = join(tmpdir(), 'kite-code-agent-tools-native-search');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{}\n');
    writeFileSync(join(workspace, 'src', 'alpha.ts'), 'const marker = "needle";\n');

    // 迁移后（ADR-0043 S1.2）搜索工具的模型条目为 schema-only，
    // 执行经 Registry dispatch 验证（原生搜索，不触碰 shell）。
    const filesOutcome = await dispatchRegisteredTool(
      searchFilesSpec,
      { pattern: 'package.json' },
      { workspace },
    );
    const contentOutcome = await dispatchRegisteredTool(
      searchContentSpec,
      { pattern: 'needle' },
      { workspace },
    );

    expect(filesOutcome.dispatched).toBe(true);
    expect(contentOutcome.dispatched).toBe(true);
    if (filesOutcome.dispatched) {
      expect(filesOutcome.output.ok).toBe(true);
      expect(filesOutcome.output.stdout).toContain('package.json');
    }
    if (contentOutcome.dispatched) {
      expect(contentOutcome.output.ok).toBe(true);
      expect(contentOutcome.output.stdout).toContain('src/alpha.ts:1:const marker = "needle";');
    }
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

  // ── Workflow Skill activation / Workflow Skill 不使用正文注入 ──

  test('exposes activate_skill only with a compiled catalog and both feature flags', () => {
    const tools = createAgentTools({
      workspace: '/tmp',
      config: {
        features: { skillWorkflowV1: true, skillActivationV2: true },
      } as unknown as AgentConfig,
      skillCatalog: {
        revision: 'skills-r1',
        capabilities: {
          revision: 'skills-r1',
          descriptors: [
            {
              capabilityId: 'skill:tdd',
              revision: 'tdd-r1',
              kind: 'skill',
              displayName: 'tdd',
              description: 'Test-driven development',
              provider: { type: 'skill', id: 'tdd', provenance: 'project' },
              declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
              effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
              policy: { workspaceTrustRequired: true, minimumApproval: 'none' },
              availability: 'available',
              diagnostics: [],
            },
          ],
        },
        entries: [],
      },
    });

    const names = toolNames(tools);
    expect(names).toContain('activate_skill');
    expect(names).not.toContain('Skill');
    expect(tools.activate_skill).toBeDefined();
  });

  test('legacy prompt skill inputs do not change builtin tools', () => {
    const baseNames = toolNames(createAgentTools({ workspace: '/tmp' }));

    const withSkill = createAgentTools({
      workspace: '/tmp',
      skills: [
        { name: 'tdd', description: 'TDD workflow', source: 'project', origin: '.kite-code' },
      ],
      skillOptions: {
        projectKiteCodeSkillsDir: '/tmp/.kite-code/skills',
        projectAgentsSkillsDir: '/tmp/.agents/skills',
        userKiteCodeSkillsDir: '/tmp/user-skills',
        userAgentsSkillsDir: '/tmp/user-agents-skills',
      },
    });

    const skillNames = toolNames(withSkill);

    expect(skillNames).toEqual(baseNames);
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
    'tool_search',
    'list_mcp_resources',
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
      toolSearch: true,
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
  test('shell_execute contract covers command-shaped approval rejection', () => {
    const contract = TOOL_CONTRACTS.get('shell_execute')!;
    expect(contract.sections.whenToUse).not.toMatch(/intent=|grant_request|prefix_rule/);
    expect(contract.sections.whenToUse).toMatch(/During planning.*proven read-only/);
    expect(contract.sections.commonMistakes).toMatch(/denied|reject/);
    expect(contract.sections.outputFormat).toMatch(/deferred: true.*until_phase: building/);
    expect(contract.sections.failureHandling).toMatch(
      /deferred until building.*do not retry.*do not ask for shell approval/,
    );
    expect(contract.sections.failureHandling).toMatch(/rejected by policy|approval flow|denied/);
  });

  test('file mutation contracts keep planning changes in the Plan', () => {
    for (const name of ['edit_file', 'write_file']) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(contract.sections.whenToUse).toMatch(/only in the building phase/);
      expect(contract.sections.whenToUse).toMatch(
        /During planning.*describe.*in the plan.*do not call.*or request approval/,
      );
      expect(contract.sections.failureHandling).toMatch(
        /planning phase.*do not retry or request approval.*plan.*after plan approval/,
      );
    }
  });

  test('ask_user contract exposes only the canonical questions shape', () => {
    const contract = TOOL_CONTRACTS.get('ask_user')!;
    expect(contract.sections.whenToUse).toMatch(/single question is an array with one item/);
    expect(contract.sections.commonMistakes).toMatch(/removed top-level `question`/);
    expect(contract.sections.commonMistakes).toMatch(/client always adds free-text input/);
    expect(contract.sections.outputFormat).toContain('`questions` contains 1-3 items');
    expect(contract.sections.outputFormat).toContain('2-3 `{label, description, recommended}`');
    expect(contract.sections.failureHandling).toMatch(
      /canonical `questions` array.*never pass stringified JSON/,
    );
  });

  // MCP resource tools form one discover/read client-side chain.
  test('MCP resource list and read tools are defined with the client-side contract', () => {
    const tools = createAgentTools({
      workspace: '/workspace',
    });
    expect(tools.list_mcp_resources).toBeDefined();
    expect(tools.read_mcp_resource).toBeDefined();
    expect(String(tools.read_mcp_resource?.description)).toContain('list_mcp_resources');
    expect(String(tools.read_mcp_resource?.description)).not.toContain(
      'mcp__<server>__list_resources',
    );
  });

  // ── Stateless tool projection ──

  test('reprojects an equivalent schema-only surface without retaining session objects', () => {
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
    expect(a).not.toBe(b);
    expect(toolNames(a)).toEqual(toolNames(b));
    expect(Object.values(a).every((entry) => entry.execute === undefined)).toBe(true);
  });

  test('reprojects equivalent MCP bindings without retaining turn-scoped objects', () => {
    clearToolCache();
    const descriptor: CapabilityDescriptor = {
      capabilityId: 'mcp:fixture/read',
      revision: 'revision-1',
      kind: 'mcp_tool',
      displayName: 'read',
      description: 'Read fixture data',
      provider: { type: 'mcp', id: 'fixture', provenance: 'remote' },
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      availability: 'available',
      diagnostics: [],
    };
    const binding = (overrides: Partial<CapabilityBinding> = {}): CapabilityBinding => ({
      bindingId: 'binding-turn-1',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: 'mcp__fixture__read',
      schemaDigest: 'schema-1',
      issuedForTurnId: 'turn-1',
      ...overrides,
    });
    const first = createAgentTools({
      workspace: '/tmp',
      mcpBindings: [{ descriptor, binding: binding() }],
    });
    const nextTurn = createAgentTools({
      workspace: '/tmp',
      mcpBindings: [
        {
          descriptor,
          binding: binding({ bindingId: 'binding-turn-2', issuedForTurnId: 'turn-2' }),
        },
      ],
    });
    const revisionChanged = createAgentTools({
      workspace: '/tmp',
      mcpBindings: [
        {
          descriptor: { ...descriptor, revision: 'revision-2' },
          binding: binding({
            capabilityRevision: 'revision-2',
            bindingId: 'binding-revision-2',
          }),
        },
      ],
    });
    const schemaChanged = createAgentTools({
      workspace: '/tmp',
      mcpBindings: [
        {
          descriptor,
          binding: binding({ schemaDigest: 'schema-2', bindingId: 'binding-schema-2' }),
        },
      ],
    });

    expect(nextTurn).not.toBe(first);
    expect(toolNames(nextTurn)).toEqual(toolNames(first));
    expect(revisionChanged).not.toBe(first);
    expect(schemaChanged).not.toBe(first);
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
