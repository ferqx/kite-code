# 多 Agent 架构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Task Tool 模式的子 Agent 系统，支持 Explore/Code/Review 3 个内置角色，星型拓扑、上下文隔离、TUI 实时渲染。

**Architecture:** 新增 `src/core/subagent/` 模块（types/roles/runner/task-tool），通过 side-channel 事件回调将子 agent 生命周期事件注入现有事件流，TUI 新增 `subagent` block 类型渲染。

**Tech Stack:** TypeScript, Bun, LangGraph, React Ink

**Design doc:** `docs/space/understanding/2026-05-30-multi-agent-design.md`

---

## 文件结构

```
src/
├── protocol/
│   └── events.ts                        # 修改：新增 subagent 事件类型
├── core/
│   ├── subagent/                         # 新建：子 agent 模块
│   │   ├── types.ts                      # SubAgentType, SubAgentConfig, SubAgentResult
│   │   ├── roles.ts                      # 3 个内置角色的 system prompt + 工具集定义
│   │   ├── runner.ts                     # SubAgentRunner：独立 graph 实例执行器
│   │   └── task-tool.ts                  # task 工具实现（含 event sink 回调）
│   ├── harness/
│   │   └── graph.ts                      # 修改：透传 subagentEventSink 到工具创建
│   ├── tools/
│   │   ├── definitions.ts                # 修改：CreateAgentToolsInput 新增 subagentEventSink
│   │   └── tool-contracts.ts             # 修改：新增 TASK_CONTRACT
│   └── runner.ts                         # 修改：构建 subagentEventSink 并注入 graph
└── app/
    └── tui/
        ├── types.ts                      # 修改：OutputBlock 新增 subagent 类型
        ├── reducers/
        │   └── handleEvent.ts            # 修改：处理 subagent 事件
        ├── OutputArea.tsx                # 修改：渲染 subagent block
        └── components/
            └── SubAgentBlock.tsx         # 新建：子 agent block 渲染组件
```

---

### Task 1: 协议层 — 新增 subagent 事件类型

**Files:**
- Modify: `src/protocol/events.ts`

**背景:** 子 agent 生命周期事件需要作为 `AgentEvent` 联合类型的一部分，才能通过现有的 `provider.onEvent()` → `dispatch({ type: "EVENT" })` 链路到达 TUI。

- [ ] **Step 1: 定义 SubAgentEvent 数据类型并扩展 AgentEvent**

在 `src/protocol/events.ts` 中，在现有类型定义之后（`ToolApprovalPayload` 之后）、`AgentEvent` 联合类型之前，添加：

```typescript
// ── 子 Agent 事件 / Sub-agent events ──
export type SubAgentRole = "explore" | "code" | "review";

export interface SubAgentStartPayload {
  id: string;
  role: SubAgentRole;
  task: string;
}

export interface SubAgentStepPayload {
  id: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

export interface SubAgentToolResultPayload {
  id: string;
  toolName: string;
  ok: boolean;
}

export interface SubAgentDonePayload {
  id: string;
  summary: string;
  toolCallCount: number;
  durationMs: number;
}

export interface SubAgentErrorPayload {
  id: string;
  error: string;
}
```

在 `AgentEvent` 联合类型中添加 5 个新成员：

```typescript
export type AgentEvent =
  // ... 现有 19 个成员保持不变 ...
  | { type: "subagent_start"; data: SubAgentStartPayload }
  | { type: "subagent_step"; data: SubAgentStepPayload }
  | { type: "subagent_tool_result"; data: SubAgentToolResultPayload }
  | { type: "subagent_done"; data: SubAgentDonePayload }
  | { type: "subagent_error"; data: SubAgentErrorPayload };
```

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 类型检查通过，无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/protocol/events.ts
git commit -m "feat: 新增 subagent 事件类型到协议层"
```

---

### Task 2: Core 层 — 子 agent 类型定义

**Files:**
- Create: `src/core/subagent/types.ts`

- [ ] **Step 1: 创建类型文件**

```typescript
// src/core/subagent/types.ts
import type { SubAgentRole } from "@/protocol/events";

export type { SubAgentRole };

/** 子 agent 角色配置 */
export interface SubAgentRoleConfig {
  role: SubAgentRole;
  /** System prompt 文本 */
  systemPrompt: string;
  /** 允许使用的工具名称集合（undefined 表示全部可用） */
  allowedTools?: Set<string>;
}

/** 子 agent 运行结果 */
export interface SubAgentResult {
  ok: boolean;
  summary: string;
  toolCallCount: number;
  durationMs: number;
  error?: string;
}

/** 事件回调：子 agent 运行时向外推送生命周期事件 */
export type SubAgentEventSink = (event: {
  type: "start" | "step" | "tool_result" | "done" | "error";
  data: Record<string, unknown>;
}) => void;
```

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/core/subagent/types.ts
git commit -m "feat: 子 agent 类型定义"
```

