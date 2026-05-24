import { describe, expect, test } from "bun:test";
import {
  createAgentTools,
  isReadOnlyShellCommand,
} from "../src/core/tools/definitions";
import { TOOL_CONTRACTS } from "../src/core/tools/tool-contracts";
import type { SkillManifest } from "../src/core/skills/types";

// Code Agent 工具定义与只读约束单元测试 / Code agent tool definitions & read-only constraint unit tests
describe("code agent tool definitions", () => {
  // 验证 agent 暴露稳定工具 schema / Agent exposes the stable tool schema
  test("exposes cache-stable agent tools plus planning tools", () => {
    const tools = createAgentTools({
      workspace: "D:\\workspace",
      shellExecutor: async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    });

    expect(tools.map((item) => item.name)).toEqual([
      "read_file",
      "edit_file",
      "write_file",
      "shell_execute",
      "read_mcp_resource",
      "update_plan",
      "ask_user",
      "set_authorization_mode",
    ]);
    expect(tools[0].schema).toBeDefined();
    expect(tools[1].schema).toBeDefined();
    expect(tools[2].schema).toBeDefined();
  });

  // 验证 ask_user 的 schema 支持预置选项和自由输入 / ask_user schema supports options and free-text input
  test("requires a question and options for ask_user", () => {
    const tools = createAgentTools({
      workspace: "D:\\workspace",
    });
    const askUserTool = tools.find((item) => item.name === "ask_user")!;

    expect(askUserTool).toBeDefined();
    expect(
      askUserTool.schema.safeParse({
        question: "应该优先支持哪种恢复输入？",
        options: [
          {
            id: "answer-flag",
            label: "--answer 参数",
            description: "CLI 直接传入用户选择或补充文本。",
          },
        ],
        allow_free_text: true,
      }).success,
    ).toBe(true);
    expect(
      askUserTool.schema.safeParse({
        options: [{ id: "a", label: "A" }],
      }).success,
    ).toBe(false);
    expect(String(askUserTool.description)).toContain("Ask the user");
  });

  // 验证 update_plan 的 Zod schema 要求完整的 state-first plan 字段（name 必填） / update_plan Zod schema requires full state-first plan fields with name as required
  test("requires full state-first plan fields in update_plan schema", () => {
    const tools = createAgentTools({
      workspace: "D:\\workspace",
    });
    const updatePlanTool = tools.find((item) => item.name === "update_plan")!;
    expect(updatePlanTool).toBeDefined();
    const parsed = updatePlanTool.schema.safeParse({
      name: "State-first refactor",
      description: "Persist access and plan in graph state.",
      status: "in_progress",
      steps: [{ step: "Update graph state", status: "pending" }],
    });
    const missingName = updatePlanTool.schema.safeParse({
      description: "Persist access and plan in graph state.",
      status: "in_progress",
      steps: [{ step: "Update graph state", status: "pending" }],
    });

    expect(parsed.success).toBe(true);
    expect(missingName.success).toBe(false);
    expect(String(updatePlanTool.description)).toContain("current plan state");
  });

  // 验证工具 schema 不随工作区访问权限变化，实际边界由工具执行层拒绝 / Tool schema is stable; runner enforces access boundaries
  test("exposes one cache-stable tool schema", () => {
    const tools = createAgentTools({
      workspace: "D:\\workspace",
    });

    expect(tools.map((item) => item.name)).toEqual([
      "read_file",
      "edit_file",
      "write_file",
      "shell_execute",
      "read_mcp_resource",
      "update_plan",
      "ask_user",
      "set_authorization_mode",
    ]);
    expect(String(tools.find((item) => item.name === "update_plan")?.description)).toContain(
      "current plan state",
    );
    expect(String(tools.find((item) => item.name === "ask_user")?.description)).toContain(
      "uncertainty",
    );
  });

  // 验证 shell_execute schema 收敛验证语义和授权建议字段 / shell_execute schema carries action envelope metadata and grant hints
  test("shell_execute schema accepts action envelope fields", () => {
    const tools = createAgentTools({
      workspace: "D:\\workspace",
    });
    const shellExecute = tools.find((item) => item.name === "shell_execute")!;

    expect(
      shellExecute.schema.safeParse({
        command: "bun test tests/graph.test.ts",
        intent: "verify",
        objective: "验证图路由行为",
        justification: "改动涉及 approval 路由，需要运行相关测试。",
        expected_observation: "graph tests pass",
        failure_strategy: "读取失败输出并修正最小相关实现。",
        prefix_rule: ["bun", "test"],
        grant_request: "same_command",
      }).success,
    ).toBe(true);
    expect(
      shellExecute.schema.safeParse({
        command: "bun test",
        intent: "unsupported",
      }).success,
    ).toBe(false);
  });

  // 验证常见只读 shell 命令（ls, cat, rg, git status 等）被正确分类为只读 / Common read-only shell commands (ls, cat, rg, git status, etc.) are correctly classified as read-only
  test("classifies conservative shell_execute inspect commands as read-only", () => {
    expect(isReadOnlyShellCommand("pwd")).toBe(true);
    expect(isReadOnlyShellCommand("ls src")).toBe(true);
    expect(isReadOnlyShellCommand("rg -n \"Plan\" src tests")).toBe(true);
    expect(isReadOnlyShellCommand("cat package.json | head -n 20")).toBe(true);
    expect(isReadOnlyShellCommand("git status --short")).toBe(true);
    expect(isReadOnlyShellCommand("git diff -- src/app/runner.ts")).toBe(true);
  });

  // 验证可能写入、删除或执行项目代码的 shell 命令不会被分类为只读（sed -i, rm -rf, git add, mkdir 等） / Shell commands that can write, delete, or execute project code (sed -i, rm -rf, git add, mkdir, etc.) are not classified as read-only
  test("does not classify mutating shell_execute commands as read-only", () => {
    expect(isReadOnlyShellCommand("echo hi > hello.txt")).toBe(false);
    expect(isReadOnlyShellCommand("sed -i 's/a/b/' src/a.ts")).toBe(false);
    expect(isReadOnlyShellCommand("rm -rf src")).toBe(false);
    expect(isReadOnlyShellCommand("bun test")).toBe(false);
    expect(isReadOnlyShellCommand("git add -A")).toBe(false);
    expect(isReadOnlyShellCommand("mkdir -p tmp")).toBe(false);
    expect(isReadOnlyShellCommand("find . -exec rm {} ;")).toBe(false);
    expect(isReadOnlyShellCommand("awk 'BEGIN { system(\"rm hello.txt\") }'")).toBe(
      false,
    );
    // 裸 & 命令分隔符注入
    expect(isReadOnlyShellCommand("echo hello & rm -rf src")).toBe(false);
    // && 和 2>&1 仍然允许
    expect(isReadOnlyShellCommand("rg pattern file 2>&1")).toBe(true);
    expect(isReadOnlyShellCommand("cat a.txt && cat b.txt")).toBe(true);
  });

  // ── Prompt cache: MCP tool ordering / MCP 工具顺序不破坏前缀缓存 ──

  test("builtin tools unchanged when MCP is present — MCP appended at end", () => {
    const baseNames = createAgentTools({ workspace: "/tmp" }).map((t) => t.name);

    const mockMcpManager = {
      getAllTools: () => [{
        server: "test",
        tool: {
          name: "echo",
          description: "Echo tool",
          inputSchema: { type: "object", properties: { message: { type: "string" } } },
        },
      }],
      callTool: async (_server: string, _tool: string, _args: Record<string, unknown>) => "ok",
    };

    const withMcp = createAgentTools({
      workspace: "/tmp",
      mcpManager: mockMcpManager as any,
    });

    const mcpNames = withMcp.map((t) => t.name);

    // 内置工具集合不变
    expect(mcpNames.slice(0, baseNames.length)).toEqual(baseNames);

    // MCP 工具追加在末尾
    expect(mcpNames[mcpNames.length - 1]).toBe("mcp__test__echo");

    // 内置工具描述不变
    const baseTool = createAgentTools({ workspace: "/tmp" }).find((t) => t.name === "read_file")!;
    const mcpTool = withMcp.find((t) => t.name === "read_file")!;
    expect(mcpTool.description).toBe(baseTool.description);
  });

  test("standalone mode preserves cache-stable tool schema", () => {
    // 独立工具模式（无 MCP）应始终返回相同顺序的工具
    const tools1 = createAgentTools({ workspace: "/tmp" });
    const tools2 = createAgentTools({ workspace: "/tmp" });
    expect(tools1.map((t) => t.name)).toEqual(tools2.map((t) => t.name));
  });

  // ── Prompt cache: Skill tool placement / Skill 工具插入不影响其他工具 ──

  test("Skill tool inserted before update_plan, not at end", () => {
    const skills: SkillManifest[] = [
      { name: "tdd", description: "Test-driven development", source: "project", origin: ".openpx" },
    ];

    const tools = createAgentTools({
      workspace: "/tmp",
      skills,
      skillOptions: {
        projectOpenpxSkillsDir: "/tmp/.openpx/skills",
        projectAgentsSkillsDir: "/tmp/.agents/skills",
        userOpenpxSkillsDir: "/tmp/user-skills",
        userAgentsSkillsDir: "/tmp/user-agents-skills",
      },
    });

    const names = tools.map((t) => t.name);

    // Skill 在 update_plan 之前
    const skillIndex = names.indexOf("Skill");
    const updatePlanIndex = names.indexOf("update_plan");
    expect(skillIndex).toBeGreaterThan(-1);
    expect(skillIndex).toBeLessThan(updatePlanIndex);

    // read_mcp_resource 在 Skill 之前
    const mcpResourceIndex = names.indexOf("read_mcp_resource");
    expect(mcpResourceIndex).toBeLessThan(skillIndex);
  });

  test("builtin tools unchanged when Skill is present", () => {
    const baseNames = createAgentTools({ workspace: "/tmp" }).map((t) => t.name);

    const skills: SkillManifest[] = [
      { name: "tdd", description: "TDD workflow", source: "project", origin: ".openpx" },
    ];

    const withSkill = createAgentTools({
      workspace: "/tmp",
      skills,
      skillOptions: {
        projectOpenpxSkillsDir: "/tmp/.openpx/skills",
        projectAgentsSkillsDir: "/tmp/.agents/skills",
        userOpenpxSkillsDir: "/tmp/user-skills",
        userAgentsSkillsDir: "/tmp/user-agents-skills",
      },
    });

    const skillNames = withSkill.map((t) => t.name);

    // 去掉 Skill 后，其余内置工具与 base 完全相同
    const withoutSkill = skillNames.filter((n) => n !== "Skill");
    expect(withoutSkill).toEqual(baseNames);
  });

  test("MCP + Skill together: both appended, builtins unchanged", () => {
    const baseNames = createAgentTools({ workspace: "/tmp" }).map((t) => t.name);

    const skills: SkillManifest[] = [
      { name: "tdd", description: "TDD", source: "project", origin: ".openpx" },
    ];

    const mockMcpManager = {
      getAllTools: () => [{
        server: "test",
        tool: {
          name: "echo",
          description: "Echo tool",
          inputSchema: { type: "object", properties: { message: { type: "string" } } },
        },
      }],
      callTool: async () => "ok",
    };

    const tools = createAgentTools({
      workspace: "/tmp",
      skills,
      skillOptions: {
        projectOpenpxSkillsDir: "/tmp/.openpx/skills",
        projectAgentsSkillsDir: "/tmp/.agents/skills",
        userOpenpxSkillsDir: "/tmp/user-skills",
        userAgentsSkillsDir: "/tmp/user-agents-skills",
      },
      mcpManager: mockMcpManager as any,
    });

    const names = tools.map((t) => t.name);

    // 检查内置工具前缀
    // 去掉 Skill 和 MCP 工具后应与 base 完全一致
    const builtinPart = names.filter((n) => n !== "Skill" && !n.startsWith("mcp__"));
    expect(builtinPart).toEqual(baseNames);

    // Skill 在 MCP 工具之前
    const skillIndex = names.indexOf("Skill");
    const firstMcpIndex = names.findIndex((n) => n.startsWith("mcp__"));
    expect(skillIndex).toBeGreaterThan(-1);
    expect(firstMcpIndex).toBeGreaterThan(-1);
    expect(skillIndex).toBeLessThan(firstMcpIndex);

    // MCP 工具在最后
    for (let i = firstMcpIndex; i < names.length; i++) {
      expect(names[i].startsWith("mcp__")).toBe(true);
    }
  });
});

