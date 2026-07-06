# Plan Mode 功能实现文档

状态：active
范围：`src/protocol/`、`src/core/`、`src/app/tui/`、`tests/`
读取时机：修改 plan 流程、plan_review 中断、ask_user 渲染、session 持久化时必读。
验证：`bun test tests/session-manager.test.ts tests/authorization-mode.test.ts tests/tool-definitions.test.ts tests/runtime-context.test.ts tests/context.test.ts tests/tui-run-agent.test.ts tests/graph.test.ts tests/runner.test.ts tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/slash-commands.test.ts`

> 设计文档：[[plan-mode-design]] — 产品方案与交互设计
> 原始计划：[[2026-06-16-plan-review-interrupt]] — 已归档，实际实现有偏差

---

## 概述

Plan Mode 允许 Agent 在执行复杂任务前先提出方案，经用户审批后再执行。整个功能涉及三层架构的全面改造。

## 最近更新（2026-07-06）

- **三轴模式语义**：`phase` 负责能力边界，`interactionMode` 负责人机确认体验，`authorization` 负责工具执行授权。三者不能互相隐式替代。
- **Plan Mode core-first**：`/plan <task>`、Shift+Tab 和 TUI session runtime 会把 `initialPhase=planning` 传入 `runAgent`，core tool policy 以 `graph.state.phase` 执行只读边界。
- **Plan approval 不再等于 full_access**：批准方案后状态迁移为 `phase=building`，`executionMode=auto` 只切到自动低风险确认，不提升到 `authorization.mode=full_access`。
- **Planning 阶段 tool policy**：默认允许 read/search/research、`ask_user`、`update_plan` 和只读 subagent；拒绝写文件、非只读 shell、实现型 subagent 和 full access escalation。
- **Full mode 收紧**：TUI/CLI 进入 full 前需要可用 sandbox backend；后台 session 不再默认注入 `full_access`。
- **沙箱配置一等化**：`sandbox.enabled` 进入 `AgentConfig`，默认 `true`。TUI、CLI 和 session runtime 通过 `resolveSandboxRuntime()` 统一解析 `{ enabled, backend, available }`；CLI `--no-sandbox` 是一次性更高优先级关闭开关。
- **动态 runtime snapshot**：当前 phase、interactionMode、authorization、sandbox、planReviewed 和 approvedPlanSummary 作为非 cacheable runtime reminder 注入模型；静态 system prompt 不再携带这些动态状态。
- **Tool cache 防旧状态**：`createAgentTools()` 的缓存 key 纳入 phase、authorization、workspaceAccess 等 runtime policy 状态，避免 stateful tools 捕获旧权限。
- **Full 入场前 guard**：`/mode full` 和无参 `/mode` 从 auto 进入 full 时，TUI 在 reducer dispatch 前通过 `admitInteractionModeTarget()` 检查 resolved sandbox backend；不可用时保持/回退 `ask` 并展示 recoverable error。Session runtime 仍保留同一 guard 作为执行前防线。
- **Full 不可用时前置禁用**：当 sandbox backend 为 `none` 时，TUI `/mode` 候选列表仍显示 `full`，但标记为 disabled，并用“未启用沙箱，Full 不可用”作为辅助文案；无参 `/mode` 在 `ask ↔ auto` 间切换，不再让用户先进入 Full 再失败。
- **授权 cache key 稳定化**：`createAgentTools()` 不再只用 `commandGrants` 数量做缓存判断，而是把 `authorization.mode + commandGrants` 做稳定序列化，并同时纳入 `interactionMode`，避免同数量不同授权复用旧 stateful tool executor。
- **实际 sandbox 投影**：TUI/CLI 解析出的 `sandboxBackend` 进入 `RunAgentInput` 和 graph state，并作为动态 runtime snapshot 注入模型；cacheable system prompt 不包含该动态字段。

## 最近更新（2026-06-30）

- **批量 tool call 路由修复**：`resolveToolRoute` 扫描全部 pending tool calls 而非仅第一个，按优先级决策（`ask_user` > 结构性 `update_plan` > `approval` > `tools`），防止 read_file 在前导致 write_file 绕过审批 / update_plan 绕过 plan_review
- **ask_user 紧凑渲染**：tool_card 改为 `⎿` 前缀单行布局，仿 shell_execute 样式。单问题 `⎿   User: answer`，多步骤 `⎿  Step1 sub_q User: answer`
- **方案内容去重**：OutputArea 以 Markdown tool_card 渲染方案，Footer PlanReviewBlock 仅显示确认操作条（不再内联方案内容）
- **ESC plan_review 停止会话**：ESC 等同 Ctrl+C，设置 `running: false` + 停止 agent，不再仅消除中断
- **计划路由优化**：`isPlanProgressOnlyUpdate` — 仅 name/description/steps 变化触发 plan_review，纯 status 更新直通