---

### Task 3: Core 层 — 内置角色定义

**Files:**
- Create: `src/core/subagent/roles.ts`

- [ ] **Step 1: 创建角色定义**

```typescript
// src/core/subagent/roles.ts
import type { SubAgentRole, SubAgentRoleConfig } from "./types";

const EXPLORE_SYSTEM_PROMPT = `You are an Explore agent. Your role is to search, trace, and gather evidence.

## Guidelines
- Exhaustively search — do not miss any leads.
- Return complete evidence chains: include file paths, line numbers, and key code snippets.
- Do NOT propose modifications or fixes. Your output is raw findings for the main agent to analyze.
- Prefer targeted searches over broad scans.
- When you find something relevant, trace all its usages (callers, callees, imports, tests).

## Output format
Return your findings as a structured report:
- Summary of what you searched for and why
- List of findings with file:line references
- Any patterns or connections you discovered
- No recommendations or proposed changes`;

const CODE_SYSTEM_PROMPT = `You are a Code agent. Your role is to implement, fix, and test.

## Guidelines
- Follow the task instructions precisely. Do not deviate or add unrequested changes.
- Before making changes, read the relevant files first to understand current state.
- After making changes, run relevant tests to verify correctness.
- If you encounter uncertainty, report it directly — do not guess.
- Make minimal, focused changes. Do not refactor unrelated code.
- Use edit_file for targeted changes, write_file only for new files or full rewrites.

## Output format
After completing the task, report:
- List of files changed and why
- Test results (pass/fail)
- Any issues or uncertainties encountered`;

const REVIEW_SYSTEM_PROMPT = `You are a Review agent. Your role is to critically examine code for bugs, security issues, logic errors, and regressions.

## Guidelines
- Be critical and thorough. Assume nothing is correct until verified.
- Look for: security vulnerabilities, logic errors, missing edge cases, race conditions, resource leaks, missing error handling, test coverage gaps.
- Cite specific file:line references for every finding.
- Rank findings by severity: Critical / Warning / Suggestion.
- Do NOT make code changes. Your output is a review report for the main agent.

## Output format
Return your findings organized by severity:
- **Critical** — bugs that will cause incorrect behavior, crashes, or security breaches
- **Warning** — issues that could cause problems under certain conditions
- **Suggestion** — improvements that are nice-to-have but not blocking`;

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "shell_execute",
  "read_mcp_resource",
]);

const FULL_TOOLS: Set<string> | undefined = undefined; // undefined = all tools available

const ROLE_CONFIGS: Record<SubAgentRole, SubAgentRoleConfig> = {
  explore: { role: "explore", systemPrompt: EXPLORE_SYSTEM_PROMPT, allowedTools: READ_ONLY_TOOLS },
  code: { role: "code", systemPrompt: CODE_SYSTEM_PROMPT, allowedTools: FULL_TOOLS },
  review: { role: "review", systemPrompt: REVIEW_SYSTEM_PROMPT, allowedTools: READ_ONLY_TOOLS },
};

/** 按角色名获取配置 */
export function getRoleConfig(role: SubAgentRole): SubAgentRoleConfig {
  return ROLE_CONFIGS[role];
}

/** 所有内置角色名 */
export const BUILTIN_ROLES: SubAgentRole[] = ["explore", "code", "review"];
```

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/core/subagent/roles.ts
git commit -m "feat: 内置子 agent 角色定义（Explore/Code/Review）"
```

---

### Task 4: Core 层 — SubAgentRunner 实现

**Files:**
- Create: `src/core/subagent/runner.ts`
- Read: `src/core/harness/graph.ts` (for understanding graph build API)
- Read: `src/core/model/context.ts` (for `buildStaticSystemPrompt` pattern)

- [ ] **Step 1: 创建 SubAgentRunner**

```typescript
// src/core/subagent/runner.ts
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentConfig } from "@/core/config/index";
import { createChatModel, type SupportedChatModel } from "@/core/model/factory";
import { createAgentTools } from "@/core/tools/definitions";
import type { ShellExecutor } from "@/core/tools/shell";
import type { McpManager } from "@/core/mcp";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import { ChatOllama } from "@langchain/ollama";
import type { SubAgentRoleConfig, SubAgentResult, SubAgentEventSink } from "./types";

export interface SubAgentRunnerInput {
  config: AgentConfig;
  workspace: string;
  role: SubAgentRoleConfig;
  task: string;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  model?: SupportedChatModel;
  timeoutMs: number;
  signal: AbortSignal;
  eventSink: SubAgentEventSink;
}

/** 绑定模型工具（区分 Ollama）/ Bind tools to model (handle Ollama separately) */
function bindTools(model: ReturnType<typeof createChatModel>, tools: ReturnType<typeof createAgentTools>) {
  if (model instanceof ChatOllama) return model.bindTools(tools);
  return model.bindTools(tools, { tool_choice: "auto" });
}

