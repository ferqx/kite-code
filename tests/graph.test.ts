import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import {
  routeEntry,
  routeAfterAgent,
  routeAfterApproval,
  routeAfterTools,
  routeAfterUserInput,
} from "../src/core/harness/routes";
import { normalizeUserInputResume } from "../src/core/harness/user-input";
import { runApprovedTool } from "../src/core/harness/tool-runner";
import {
  getPendingToolRequest,
  toolRequestFromMessage,
} from "../src/core/harness/tool-requests";
import {
  applyApprovalGrant,
  defaultAuthorizationState,
  grantSameCommand,
} from "../src/core/harness/tool-policy";
import type { CodeAgentState } from "../src/core/harness/state";
import type { AgentPlan } from "../src/protocol/index";
import type { ShellResult } from "../src/core/types";
import type { AgentConfig } from "../src/core/config/index";
import { buildCodeAgentGraph } from "../src/core/harness/graph";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// forceContextCompaction removed — compaction disabled

// ---------------------------------------------------------------------------
// FakeChatModel with spy — used for agent node integration tests
// ---------------------------------------------------------------------------

class SpyFakeChatModel extends ChatOpenAI {
  _retryListener: unknown = null;
  private _callCount = 0;
  /** The input messages received by the last invoke() call */
  lastInputMessages: BaseMessage[] = [];

  get callCount() {
    return this._callCount;
  }

  constructor(private _responses: AIMessage[]) {
    super({
      apiKey: "noop",
      model: "fake",
      configuration: { baseURL: "http://localhost:9999" },
      temperature: 0,
    });
  }

  override async invoke(input: unknown, _options?: unknown): Promise<any> {
    // Save the messages the model was given (input is an array of BaseMessages)
    if (Array.isArray(input)) this.lastInputMessages = input as BaseMessage[];
    const response =
      this._responses[this._callCount] ??
      this._responses[this._responses.length - 1];
    this._callCount++;
    return response;
  }

  bind(_kwargs: unknown): this {
    return this;
  }

  override bindTools(_tools: unknown[], _kwargs?: unknown): this {
    return this;
  }
}

const fakeConfig: AgentConfig = {
  providerName: "fake" as any,
  providerType: "openai-compatible",
  apiKey: "noop",
  baseURL: "http://localhost:9999",
  modelName: "fake",
};

const activePlan: AgentPlan = {
  name: "Implement state-first plan flow",
  description: "Persist access and plan in graph state.",
  status: "in_progress",
  steps: [{ step: "Inspect graph state", status: "in_progress" }],
};

