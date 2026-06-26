# Plan 子 Agent 角色设计方案

状态：draft
关联：[[plan-mode-design]] [[plan-mode-implementation]]

---

## 1. 背景：Claude Code 的 Plan 子 Agent 设计

### 1.1 定位

Claude Code 的 Plan 子 agent 是 **5 阶段规划工作流中 Phase 2（Design）的核心执行者**。它不是主 agent 的替代品，而是主 agent 的设计智囊——当主 agent 需要从多个架构角度审视问题时，派发多个 Plan 子 agent 并行产出独立设计方案。

### 1.2 关键设计决策

| 维度 | Claude Code 的选择 | 理由 |
|------|-------------------|------|
| **工具集** | 只读 + 计划文件写入，无 Edit/Write/Agent | 设计方案，不执行。写计划文件是唯一允许的写入 |
| **模型** | 继承父 agent（不降级） | 架构推理需要与主 agent 同等推理质量 |
| **子 agent 权限** | 不可再派生 agent | Plan agent 本身是设计者，不需管理子任务 |
| **并行模式** | 多 Plan agent 并行，不同视角（简单性/性能/可维护性） | 多视角碰撞 → 主 agent 合并最优方案 |
| **输入** | 阶段 1 的研究发现 + 任务需求 | 基于证据设计，不凭空架构 |
| **输出** | 结构化设计方案（方法、关键文件、可复用代码、验证策略） | 统一格式便于主 agent 合并 |

### 1.3 与其他角色的关系

```
主 Agent
  ├─ Explore 子 agent → 搜索、追踪、收集证据（Haiku，快速低延迟）
  ├─ Plan 子 agent   → 架构设计、方案评估（父模型，高推理质量）
  ├─ Code 子 agent   → 实现、修复、测试
  └─ Review 子 agent → 审计、安全检查
```

Plan 子 agent 在 Explore 之后、Code 之前运行——它把研究发现转化为可执行的方案。

---

## 2. 现状分析：openpx-new 的缺口

### 2.1 已有的

- **Plan Mode**（`AgentPhase = 'planning' | 'building'`）：限制主 agent 工具为只读 + `update_plan` + `ask_user`
- **`update_plan` 工具**：主 agent 提交方案，触发 `plan_review` 中断等用户审批
- **三个子 agent 角色**：`explore`（只读搜索）、`code`（全工具）、`review`（只读审计）
- **`task` 工具**：派发子 agent 的统一入口

### 2.2 缺失的

- **无 `plan` 子 agent 角色**：主 agent 无法将"设计方案"这件事委托给专门的子 agent
- **主 agent 独自规划**：当前 plan mode 中，主 agent 自己读文件、自己想方案、自己调 `update_plan`——这在复杂任务中导致：
  - 主 agent 上下文被大量文件读取和方案推敲占满
  - 无法从多个架构视角并行获取独立方案
  - 设计质量受限于单线程思考

### 2.3 为什么需要 Plan 子 Agent

1. **多视角设计**：主 agent 派发 2-3 个 Plan agent，分别从"最简实现""最高性能""最易维护"角度独立设计方案，然后合并最优解
2. **上下文隔离**：复杂的架构推敲过程不污染主 agent 上下文窗口
3. **并行加速**：Explore（收集证据）→ Plan（设计方案）→ Code（实现）可流水线化，Plan agent 不需要等主 agent 逐个思考
4. **角色匹配**：`explore` 负责"找到什么"，`plan` 负责"怎么改"，`code` 负责"改"，`review` 负责"改对没"——形成完整的工具链

---

## 3. 方案设计

### 3.1 Plan 角色定义

```typescript
// 角色标识
type SubAgentRole = 'explore' | 'plan' | 'code' | 'review';
```

### 3.2 角色配置

```typescript
const PLAN_SYSTEM_PROMPT = `You are a Plan agent. Your role is to design implementation approaches — not to implement them.

## Guidelines
- Base your design on the findings and requirements provided in the task. Do NOT search for additional files unless the task explicitly asks you to verify a specific claim.
- Produce exactly ONE recommended approach, not a menu of options. Explain WHY this approach is best.
- Cover: architecture, data flow, file structure, key interfaces, dependencies, and testing strategy.
- Identify risks and trade-offs explicitly. No design is perfect — be honest about downsides.
- Reference existing code patterns and reusable utilities with specific file:line references.
- Do NOT make any code changes. Your output is a design document for the main agent to review and execute.