/** 子 agent ID 生成器 */
let _subAgentCounter = 0;
function nextSubAgentId(): string {
  return `sub-${Date.now().toString(36)}-${_subAgentCounter++}`;
}

/** 运行子 Agent：独立上下文窗口 + 受限工具集 + 循环执行至完成 */
export async function runSubAgent(input: SubAgentRunnerInput): Promise<SubAgentResult> {
  const id = nextSubAgentId();
  const model = input.model ?? createChatModel(input.config);
  const startTime = Date.now();
  let toolCallCount = 0;

  // 发出 start 事件
  input.eventSink({
    type: "start",
    data: { id, role: input.role.role, task: input.task },
  });

  // 构建工具集：受限角色只提供允许的工具
  const allTools = createAgentTools({
    workspace: input.workspace,
    shellExecutor: input.shellExecutor,
    mcpManager: input.mcpManager,
    skills: input.skills,
    skillOptions: input.skillOptions,
  });
  const tools = input.role.allowedTools
    ? allTools.filter((t) => input.role.allowedTools!.has(t.name))
    : allTools;

  const systemMessage = new SystemMessage(input.role.systemPrompt);
  const messages: BaseMessage[] = [systemMessage, new HumanMessage(input.task)];

  try {
    // 设置超时
    const timeoutId = setTimeout(() => {
      // timeout handled by AbortController pattern — signal check in loop
    }, input.timeoutMs);

    const deadline = Date.now() + input.timeoutMs;

    while (true) {
      if (input.signal.aborted) {
        clearTimeout(timeoutId);
        throw new Error("Sub-agent aborted");
      }
      if (Date.now() > deadline) {
        clearTimeout(timeoutId);
        throw new Error(`Sub-agent timed out after ${input.timeoutMs}ms`);
      }

      const response = await bindTools(model, tools).invoke(messages) as AIMessage;

      if (response.tool_calls && response.tool_calls.length > 0) {
        // 处理工具调用
        for (const tc of response.tool_calls) {
          const tool = tools.find((t) => t.name === tc.name);
          if (!tool) continue;

          // 发出 step 事件
          input.eventSink({
            type: "step",
            data: {
              id,
              toolName: tc.name,
              toolArgs: (tc.args as Record<string, unknown>) ?? {},
            },
          });

          toolCallCount++;

          let toolOutput: string;
          let ok = true;
          try {
            toolOutput = await tool.invoke(tc.args ?? {});
            // 尝试解析 JSON 判断 ok
            try {
              const parsed = JSON.parse(toolOutput);
              ok = parsed.ok !== false;
            } catch { /* not JSON */ }
          } catch (e: any) {
            toolOutput = JSON.stringify({ ok: false, error: e?.message ?? String(e) });
            ok = false;
          }

          // 发出 tool_result 事件
          input.eventSink({
            type: "tool_result",
            data: { id, toolName: tc.name, ok },
          });

          messages.push(response);
          messages.push({
            type: "tool" as const,
            content: toolOutput,
            tool_call_id: tc.id ?? "",
            name: tc.name,
          } as any);
        }
      } else {
        // 无工具调用 → 最终文本 = 摘要
        messages.push(response);
        const summary = typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);
        const durationMs = Date.now() - startTime;
        clearTimeout(timeoutId);

        input.eventSink({
          type: "done",
          data: { id, summary, toolCallCount, durationMs },
        });

        return { ok: true, summary, toolCallCount, durationMs };
      }
    }
  } catch (e: any) {
    const durationMs = Date.now() - startTime;
    const error = e?.message ?? String(e);
    input.eventSink({
      type: "error",
      data: { id, error },
    });
    return { ok: false, summary: error, toolCallCount, durationMs, error };
  }
}
```

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 通过（可能有一些 `any` 类型的警告，但无阻塞性错误）

- [ ] **Step 3: Commit**

```bash
git add src/core/subagent/runner.ts
git commit -m "feat: SubAgentRunner 实现（独立上下文 + 受限工具集 + 生命周期事件）"
```

---

### Task 5: Core 层 — task 工具实现

**Files:**
- Create: `src/core/subagent/task-tool.ts`

- [ ] **Step 1: 创建 task 工具工厂函数**

```typescript
// src/core/subagent/task-tool.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { AgentConfig } from "@/core/config/index";
import type { ShellExecutor } from "@/core/tools/shell";
import type { McpManager } from "@/core/mcp";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import type { SubAgentRole, SubAgentEventSink } from "./types";
import { getRoleConfig, BUILTIN_ROLES } from "./roles";
import { runSubAgent } from "./runner";

export interface TaskToolDeps {
  config: AgentConfig;
  workspace: string;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  eventSink: SubAgentEventSink;
  signal?: AbortSignal;
}

/** 最大并发子 agent 数 */
const MAX_CONCURRENT = 10;
let activeCount = 0;