## 触发方式

| 触发方式 | 实现 |
|----------|------|
| `/plan <task>` | slash command，进入 planning phase + 立即提交任务 |
| `/plan`（无参数） | 仅切换 phase 为 planning，用户后续输入任务 |
| Shift+Tab | 切换 planning ↔ building，全局快捷键 |
| Agent 自主判断 | system prompt Plan-First Rule，Agent 自行决定是否先出方案 |

## 架构

### 协议层 (protocol)

- **新事件**: `need_plan_review` — `NeedPlanReviewPayload { plan: AgentPlan }`
- **新类型**: `AgentPlan`、`AgentPlanStep`、`PlanStatus`、`UserInputQuestion`
- **新 UserAction**: `approve_plan_auto`、`approve_plan_manual`、`supplement_plan`、`reject_plan`
- **扩展**: `UserInputPayload` 新增 `questions?: UserInputQuestion[]`（多问题模式）

### 核心层 (core)

- **graph.ts**: 新增 `planReview` 节点，首次 `update_plan` 调用 → interrupt 等用户审批。审批通过 → 设置 `state.plan`、`planReviewed=true`、`phase=building`；`auto` 只映射为 `interactionMode=auto`，不提升 `authorization.mode`
- **routes.ts**: `update_plan` 结构性变更（首次提交或名称/描述/步骤文本改变）路由到 `plan_review`，纯进度更新（仅 status 变化）路由到 `tools`。批量 tool call 场景按优先级扫描全部 pending：ask_user > 结构性 update_plan > 需审批 > tools。
- **runner.ts**: 事件提取、中断映射、resume value 转换
- **user-input.ts**: `normalizeUserInputResume` 支持 `answers` map（多问题）
- **sessions.ts**: `ReplayInterrupt` 扩展 `plan_review` 类型，从 checkpoint `channel_values.plan` 提取已批准方案
- **types.ts**: `PlanReviewResumeValue` + `UserInputResumeValue.answers`
- **tool-policy.ts**: 统一返回 `allow | ask | deny` 决策；planning phase 对写入、非只读 shell、实现型 subagent 做 hard deny
- **context.ts/runtime-context.ts**: 静态 system prompt 只保留通用协作规则和 cacheable workspace context；动态模式快照追加为合成 `HumanMessage`

### TUI 层 (app/tui)

- **PlanReviewBlock.tsx**: plan_review 中断时的确认操作条（Footer），三个选项：Auto / Manual / Tell。方案内容在 OutputArea 渲染
- **TaskProgressBlock.tsx**: 审批后只读进度列表，显示在 Footer 上方
- **BlockRenderer.tsx**: plan_review 卡片渲染（OutputArea）— `borderStyle="round"` + name + Markdown description + steps，支持 `awaiting review` / `auto mode` / `manual approval` / `supplemented` / `cancelled` / `rejected` 多种状态
- **InputBlock.tsx**: 多问题 Wizard 模式 — 步骤导航、逐题回答、已回答摘要、汇总提交。单问题模式保持原有行为
- **InputLine.tsx**: plan mode 可视化 — `≻◷` prompt + 模式指示条
- **StatusBar.tsx**: idle 时 plan mode 也显示 `○ Planning`
- **replay-blocks.ts**: 从消息历史提取 plan_review 块（`update_plan` AIMessage tool_call args + ToolMessage 结果），支持所有审批状态恢复
- **agentReducer.ts**: `TOGGLE_PLAN_MODE`、plan_review Esc 取消停止 agent、多问题 resolution
- **useGlobalKeys.ts**: Shift+Tab 切换 + supplement 模式 Esc 局部消费

### CLI (app/cli)

- plan_review 中断支持 `a/auto`、`m/manual`、`t/tell`、`r/reject`

## 用户交互流程

```
用户输入任务
  │
  ├─ 需要澄清？→ ask_user (多问题 batch) → 用户回答 → 继续
  │
  └─ Agent 调用 update_plan → plan_review 中断
      │
      ├─ Approve and continue: phase=building，自动处理低风险确认，authorization 保持 default
      ├─ Approve with confirmations: phase=building，逐项确认受保护工具
      ├─ Tell: 补充反馈 → Agent 修订 → 再次 plan_review
      └─ Esc/Ctrl+C: 取消，agent 停止
```