## Output format
Return a structured design document:
- **Context** — what problem this solves, constraints, and assumptions
- **Approach** — single recommended implementation strategy with rationale
- **Key Files** — files to create/modify/delete, with what changes in each
- **Reusable Code** — existing functions, components, or patterns to leverage (with file:line)
- **Risks & Trade-offs** — what could go wrong, what we're sacrificing
- **Verification** — how to test the changes end-to-end

Keep the document focused and actionable. The main agent will read it and turn it into concrete tool calls.`;

const PLAN_ROLE_CONFIG: SubAgentRoleConfig = {
  role: 'plan',
  systemPrompt: PLAN_SYSTEM_PROMPT,
  allowedTools: new Set(['read_file', 'shell_execute', 'read_mcp_resource']),
  timeoutMs: 10 * 60 * 1000, // 10 分钟：设计比搜索需要更多思考时间
};
```

### 3.3 工具限制

Plan agent 是**纯设计角色**，工具集严格限制为只读：

| 工具 | 允许 | 理由 |
|------|------|------|
| `read_file` | ✅ | 验证任务中引用的文件路径和代码 |
| `shell_execute`（只读） | ✅ | grep/rg 补充搜索，但 shell wrapper 已限制为只读命令 |
| `read_mcp_resource` | ✅ | 读取 MCP 资源 |
| `edit_file` | ❌ | 不做修改 |
| `write_file` | ❌ | 不做修改 |
| `task` | ❌ | 不派生子 agent（设计者不管理） |
| `update_plan` | ❌ | Plan agent 输出设计方案文本，不直接操作主 agent 的计划状态 |
| `ask_user` | ❌ | 不与用户交互（主 agent 负责收集需求、澄清问题） |
| `Skill` | ❌ | 不需要加载技能 |

> **与 Claude Code 的关键差异**：Claude Code 的 Plan agent 可以写入计划文件（`.claude/plans/{id}.md`），因为其 `ExitPlanMode` 工具依赖文件系统交换计划内容。openpx-new 的 Plan agent 通过返回结构化文本传递设计方案，无需文件写入权限。

### 3.4 模型选择

Plan agent **继承父 agent 模型**（不降级），因为架构推理需要与主 agent 同等的推理质量。这与 Explore agent 使用 Haiku 的策略不同——搜索是广度优先的低延迟操作，而设计是深度优先的高推理操作。

### 3.5 超时

**10 分钟**。比 Explore/Review 的 5 分钟长，因为设计需要更多思考时间。比 Code agent 的不限制超时短，因为设计不涉及漫长的编译/测试循环。

---

## 4. 工作流集成

### 4.1 5 阶段规划流中的位置

```
Phase 1: Explore — 派发 Explore agent 收集证据
    │
Phase 2: Design  — 派发 Plan agent(s) 设计方案  ← 新角色在这里
    │
Phase 3: Review  — 主 agent 合并方案 + 审查
    │
Phase 4: Write   — 主 agent 调用 update_plan 提交方案
    │
Phase 5: Exit    — plan_review 中断 → 用户审批
```

### 4.2 典型调用模式

**单视角设计（标准任务）**：
```
主 agent: task({ subagent_type: 'plan', task: `
  Task: Design a unified diff format for TUI file change rendering.
  
  Findings from Explore:
  - src/app/tui/components/DiffBlock.tsx: 3 different diff rendering code paths
  - src/app/tui/components/FileChangeBlock.tsx: uses hand-rolled diff parser
  - tests/tui-layout.test.tsx: diff test coverage is fragmented
  
  Requirements:
  - Single unified diff format
  - Backward compatible with existing block types
  - Performance: no regression on files > 1000 lines
`})
```

**多视角设计（复杂任务）**：
```
主 agent 并行派发 3 个 Plan agent：
  Plan-simplicity: "Design the simplest possible approach..."
  Plan-performance: "Design the most performant approach..."
  Plan-maintainability: "Design the most maintainable approach..."

主 agent 读取 3 份设计方案 → 合并最优解 → update_plan
```

### 4.3 与 update_plan 的关系

Plan agent 的输出是**设计方案文本**（Markdown），不是 `AgentPlan` 结构。主 agent 读取 Plan agent 的设计输出后：
1. 评估方案、合并多视角建议
2. 必要时读文件验证关键假设
3. 调用 `update_plan` 提交最终方案（此时已是经过专业设计的成熟方案）