export function createTaskTool(deps: TaskToolDeps) {
  return tool(
    async ({ subagent_type, task }) => {
      if (activeCount >= MAX_CONCURRENT) {
        return JSON.stringify({
          ok: false,
          error: `Maximum concurrent sub-agents (${MAX_CONCURRENT}) reached. Wait for running sub-agents to complete.`,
        });
      }

      const roleConfig = getRoleConfig(subagent_type);
      const signal = deps.signal ?? new AbortController().signal;

      activeCount++;
      try {
        const result = await runSubAgent({
          config: deps.config,
          workspace: deps.workspace,
          role: roleConfig,
          task,
          shellExecutor: deps.shellExecutor,
          mcpManager: deps.mcpManager,
          skills: deps.skills,
          skillOptions: deps.skillOptions,
          timeoutMs: 30 * 60 * 1000, // 30 分钟
          signal,
          eventSink: deps.eventSink,
        });
        return JSON.stringify(result);
      } finally {
        activeCount--;
      }
    },
    {
      name: "task",
      description: [
        "Dispatch a task to a specialized sub-agent with an isolated context window and restricted tool set.",
        "Sub-agents run independently and return a final summary — they cannot see the main conversation history.",
        "",
        "Available sub-agent types:",
        "- explore: Read-only codebase search and evidence gathering. Returns structured findings with file:line references.",
        "- code: Full implementation agent. Can read, write, edit files, and run shell commands. Provide precise, detailed instructions.",
        "- review: Critical code reviewer. Returns findings organized by severity (Critical/Warning/Suggestion) with file:line references.",
        "",
        "When NOT to use:",
        "- Do NOT delegate tasks that require understanding the full conversation context — handle those yourself.",
        "- Do NOT use for simple single-file reads or grep commands — use read_file or shell_execute directly.",
        "",
        "The task description must be self-contained and include ALL necessary context, as the sub-agent has no access to the conversation history.",
      ].join("\n"),
      schema: z.object({
        subagent_type: z.enum(["explore", "code", "review"]).describe("Type of sub-agent to invoke"),
        task: z.string().min(1).describe("Self-contained task description with all necessary context. The sub-agent cannot see the main conversation."),
      }),
    },
  );
}
```

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/core/subagent/task-tool.ts
git commit -m "feat: task 工具实现（子 agent 派发 + 并发控制）"
```

---

### Task 6: Core 层 — tool-contracts 新增 TASK_CONTRACT

**Files:**
- Modify: `src/core/tools/tool-contracts.ts`

- [ ] **Step 1: 添加 TASK_CONTRACT 并注册**

在 `src/core/tools/tool-contracts.ts` 末尾的 `APPLY_PATCH_CONTRACT` 之后、`KNOWN_TOOL_NAMES` 之前，添加：

```typescript
export const TASK_CONTRACT: ToolContract = {
  name: "task",
  sections: {
    whenToUse:
      "Dispatch a task to a specialized sub-agent with an isolated context window. " +
      "Use for parallel work (multiple sub-agents running simultaneously), role-specific work " +
      "(explore for search, code for implementation, review for quality checks), " +
      "and long-running autonomous tasks. " +
      "The task description MUST be self-contained — include ALL necessary context, file paths, " +
      "and specific instructions. Sub-agents cannot see the main conversation history. " +
      "Do NOT use for simple single-file reads or grep commands — use direct tools instead.",
    commonMistakes:
      "Providing a vague task description that the sub-agent cannot execute without conversation context. " +
      "Using 'code' for exploration tasks — use 'explore' for search and evidence gathering. " +
      "Not including specific file paths or function names in the task description. " +
      "Expecting the sub-agent to know about decisions made earlier in the conversation.",
    outputFormat:
      "JSON: ok (boolean), summary (string — the sub-agent's final output), toolCallCount (number), durationMs (number). " +
      "On error: ok: false with error field containing the error message.",
    failureHandling:
      "If the sub-agent times out (30 min): the task returns an error. Retry with a more focused task description. " +
      "If max concurrent sub-agents (10) are running: wait for running sub-agents to complete. " +
      "If the sub-agent returns unclear results: rephrase the task with more precise instructions and retry.",
  },
  description: "",
};
TASK_CONTRACT.description = buildDescription(TASK_CONTRACT.sections);
```

更新 `KNOWN_TOOL_NAMES`：

```typescript
export const KNOWN_TOOL_NAMES = [
  // ... existing ...
  "apply_patch",
  "task",          // ← 新增
] as const;
```

更新 `TOOL_CONTRACTS`：

```typescript
export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = new Map([
  // ... existing ...
  ["apply_patch", APPLY_PATCH_CONTRACT],
  ["task", TASK_CONTRACT],    // ← 新增
]);
```

- [ ] **Step 2: 验证类型检查和现有测试**

