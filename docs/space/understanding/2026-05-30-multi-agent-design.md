# 多 Agent 架构设计

最后更新：2026-05-30

---

## 1. 设计目标

### 解决的场景

| 场景 | 说明 |
|------|------|
| **A. 并行执行** | 一个任务拆成多个子任务，不同子 agent 同时工作（如同时搜索多个模块），完成后汇总 |
| **B. 角色分工** | 不同 agent 有不同专长和能力边界（Explore 搜索、Code 落地、Review 审查） |
| **C. 长任务自治** | agent 可脱离用户交互在后台持续运行，完成后回报 |

### 明确不做（当前阶段）

| 不做 | 理由 |
|------|------|
| **D. 多 Agent 协作（peer-to-peer 协商）** | 工程复杂度远超收益；Anthropic 的 Agent Teams 仍处于实验阶段 |
| **自定义 Agent 配置** | 先用内置固定角色验证稳定性，后续开放 `.kite-code/agents/` 用户自定义 |
| **子 Agent 嵌套（depth > 0）** | 防止 agent 无限递归派生，子 agent 不可调用 `task` 工具 |

---

## 2. 核心架构：Task Tool 模式

### 2.1 拓扑

```
主 Agent Graph（现有，不变）
  │
  ├─ agent 节点
  │   └─ 模型调用 task 工具
  │
  └─ tools 节点（新增 task 处理）
      └─ SubAgentRunner 启动独立 Agent 实例
           ├─ 独立上下文窗口
           ├─ 独立工具集
           ├─ 独立 AbortController
           └─ 运行至完成 → 返回摘要注入主对话
```

### 2.2 设计原则

- **上下文隔离**：子 agent 拥有独立上下文窗口，不共享主 agent 消息历史
- **单向通信**：主 agent 派发任务 → 子 agent 返回最终摘要，无双向交互
- **主 Agent 是唯一决策者**：Plan 模式由主 agent 把控，子 agent 只做执行和研究
- **复用现有基础设施**：AbortController、checkpoint、审批系统

### 2.3 对比业界

| 维度 | Kite Code | Claude Code | Codex CLI |
|------|--------|-------------|-----------|
| 子 Agent 模型 | 独立 graph runner | 独立 query loop | 独立 agent 线程 |
| 上下文模型 | 完全隔离（仅 prompt） | 完全隔离（仅 summary 返回） | 独立上下文窗口 |
| 通信方向 | 单向（task → result） | 单向 | 单向 |
| 配置方式 | 内置固定角色 | `.claude/agents/*.md` | `.codex/agents/*.toml` |
| 最大并发 | 10 | 无硬性限制 | 6 |
| 超时 | 30 分钟 | 5 分钟 | 30 分钟（CSV batch） |
| 嵌套 | 0（不可递归） | 0 | 1 |

---

## 3. 内置角色

### 3.1 角色定义

| 角色 | 工具集 | 职责 |
|------|--------|------|
| **Explore** | `read_file`、`shell_execute`（只读命令白名单）、`read_mcp_resource` | 搜索、追踪、收集证据，返回完整发现 |
| **Code** | 全部 6 个工具（含 `edit_file`、`write_file`、`shell_execute` 完整权限） | 落地实现、修复 bug、运行测试 |
| **Review** | 同 Explore（只读） | 批判性审查：bug、安全漏洞、逻辑矛盾、回归风险 |

### 3.2 角色不包含 Plan

主 Agent 已有 planning 模式（`workspaceAccess: "read-only"` → `phase: "planning"`），方案由主 agent 把控。子 agent 不越俎代庖做规划决策。主 agent 在调用 Code 子 agent 时，应提供明确、具体的实现指令，而非让子 agent 自行设计。

### 3.3 System Prompt 区分

Explore 和 Review 工具集完全相同（都是只读），区别完全在 system prompt：

- **Explore**："穷尽搜索，不遗漏线索。返回完整证据链，包含文件路径、行号、关键代码片段。不提出修改建议。"
- **Review**："批判性审查。寻找 bug、安全漏洞、逻辑矛盾、边界条件遗漏、测试覆盖缺口。返回按严重程度分级的发现清单，包含具体文件:行引用。"
- **Code**："严格按照指令实现。完成修改后运行相关测试验证。如果遇到不确定的情况，直接汇报，不要猜测。"

---

## 4. 生命周期管理

### 4.1 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 超时 | 30 分钟 | 子 agent 从启动到强制终止的最大时长 |
| 工具调用上限 | 无限制 | 不做硬性限制，依赖超时兜底 |
| 最大并发 | 10 | 同时运行的子 agent 数量上限 |
| 嵌套深度 | 0 | 子 agent 不可调用 `task` 工具 |
| 独立 checkpoint | 无 | 子 agent 是一次性的，不需要回溯 |

### 4.2 并发控制

复用现有多会话并发基础设施（独立 AbortController）。新增全局子 agent 计数器：

```
subagent.activeCount ≤ subagent.maxConcurrent (10)
```

超过上限时，新请求排队等待（FIFO 队列）。

### 4.3 中止