这维持了 **单一真相源**：`state.plan` 始终由主 agent 通过 `update_plan` 管理，Plan agent 只是辅助设计工具。

---

## 5. 实现清单

### 5.1 协议层

| 文件 | 变更 |
|------|------|
| `src/protocol/events.ts:243` | `SubAgentRole` 类型增加 `'plan'` |

```typescript
// Before
export type SubAgentRole = 'explore' | 'code' | 'review';
// After
export type SubAgentRole = 'explore' | 'plan' | 'code' | 'review';
```

### 5.2 核心层

| 文件 | 变更 |
|------|------|
| `src/core/subagent/roles.ts` | 新增 `PLAN_SYSTEM_PROMPT` + `plan` 配置项 + `BUILTIN_ROLES` 加入 `'plan'` |
| `src/core/subagent/task-tool.ts:97` | `subagent_type` enum 增加 `'plan'`，tool description 增加 plan 说明 |

```typescript
// task-tool.ts schema
subagent_type: z.enum(['explore', 'plan', 'code', 'review'])
```

```typescript
// task-tool.ts description 增加:
'- plan: Read-only architecture design. Best for: designing implementation approaches, evaluating trade-offs, proposing file structures.',
```

### 5.3 TUI 层

| 文件 | 变更 |
|------|------|
| `src/app/tui/components/SubAgentBlock.tsx:9-19` | `roleLabel` 增加 `case 'plan': return 'Plan'` |

### 5.4 系统提示

| 文件 | 变更 |
|------|------|
| `src/core/prompts/system-prompt.txt` | Sub-agents 节增加 plan 角色说明，Plan-First Rule 节提示可用 plan agent 辅助设计 |

### 5.5 测试

| 文件 | 变更 |
|------|------|
| `tests/tool-definitions.test.ts` | 验证 plan 角色在 task tool schema 中 |
| `tests/` 相关测试 | 验证 plan role config 正确性 |

### 5.6 不变更的部分

- **图拓扑**：不新增节点，plan agent 通过现有 `task` 工具派发
- **路由**：不影响 `resolveToolRoute()`，`task` 工具始终直通
- **审批流**：`task` 工具始终允许，Plan agent 内部只有只读工具，不触发审批
- **Plan Mode 交互**：`planning` phase 的工具限制已允许 `task`（风险 `plan`），Plan agent 可在 planning 阶段使用
- **持久化**：子 agent 步骤已纳入 checkpoint，无需额外处理

---

## 6. 与 Claude Code 的差异对照

| 维度 | Claude Code | openpx-new（本方案） |
|------|-------------|---------------------|
| Plan agent 写入权限 | 可写计划文件 | 纯只读（方案通过返回值传递） |
| Plan agent 可派生 agent | 否（`disallowedTools` 含 Agent） | 否（`task` 不在 allowedTools 中） |
| 模型 | 继承父 agent | 继承父 agent |
| 超时 | 跟随默认 | 10 分钟 |
| 方案输出格式 | 写到 `.claude/plans/{id}.md` | 返回结构化 Markdown 文本 |
| 与主 agent 计划的关系 | 直接写入计划文件 | 返回设计方案 → 主 agent 合并后调 `update_plan` |
| 多视角并行 | 支持 | 支持（主 agent 并行派发多个 Plan agent） |

核心差异在于：Claude Code 的 Plan agent 直接写入计划文件（因为其 `ExitPlanMode` 依赖文件系统），而 openpx-new 的 Plan agent 返回文本给主 agent——这更符合 openpx-new 的星型拓扑架构（子 agent 隔离，主 agent 统一决策）。

---

## 7. 风险评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| Plan agent 过度搜索 | 低 | 系统提示强调"基于任务中提供的研究发现设计，不要额外搜索" |
| Plan agent 产出的方案无法执行 | 中 | 主 agent 负责审查和验证方案后再调 `update_plan` |
| 模型上下文不足以装下复杂方案 | 低 | Plan agent 有独立上下文窗口，输出是紧凑的结构化文本 |
| 用户困惑 Plan agent vs Plan Mode | 低 | Plan agent 是后台子 agent（用户看到 SubAgentBlock），Plan Mode 是前台交互模式 |