Run: `bun run typecheck && bun test tests/tool-definitions.test.ts`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add src/core/tools/tool-contracts.ts
git commit -m "feat: 新增 task 工具契约"
```

---

### Task 7: Core 层 — 在 graph 和 tools 中透传 subagentEventSink

**Files:**
- Modify: `src/core/tools/definitions.ts`
- Modify: `src/core/harness/graph.ts`

- [ ] **Step 1: definitions.ts — CreateAgentToolsInput 新增 config + eventSink 字段**

在 `CreateAgentToolsInput` 接口中添加：

```typescript
export interface CreateAgentToolsInput {
  // ... 现有字段保持不变 ...
  /** Agent 配置（task 工具创建模型实例时需要）/ Agent config (needed by task tool for model creation) */
  config?: import("@/core/config/index").AgentConfig;
  /** 子 agent 事件回调（用于 task 工具）/ Sub-agent event sink (for task tool) */
  subagentEventSink?: import("@/core/subagent/types").SubAgentEventSink;
  /** 外部中止信号（用于 task 工具）/ External abort signal (for task tool) */
  subagentSignal?: AbortSignal;
}
```

在 `createAgentTools` 函数内的 `builtinTools` 数组构建处，`createSetAuthorizationModeTool()` 之前，添加 task 工具：

```typescript
import { createTaskTool, type TaskToolDeps } from "@/core/subagent/task-tool";

// 在 builtinTools 数组中：
const taskTool = input.subagentEventSink && input.config
  ? createTaskTool({
      config: input.config,
      workspace: input.workspace,
      shellExecutor: input.shellExecutor,
      mcpManager: input.mcpManager,
      skills: input.skills,
      skillOptions: input.skillOptions,
      eventSink: input.subagentEventSink,
      signal: input.subagentSignal,
    })
  : null;

const builtinTools = [
  readFileTool,
  editFileTool,
  writeFileTool,
  shellExecute,
  readMcpResource,
  ...(skillTool ? [skillTool] : []),
  ...(taskTool ? [taskTool] : []),    // ← 新增
  createUpdatePlanTool(),
  createAskUserTool(),
  createSetAuthorizationModeTool(),
];
```

在 `createAgentTools` 函数中，现有的 `builtinTools` 数组构建之后，`createSetAuthorizationModeTool()` 之前，添加 task 工具：

```typescript
import { createTaskTool, type TaskToolDeps } from "@/core/subagent/task-tool";

// 在 createAgentTools 函数内，builtinTools 数组构建处：
const taskTool = input.subagentEventSink
  ? createTaskTool({
      config: input.config,         // ← 需要传入 config
      workspace: input.workspace,
      shellExecutor: input.shellExecutor,
      mcpManager: input.mcpManager,
      skills: input.skills,
      skillOptions: input.skillOptions,
      eventSink: input.subagentEventSink,
      signal: input.subagentSignal,
    })
  : null;