## 设计决策

| 决策 | 结论 |
|------|------|
| PlanReview 选项 | Auto / Manual / Tell 三选项 |
| Pre-plan 澄清 | ask_user questions 数组批量确认 |
| Supplement 后 | 再次触发 plan_review（不设 state.plan） |
| 补充方式 | 纯自由文本，Esc 回退到选项页 |
| free_text | 永远可用，Tab 切换 |
| Plan 展示 | 方案内容 OutputArea tool_card Markdown（进 Static） + 确认条 Footer（动态） |
| 边框样式 | `borderStyle="round"` + `columns` 响应式宽度 |
| 持久化 | 消息中提取 plan_review 块 + checkpoint state.plan 兜底 |
| Auto 语义 | 只表示自动确认策略，不表示 full access |
| Full 语义 | 仅 building phase 下可用，且需要 sandbox backend |

---

## ask_user tool_card 紧凑渲染

`ToolCardBlock.tsx` — `renderAskUserSummary` 替代 `formatAskUserContent` + `MarkdownBlock`：

- **解析**：`parseAskUserAnswers` 从 summary 提取 answer/answerMap/isCancelled（兼容 JSON 和上游纯文本格式）
- **单问题**：`⎿   User: answer` — 问题文本已在 detail 行，不重复
- **多步骤**：`⎿  Step1 sub_question User: answer` — 每步一行，sub_question >40 字截断
- **取消**：`⎿   Cancelled`
- summary 为空 → 不渲染（上游 `parseToolResultEvents` 保证非空，此 guard 为防御性）

## PlanReviewBlock 布局

Footer 仅渲染确认操作条（无内联方案内容）：

```
╭─────────────────────────────────────────────────╮
│ Review the plan above and choose:               │
│ ▶ 1. Approve and continue (Recommended)         │
│  Execute with automatic low-risk confirmations  │
│   2. Approve with confirmations                 │
│  Ask before edits and risky tools               │
│   3. Tell Agent what to change                  │
│  Provide feedback to revise the plan            │
│ ↑↓ select Enter confirm a/m/t quick key Esc cancel│
╰─────────────────────────────────────────────────╯
```

方案内容在 OutputArea 以 `update_plan` tool_card（`expanded: true` + `summary` 填充）经 `MarkdownBlock` 完整渲染。

## plan_review 中断处理

`handleEvent.ts` — `need_plan_review`：
1. 查找 pending `update_plan` tool_card（status: running）
2. 填充 `summary` = 方案 Markdown 格式文本（`plan.description + Steps: ...`）
3. 设置 `expanded: true`，`status: done`
4. 设置 `status.pendingPlan = plan`

`agentReducer.ts` — `RESOLVE_PLAN_REVIEW`：
- Auto/Manual → `status.plan = pendingPlan`，`pendingPlan = null`
- Supplement/reject → 保持 plan 不变

`agentReducer.ts` — `ESCAPE`（plan_review 期间）：
- `cancelRunningBlocks()` + `finalizeLastTurnStreaming()` + `running: false` + `interrupt: null`
- 等同 Ctrl+C，停止整个会话

## 计划路由：isPlanProgressOnlyUpdate + 批量扫描

`routes.ts` — `resolveToolRoute()` 扫描全部待处理 tool calls，按优先级决策：

```typescript
for (const request of allRequests) {
  if (request.name === 'ask_user') return 'user_input';  // Priority 1
  if (request.name === 'update_plan' && !isPlanProgressOnlyUpdate(state.plan, request.args)) {
    return 'plan_review';  // Priority 2
  }
  // ... policy evaluation → hasApprovalRequired (Priority 3)
}
return 'tools';  // Priority 4
```

`isPlanProgressOnlyUpdate` 仅在 name/description/steps（文本 + 数量）完全不变时返回 true。纯状态更新（`in_progress` → `completed`）直通执行。

批量场景：若 AIMessage 含 `[read_file, update_plan(structural)]`，优先级 2 触发 → `plan_review`，`update_plan` 不在第一位也能被正确拦截。

## 相关文档

- [[layer-boundary-enforcement]] — core 层边界约束
- [[tool-description-contracts]] — 工具 ACI 契约
- [[tui-reference-stability]] — useStaticContent 与 Static/Dynamic 分离