// 图路由单元测试 / Graph routing unit tests — 验证 agent 主循环中各节点的路由逻辑和工具审批流
describe("graph local tool routing", () => {
  // 无待审批工具调用时，审批节点回到单一 agent / When no pending tool call exists, approval routes back to the single agent
  test("routes to agent when approval has no pending tool call", () => {
    expect(routeAfterApproval({ messages: [] } as unknown as CodeAgentState)).toBe("agent");
  });

  // 验证 graph state 始终使用 write workspaceAccess / Verify graph state always uses write workspaceAccess
  test("uses write workspaceAccess by default", () => {
    const s = { workspaceAccess: "write" } as CodeAgentState;
    expect(s.workspaceAccess).toBe("write");
  });

  // 验证 write 访问下 update_plan 工具调用直接路由到 tools，无需审批 / update_plan skips approval under write access
  test("routes update_plan tool calls directly to tools without approval under write access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "update_plan",
                args: {
                  name: activePlan.name,
                  description: activePlan.description,
                  status: activePlan.status,
                  steps: activePlan.steps,
                },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 shell_execute 中的只读命令按统一策略直接进入 tools / shell_execute read-only commands route directly to tools by policy
  test("routes read-only shell_execute calls directly to tools", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        phase: "building",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "shell_execute",
                args: { command: "git status --short" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 write 访问下受保护的写入工具仍然进入 approval / Protected write tools still route through approval under write access
  test("routes protected write-access tool calls through approval", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "write_file",
                args: { path: "hello.txt", content: "hi" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("approval");
  });

  // 验证验证语义通过 shell_execute intent 表达，仍按命令策略进入审批 / Verification intent shell_execute routes through approval by command policy
  test("routes verification intent shell_execute calls through approval", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        phase: "building",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-verify",
                name: "shell_execute",
                args: {
                  intent: "verify",
                  command: "bun test tests/graph.test.ts",
                },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("approval");
  });

  // 验证 same_command 授权命中后，同一命令直接进入 tools / same_command grants route the same shell command directly to tools
  test("routes same-command granted shell_execute calls directly to tools", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        phase: "building",
        workspace: "/tmp/workspace",
        threadId: "thread-a",
        authorization: grantSameCommand(defaultAuthorizationState(), {
          workspace: "/tmp/workspace",
          threadId: "thread-a",
          command: "bun test",
        }),
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "shell_execute",
                args: { command: "bun test", justification: "重新验证" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 full_access 下高危 shell_execute 也不再进入审批或默认拒绝 / full_access routes destructive shell_execute to tools for execution
  test("routes destructive shell_execute calls directly under full access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        phase: "building",
        workspace: "/tmp/workspace",
        threadId: "thread-a",
        authorization: applyApprovalGrant({
          authorization: defaultAuthorizationState(),
          grant: "full_access",
          workspace: "/tmp/workspace",
          threadId: "thread-a",
          request: {
            id: "call-setup",
            name: "shell_execute",
            args: { command: "bun test" },
            reason: "Grant full access",
            protectedCommand: "bun test",
          },
        }),
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "shell_execute",
                args: { command: "sudo rm -rf /" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证高危 shell_execute 请求进入 tools 由执行层返回拒绝，而不是进入普通审批 / Destructive shell_execute requests route to tools for policy rejection
  test("routes destructive shell_execute calls to tools for rejection", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        phase: "building",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "shell_execute",
                args: { command: "sudo rm -rf /" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 read-only 访问下 shell_execute 只读检查直接路由到 tools，无需审批 / shell_execute inspect commands route directly to tools under read-only access
  test("routes read-only shell_execute inspect calls directly to tools without approval", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        phase: "planning",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "shell_execute",
                args: { intent: "inspect", command: "rg -n Plan src" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("tools");
  });

  // 验证 ask_user 在 write 访问下不走工具审批，而是进入用户输入中断节点 / ask_user routes to user_input instead of approval under write access
  test("routes ask_user calls to user input under write access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-ask",
                name: "ask_user",
                args: {
                  question: "应该怎么处理缺失配置？",
                  options: [{ id: "default", label: "使用默认配置" }],
                  allow_free_text: true,
                },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("user_input");
  });

  // 验证 ask_user 在 read-only 访问下也不会被只读工具执行层拒绝 / ask_user is allowed under read-only access through the user_input node
  test("routes ask_user calls to user input under read-only access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-ask",
                name: "ask_user",
                args: {
                  question: "选择实现范围？",
                  options: [{ id: "minimal", label: "最小实现" }],
                },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("user_input");
  });

  // 验证 read-only 访问下有 final 文本时直接结束，不再经过 stop_check 或模式确认 / Read-only final ends directly without stop_check or mode confirmation
  test("ends read-only completion directly when final exists", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("__end__");
  });

  // 验证工具执行完成后直接回到 agent，由工具消息自身携带成功或失败上下文 / Tool results route directly back to agent with ToolMessage context
  test("routes completed tool updates back to agent", () => {
    expect(
      routeAfterTools({
        workspaceAccess: "write",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [],
        final: "Plan ready",
      } as unknown as CodeAgentState),
    ).toBe("agent");
  });

  // 验证 write 访问下写入工具调用路由到审批 / Write tools under write access route to approval
  test("routes write tool calls to approval under write access", () => {
    expect(
      routeAfterAgent({
        workspaceAccess: "write",
        plan: activePlan,
        workspace: "/tmp/workspace",
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: "write_file",
                args: { path: "hello.txt", content: "hi" },
              },
            ],
          }),
        ],
      } as unknown as CodeAgentState),
    ).toBe("approval");
  });

  // 验证 ask_user 工具调用会解析为结构化用户输入请求 / ask_user tool call parses into a structured user input request
  test("parses ask_user tool calls", () => {
    const request = toolRequestFromMessage(
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-ask",
            name: "ask_user",
            args: {
              question: "选择方案？",
              options: [
                { id: "a", label: "方案 A", description: "最小改动" },
                { id: "b", label: "方案 B" },
              ],
              allow_free_text: true,
            },
          },
        ],
      }),
      "/tmp/workspace",
    );

    expect(request?.name).toBe("ask_user");
    if (!request || request.name !== "ask_user") {
      throw new Error("expected ask_user request");
    }
    expect(request?.protectedCommand).toBe("ask_user");
    expect(request?.args.question).toBe("选择方案？");
    expect(request?.args.options[0]?.id).toBe("a");
    expect(request?.args.allow_free_text).toBe(true);
  });

  // 验证用户输入中断恢复后直接回到 agent / user_input returns directly to agent after resume
  test("routes completed user input back to agent", () => {
    expect(
      routeAfterUserInput({
        workspaceAccess: "write",
        workspace: "/tmp/workspace",
        messages: [],
        final: "",
      } as unknown as CodeAgentState),
    ).toBe("agent");
  });

  // 验证用户输入恢复值既支持字符串，也支持结构化 answer/choice / User input resume supports strings and structured answers
  test("normalizes user input resume values", () => {
    expect(normalizeUserInputResume("使用最小实现")).toEqual({
      answer: "使用最小实现",
    });
    expect(normalizeUserInputResume({ answer: "A" })).toEqual({ answer: "A" });
    expect(normalizeUserInputResume({ choice: "minimal" })).toEqual({
      answer: "minimal",
    });
    expect(normalizeUserInputResume(true)).toEqual({ answer: "" });
  });

  // 验证 update_plan 工具执行后返回结构化的 plan 状态（名称、状态、步骤） / update_plan returns the structured plan state with name, status, and steps after execution
  test("update_plan returns the next plan state", async () => {
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-1",
        name: "update_plan",
        args: activePlan,
        reason: "Create plan",
        protectedCommand: "update_plan",
      },
      workspaceAccess: "write",
    });

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("update_plan");
    expect("plan" in result && result.plan ? result.plan.name : "").toBe(activePlan.name);
    expect("plan" in result && result.plan ? result.plan.status : "").toBe("in_progress");
    expect("plan" in result && result.plan ? result.plan.steps[0]?.step : "").toBe(
      "Inspect graph state",
    );
  });

  // 验证 write 访问下 update_plan 只更新计划，不自动切换访问权限 / update_plan updates plan without switching workspace access
  test("write-access update_plan keeps workspace access unchanged", async () => {
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-1",
        name: "update_plan",
        args: activePlan,
        reason: "Create plan",
        protectedCommand: "update_plan",
      },
      workspaceAccess: "write",
    });

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("update_plan");
    expect("plan" in result && result.plan ? result.plan.name : "").toBe(activePlan.name);
    expect("workspaceAccess" in result ? result.workspaceAccess : undefined).toBeUndefined();
  });

  // 验证 read-only 访问下允许通过 shell_execute 执行只读 shell 命令（如 cat）并返回 action 元数据 / shell_execute inspect commands are allowed under read-only access
  test("allows shell_execute inspect commands under read-only access", async () => {
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-1",
        name: "shell_execute",
        args: { intent: "inspect", command: "cat package.json" },
        reason: "Read package",
        protectedCommand: "cat package.json",
      },
      shellExecutor: async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "{}",
        stderr: "",
      }),
      workspaceAccess: "write",
      phase: "planning",
    });

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("shell_execute");
    expect((result as ShellResult).stdout).toBe("{}");
    expect("action" in result ? result.action?.intent : undefined).toBe("inspect");
  });

  // 验证 planning 阶段下拒绝 shell 命令 / Shell commands with write redirects are rejected during planning phase
  test("rejects write-like shell commands during planning phase", async () => {
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-1",
        name: "shell_execute",
        args: { command: "echo hi > hello.txt" },
        reason: "Unexpected write",
        protectedCommand: "echo hi > hello.txt",
      },
      workspaceAccess: "write",
      phase: "planning",
    });

    expect(result.ok).toBe(false);
    expect((result as ShellResult).stderr).toContain("planning");
  });

  // 验证 building 阶段下 write_file 正常执行 / Write tools execute normally during building phase
  test("allows write tools during building phase", async () => {
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-1",
        name: "write_file",
        args: { path: "hello.txt", content: "hi" },
        reason: "Write file",
        protectedCommand: "write_file hello.txt",
      },
      workspaceAccess: "write",
    });

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("write_file");
  });

  // 验证 planning phase 是独立的执行边界，执行类工具会在 runner 兜底拒绝 / Planning phase is an execution boundary enforced by the runner
  test("rejects shell_execute under planning phase before running the executor", async () => {
    let called = false;
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-1",
        name: "shell_execute",
        args: { command: "bun test" },
        reason: "Unexpected execution",
        protectedCommand: "bun test",
      },
      shellExecutor: async (input) => {
        called = true;
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: "should not run",
          stderr: "",
        };
      },
      workspaceAccess: "write",
      phase: "planning",
    });

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect((result as ShellResult).stderr).toContain("planning phase");
  });

  // 验证 shell_execute 用 action envelope 执行验证命令，并保留 action 元数据 / shell_execute executes verification intent commands with action metadata
  test("runs shell_execute verification commands with action metadata", async () => {
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-verify",
        name: "shell_execute",
        args: {
          intent: "verify",
          command: "bun test tests/graph.test.ts",
          objective: "验证图行为",
          expected_observation: "graph tests pass",
          failure_strategy: "读取失败输出并修正实现。",
          prefix_rule: ["bun", "test"],
        },
        reason: "Verify graph behavior",
        protectedCommand: "bun test tests/graph.test.ts",
      },
      shellExecutor: async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "26 pass",
        stderr: "",
      }),
      workspaceAccess: "write",
      phase: "building",
      authorization: defaultAuthorizationState(),
      approvedGrant: "approve_once",
    });

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("shell_execute");
    expect((result as ShellResult).command).toBe("bun test tests/graph.test.ts");
    expect("action" in result ? result.action?.intent : undefined).toBe("verify");
    expect("action" in result ? result.action?.objective : undefined).toBe("验证图行为");
    expect("action" in result ? result.action?.grantUsed : undefined).toBe(
      "approve_once",
    );
  });

  // 验证失败工具结果会把失败原因和正确用法一并交回模型 / Failed tool results include reason and tool guidance for the model
  test("failed tool results include reason and usage guidance", async () => {
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-1",
        name: "shell_execute",
        args: { intent: "inspect", command: "rg -n Missing src" },
        reason: "Search missing text",
        protectedCommand: "rg -n Missing src",
      },
      shellExecutor: async (input) => ({
        ok: false,
        command: input.command,
        exitCode: 2,
        stdout: "",
        stderr: "rg: Missing: No such file or directory",
      }),
      workspaceAccess: "write",
      phase: "planning",
    });

    const failure = (
      result as ShellResult & {
        failure?: { reason: string; guidance: string };
      }
    ).failure;

    expect(result.ok).toBe(false);
    expect(result.tool).toBe("shell_execute");
    expect(failure?.reason).toContain("rg: Missing");
    expect(failure?.guidance).toContain("shell_execute");
    expect(failure?.guidance).toContain("inspect");
  });

  // 验证底层 shell 抛错也会转换成工具失败结果，不阻断 ToolMessage 返回 / Shell executor throws are converted to tool failure results
  test("shell executor errors return failed tool results instead of throwing", async () => {
    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request: {
        id: "call-1",
        name: "shell_execute",
        args: { intent: "inspect", command: "rg -n Plan src" },
        reason: "Search code",
        protectedCommand: "rg -n Plan src",
      },
      shellExecutor: async () => {
        throw new Error("spawn failed");
      },
      workspaceAccess: "write",
      phase: "planning",
    });

    const failure = (
      result as ShellResult & {
        failure?: { reason: string; guidance: string };
      }
    ).failure;

    expect(result.ok).toBe(false);
    expect((result as ShellResult).stderr).toContain("spawn failed");
    expect(failure?.reason).toContain("spawn failed");
    expect(failure?.guidance).toContain("shell_execute");
  });

  // 验证重复工具调用不再由工具执行层拦截，循环边界交给图递归限制 / Repeated tool calls are not blocked by tool runner; graph recursion owns loop bounds
  test("does not intercept repeated read-only tool requests", async () => {
    const request = {
      id: "call-1",
      name: "shell_execute" as const,
      args: { intent: "inspect" as const, command: "cat package.json" },
      reason: "Read package",
      protectedCommand: "cat package.json",
    };

    const result = await runApprovedTool({
      workspace: "/tmp/workspace",
      request,
      shellExecutor: async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "package",
        stderr: "",
      }),
      workspaceAccess: "write",
      phase: "planning",
    });

    expect(result.ok).toBe(true);
    expect((result as ShellResult).stdout).toBe("package");
  });

});