- 用户按 `Ctrl+C`：中止当前前端 agent 及其所有活跃子 agent
- 前端 agent 正常结束：等待所有子 agent 完成
- 子 agent 超时：AbortController.abort() → `SubAgentTimeoutError`

---

## 5. 审批策略

### 5.1 策略：混合模式

```
Code 子 agent 执行工具前：
  1. Explore / Review 子 agent — 只有只读工具，永不触发审批
  2. Code 子 agent —
     a. 查主 agent 的 authorization 状态
     b. 如果已授权（same_command / full_access）→ 直接执行
     c. 未授权 → 判断是否为"敏感操作"
        - 非敏感（read_file, read_mcp_resource, shell_execute 只读命令）→ 直接执行
        - 敏感（edit_file, write_file, shell_execute 非只读命令）→ 触发审批
```

### 5.2 审批展示

子 agent 触发审批时，TUI 在子 agent block 内嵌入审批卡片，等待用户交互。同一时间只有一个子 agent 可以等待审批（串行排队）。

### 5.3 设计依据

- 工具白名单已消除 2/3 的审批需求（Explore 和 Review 只有只读工具）
- 继承主 agent 授权避免重复审批
- 敏感操作仍然需要用户确认，不因"子 agent"身份跳过安全边界

---

## 6. TUI 渲染

### 6.1 Block 类型：`subagent`

子 agent 作为嵌入对话流的新 block 类型，对齐 Claude Code 的展示模式。

```
渲染状态：

▸ Explore · 搜索 UserService 引用...
  ├─ Grep: UserService                    [1.2s]
  ├─ Read: src/services/user.ts           [0.3s]
  └─ Grep: UserService\.getById           [0.8s]

▼ Explore · 搜索 UserService 引用 — 3 次工具调用，2.3s
  │ 找到 8 处引用，分布在 5 个文件中：
  │ - src/controllers/auth.ts:45, 78
  │ - src/middleware/session.ts:23
  │ - ...
```

### 6.2 Block 行为

- **运行中**：显示角色图标（🔍/🔧/👁）+ 任务摘要 + 实时工具调用列表 + 耗时
- **完成后**：默认折叠为一行摘要（角色 + 任务 + 工具调用次数 + 总耗时），可展开查看完整输出
- **并行**：每个子 agent 独立 block，按启动时间顺序排列，互不遮挡
- **报错**：子 agent 超时/异常 → block 标记为错误状态，显示错误原因

---

## 7. 事件协议

### 7.1 新增事件类型

```typescript
// 子 agent 生命周期事件
type SubAgentEvent =
  | { type: "subagent_start"; data: { id: string; role: "explore" | "code" | "review"; task: string } }
  | { type: "subagent_step"; data: { id: string; toolName: string; toolArgs: Record<string, unknown> } }
  | { type: "subagent_tool_result"; data: { id: string; toolName: string; ok: boolean } }
  | { type: "subagent_done"; data: { id: string; summary: string; toolCallCount: number; durationMs: number } }
  | { type: "subagent_error"; data: { id: string; error: string } }
```

这些事件插入现有的 `AgentEvent` 联合类型，runner 的 `processStream` 中消费。

### 7.2 实现位置

- `src/protocol/events.ts` — 新增事件类型定义
- `src/core/runner.ts` — SubAgentRunner 实现
- `src/core/tools/definitions.ts` — 新增 `task` 工具
- `src/app/tui/OutputArea.tsx` — 新增 `subagent` block 渲染
- `src/app/tui/App.tsx` — reducer 新增 subagent 相关 Action

---

## 8. Task 工具定义

```typescript
// task 工具 schema
{
  name: "task",
  description: "派发任务给子 Agent 执行。子 Agent 拥有独立上下文窗口和受限工具集。",
  schema: {
    subagent_type: "explore" | "code" | "review",
    task: string,     // 明确、具体的任务描述，包含所有必要的上下文信息
  }
}
```

`task` 字段到子 agent 的映射：

```
subagent_type: "explore"  → SubAgentType.Explore   → 只读工具集 + Explore system prompt
subagent_type: "code"     → SubAgentType.Code      → 全部工具 + Code system prompt
subagent_type: "review"   → SubAgentType.Review    → 只读工具集 + Review system prompt
```

---

## 9. 与现有系统的关系

### 9.1 不影响现有代码

- 主 Agent Graph 拓扑不变（agent → approval/tools/user_input → agent）
- 审批流不变（tool-policy、approval 节点）
- checkpoint 持久化不变（主 agent 的 checkpoint 正常保存）

### 9.2 新增加

- `src/core/subagent/` — 子 agent 模块
  - `types.ts` — 子 agent 类型定义
  - `roles.ts` — 内置角色定义（system prompt + 工具集）
  - `runner.ts` — SubAgentRunner（独立的 agent 执行器）
  - `task-tool.ts` — task 工具实现

### 9.3 复用

- 模型工厂（`src/core/model/factory.ts`）
- 工具定义（`src/core/tools/definitions.ts`）
- 审批策略（`src/core/harness/tool-policy.ts`）
- AbortController（现有多会话并发机制）
- 事件协议（`src/protocol/events.ts`）

---

## 10. 关联文档

- [`../plans/index.md`](../plans/index.md) — 方案注册表