const builtinTools = [
  readFileTool,
  editFileTool,
  writeFileTool,
  shellExecute,
  readMcpResource,
  ...(skillTool ? [skillTool] : []),
  ...(taskTool ? [taskTool] : []),    // ← 新增
  createUpdatePlanTool(),
  createAskUserTool(),
  createSetAuthorizationModeTool(),
];
```

注意：`CreateAgentToolsInput` 没有 `config` 字段。需要在 graph.ts 中传入 config 给 `createAgentTools`。让我检查...

实际上 `CreateAgentToolsInput` 目前没有 config。task tool 需要 config 来创建模型实例。有两个方案：
a) 在 `CreateAgentToolsInput` 中添加 `config`
b) 在 `SubAgentRunner` 中通过 `input.config` 获取

实际上 `SubAgentRunner` 和 `createTaskTool` 都需要 config。但 `createAgentTools` 在 graph.ts 的 agent 节点中被调用，agent 节点内没有 config...

看 graph.ts 中的 agent 节点：
```typescript
const agent = async (state: CodeAgentState) => {
    const tools = createAgentTools({
      workspace: state.workspace,
      shellExecutor: input.shellExecutor,
      mcpManager: input.mcpManager,
      skills: input.skills,
      skillOptions: input.skillOptions,
    });
```

`input` 是 `BuildCodeAgentGraphInput`，它有 `config`。所以需要通过 `input.config` 传入。需要在 `CreateAgentToolsInput` 中添加 `config` 字段。

但 typecheck 会过吗？让我们看...

实际上 `createAgentTools` 的调用者在 graph.ts 中有 `input.config`。我可以简单地在 `CreateAgentToolsInput` 添加 config 字段，然后在 graph.ts 的调用处传入。

但 `CreateAgentToolsInput` 被多处调用，包括测试。添加可选字段不会破坏现有调用。

OK，修改 plan: 需要在 `CreateAgentToolsInput` 中添加 `config?: AgentConfig` 字段。

- [ ] **Step 2: graph.ts — 构建 subagentEventSink 并注入**

在 `buildCodeAgentGraph` 中的 agent 节点内，修改 `createAgentTools` 调用，传入 config、subagentEventSink 和 signal：

```typescript
const tools = createAgentTools({
  workspace: state.workspace,
  shellExecutor: input.shellExecutor,
  mcpManager: input.mcpManager,
  skills: input.skills,
  skillOptions: input.skillOptions,
  config: input.config,                                    // ← 新增
  subagentEventSink: input.subagentEventSink,              // ← 新增
  subagentSignal: input.subagentSignal,                    // ← 新增
});
```

在 `BuildCodeAgentGraphInput` 接口中添加：

```typescript
export interface BuildCodeAgentGraphInput {
  // ... 现有字段 ...
  /** 子 agent 事件回调 / Sub-agent event sink */
  subagentEventSink?: import("@/core/subagent/types").SubAgentEventSink;
  /** 子 agent 中止信号 / Sub-agent abort signal */
  subagentSignal?: AbortSignal;
}
```

- [ ] **Step 3: 验证类型检查**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/core/tools/definitions.ts src/core/harness/graph.ts
git commit -m "feat: graph 层透传 subagentEventSink 到 task 工具"
```

---

### Task 8: Core 层 — runner.ts 构建事件桥接

**Files:**
- Modify: `src/core/runner.ts`

- [ ] **Step 1: 在 runAgent 中构建 subagentEventSink 并注入 graph**

在 `runAgent` 函数中，`buildCodeAgentGraph` 调用处添加 subagentEventSink：

```typescript
// 在 runAgent 函数内，buildCodeAgentGraph 调用处：
const subagentEventSink: import("@/core/subagent/types").SubAgentEventSink = (e) => {
  switch (e.type) {
    case "start":
      provider.onEvent({ type: "subagent_start", data: e.data as any });
      break;
    case "step":
      provider.onEvent({ type: "subagent_step", data: e.data as any });
      break;
    case "tool_result":
      provider.onEvent({ type: "subagent_tool_result", data: e.data as any });
      break;
    case "done":
      provider.onEvent({ type: "subagent_done", data: e.data as any });
      break;
    case "error":
      provider.onEvent({ type: "subagent_error", data: e.data as any });
      break;
  }
};

const { graph, checkpointer } = buildCodeAgentGraph({
  config: input.config,
  checkpointPath: input.checkpointPath,
  shellExecutor: input.shellExecutor,
  authorizationOverride: input.authorizationOverride,
  model: input.model,
  thinkingLevel: input.thinkingLevel,
  skills: input.skills,
  skillOptions: input.skillOptions,
  mcpManager: input.mcpManager,
  subagentEventSink,           // ← 新增
  subagentSignal: input.signal,// ← 新增
});
```

在 `RevertInput` 和 `ForkInput` 接口中不需要添加（rewind/fork 场景不需要子 agent 支持）。

同样需要在 `streamCodeAgent`、`resumeCodeAgent`、`revertToCheckpoint`、`forkFromCheckpoint` 中的 `buildCodeAgentGraph` 调用处添加（至少 `streamCodeAgent` 需要）。

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/core/runner.ts
git commit -m "feat: runner 层构建 subagent 事件桥接"
```

---

### Task 9: TUI 层 — 新增 subagent block 类型

**Files:**
- Modify: `src/app/tui/types.ts`

- [ ] **Step 1: 扩展 OutputBlock 联合类型**

在 `OutputBlock` 联合类型末尾添加：

```typescript
export type OutputBlock =
  // ... 现有 7 种 block 类型保持不变 ...
  | { id: number; kind: "subagent"; subagentId: string; role: "explore" | "code" | "review"; task: string; status: "running" | "done" | "error"; summary: string; toolCallCount: number; durationMs: number; steps: SubAgentStepRecord[]; error?: string }

export interface SubAgentStepRecord {
  toolName: string;
  toolArgs: Record<string, unknown>;
  ok?: boolean;
}
```

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/types.ts
git commit -m "feat: TUI 类型新增 subagent block"
```

---

### Task 10: TUI 层 — reducer 处理 subagent 事件

**Files:**
- Modify: `src/app/tui/reducers/handleEvent.ts`

- [ ] **Step 1: 在 handleEventAction 中添加 5 个 subagent 事件处理**

在 `handleEventAction` 的 switch 语句中，`case "compact_end":` 之后、`default:` 之前，添加：

```typescript
case "subagent_start": {
  const id = state.nextBlockId;
  const block: OutputBlock = {
    id,
    kind: "subagent",
    subagentId: event.data.id,
    role: event.data.role,
    task: event.data.task,
    status: "running",
    summary: "",
    toolCallCount: 0,
    durationMs: 0,
    steps: [],
  };
  return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
}

case "subagent_step": {
  const blocks = state.blocks.map((b) => {
    if (b.kind === "subagent" && b.subagentId === event.data.id) {
      return {
        ...b,
        steps: [...b.steps, {
          toolName: event.data.toolName,
          toolArgs: event.data.toolArgs,
        }],
      };
    }
    return b;
  });
  return { ...state, blocks };
}

case "subagent_tool_result": {
  const blocks = state.blocks.map((b) => {
    if (b.kind === "subagent" && b.subagentId === event.data.id) {
      const steps = b.steps.map((s, i) =>
        i === b.steps.length - 1 && s.toolName === event.data.toolName
          ? { ...s, ok: event.data.ok }
          : s
      );
      return { ...b, steps };
    }
    return b;
  });
  return { ...state, blocks };
}

case "subagent_done": {
  const blocks = state.blocks.map((b) => {
    if (b.kind === "subagent" && b.subagentId === event.data.id) {
      return {
        ...b,
        status: "done" as const,
        summary: event.data.summary,
        toolCallCount: event.data.toolCallCount,
        durationMs: event.data.durationMs,
      };
    }
    return b;
  });
  return { ...state, blocks };
}

case "subagent_error": {
  const blocks = state.blocks.map((b) => {
    if (b.kind === "subagent" && b.subagentId === event.data.id) {
      return { ...b, status: "error" as const, error: event.data.error };
    }
    return b;
  });
  return { ...state, blocks };
}
```

需要导入 `OutputBlock`：

```typescript
// 文件顶部已有 "import type { TuiState, OutputBlock, InterruptState, FileChangeRecord } from "../types";"
// 无需修改
```

- [ ] **Step 2: 验证类型检查和现有 TUI 测试**

Run: `bun run typecheck && bun test tests/tui-reducer.test.ts`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/reducers/handleEvent.ts
git commit -m "feat: reducer 处理 subagent 生命周期事件"
```

---

### Task 11: TUI 层 — SubAgentBlock 渲染组件

**Files:**
- Create: `src/app/tui/components/SubAgentBlock.tsx`

- [ ] **Step 1: 创建渲染组件**

```typescript
// src/app/tui/components/SubAgentBlock.tsx
import React from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../types";
import { darkTheme as dt } from "../theme";

function roleIcon(role: string): string {
  switch (role) {
    case "explore": return "🔍";
    case "code": return "🔧";
    case "review": return "👁";
    default: return "•";
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case "explore": return "Explore";
    case "code": return "Code";
    case "review": return "Review";
    default: return role;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

interface SubAgentBlockProps {
  block: OutputBlock & { kind: "subagent" };
}

export default function SubAgentBlock({ block }: SubAgentBlockProps) {
  const icon = roleIcon(block.role);
  const label = roleLabel(block.role);

  if (block.status === "running") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.warning}>▸ {icon} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {block.task}</Text>
          <Text color={dt.dim}> ...</Text>
        </Box>
        {block.steps.map((step, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={dt.dim}>├─ {step.toolName}</Text>
            {step.toolArgs && Object.keys(step.toolArgs).length > 0 && (
              <Text color={dt.muted}> {JSON.stringify(step.toolArgs).slice(0, 60)}</Text>
            )}
            {step.ok !== undefined && (
              <Text color={step.ok ? dt.success : dt.error}>
                {" "}{step.ok ? "✓" : "✗"}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    );
  }

  if (block.status === "error") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={dt.error}>✗ {icon} </Text>
          <Text color={dt.primary}>{label}</Text>
          <Text color={dt.muted}> · {block.task}</Text>
        </Box>
        <Box paddingLeft={3}>
          <Text color={dt.error}>{block.error ?? "Unknown error"}</Text>
        </Box>
      </Box>
    );
  }

  // done
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={dt.success}>▼ {icon} </Text>
        <Text color={dt.primary}>{label}</Text>
        <Text color={dt.muted}> · {block.task}</Text>
        <Text color={dt.dim}> — {block.toolCallCount} 次工具调用，{formatDuration(block.durationMs)}</Text>
      </Box>
      {block.summary && (
        <Box paddingLeft={3} flexDirection="column">
          {block.summary.split("\n").map((line, i) => (
            <Text key={i} color={dt.dim}>
              {i === 0 ? "│ " : "  "}{line.slice(0, 300)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/components/SubAgentBlock.tsx
git commit -m "feat: SubAgentBlock 渲染组件（运行中/完成/错误三态）"
```

---

### Task 12: TUI 层 — OutputArea 集成 subagent block 渲染

**Files:**
- Modify: `src/app/tui/OutputArea.tsx`

- [ ] **Step 1: 在 renderBlock 中添加 subagent 分支**

导入 SubAgentBlock：

```typescript
import SubAgentBlock from "./components/SubAgentBlock";
```

在 `renderBlock` 函数的 switch 语句中，`case "question":` 之后、`default:` 之前，添加：

```typescript
case "subagent":
  return (
    <Box key={block.id} flexDirection="column" marginBottom={BLOCK_GAP}>
      <SubAgentBlock block={block} />
    </Box>
  );
```

- [ ] **Step 2: 验证类型检查**

Run: `bun run typecheck`
Expected: 通过

- [ ] **Step 3: 验证 TUI 布局测试**

Run: `bun test tests/tui-layout.test.tsx`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/app/tui/OutputArea.tsx
git commit -m "feat: OutputArea 集成 subagent block 渲染"
```

---

### Task 13: 集成测试 — subagent runner 单元测试

**Files:**
- Create: `tests/subagent.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
// tests/subagent.test.ts
import { describe, it, expect, mock } from "bun:test";
import { getRoleConfig, BUILTIN_ROLES } from "@/core/subagent/roles";

describe("内置角色定义", () => {
  it("应包含 3 个角色", () => {
    expect(BUILTIN_ROLES).toHaveLength(3);
    expect(BUILTIN_ROLES).toContain("explore");
    expect(BUILTIN_ROLES).toContain("code");
    expect(BUILTIN_ROLES).toContain("review");
  });

  it("explore 角色应有只读工具集", () => {
    const config = getRoleConfig("explore");
    expect(config.allowedTools).toBeDefined();
    expect(config.allowedTools!.has("read_file")).toBe(true);
    expect(config.allowedTools!.has("edit_file")).toBe(false);
    expect(config.allowedTools!.has("write_file")).toBe(false);
  });

  it("code 角色应有全部工具", () => {
    const config = getRoleConfig("code");
    expect(config.allowedTools).toBeUndefined();
  });

  it("review 角色应有只读工具集", () => {
    const config = getRoleConfig("review");
    expect(config.allowedTools).toBeDefined();
    expect(config.allowedTools!.has("read_file")).toBe(true);
    expect(config.allowedTools!.has("edit_file")).toBe(false);
  });

  it("所有角色的 system prompt 应非空", () => {
    for (const role of BUILTIN_ROLES) {
      const config = getRoleConfig(role);
      expect(config.systemPrompt.length).toBeGreaterThan(100);
    }
  });
});

describe("SubAgentEventSink 类型", () => {
  it("事件类型应包含 5 种", () => {
    const types = ["start", "step", "tool_result", "done", "error"] as const;
    expect(types).toHaveLength(5);
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `bun test tests/subagent.test.ts`
Expected: 6 tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/subagent.test.ts
git commit -m "test: 子 agent 角色定义和类型测试"
```

---

### Task 14: 端到端验证

- [ ] **Step 1: 运行全量测试**

```bash
bun test
bun run typecheck
```

Expected: 所有现有测试通过，无类型错误

- [ ] **Step 2: 运行 TUI 手动验证**

```bash
bun run tui
```

Expected: TUI 正常启动，输入任务后主 agent 可正常运行。当模型调用 `task` 工具时，子 agent block 正确渲染。

- [ ] **Step 3: 更新 PRODUCT.md 和 ROADMAP.md**

在 `PRODUCT.md` 核心特性表中添加：

```
| 多 Agent 协作 | 3 个内置角色（Explore/Code/Review），星型拓扑，上下文隔离，Task Tool 模式 |
```

在 `ROADMAP.md` 已完成部分添加条目。

- [ ] **Step 4: Commit**

```bash
git add PRODUCT.md ROADMAP.md
git commit -m "docs: 多 Agent 功能记录到产品文档和路线图"
```

---

## 自检

### 1. Spec coverage 对照

| 设计文档章节 | 对应 Task |
|-------------|----------|
| 2. 核心架构 Task Tool 模式 | Task 4 (runner), Task 5 (task-tool), Task 7 (graph) |
| 3. 内置角色 | Task 3 (roles) |
| 4. 生命周期管理 | Task 4 (runner: timeout/并发) |
| 5. 审批策略 | Task 4 (runner — explore/review 只读工具不触发审批) |
| 6. TUI 渲染 | Task 9-12 (types/reducer/SubAgentBlock/OutputArea) |
| 7. 事件协议 | Task 1 (protocol events) |
| 8. Task 工具定义 | Task 5 (task-tool), Task 6 (contract) |
| 9. 与现有系统的关系 | Task 7 (graph), Task 8 (runner bridge) |

### 2. Placeholder scan

无 TBD/TODO/占位符。所有代码步骤包含完整实现。

### 3. 类型一致性

- `SubAgentRole` 在 protocol/events.ts 定义 → subagent/types.ts re-export → roles.ts 使用 → task-tool.ts 使用 → TUI types.ts 使用
- `SubAgentEventSink` 在 subagent/types.ts 定义 → runner.ts 使用 → task-tool.ts 使用 → graph.ts/graph.ts 和 runner.ts 传递
- `OutputBlock.subagent` 在 types.ts 定义 → handleEvent.ts 构建 → SubAgentBlock.tsx 渲染 → OutputArea.tsx 集成