// ── routeEntry 与 getPendingToolRequest 测试 / routeEntry and getPendingToolRequest tests ──
describe("routeEntry — start-of-graph routing", () => {
  const baseState = {
    workspaceAccess: "write" as const,
    phase: "building" as const,
    workspace: "/tmp/workspace",
    threadId: "thread-1",
    userId: "test",
    authorization: defaultAuthorizationState(),
    approvedToolRequest: null,
    approvedToolGrant: null,
    contextBudget: undefined,
    contextSummary: "",
    plan: null,
    final: "",
    modelProvider: "",
    modelName: "",
    thinkingLevel: null,
    activeSkillInstructions: "",
    messages: [],
  };

  test("routes to agent when no messages exist", () => {
    expect(routeEntry(baseState as CodeAgentState)).toBe("agent");
  });

  test("routes to agent when conversation has no pending tool calls", () => {
    const state = {
      ...baseState,
      messages: [
        new AIMessage({ content: "Hello" }),
      ],
    } as CodeAgentState;
    expect(routeEntry(state)).toBe("agent");
  });

  test("routes to tools for update_plan (no approval needed)", () => {
    const state = {
      ...baseState,
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-1", name: "update_plan", args: { name: "Test Plan", description: "desc", status: "in_progress", steps: [] } },
          ],
        }),
      ],
    } as unknown as CodeAgentState;
    expect(routeEntry(state)).toBe("tools");
  });

  test("routes to approval for write_file tool call", () => {
    const state = {
      ...baseState,
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-1", name: "write_file", args: { path: "test.txt", content: "hi" } },
          ],
        }),
      ],
    } as unknown as CodeAgentState;
    expect(routeEntry(state)).toBe("approval");
  });

  test("routes to user_input for ask_user tool call", () => {
    const state = {
      ...baseState,
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-ask", name: "ask_user", args: { question: "What next?" } },
          ],
        }),
      ],
    } as unknown as CodeAgentState;
    expect(routeEntry(state)).toBe("user_input");
  });

  test("routes to tools for destructive shell_execute (policy rejects)", () => {
    const state = {
      ...baseState,
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-1", name: "shell_execute", args: { command: "sudo rm -rf /" } },
          ],
        }),
      ],
    } as unknown as CodeAgentState;
    expect(routeEntry(state)).toBe("tools");
  });

  test("routes to agent when all tool calls are resolved with ToolMessages", () => {
    const state = {
      ...baseState,
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-1", name: "read_file", args: { path: "x.ts" } },
          ],
        }),
        new ToolMessage({
          content: "file content",
          tool_call_id: "call-1",
          status: "success",
        }),
        new AIMessage({ content: "Done reading." }),
      ],
    } as unknown as CodeAgentState;
    expect(routeEntry(state)).toBe("agent");
  });

  test("routes to approval when last AIMessage has unresolved tool call (checkpoint restore)", () => {
    // Simulate checkpoint restore: conversation has resolved tool calls followed
    // by an unresolved AIMessage (interrupted before approval completed)
    const state = {
      ...baseState,
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-1", name: "read_file", args: { path: "x.ts" } },
          ],
        }),
        new ToolMessage({
          content: "file content",
          tool_call_id: "call-1",
          status: "success",
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-2", name: "write_file", args: { path: "y.ts", content: "new" } },
          ],
        }),
        // No ToolMessage for call-2 — dangling tool call
      ],
    } as unknown as CodeAgentState;
    // Should detect the dangling call-2 and route to approval
    expect(routeEntry(state)).toBe("approval");
  });

  test("routes to tools when read-only shell_execute is pending (no approval needed)", () => {
    const state = {
      ...baseState,
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-1", name: "shell_execute", args: { command: "git status --short" } },
          ],
        }),
      ],
    } as unknown as CodeAgentState;
    expect(routeEntry(state)).toBe("tools");
  });

  test("detects unresolved tool call correctly with interleaved resolved calls", () => {
    // Complex scenario: multiple tool calls with interleaving
    const state = {
      ...baseState,
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-a", name: "read_file", args: { path: "a.ts" } },
          ],
        }),
        new ToolMessage({
          content: "a content",
          tool_call_id: "call-a",
          status: "success",
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-b", name: "read_file", args: { path: "b.ts" } },
          ],
        }),
        new ToolMessage({
          content: "b content",
          tool_call_id: "call-b",
          status: "success",
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call-c", name: "shell_execute", args: { command: "rm file.txt" } },
          ],
        }),
        // call-c has no ToolMessage — dangling
      ],
    } as unknown as CodeAgentState;
    expect(routeEntry(state)).toBe("approval");
  });
});