// 工具契约验证测试：确保所有工具描述作为一等 UX 契约，包含何时使用、常见误区、输出格式和失败处理 / Tool contract verification: ensure all tool descriptions are first-class UX contracts with whenToUse, commonMistakes, outputFormat, and failureHandling sections
describe("tool contracts (ACI)", () => {
  const registeredTools = [
    "read_file",
    "edit_file",
    "write_file",
    "shell_execute",
    "update_plan",
    "read_mcp_resource",
    "ask_user",
    "set_authorization_mode",
  ];

  // 每个注册工具的契约必须存在 / Every registered tool must have a contract
  test("every registered tool has a contract", () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name);
      expect(contract).toBeDefined();
      expect(contract?.name).toBe(name);
    }
  });

  // 每个契约必须有非空的四个基本部分 / Every contract must have four non-empty sections
  test("every contract has four non-empty sections", () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(contract.sections.whenToUse.length).toBeGreaterThan(20);
      expect(contract.sections.commonMistakes.length).toBeGreaterThan(20);
      expect(contract.sections.outputFormat.length).toBeGreaterThan(10);
      expect(contract.sections.failureHandling.length).toBeGreaterThan(20);
    }
  });

  // 每个契约的描述必须与 sections 内容一致 / Each contract's description must be consistent with its sections
  test("contract description embeds all section content", () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(contract.description).toContain(contract.sections.whenToUse.slice(0, 30));
      expect(contract.description).toContain("Common mistakes");
      expect(contract.description).toContain("Output:");
      expect(contract.description).toContain("Failure:");
    }
  });

  // 每个注册工具的 tool() description 必须等于其契约描述 / Each registered tool() description must equal its contract description
  test("tool descriptions match contract descriptions", () => {
    const tools = createAgentTools({
      workspace: "/tmp/test-workspace",
    });
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      const toolObj = tools.find((item) => item.name === name);
      expect(toolObj).toBeDefined();
      expect(toolObj!.description).toBe(contract.description);
    }
  });

  // whenToUse 必须提及至少一个不应使用该工具的替代方案 / whenToUse must mention at least one alternative tool name
  test("whenToUse mentions at least one alternative tool name", () => {
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
  test("commonMistakes describes actionable failure patterns", () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(
        contract.sections.commonMistakes,
        `${name}: commonMistakes should describe specific things the model does wrong`,
      ).toMatch(/fail|error|match|reject|denied|wrong|incorrect|forget|overusing|substitute|should not|instead|avoid|vague|without|lack|could answer|not providing/i);
    }
  });

  // outputFormat 必须提及至少一个返回字段名 / outputFormat must mention at least one JSON field name
  test("outputFormat describes expected JSON fields", () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(
        contract.sections.outputFormat,
        `${name}: outputFormat should mention specific field names`,
      ).toMatch(/\bok\b/);
    }
  });

  // failureHandling 必须提供可执行的恢复步骤 / failureHandling must provide executable recovery steps
  test("failureHandling provides actionable recovery steps", () => {
    for (const name of registeredTools) {
      const contract = TOOL_CONTRACTS.get(name)!;
      expect(
        contract.sections.failureHandling,
        `${name}: failureHandling should describe recovery actions`,
      ).toMatch(/retry|re-read|adjust|switch|fix|check|verify|read_file|shell_execute|edit_file|write_file|update_plan|call|again|no error|recover/i);
    }
  });

  // shell_execute 的特殊契约要求 / shell_execute-specific contract requirements
  test("shell_execute contract covers intent enumeration and approval rejection", () => {
    const contract = TOOL_CONTRACTS.get("shell_execute")!;
    expect(contract.sections.whenToUse).toMatch(/intent=inspect|intent=verify|intent=test|intent=build|intent=git/);
    expect(contract.sections.commonMistakes).toMatch(/reject/);
    expect(contract.sections.failureHandling).toMatch(/rejected by policy|denied|plan mode/);
  });

  // read_mcp_resource 工具 schema 校验 / read_mcp_resource tool schema validation
  test("validates read_mcp_resource schema", () => {
    const tools = createAgentTools({
      workspace: "/workspace",
    });
    const tool = tools.find((item) => item.name === "read_mcp_resource")!;
    expect(tool).toBeDefined();

    // Valid schema
    expect(
      tool.schema.safeParse({
        server: "docs-server",
        uri: "file:///specs/api.md",
      }).success,
    ).toBe(true);

    // Missing required fields
    expect(
      tool.schema.safeParse({}).success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({ server: "srv" }).success,
    ).toBe(false);
  });

  // apply_patch 契约已存在但尚未注册为 Agent 工具 / apply_patch contract exists but is not yet registered as an agent tool
  test("apply_patch contract exists for future wiring", () => {
    const contract = TOOL_CONTRACTS.get("apply_patch");
    expect(contract).toBeDefined();
    expect(contract?.description).toBeTruthy();
    expect(contract?.sections.whenToUse.length).toBeGreaterThan(20);
  });
});