describe("getPendingToolRequest", () => {
  const workspace = "/tmp/workspace";

  test("returns null for empty messages", () => {
    expect(getPendingToolRequest([], workspace)).toBeNull();
  });

  test("returns null when last message is plain text AIMessage", () => {
    const messages = [new AIMessage({ content: "Hello" })];
    expect(getPendingToolRequest(messages, workspace)).toBeNull();
  });

  test("returns pending request for unresolved tool call on last AIMessage", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-1", name: "shell_execute", args: { command: "rm -f *.log" } },
        ],
      }),
    ];
    const result = getPendingToolRequest(messages, workspace);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("shell_execute");
    if (result && result.name === "shell_execute") {
      expect(result.args.command).toBe("rm -f *.log");
    }
  });

  test("returns null when all tool calls have matching ToolMessages", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-1", name: "read_file", args: { path: "x.ts" } },
        ],
      }),
      new ToolMessage({
        content: "result",
        tool_call_id: "call-1",
        status: "success",
      }),
    ];
    expect(getPendingToolRequest(messages, workspace)).toBeNull();
  });

  test("detects dangling tool call in middle of conversation (not last message)", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-1", name: "read_file", args: { path: "x.ts" } },
        ],
      }),
      // No ToolMessage for call-1 — dangling
      new AIMessage({ content: "I'll read that file." }),
    ];
    const result = getPendingToolRequest(messages, workspace);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("read_file");
  });

  test("detects pending tool calls from reconstructed message instances (checkpoint round-trip)", () => {
    // Simulate messages as reconstructed by the LangGraph checkpoint serde
    // — these are actual class instances, not plain objects
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-prev", name: "read_file", args: { path: "prev.ts" } },
        ],
      }),
      new ToolMessage({
        content: "previous result",
        tool_call_id: "call-prev",
        status: "success",
      }),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-d", name: "shell_execute", args: { command: "ls" } },
        ],
      }),
      // No ToolMessage for call-d — dangling
    ];

    const result = getPendingToolRequest(messages, workspace);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("shell_execute");
    expect(result?.id).toBe("call-d");
  });
});

// forceCompact removed — compaction logic removed
